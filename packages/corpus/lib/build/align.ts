/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The align phase reads each adapter's canonical rows and applies license and register refusals.
 *   It expands synthesis and aligns each row. It then routes the result to a split or quarantine.
 *
 *   The phase appends to four files. It writes a checkpoint at each adapter boundary, allowing an interrupted
 *   build to resume at the next adapter without aligning earlier adapters again.
 */

import { openWriteStream, type WriteStream } from "@mailwoman/core/fs/streams"
import { truncateFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilder } from "path-ts"

import {
	ALIGN_OUTPUTS,
	readAlignCheckpoint,
	writeAlignCheckpoint,
	type AlignCheckpoint,
	type AlignOutputName,
	type AlignSettings,
} from "#build/checkpoint"
import { createIneligibilityReader } from "#build/eligibility"
import { streamJSONL } from "#build/rows"
import type { BuildProfile, BuildStage } from "#build/types"
import { flushStream, once, type AdapterRunManifest } from "#runner"
import { defaultAugmentationsForCountry, synthesizeRow } from "#synthesizers/utils"
import type { CanonicalRow } from "#types"
import { alignRow } from "#utils/align"
import {
	createLicenseVerdictCache,
	type LicensePolicy,
	type LicenseRefusalKind,
	type LicenseVerdictCache,
} from "#utils/license"
import { SPLIT_NAMES, splitForRow, type CountryHoldout, type SplitName } from "#utils/split"

export interface AlignPhaseOptions {
	/**
	 * The adapter runs to align, in the order their rows enter the output files.
	 */
	adapterRuns: readonly AdapterRunManifest[]

	corpusVersion: string
	synthesize: boolean
	profile: BuildProfile
	licensePolicy: LicensePolicy
	excludeLicenses: readonly RegExp[]
	holdouts: Record<string, CountryHoldout>

	/**
	 * Each register source's ingest-eligibility reasons, or `null` under the exploratory profile.
	 */
	eligibility: ReadonlyMap<string, readonly string[]> | null

	labeledPaths: Record<SplitName, PathBuilder>

	/**
	 * Where each split's `source_id` values are written, one per line in the order their rows were aligned.
	 *
	 * The split phase sorts these rather than parsing every labeled row again for its id.
	 */
	sourceIDPaths?: Record<SplitName, PathBuilder> | null

	quarantinePath: PathBuilder
	checkpointPath: PathBuilder

	/**
	 * Continue from the checkpoint at `checkpointPath` rather than writing the outputs from the start.
	 */
	resume: boolean

	onProgress?: (stage: BuildStage, message: string) => void
}

/**
 * The counts produced by the align phase.
 *
 * The build uses them in its manifest and frozen source record.
 */
export interface AlignPhaseResult {
	aligned: number
	quarantined: number
	counts: Record<SplitName, number>
	licenseCounts: Map<string, number>
	refusedByKind: Map<LicenseRefusalKind, number>
	/**
	 * Rows the license policy refused, counted per `source`.
	 *
	 * A source here contributed zero rows to the corpus whatever its adapter reported writing.
	 * That is the distinction between a source present in corpus provenance
	 * and one present in model provenance.
	 */
	refusedBySource: Map<string, number>
	excludedByLicense: number
	admittedUnresolved: number
	excludedByEligibility: number
	rowsBySource: Map<string, { rows: number; license: string }>
	ineligibleSources: Map<string, readonly string[]>

	/**
	 * The source-id lists this phase wrote, or `null` when it wrote none.
	 *
	 * A phase resumed from a checkpoint that records no list offsets writes none,
	 * because the rows before the checkpoint have no ids on disk.
	 */
	sourceIDPaths: Record<SplitName, PathBuilder> | null

	/**
	 * The license cache this phase uses.
	 *
	 * Its `refusedValues()` method returns every value it refused.
	 */
	licenses: LicenseVerdictCache
}

/**
 * The mutable state of one align run.
 * The checkpoint restores and records this state.
 */
export interface AlignTally {
	aligned: number
	quarantined: number
	excludedByLicense: number
	admittedUnresolved: number
	excludedByEligibility: number
}

/**
 * Return each output to the length the checkpoint recorded.
 *
 * Whatever the interrupted adapter wrote past the boundary is discarded, because the checkpoint's
 * accumulators do not count those rows and the split manifests are computed from the accumulators.
 */
async function restoreOutputs(checkpoint: AlignCheckpoint, paths: Record<AlignOutputName, PathBuilder>): Promise<void> {
	for (const name of ALIGN_OUTPUTS) {
		await truncateFile(paths[name], checkpoint.offsets[name])
	}
}

/**
 * Restore the accumulators a checkpoint recorded into this run's containers.
 */
function restoreTally(checkpoint: AlignCheckpoint, result: AlignPhaseResult): AlignTally {
	for (const name of ["train", "val", "test"] as const) {
		result.counts[name] = checkpoint.counts[name]
	}

	for (const [license, count] of Object.entries(checkpoint.license_counts)) {
		result.licenseCounts.set(license, count)
	}

	for (const [kind, count] of Object.entries(checkpoint.refused_by_kind)) {
		result.refusedByKind.set(kind as LicenseRefusalKind, count)
	}

	for (const [source, count] of Object.entries(checkpoint.refused_by_source)) {
		result.refusedBySource.set(source, count)
	}

	for (const [source, contributed] of Object.entries(checkpoint.rows_by_source)) {
		result.rowsBySource.set(source, contributed)
	}

	return {
		aligned: checkpoint.aligned,
		quarantined: checkpoint.quarantined,
		excludedByLicense: checkpoint.excluded_by_license,
		admittedUnresolved: checkpoint.admitted_unresolved_license_rows,
		excludedByEligibility: checkpoint.excluded_by_eligibility,
	}
}

/**
 * The settings an align checkpoint or completion record is written under.
 */
export function alignSettings(
	opts: Pick<
		AlignPhaseOptions,
		"corpusVersion" | "synthesize" | "licensePolicy" | "excludeLicenses" | "profile" | "holdouts"
	>
): AlignSettings {
	return {
		corpus_version: opts.corpusVersion,
		synthesize: opts.synthesize,
		license_policy: opts.licensePolicy,
		exclude_licenses: opts.excludeLicenses.map((pattern) => pattern.source).toSorted(),
		profile: opts.profile,
		holdout_digest: sha256Hex(stringifyJSON(opts.holdouts)),
	}
}

/**
 * Where one aligned row's output goes.
 */
export interface RowAlignerSinks {
	/**
	 * One labeled JSONL line for `split`, with the row's `source_id`, or `null` when the row has none.
	 */
	labeled: (split: SplitName, line: string, sourceID: string | null) => void
	/**
	 * One quarantine JSONL line.
	 */
	quarantine: (line: string) => void
}

export interface RowAlignerOptions {
	synthesize: boolean
	holdouts: Record<string, CountryHoldout>
	licenses: LicenseVerdictCache
	ineligibility: ReturnType<typeof createIneligibilityReader>
	/**
	 * The accumulators the aligner adds each row to.
	 */
	result: AlignPhaseResult
	tally: AlignTally
	sinks: RowAlignerSinks
}

/**
 * The align phase's work on one canonical row: refusals, synthesis, alignment and the split route.
 *
 * Each row's output depends on that row alone.
 * The aligner keeps only caches and sums between rows, and a later row writes the same
 * lines whatever they hold, so a source's rows can be aligned in contiguous ranges
 * and the ranges' outputs joined in order.
 */
export function createRowAligner(opts: RowAlignerOptions): (row: CanonicalRow) => void {
	const { result, tally, sinks, licenses, ineligibility } = opts

	const quarantine = (row: CanonicalRow, reason: string): void => {
		sinks.quarantine(`${stringifyJSON({ row, reason })}\n`)
	}

	return (row) => {
		result.licenseCounts.set(row.license, (result.licenseCounts.get(row.license) ?? 0) + 1)

		// The license count is incremented before the drop, so the manifest's license set
		// reflects what the corpus contained and `excluded_by_license` what was removed.
		const verdict = licenses.read(row.license)

		if (verdict.refusal) {
			tally.excludedByLicense++
			result.refusedByKind.set(verdict.refusal, (result.refusedByKind.get(verdict.refusal) ?? 0) + 1)

			// Counted per source as well as per refusal kind, because an adapter's own `written`
			// count records what it emitted rather than what entered the corpus.
			// A source refused here contributed no row, and model provenance generated from model provenance
			// generated from `adapters[].written` only would credit it with rows it did not supply.
			result.refusedBySource.set(row.source, (result.refusedBySource.get(row.source) ?? 0) + 1)

			return
		}

		// An admitted row whose license resolves to no expression entered with
		// unknown obligations rather than with none.
		// The manifest states the count so a consumer can tell the two apart.
		if (!verdict.resolved) {
			tally.admittedUnresolved++
		}

		// Eligibility runs before augmentation: a synthetic row inherits its ancestor's `source`,
		// so refusing the ancestor here refuses everything fanned from it.
		const ineligible = ineligibility.read(row)

		if (ineligible) {
			tally.excludedByEligibility++

			quarantine(row, `source-ineligible:${ineligible.join("; ")}`)

			return
		}

		// Counted after both refusals, so the frozen manifest records what a source
		// contributed rather than what it offered.
		const contributed = result.rowsBySource.get(row.source)

		result.rowsBySource.set(row.source, { rows: (contributed?.rows ?? 0) + 1, license: row.license })

		const fanned: CanonicalRow[] = [row]

		if (opts.synthesize) {
			for (const aug of synthesizeRow(row, defaultAugmentationsForCountry(row.country))) {
				fanned.push(aug)
			}
		}

		for (const r of fanned) {
			let aligned: ReturnType<typeof alignRow>

			try {
				aligned = alignRow(r)
			} catch (error) {
				// No single row may crash a multi-hour build.
				// An unknown throw is quarantined as `align-threw`, and a rise in that reason's count is a finding.
				quarantine(r, `align-threw:${(error as Error).message.slice(0, 160)}`)

				tally.quarantined++

				continue
			}

			if (aligned.kind === "labeled") {
				const split = splitForRow(aligned.row, opts.holdouts)

				// The split phase used to parse every labeled row back for its `source_id`.
				// The same guard it applied keeps the list identical to what that parse produced.
				sinks.labeled(
					split,
					`${stringifyJSON(aligned.row)}\n`,
					typeof aligned.row.source_id === "string" ? aligned.row.source_id : null
				)

				result.counts[split]++

				tally.aligned++
			} else {
				quarantine(r, aligned.row.reason)

				tally.quarantined++
			}
		}
	}
}

/**
 * An empty set of align accumulators.
 */
export function emptyAlignResult(
	licenses: LicenseVerdictCache,
	ineligibleSources: Map<string, readonly string[]>
): AlignPhaseResult {
	return {
		aligned: 0,
		quarantined: 0,
		counts: { train: 0, val: 0, test: 0 },
		licenseCounts: new Map(),
		refusedByKind: new Map(),
		excludedByLicense: 0,
		admittedUnresolved: 0,
		excludedByEligibility: 0,
		refusedBySource: new Map(),
		rowsBySource: new Map(),
		ineligibleSources,
		sourceIDPaths: null,
		licenses,
	}
}

/**
 * Align every adapter run's rows into the four output files, writing a checkpoint at each adapter boundary.
 */
export async function runAlignPhase(opts: AlignPhaseOptions): Promise<AlignPhaseResult> {
	const ineligibility = createIneligibilityReader(opts.eligibility)
	const licenses = createLicenseVerdictCache(opts.licensePolicy, opts.excludeLicenses)

	const result = emptyAlignResult(licenses, ineligibility.refused)
	const settings = alignSettings(opts)

	const paths: Record<AlignOutputName, PathBuilder> = { ...opts.labeledPaths, quarantine: opts.quarantinePath }

	const checkpoint = opts.resume
		? await readAlignCheckpoint(opts.checkpointPath, {
				settings,
				adapterOrder: opts.adapterRuns.map((run) => run.adapter_id),
			})
		: null

	let tally: AlignTally = {
		aligned: 0,
		quarantined: 0,
		excludedByLicense: 0,
		admittedUnresolved: 0,
		excludedByEligibility: 0,
	}

	if (checkpoint) {
		await restoreOutputs(checkpoint, paths)
		tally = restoreTally(checkpoint, result)

		opts.onProgress?.(
			"align",
			`resumed align after ${checkpoint.completed_adapters.join(", ")} ` +
				`(${tally.aligned.toLocaleString()} aligned rows)`
		)
	}

	// `a` rather than the default `w` on a resume, because the files hold the rows the checkpoint counted.
	const flags = checkpoint ? "a" : "w"

	const streams: Record<AlignOutputName, WriteStream> = {
		train: openWriteStream(paths.train, { encoding: "utf8", flags }),
		val: openWriteStream(paths.val, { encoding: "utf8", flags }),
		test: openWriteStream(paths.test, { encoding: "utf8", flags }),
		quarantine: openWriteStream(paths.quarantine, { encoding: "utf8", flags }),
	}

	const offsets: Record<AlignOutputName, number> = checkpoint
		? { ...checkpoint.offsets }
		: { train: 0, val: 0, test: 0, quarantine: 0 }

	// A checkpoint without list offsets predates the lists, so the rows it counts have no ids on disk.
	const idPaths = opts.sourceIDPaths && (!checkpoint || checkpoint.source_id_offsets) ? opts.sourceIDPaths : null
	const idOffsets: Record<SplitName, number> = { train: 0, val: 0, test: 0, ...checkpoint?.source_id_offsets }

	if (idPaths && checkpoint) {
		for (const split of SPLIT_NAMES) {
			await truncateFile(idPaths[split], idOffsets[split])
		}
	}

	const idStreams: Record<SplitName, WriteStream> | null = idPaths
		? {
				train: openWriteStream(idPaths.train, { encoding: "utf8", flags }),
				val: openWriteStream(idPaths.val, { encoding: "utf8", flags }),
				test: openWriteStream(idPaths.test, { encoding: "utf8", flags }),
			}
		: null

	result.sourceIDPaths = idPaths

	const writeLine = (name: AlignOutputName, line: string): void => {
		offsets[name] += Buffer.byteLength(line, "utf8")
		streams[name].write(line)
	}

	const writeSourceID = (split: SplitName, sourceID: string): void => {
		if (!idStreams) return

		const line = `${sourceID}\n`

		idOffsets[split] += Buffer.byteLength(line, "utf8")
		idStreams[split].write(line)
	}

	const allStreams = (): WriteStream[] => [...Object.values(streams), ...(idStreams ? Object.values(idStreams) : [])]

	const alignOne = createRowAligner({
		synthesize: opts.synthesize,
		holdouts: opts.holdouts,
		licenses,
		ineligibility,
		result,
		tally,
		sinks: {
			labeled: (split, line, sourceID) => {
				writeLine(split, line)

				if (sourceID != null) {
					writeSourceID(split, sourceID)
				}
			},
			quarantine: (line) => writeLine("quarantine", line),
		},
	})

	const completed = checkpoint ? [...checkpoint.completed_adapters] : []

	for (const adapterRun of opts.adapterRuns) {
		if (completed.includes(adapterRun.adapter_id)) continue

		opts.onProgress?.("align", `aligning ${adapterRun.adapter_id}`)

		for await (const row of streamJSONL<CanonicalRow>(adapterRun.jsonl_path)) {
			alignOne(row)
		}

		// The checkpoint is written at the adapter boundary, after the bytes it counts have reached disk.
		// Mid-adapter recovery is unavailable.
		// The largest adapter takes about twenty minutes to align.
		// A row offset inside one adapter's file would still require replaying that adapter's synthesis.
		await Promise.all(allStreams().map((stream) => flushStream(stream)))

		completed.push(adapterRun.adapter_id)

		await writeAlignCheckpoint(opts.checkpointPath, {
			settings,
			completed_adapters: [...completed],
			offsets: { ...offsets },
			...(idStreams ? { source_id_offsets: { ...idOffsets } } : {}),
			counts: { ...result.counts },
			aligned: tally.aligned,
			quarantined: tally.quarantined,
			license_counts: Object.fromEntries(result.licenseCounts),
			refused_by_kind: Object.fromEntries(result.refusedByKind),
			refused_by_source: Object.fromEntries(result.refusedBySource),
			excluded_by_license: tally.excludedByLicense,
			admitted_unresolved_license_rows: tally.admittedUnresolved,
			excluded_by_eligibility: tally.excludedByEligibility,
			rows_by_source: Object.fromEntries(result.rowsBySource),
			written_at: new Date().toISOString(),
		})
	}

	for (const stream of allStreams()) {
		stream.end()
	}

	await Promise.all(allStreams().map((stream) => once(stream, "close")))

	return { ...result, ...tally }
}
