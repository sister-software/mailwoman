/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end corpus build (Phase 1 task #10 in the plan).
 *
 *   `buildCorpus(opts)` orchestrates every stage of the pipeline:
 *
 *   1. **Adapter runs** — drives every adapter in turn (via `runAdapter`), writing
 *        `<intermediate>/<adapter.id>/canonical.jsonl` files.
 *   2. **Synthesis** — optional. For each canonical row, every applicable augmentation in the row's
 *        country-default policy emits an augmented row alongside the original.
 *   3. **Alignment** — every row (original + augmented) is aligned via `alignRow`. Successes go to
 *        `labeled.jsonl`; quarantines are appended to `quarantine.jsonl` with reasons.
 *   4. **Splits** — `splitRows` partitions labeled `source_id`s into train/val/test by locality holdout.
 *        Manifest written to `splits/SPLIT_MANIFEST.json` + per-split `train.txt` / `val.txt` /
 *        `test.txt`.
 *   5. **Parquet files** — `writeParquetSplits` streams labeled rows into 1M-row `.parquet` files per split
 *        under `corpus-v<version>/{train,val,test}/part-nnnn.parquet` (snappy-compressed, 50k-row
 *        row groups), with per-file checksums + per-stage manifest in
 *        `corpus-v<version>/manifest.json`.
 *   6. **Top-level manifest** — `<outputDir>/manifest.json` ties every per-stage manifest together with
 *        a top-level corpus_version, built_at, and aggregate counts.
 *
 *   Output layout:
 *
 *   ```
 *   <outputDir>/
 *   manifest.json
 *   intermediate/
 *     <adapter.id>/canonical.jsonl   # one per adapter
 *     labeled.jsonl                  # post-alignment, pre-parquet
 *     quarantine.jsonl               # rows that failed alignment
 *   splits/
 *     SPLIT_MANIFEST.json
 *     train.txt / val.txt / test.txt
 *   corpus-v<version>/
 *     manifest.json
 *     train/part-nnnn.parquet
 *     val/part-nnnn.parquet
 *     test/part-nnnn.parquet
 * ```
 *
 *   The intermediate files live alongside the final parquet files for reproducibility + debugging. Operators
 *   can `rm -rf intermediate/` after the build if disk is tight. the final `corpus-v<version>/` is
 *   self-contained.
 */

import { delimitedSource, preferCompressed } from "@mailwoman/core/fs/delimited"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { openWriteStream, type WriteStream } from "@mailwoman/core/fs/streams"
import { writeLocalJSONFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { defaultAdapterRegistry } from "#adapters/utils"
import { $public } from "#env"
import { ROWS_PER_FILE } from "#parquet/schema"
import { DEFAULT_SHUFFLE_SEED, DEFAULT_SHUFFLE_WINDOW, shuffleWithinWindow } from "#parquet/shuffle"
import { type ParquetManifest, writeParquetSplits } from "#parquet/writers"
import { once, runAdapter, type AdapterRunManifest } from "#runner"
import { ingestEligibilityProblems, readAddressSourceRegister, type LicenseDecision } from "#source-register/index"
import { freezeTrainingManifest } from "#source-register/training-manifest"
import { defaultAugmentationsForCountry, synthesizeRow } from "#synthesizers/utils"
import type { AdapterOptions, CanonicalRow, CorpusAdapter, LabeledRow } from "#types"
import { alignRow } from "#utils/align"
import { licenseExcluded } from "#utils/license"
import {
	defaultHoldouts,
	splitForRow,
	writeSplitManifestsFromLabeledFiles,
	type SplitManifest,
	type SplitName,
} from "#utils/split"

/**
 * Stage tags surfaced to `onProgress`.
 */
export type BuildStage = "adapter-run" | "align" | "split" | "parquet" | "manifest"

/**
 * The frozen source record's filename, beside the build's own `MANIFEST.json`.
 */
export const TRAINING_MANIFEST_FILE = "TRAINING_SOURCES.json"

/**
 * Per-invocation options for `buildCorpus`.
 */
export interface BuildCorpusOptions {
	/**
	 * Root output directory.
	 *
	 * All build artifacts land beneath it.
	 */
	outputDir: PathBuilderLike

	/**
	 * Corpus version (e.g. `"0.1.0"`).
	 *
	 * Stamped onto every row + into the output dir name.
	 */
	corpusVersion: string

	/**
	 * Adapters to drive, in order.
	 *
	 * Defaults to `defaultAdapterRegistry.list()`.
	 * Pass an explicit list to filter (e.g. `[wofAdminAdapter]` for a smoke run).
	 */
	adapters?: readonly CorpusAdapter[]

	/**
	 * Per-adapter `AdapterOptions` — looked up by adapter id.
	 *
	 * Adapters whose id is missing from this map are skipped (and noted in the manifest).
	 */
	adapterInputs: Record<string, AdapterOptions>

	/**
	 * Enable synthesis pass.
	 *
	 * Default `true`.
	 * Set `false` for fixture-driven smoke tests.
	 */
	synthesize?: boolean

	/**
	 * Max rows per `.parquet` file, forwarded to `writeParquetSplits`.
	 *
	 * Default 1_000_000.
	 */
	rowsPerFile?: number

	/**
	 * Rows held in memory while shuffling each split before it is written to parquet.
	 *
	 * Rows arrive in adapter order.
	 * Adapter order is country order within a source, so an unshuffled row-group
	 * holds one to eleven of its source's countries.
	 *
	 * A bounded epoch draw reads one row-group and therefore sees only those.
	 * See `docs/engineering/reference/corpus-draw-coverage.mdx`.
	 *
	 * Default {@linkcode DEFAULT_SHUFFLE_WINDOW}.
	 * `0` or `1` writes the arrival order unchanged and consumes no random draw,
	 * which is what every corpus built before this option existed carries.
	 */
	shuffleWindow?: number

	/**
	 * Seed for {@linkcode BuildCorpusOptions.shuffleWindow}'s draw.
	 *
	 * Fixed by default so two builds of one input write the same row order.
	 */
	shuffleSeed?: number

	/**
	 * Progress hook.
	 *
	 * Errors thrown abort the build.
	 */
	onProgress?: (stage: BuildStage, message: string) => void

	/**
	 * License kinds to purposely exclude from this build (#26).
	 *
	 * Compiled patterns (see `compileLicenseExcludes` / `SHARE_ALIKE_PATTERN` in `license.ts`);
	 * a row whose `license` matches any is dropped at ingest.
	 * Default (omitted) includes everything — exclusion is a deliberate act rather than a silent default.
	 *
	 * A proprietary-weights build passes the share-alike set (`--exclude-share-alike`).
	 */
	excludeLicenses?: readonly RegExp[]
	/**
	 * What this corpus is being built for.
	 *
	 * Defaults to {@linkcode BuildProfile.Exploratory}.
	 */
	profile?: BuildProfile
}

/**
 * What a corpus build is for, which decides whether a source has to be eligible before its rows enter.
 *
 * The two differ in one place and it is the place that matters.
 * An exploratory build answers whether a source is worth having and must be
 * able to read a source nobody has reviewed.
 *
 * A release-eligible build produces rows that reach a published model, so every source
 * in it has to carry an elected grant permitting the acts ingest performs.
 *
 * Splitting them keeps the second from resting on the first's permissiveness.
 * `excludeLicenses` is unchanged and orthogonal: it drops a row whose license string matches
 * a pattern an operator named, which is a refusal rather than a positive eligibility.
 */
export const BuildProfile = {
	/**
	 * Include every row an adapter yields.
	 *
	 * What the build has always done, and the profile a measurement runs under.
	 */
	Exploratory: "exploratory",
	/**
	 * Include a row only when the register says its source is eligible for ingest.
	 *
	 * A source whose terms nobody read is refused here, which is the state all
	 * 389 register sources are in today.
	 */
	ReleaseEligible: "release-eligible",
} as const

export type BuildProfile = (typeof BuildProfile)[keyof typeof BuildProfile]

/**
 * Every register source's ingest-eligibility reasons, keyed by the adapter id its rows carry.
 *
 * Read once per build rather than per row.
 * An empty array means eligible, and that is the only value a caller may read as permission.
 *
 * A source the map does not carry is one the register never named,
 * which the caller refuses rather than admits.
 *
 * The join is on the register's `sourceID`, which is what an adapter stamps into a row's `source`.
 * A register source whose id no adapter emits contributes nothing here and is not an error:
 * the register lists sources that have been researched, and most have no adapter yet.
 */
async function readSourceEligibility(): Promise<ReadonlyMap<string, readonly string[]>> {
	const register = await readAddressSourceRegister()

	return new Map(register.sources.map((source) => [source.sourceID, ingestEligibilityProblems(source, register)]))
}

/**
 * The register's license decisions keyed by the label a row carries,
 * for freezing into the training manifest.
 *
 * Keyed on the decision's `licenseID` because that is what a register source's `license` field holds.
 * An adapter stamping its own label — `CC0-1.0`, `Public Domain` — matches no key,
 * and the frozen record says so with a `null` decision rather than inventing one.
 *
 * Read even under the exploratory profile, since the manifest records what was known
 * at build time whichever profile ran, and a build that recorded nothing would be
 * indistinguishable from one whose sources had no decisions.
 */
async function readRegisterDecisions(): Promise<ReadonlyMap<string, LicenseDecision>> {
	const register = await readAddressSourceRegister()

	return new Map(register.licenses.map((decision) => [decision.licenseID, decision]))
}

/**
 * Top-level manifest tying every stage together.
 */
export interface BuildCorpusManifest {
	corpus_version: string
	built_at: string
	adapters: AdapterRunManifest[]
	skipped_adapters: string[]
	splits: { counts: SplitManifest["counts"]; holdouts: SplitManifest["holdouts"] }
	slices: { counts: ParquetManifest["counts"]; total_rows: number }
	quarantine_count: number
	total_aligned_rows: number
	/**
	 * Resolved license set across all included rows (license string → row count), +
	 * the count dropped by `excludeLicenses` (#26).
	 *
	 * The model card derives its data-attribution table from `licenses`.
	 */
	licenses: Record<string, number>
	excluded_by_license: number
	/**
	 * The profile this build ran under, so a consumer reading the manifest can tell a
	 * corpus whose sources were checked from one whose sources were not.
	 *
	 * Absent from a manifest written before profiles existed.
	 */
	profile: BuildProfile
	/**
	 * Rows dropped because the register does not call their source eligible.
	 *
	 * Always zero under {@linkcode BuildProfile.Exploratory}, which asks nothing of the register.
	 */
	excluded_by_eligibility: number
	/**
	 * Every source refused under {@linkcode BuildProfile.ReleaseEligible}, with the reasons
	 * the register gave, so a blocked build says what to fix rather than only that it stopped.
	 */
	ineligible_sources: Record<string, readonly string[]>
	/**
	 * The `contentDigest` of the `TRAINING_SOURCES.json` written beside this manifest,
	 * which is the frozen record of which sources contributed and under which terms.
	 */
	training_manifest_digest: string
}

/**
 * Drive the full corpus build to completion.
 *
 * Memory profile: the function maintains an in-memory `Map<source_id, SplitName>`
 * to bridge the align → parquet hand-off.
 * For Phase 1 fixture-scale runs (≤ 10⁴ rows) this is trivial.
 *
 * For real 5M+ runs, the map fits comfortably in a few hundred MB.
 * The canonical.jsonl and labeled.jsonl payloads stream and never sit in memory.
 */
export async function buildCorpus(opts: BuildCorpusOptions): Promise<BuildCorpusManifest> {
	const adapters = opts.adapters ?? defaultAdapterRegistry.list()
	const synthesize = opts.synthesize ?? true
	const rowsPerFile = opts.rowsPerFile ?? ROWS_PER_FILE
	const shuffleWindow = opts.shuffleWindow ?? DEFAULT_SHUFFLE_WINDOW
	const shuffleSeed = opts.shuffleSeed ?? DEFAULT_SHUFFLE_SEED
	const built_at = new Date().toISOString()

	const outputDir = PathBuilder.from(opts.outputDir)
	await makeDirectories(outputDir)
	const intermediateDir = outputDir("intermediate")
	await makeDirectories(intermediateDir)

	// 1. Adapter runs.
	const adapterRuns: AdapterRunManifest[] = []
	const skipped: string[] = []

	for (const adapter of adapters) {
		const adapterOptions = opts.adapterInputs[adapter.id]

		if (!adapterOptions) {
			skipped.push(adapter.id)
			opts.onProgress?.("adapter-run", `skipped ${adapter.id} (no input configured)`)

			continue
		}

		// Opt-in resume (MAILWOMAN_RESUME=1): if a complete per-adapter canonical.jsonl +
		// manifest.json already exist, reuse them instead of re-emitting.
		// The manifest is written only after the canonical is fully flushed,
		// so its presence guarantees completeness.
		// Row order is identical, so downstream holdout-split determinism is preserved.
		// Recovers an align-phase crash without redoing the (expensive) emit phase.
		// Default (unset) re-emits, preserving correctness.
		// (2026-06-12.)
		const adapterDir = intermediateDir(adapter.id)
		const cachedManifest = adapterDir("MANIFEST.json")

		if (
			$public.MAILWOMAN_RESUME === "1" &&
			(await pathExists(cachedManifest)) &&
			(await pathExists(adapterDir("canonical.jsonl")))
		) {
			const cached = await readLocalJSONFile<AdapterRunManifest>(cachedManifest)
			opts.onProgress?.("adapter-run", `resumed ${adapter.id} (reused ${cached.yielded} canonical rows)`)
			adapterRuns.push(cached)

			continue
		}

		opts.onProgress?.("adapter-run", `running ${adapter.id}`)

		const m = await runAdapter({
			adapter,
			adapterOptions,
			outputDir: intermediateDir,
			corpusVersion: opts.corpusVersion,
		})

		adapterRuns.push(m)
	}

	// 2 + 3.
	// Synthesis + alignment: stream every canonical.jsonl, optionally augment, align, and route
	// each labeled row directly to its split-specific jsonl (`labeled-{train,val,test}. jsonl`).
	// Memory cost is O(1) — the prior in-memory `splitInputs` array + `splitByIDMap`
	// + `SplitManifest.{train,val,test}` arrays are gone.
	//   Per-row split is decided inline via
	// `splitForRow` (a pure function of source_id + region + holdout policy).
	const labeledPaths: Record<SplitName, PathBuilder> = {
		train: intermediateDir("labeled-train.jsonl"),
		val: intermediateDir("labeled-val.jsonl"),
		test: intermediateDir("labeled-test.jsonl"),
	}

	const labeledStreams: Record<SplitName, WriteStream> = {
		train: openWriteStream(labeledPaths.train, { encoding: "utf8" }),
		val: openWriteStream(labeledPaths.val, { encoding: "utf8" }),
		test: openWriteStream(labeledPaths.test, { encoding: "utf8" }),
	}

	const quarantinePath = intermediateDir("quarantine.jsonl")
	const quarantineStream = openWriteStream(quarantinePath, { encoding: "utf8" })

	let aligned = 0
	let quarantined = 0
	const counts: Record<SplitName, number> = { train: 0, val: 0, test: 0 }
	const holdouts = defaultHoldouts()
	// License accounting + the deliberate exclusion filter (#26).
	// `licenseCounts` is the resolved license set (→ manifest + model-card attribution);
	// `excludeLicenses` (empty by default → include everything) is the operator's
	// purposeful exclusion, never a silent drop.
	const excludeLicenses = opts.excludeLicenses ?? []
	const licenseCounts = new Map<string, number>()
	let excludedByLicense = 0

	const profile = opts.profile ?? BuildProfile.Exploratory
	const eligibility = profile === BuildProfile.ReleaseEligible ? await readSourceEligibility() : null
	const rowsBySource = new Map<string, { rows: number; license: string }>()
	const registerDecisions = await readRegisterDecisions()
	const ineligibleSources = new Map<string, readonly string[]>()
	let excludedByEligibility = 0

	/**
	 * Why a row's source may not enter a release-eligible corpus, or `null` when it may.
	 *
	 * Keyed on the adapter id the row carries.
	 * A source the register does not name at all is refused rather than admitted: the register is
	 * the record of what has been reviewed, and a name absent from it is a source nobody reviewed.
	 */
	const ineligibleBecause = (row: CanonicalRow): readonly string[] | null => {
		if (!eligibility) return null

		const cached = ineligibleSources.get(row.source)

		if (cached) return cached

		const problems = eligibility.get(row.source) ?? [
			`the register names no source ${stringifyJSON(row.source)}, so nothing has been reviewed for it`,
		]

		if (!problems.length) return null

		ineligibleSources.set(row.source, problems)

		return problems
	}

	const writeQuarantine = (row: CanonicalRow, reason: string): void => {
		quarantineStream.write(`${stringifyJSON({ row, reason })}\n`)
	}

	for (const adapterRun of adapterRuns) {
		opts.onProgress?.("align", `aligning ${adapterRun.adapter_id}`)

		for await (const row of streamJSONL<CanonicalRow>(adapterRun.jsonl_path)) {
			licenseCounts.set(row.license, (licenseCounts.get(row.license) ?? 0) + 1)

			// Deliberate license exclusion (#26): drop a row only when the operator
			// named its license kind via `excludeLicenses`.
			// Default (no patterns) keeps everything — exclusion is a purposeful act
			// rather than a silent default.
			// Counted before the drop so the manifest's license set reflects what the corpus
			// actually contained, and `excluded_by_license` what was removed.
			if (licenseExcluded(row.license, excludeLicenses)) {
				excludedByLicense++

				continue
			}

			// Positive eligibility, and it runs before augmentation on purpose.
			// A synthetic row carries its ancestor's `source`, so refusing the ancestor
			// here refuses every row fanned from it.
			// Checking after the fan-out would let an ineligible source re-enter as
			// the base of a synthesized row.
			const ineligible = ineligibleBecause(row)

			if (ineligible) {
				excludedByEligibility++

				writeQuarantine(row, `source-ineligible:${ineligible.join("; ")}`)

				continue
			}

			// Counted after both refusals, so the frozen manifest records what a source
			// contributed rather than what it offered.
			// A source dropped entirely appears under `refused` with its reasons instead.
			const contributed = rowsBySource.get(row.source)

			rowsBySource.set(row.source, { rows: (contributed?.rows ?? 0) + 1, license: row.license })

			const fanned: CanonicalRow[] = [row]

			if (synthesize) {
				for (const aug of synthesizeRow(row, defaultAugmentationsForCountry(row.country))) {
					fanned.push(aug)
				}
			}

			for (const r of fanned) {
				let result: ReturnType<typeof alignRow>

				try {
					result = alignRow(r)
				} catch (error) {
					// Last-resort robustness (2026-06-12): no single row may crash a multi-hour build.
					// alignRow's targeted paths normalize/quarantine known issues with specific reasons.
					// This catches any unknown throw (e.g. assertSpanInvariants on an unforeseen span shape)
					// → quarantine + continue.
					// A spike in `align-threw` reasons is a finding.
					writeQuarantine(r, `align-threw:${(error as Error).message.slice(0, 160)}`)

					quarantined++

					continue
				}

				if (result.kind === "labeled") {
					const split = splitForRow(result.row, holdouts)
					labeledStreams[split].write(`${stringifyJSON(result.row)}\n`)

					counts[split]++

					aligned++
				} else {
					writeQuarantine(r, result.row.reason)

					quarantined++
				}
			}
		}
	}

	for (const s of Object.values(labeledStreams)) {
		s.end()
	}

	quarantineStream.end()
	await Promise.all([...Object.values(labeledStreams).map((s) => once(s, "close")), once(quarantineStream, "close")])

	// 4. Splits — manifest derived by streaming the per-split labeled files.
	//    No in-memory
	// source-id arrays.
	// `sort(1)` from coreutils produces the deterministic per-split .txt manifests
	// with disk spill for splits that exceed in-memory thresholds.
	opts.onProgress?.("split", `splitting ${aligned} aligned rows`)
	const splitsDir = outputDir("splits")

	const splitCounts = await writeSplitManifestsFromLabeledFiles({
		labeledPaths,
		outputDir: splitsDir,
		corpusVersion: opts.corpusVersion,
		counts,
		holdouts,
	})

	// 5. Parquet files — per-split labeled jsonl streams in, `.parquet` files out.
	//    The prior
	// `splitFor(source_id)` callback (and the `Map<source_id, SplitName>` behind it) is gone.
	opts.onProgress?.("parquet", "writing parquet files")

	// Each split gets its own generator seeded from one base, so a split's row order does
	// not depend on how many rows the splits before it happened to carry.
	const shuffled = (path: PathBuilderLike, salt: number) =>
		shuffleWithinWindow(streamJSONL<LabeledRow>(path), makeMulberry32(shuffleSeed + salt), shuffleWindow)

	opts.onProgress?.(
		"parquet",
		shuffleWindow > 1
			? `shuffling each split within a ${shuffleWindow.toLocaleString("en-US")}-row window, seed ${shuffleSeed}`
			: "writing rows in arrival order (shuffle window disabled)"
	)

	const parquetManifest = await writeParquetSplits(
		{
			train: shuffled(labeledPaths.train, 0),
			val: shuffled(labeledPaths.val, 1),
			test: shuffled(labeledPaths.test, 2),
		},
		{
			outputDir,
			corpusVersion: opts.corpusVersion,
			rowsPerFile,
		}
	)

	// License-set visibility (#26): loudly report the resolved license set so a build is an obvious
	// deliberate act — especially a proprietary-weights build (did you pass --exclude-share-alike?).
	const licenseSummary = [...licenseCounts.entries()].toSorted((a, b) => b[1] - a[1])

	opts.onProgress?.(
		"manifest",
		`license set: ${licenseSummary.map(([l, c]) => `${l}=${c}`).join(", ")}` +
			(excludedByLicense > 0
				? ` | EXCLUDED ${excludedByLicense} rows by --exclude-licenses`
				: " | NO license exclusion applied (all rows kept)")
	)

	// 6. Top-level manifest, and the frozen source record beside it.
	opts.onProgress?.("manifest", "writing top-level MANIFEST.json")

	// Frozen from what this build observed rather than re-derived from the register later.
	// The register moves as somebody reviews terms, and a record re-derived tomorrow
	// would describe a build that never happened.
	const trainingManifest = freezeTrainingManifest({
		corpusVersion: opts.corpusVersion,
		builtAt: built_at,
		profile,
		rowsBySource,
		decisionsByLicense: registerDecisions,
		refused: ineligibleSources,
	})

	await writeLocalJSONFile(trainingManifest, outputDir(TRAINING_MANIFEST_FILE))

	const manifest: BuildCorpusManifest = {
		corpus_version: opts.corpusVersion,
		built_at,
		adapters: adapterRuns,
		skipped_adapters: skipped,
		splits: { counts: splitCounts, holdouts },
		slices: { counts: parquetManifest.counts, total_rows: parquetManifest.total_rows },
		quarantine_count: quarantined,
		total_aligned_rows: aligned,
		licenses: Object.fromEntries(licenseSummary),
		excluded_by_license: excludedByLicense,
		profile,
		excluded_by_eligibility: excludedByEligibility,
		ineligible_sources: Object.fromEntries(ineligibleSources),
		/**
		 * The digest of the frozen source record written beside this manifest.
		 *
		 * A consumer quotes it to say which build's sources it is talking about.
		 */
		training_manifest_digest: trainingManifest.contentDigest,
	}

	await writeLocalJSONFile(manifest, outputDir("MANIFEST.json"))

	return manifest
}

async function* streamJSONL<T>(path: PathBuilderLike): AsyncIterable<T> {
	// JSONSpliterator yields already-parsed rows (skipEmpty is on by default, so blank
	// lines are dropped at the row level) and throws SyntaxError on a malformed row.
	// Same fail-loud behavior as the prior readline + bare `JSON.parse`.
	//
	// Callers name the plain `.jsonl`.
	// `preferCompressed` answers with the `.zst` sibling when that is what is on disk,
	// and `delimitedSource` then reads it through a decompressing pipe — so a corpus converted in place
	// reads exactly like one that was not, and a half-converted one reads correctly either way.
	// Both are called inline, because each yields a source that may only be consumed once.
	yield* JSONSpliterator.fromAsync<T>(delimitedSource(await preferCompressed(path)))
}
