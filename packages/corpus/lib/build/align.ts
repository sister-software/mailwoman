// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The align phase reads each adapter's canonical rows and applies license and register refusals.
 *   It expands synthesis and aligns each row. It then routes the result to a split or quarantine.
 *
 *   The phase appends to four files. It writes a checkpoint at each adapter boundary, allowing an interrupted
 *   build to resume at the next adapter without aligning earlier adapters again.
 */

import { sha256Hex } from "@mailwoman/core/crypto/hash"
import { openWriteStream, type WriteStream } from "@mailwoman/core/fs/streams"
import { truncateFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/values/json"
import {
	createLicenseVerdictCache,
	type LicensePolicy,
	type LicenseRefusalKind,
	type LicenseVerdictCache,
} from "@mailwoman/license/policy"
import type { PathBuilder } from "path-ts"

import { recordIDOf } from "#adapters/record-id"
import { createUnitSplitter, type UnitSplitter } from "#adapters/street/unit"
import {
	ALIGN_OUTPUTS,
	readAlignCheckpoint,
	writeAlignCheckpoint,
	type AlignCheckpoint,
	type AlignOutputName,
	type AlignSettings,
} from "#build/checkpoint"
import {
	componentFindings,
	createComponentCheckMemo,
	componentFindingsRecord,
	ComponentRule,
	ENFORCED_COMPONENT_RULES,
	regionValueKey,
	type ComponentFindingCounts,
} from "#build/component-check"
import { createIneligibilityReader } from "#build/eligibility"
import { tryReadDefaultRegionNames, type RegionNames } from "#build/region-names"
import { streamJSONL } from "#build/rows"
import type { BuildProfile, BuildStage } from "#build/types"
import { flushStream, once, type AdapterRunManifest } from "#runner"
import { defaultAugmentationsForCountry, synthesizeRow } from "#synthesizers/utils"
import type { AdapterOptions, CanonicalRow, LabeledRow } from "#types"
import { alignRow, nfcComponents } from "#utils/align"
import type { SplitRetention } from "#utils/retention"
import {
	hashBucket,
	holdoutReadsOnlyPostcode,
	SPLIT_NAMES,
	splitForRow,
	type CountryHoldout,
	type SplitName,
} from "#utils/split"

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
	 * Each capped source's `trainShare`, from {@linkcode trainSharesOf}.
	 */
	trainShares?: Readonly<Record<string, number>>

	/**
	 * The retention table applied to every aligned row, when one was registered
	 * (HOLDOUT_AND_EVALUATION section 5.1).
	 */
	retention?: SplitRetention

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
	 * That's the distinction between a source present in corpus provenance
	 * and one present in model provenance.
	 */
	refusedBySource: Map<string, number>
	/**
	 * Training draws each source's `trainShare` left out: a row it dropped,
	 * or an augmentation it kept from running.
	 *
	 * A skipped augmentation would have written one row or none.
	 * Validation and test rows are never left out.
	 */
	trainRowsLeftOutBySource: Map<string, number>
	excludedByLicense: number
	admittedUnresolved: number
	excludedByEligibility: number
	rowsBySource: Map<string, { rows: number; license: string }>
	ineligibleSources: Map<string, readonly string[]>
	/**
	 * Base rows failing each component rule, per `source` then rule (#2898).
	 *
	 * Every rule is counted, whether the build quarantines a row for it
	 * (`ENFORCED_COMPONENT_RULES`) or only reports it.
	 */
	componentFindingsBySource: ComponentFindingCounts
	/**
	 * The component rules this phase couldn't check, because the data they read wasn't on the host.
	 *
	 * Their counts in {@linkcode AlignPhaseResult.componentFindingsBySource} are absent rather than zero.
	 */
	uncheckedComponentRules: Set<ComponentRule>
	/**
	 * The base rows that reached the component check with a region, per {@linkcode regionValueKey}.
	 *
	 * A build that reuses a source under other region data recounts `region:unknown` from these.
	 * The serial build's checkpoint doesn't record them, because only a parallel
	 * build's source records are reused.
	 */
	regionValues: Map<string, number>

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

	for (const [source, count] of Object.entries(checkpoint.train_rows_left_out_by_source ?? {})) {
		result.trainRowsLeftOutBySource.set(source, count)
	}

	for (const [source, count] of Object.entries(checkpoint.refused_by_source)) {
		result.refusedBySource.set(source, count)
	}

	for (const [source, contributed] of Object.entries(checkpoint.rows_by_source)) {
		result.rowsBySource.set(source, contributed)
	}

	// A checkpoint from before the per-source component counts would leave them short by every aligned adapter.
	if (!checkpoint.component_findings_by_source) {
		throw new Error(
			`resume refused: the align checkpoint after ${checkpoint.completed_adapters.join(", ")} records no ` +
				`component_findings_by_source, so the manifest's per-source component counts would miss those adapters. ` +
				`Rebuild with --fresh.`
		)
	}

	for (const [source, rules] of Object.entries(checkpoint.component_findings_by_source)) {
		result.componentFindingsBySource.set(source, new Map(Object.entries(rules) as [ComponentRule, number][]))
	}

	// A checkpoint that records no list was written before `region:unknown` existed, so its rows went unchecked.
	for (const rule of checkpoint.unchecked_component_rules ?? [ComponentRule.RegionUnknown]) {
		result.uncheckedComponentRules.add(rule as ComponentRule)
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
 *
 * `train_shares` is present only when a source is capped, so a build without
 * one writes the settings it always has.
 */
export function alignSettings(
	opts: Pick<
		AlignPhaseOptions,
		"corpusVersion" | "synthesize" | "licensePolicy" | "excludeLicenses" | "profile" | "holdouts" | "trainShares"
	>
): AlignSettings {
	const shares = Object.entries(opts.trainShares ?? {}).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

	return {
		corpus_version: opts.corpusVersion,
		synthesize: opts.synthesize,
		license_policy: opts.licensePolicy,
		exclude_licenses: opts.excludeLicenses.map((pattern) => pattern.source).toSorted(),
		profile: opts.profile,
		holdout_digest: sha256Hex(stringifyJSON(opts.holdouts)),
		...(shares.length ? { train_shares: Object.fromEntries(shares) } : {}),
	}
}

/**
 * The salt that separates the `trainShare` draw from the hash that sends a
 * held-out record to validation or test.
 */
const TRAIN_SHARE_SALT = "train-share"

/**
 * Hash buckets the `trainShare` draw resolves a share to: one per million.
 */
const TRAIN_SHARE_BUCKETS = 1_000_000

/**
 * One training record in 1,024 runs every augmentation, so the assertion that its
 * variants train checks the rows a draw before synthesis never makes.
 */
const AUDITED_DRAW_RECORDS = 1024

/**
 * The salt of the draw that picks the audited records, apart from the share's own draw.
 */
const DRAW_AUDIT_SALT = "train-share-audit"

/**
 * Whether a training row whose source keeps `share` of its training rows is kept.
 *
 * The draw reads `recordIDOf(sourceID)`, which keeps the id up to its last `#`.
 * A source whose ids hold no `#`, as NAD's don't, draws once per row: a variant synthesized
 * from a record draws apart from its base row, so a kept record contributes some of its forms.
 *
 * Under a share of 0.11, 57% of NAD's training records keep at least one row.
 */
export function keepsTrainRow(sourceID: string, share: number): boolean {
	if (share >= 1) return true

	return hashBucket(`${TRAIN_SHARE_SALT}|${recordIDOf(sourceID)}`, TRAIN_SHARE_BUCKETS) < share * TRAIN_SHARE_BUCKETS
}

/**
 * Each configured source's `trainShare`, for the align phase.
 */
export function trainSharesOf(adapterInputs: Readonly<Record<string, AdapterOptions>>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(adapterInputs).flatMap(([source, options]) =>
			typeof options.trainShare === "number" ? [[source, options.trainShare]] : []
		)
	)
}

/**
 * One labeled row as a line of a labeled JSONL file.
 */
export function labeledLine(row: LabeledRow): string {
	return `${stringifyJSON(row)}\n`
}

/**
 * The `source_id` a labeled row contributes to its split's id list, or `null` when it has none.
 *
 * The split phase once parsed every labeled row back for its `source_id`.
 * The same guard it applied keeps the list identical to what that parse produced.
 */
export function labeledSourceID(row: LabeledRow): string | null {
	return typeof row.source_id === "string" ? row.source_id : null
}

/**
 * Where one aligned row's output goes.
 */
export interface RowAlignerSinks {
	/**
	 * One labeled row for `split`.
	 *
	 * A sink that writes labeled JSONL calls {@linkcode labeledLine} and {@linkcode labeledSourceID}.
	 * A parallel build's align range stages the row for its parquet part instead.
	 */
	labeled: (split: SplitName, row: LabeledRow) => void
	/**
	 * One quarantine JSONL line.
	 */
	quarantine: (line: string) => void
}

export interface RowAlignerOptions {
	synthesize: boolean
	holdouts: Record<string, CountryHoldout>
	/**
	 * The retention table applied to every aligned row, when one was registered
	 * (HOLDOUT_AND_EVALUATION section 5.1).
	 */
	retention?: SplitRetention
	/**
	 * Each capped source's `trainShare` (`AdapterOptions.trainShare`).
	 */
	trainShares?: Readonly<Record<string, number>>
	licenses: LicenseVerdictCache
	ineligibility: ReturnType<typeof createIneligibilityReader>
	/**
	 * The unit vocabulary the component check's `street:trailing-unit` rule reads, from `createUnitSplitter`.
	 */
	units: UnitSplitter
	/**
	 * The region forms the `region:unknown` rule reads, or `null` when the WOF database isn't on the host.
	 *
	 * A `null` records the rule in `result.uncheckedComponentRules`.
	 */
	regions: RegionNames | null
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
 * Each row's output depends only on that row's data.
 * The aligner keeps caches and sums between rows.
 *
 * Every later row writes the same lines regardless of those values.
 * A source's rows can therefore be aligned in contiguous ranges and the range outputs joined in order.
 */
export function createRowAligner(opts: RowAlignerOptions): (row: CanonicalRow) => void {
	const { result, tally, sinks, licenses, ineligibility } = opts
	const context = { units: opts.units, regions: opts.regions, memo: createComponentCheckMemo() }

	if (!opts.regions) {
		result.uncheckedComponentRules.add(ComponentRule.RegionUnknown)
	}

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
			// generated from `adapters[].written` only would credit it with rows it didn't supply.
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

		// The value `region:unknown` reads, counted under the condition the rule checks it.
		const region = row.components.region

		if (region) {
			const key = regionValueKey(row.country, region)

			result.regionValues.set(key, (result.regionValues.get(key) ?? 0) + 1)
		}

		// A row whose values fail its country's rules or contradict each other (#2898) is
		// quarantined before augmentation, so no variant inherits the wrong value.
		const findings = componentFindings(row.components, row.country, context)

		if (findings.length) {
			const bySource = result.componentFindingsBySource.get(row.source) ?? new Map<ComponentRule, number>()

			result.componentFindingsBySource.set(row.source, bySource)

			for (const finding of findings) {
				bySource.set(finding.rule, (bySource.get(finding.rule) ?? 0) + 1)
			}
		}

		const invalid = findings.filter((finding) => ENFORCED_COMPONENT_RULES.has(finding.rule))

		if (invalid.length) {
			quarantine(row, invalid.map((finding) => `component-invalid:${finding.rule}`).join("; "))

			tally.quarantined++

			return
		}

		// Counted after both refusals, so the frozen manifest records what a source
		// contributed rather than what it offered.
		const contributed = result.rowsBySource.get(row.source)

		result.rowsBySource.set(row.source, { rows: (contributed?.rows ?? 0) + 1, license: row.license })

		const leaveOut = (source: string): void => {
			result.trainRowsLeftOutBySource.set(source, (result.trainRowsLeftOutBySource.get(source) ?? 0) + 1)
		}

		const baseShare = opts.trainShares?.[row.source]

		// A training base row in a country whose holdout reads only postcodes has variants that
		// all train (`holdoutReadsOnlyPostcode`), so each variant's share is drawn from its id
		// before the augmentation runs, and an augmentation the share leaves out is never run.
		// One record in AUDITED_DRAW_RECORDS runs every augmentation, so the assertion
		// below checks the premise on rows the shortcut never makes.
		const variantsTrain =
			typeof baseShare === "number" &&
			!opts.retention &&
			holdoutReadsOnlyPostcode(opts.holdouts[row.country]) &&
			splitForRow({ ...row, components: nfcComponents(row.components) }, opts.holdouts) === "train"

		const drawsFirst = variantsTrain && hashBucket(`${DRAW_AUDIT_SALT}|${row.source_id}`, AUDITED_DRAW_RECORDS) !== 0

		const wants = drawsFirst
			? (method: string): boolean => {
					const kept = keepsTrainRow(`${row.source_id}+${method}`, baseShare)

					if (!kept) {
						leaveOut(row.source)
					}

					return kept
				}
			: undefined

		const fanned: CanonicalRow[] = [row]

		if (opts.synthesize) {
			for (const aug of synthesizeRow(row, defaultAugmentationsForCountry(row.country), wants)) {
				// The draw above read `${source_id}+${method}`, so a variant written under another id drew for the wrong row.
				if (drawsFirst && aug.source_id !== `${row.source_id}+${aug.augmentation?.name}`) {
					throw new Error(
						`createRowAligner: variant ${aug.source_id} of ${row.source_id} doesn't carry its method's id, ` +
							`so its training share was drawn for another id`
					)
				}

				fanned.push(aug)
			}
		}

		for (const r of fanned) {
			const share = opts.trainShares?.[r.source]

			// A capped source decides each row's split before aligning it, so a training
			// row the share leaves out is never aligned.
			// `alignRow` changes only the text's normal form.
			// The split reads the components in that form, so the decision equals the one made after alignment.
			// Retention reads the aligned row's span tags, so a build with a retention
			// table decides after alignment.
			const early =
				typeof share === "number" && !opts.retention
					? splitForRow({ ...r, components: nfcComponents(r.components) }, opts.holdouts)
					: null

			if (variantsTrain && early !== "train") {
				throw new Error(
					`createRowAligner: variant ${r.source_id} of a training row splits ${String(early)} under a holdout that ` +
						`reads only postcodes, so drawing its share before synthesis would have dropped a held-out row`
				)
			}

			if (early === "train" && !keepsTrainRow(r.source_id, share!)) {
				leaveOut(r.source)

				continue
			}

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
				const split = early ?? splitForRow(aligned.row, opts.holdouts, undefined, opts.retention)

				if (
					early === null &&
					split === "train" &&
					typeof share === "number" &&
					!keepsTrainRow(aligned.row.source_id, share)
				) {
					leaveOut(aligned.row.source)

					continue
				}

				sinks.labeled(split, aligned.row)

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
		trainRowsLeftOutBySource: new Map(),
		rowsBySource: new Map(),
		ineligibleSources,
		componentFindingsBySource: new Map(),
		uncheckedComponentRules: new Set(),
		regionValues: new Map(),
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
		retention: opts.retention,
		trainShares: opts.trainShares,
		licenses,
		ineligibility,
		units: await createUnitSplitter(),
		regions: await tryReadDefaultRegionNames(),
		result,
		tally,
		sinks: {
			labeled: (split, row) => {
				writeLine(split, labeledLine(row))

				const sourceID = labeledSourceID(row)

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
			train_rows_left_out_by_source: Object.fromEntries(result.trainRowsLeftOutBySource),
			excluded_by_license: tally.excludedByLicense,
			admitted_unresolved_license_rows: tally.admittedUnresolved,
			excluded_by_eligibility: tally.excludedByEligibility,
			rows_by_source: Object.fromEntries(result.rowsBySource),
			component_findings_by_source: componentFindingsRecord(result.componentFindingsBySource),
			unchecked_component_rules: [...result.uncheckedComponentRules],
			written_at: new Date().toISOString(),
		})
	}

	for (const stream of allStreams()) {
		stream.end()
	}

	await Promise.all(allStreams().map((stream) => once(stream, "close")))

	return { ...result, ...tally }
}
