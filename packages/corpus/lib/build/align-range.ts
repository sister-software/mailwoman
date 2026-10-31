/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One source's align work over a contiguous byte range of its canonical rows, for a parallel build.
 *
 *   The align phase's output for a row depends only on that row's data (`createRowAligner`), so a source's
 *   `canonical.jsonl` can be divided at line boundaries and each range aligned by its own process. The ranges'
 *   labeled files read in range order hold the bytes one serial pass writes, and their tallies merged in range order
 *   equal that pass's tallies. File size and bytes determine the boundaries, regardless of worker count.
 *
 *   Each range's task writes its outputs under its own directory and a `RANGE_COMPLETE.json` after every output has
 *   been flushed and closed. A resumed build reuses a range whose record states the same offsets and settings and
 *   whose files still have the recorded sizes, and aligns every other range again from its first byte.
 */

import { readFileRange, tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { openReadStream, openWriteStream, type WriteStream } from "@mailwoman/core/fs/streams"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { alignSettings, createRowAligner, emptyAlignResult, type AlignTally } from "#build/align"
import { alignTotalsOf, serializeAlignTotals, type AlignTotalsRecord } from "#build/align-totals"
import type { AlignSettings } from "#build/checkpoint"
import { createIneligibilityReader } from "#build/eligibility"
import type { BuildProfile } from "#build/types"
import { flushStream, once } from "#runner"
import type { CanonicalRow } from "#types"
import { createLicenseVerdictCache, type LicensePolicy } from "#utils/license"
import { SPLIT_NAMES, type CountryHoldout, type SplitName } from "#utils/split"

/**
 * One range's place in its source's canonical file.
 */
export interface AlignRangePlan {
	index: number
	count: number
	/**
	 * The canonical file's size when the plan was made.
	 */
	canonicalBytes: number
	/**
	 * First byte of the range, at the start of a line.
	 */
	start: number
	/**
	 * One past the last byte of the range: the byte after a newline, or the end of the file.
	 */
	end: number
}

/**
 * The files one range's task writes, by name.
 */
export const ALIGN_RANGE_OUTPUTS = [
	"labeled-train.jsonl",
	"labeled-val.jsonl",
	"labeled-test.jsonl",
	"quarantine.jsonl",
	"source-ids-train.txt",
	"source-ids-val.txt",
	"source-ids-test.txt",
] as const

export type AlignRangeOutputName = (typeof ALIGN_RANGE_OUTPUTS)[number]

/**
 * What a finished range's task records beside its outputs.
 */
export interface AlignRangeRecord {
	plan: AlignRangePlan
	settings: AlignSettings
	/**
	 * Each output's size in bytes after it was closed.
	 */
	outputs: Record<AlignRangeOutputName, number>
	totals: AlignTotalsRecord
	completed_at: string
}

/**
 * The record's name in a range's directory, written by {@linkcode runAlignRange}
 * after every output is closed.
 */
export const ALIGN_RANGE_RECORD_FILE = "RANGE_COMPLETE.json"

/**
 * The directory one range's task writes into.
 */
export function alignRangeDirectory(
	sourceDir: PathBuilderLike,
	plan: Pick<AlignRangePlan, "index" | "count">
): PathBuilder {
	return PathBuilder.from(sourceDir)("align", `range-${plan.index}-of-${plan.count}`)
}

/**
 * The bytes the boundary search reads at a time.
 */
const BOUNDARY_PROBE_BYTES = 64 * 1024

/**
 * The offset of the byte after the first newline at or after `offset`,
 * or the file's size when no newline follows.
 */
async function nextLineStart(path: PathBuilderLike, offset: number, size: number): Promise<number> {
	let position = offset

	while (position < size) {
		const chunk = await readFileRange(path, position, BOUNDARY_PROBE_BYTES)
		const newline = chunk.indexOf(0x0a)

		if (newline !== -1) return position + newline + 1

		position += chunk.length

		if (!chunk.length) break
	}

	return size
}

/**
 * Divide a canonical file into at most `count` ranges that each begin at a line start.
 *
 * The boundaries sit at the first line start at or after each `i / count` of the file,
 * The file determines those boundaries.
 * A file with fewer lines than `count` yields fewer ranges, and an empty file yields one empty range.
 */
export async function planAlignRanges(path: PathBuilderLike, count: number): Promise<AlignRangePlan[]> {
	const size = (await tryStat(path))?.size

	if (size == null) throw new Error(`planAlignRanges: ${path.toString()} does not exist`)

	const boundaries = [0]

	for (let i = 1; i < count; i++) {
		// The probe starts one byte early, so a boundary that lands on a line start keeps that line start.
		const boundary = await nextLineStart(path, Math.max(0, Math.floor((i * size) / count) - 1), size)

		if (boundary > boundaries.at(-1)! && boundary < size) {
			boundaries.push(boundary)
		}
	}

	boundaries.push(size)

	return boundaries.slice(0, -1).map((start, index) => ({
		index,
		count: boundaries.length - 1,
		canonicalBytes: size,
		start,
		end: boundaries[index + 1]!,
	}))
}

export interface AlignRangeOptions {
	canonicalPath: PathBuilderLike
	plan: AlignRangePlan
	sourceDir: PathBuilderLike
	corpusVersion: string
	synthesize: boolean
	profile: BuildProfile
	licensePolicy: LicensePolicy
	excludeLicenses: readonly RegExp[]
	holdouts: Record<string, CountryHoldout>
	eligibility: ReadonlyMap<string, readonly string[]> | null
}

/**
 * The record of a range that a resumed build may reuse, or `null` when the range must be aligned again.
 *
 * Reuse needs the same offsets in a file of the same size, the same settings,
 * and every output at its recorded size.
 * A task killed before it wrote its record leaves no record, so its range is aligned again.
 */
export async function reusableAlignRange(
	sourceDir: PathBuilderLike,
	plan: AlignRangePlan,
	settings: AlignSettings
): Promise<AlignRangeRecord | null> {
	const dir = alignRangeDirectory(sourceDir, plan)
	const record = await tryReadLocalJSONFile<AlignRangeRecord>(dir(ALIGN_RANGE_RECORD_FILE)).catch(() => null)

	if (!record) return null

	if (stringifyJSON(record.plan) !== stringifyJSON(plan)) return null

	if (stringifyJSON(record.settings) !== stringifyJSON(settings)) return null

	for (const name of ALIGN_RANGE_OUTPUTS) {
		if ((await tryStat(dir(name)))?.size !== record.outputs[name]) return null
	}

	return record
}

/**
 * Align one range into its directory and write its record.
 */
export async function runAlignRange(opts: AlignRangeOptions): Promise<AlignRangeRecord> {
	const dir = alignRangeDirectory(opts.sourceDir, opts.plan)

	await makeDirectories(dir)

	const ineligibility = createIneligibilityReader(opts.eligibility)
	const licenses = createLicenseVerdictCache(opts.licensePolicy, opts.excludeLicenses)
	const result = emptyAlignResult(licenses, ineligibility.refused)

	const tally: AlignTally = {
		aligned: 0,
		quarantined: 0,
		excludedByLicense: 0,
		admittedUnresolved: 0,
		excludedByEligibility: 0,
	}

	const streams = Object.fromEntries(
		ALIGN_RANGE_OUTPUTS.map((name) => [name, openWriteStream(dir(name), { encoding: "utf8", flags: "w" })])
	) as Record<AlignRangeOutputName, WriteStream>

	const outputs = Object.fromEntries(ALIGN_RANGE_OUTPUTS.map((name) => [name, 0])) as Record<
		AlignRangeOutputName,
		number
	>

	const write = (name: AlignRangeOutputName, line: string): void => {
		outputs[name] += Buffer.byteLength(line, "utf8")
		streams[name].write(line)
	}

	const alignOne = createRowAligner({
		synthesize: opts.synthesize,
		holdouts: opts.holdouts,
		licenses,
		ineligibility,
		result,
		tally,
		sinks: {
			labeled: (split: SplitName, line, sourceID) => {
				write(`labeled-${split}.jsonl`, line)

				if (sourceID != null) {
					write(`source-ids-${split}.txt`, `${sourceID}\n`)
				}
			},
			quarantine: (line) => write("quarantine.jsonl", line),
		},
	})

	if (opts.plan.end > opts.plan.start) {
		// `end` is inclusive for a read stream.
		const range = openReadStream(opts.canonicalPath, { start: opts.plan.start, end: opts.plan.end - 1 })

		for await (const row of JSONSpliterator.fromAsync<CanonicalRow>(range)) {
			alignOne(row)
		}
	}

	await Promise.all(Object.values(streams).map((stream) => flushStream(stream)))

	for (const stream of Object.values(streams)) {
		stream.end()
	}

	await Promise.all(Object.values(streams).map((stream) => once(stream, "close")))

	const record: AlignRangeRecord = {
		plan: opts.plan,
		settings: alignSettings(opts),
		outputs,
		totals: serializeAlignTotals(alignTotalsOf({ ...result, ...tally })),
		completed_at: new Date().toISOString(),
	}

	await writeLocalJSONFile(record, dir(ALIGN_RANGE_RECORD_FILE))

	return record
}

/**
 * Each split's labeled files and source-id lists across a source's ranges, in range order.
 */
export function alignRangeSplitFiles(
	sourceDir: PathBuilderLike,
	plans: readonly AlignRangePlan[]
): Record<SplitName, { labeled: PathBuilder[]; sourceIDs: PathBuilder[] }> {
	return Object.fromEntries(
		SPLIT_NAMES.map((split) => [
			split,
			{
				labeled: plans.map((plan) => alignRangeDirectory(sourceDir, plan)(`labeled-${split}.jsonl`)),
				sourceIDs: plans.map((plan) => alignRangeDirectory(sourceDir, plan)(`source-ids-${split}.txt`)),
			},
		])
	) as Record<SplitName, { labeled: PathBuilder[]; sourceIDs: PathBuilder[] }>
}
