/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
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
import {
	createLicenseVerdictCache,
	LicensePolicy,
	type LicenseRefusalKind,
	type LicenseVerdictCache,
} from "#utils/license"
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
	 * Every build artifact lands beneath it.
	 */
	outputDir: PathBuilderLike

	/**
	 * Corpus version (e.g. `"0.1.0"`), stamped onto every row and into the output directory name.
	 */
	corpusVersion: string

	/**
	 * Adapters to drive, in order.
	 *
	 * The default is `defaultAdapterRegistry.list()`, and an explicit list filters the run.
	 */
	adapters?: readonly CorpusAdapter[]

	/**
	 * Per-adapter `AdapterOptions` looked up by adapter id.
	 *
	 * An adapter whose id is missing is skipped and recorded in the manifest.
	 */
	adapterInputs: Record<string, AdapterOptions>

	/**
	 * Enable the synthesis pass.
	 *
	 * The default is `true`, and a fixture-driven smoke test passes `false`.
	 */
	synthesize?: boolean

	/**
	 * Max rows per `.parquet` file, forwarded to `writeParquetSplits`.
	 * The default is 1_000_000.
	 */
	rowsPerFile?: number

	/**
	 * Rows held in memory while shuffling each split before it is written to parquet.
	 *
	 * Rows arrive in adapter order, and within one source that order is by country.
	 * An unshuffled row-group therefore holds one to eleven of its source's countries,
	 * and a bounded epoch draw reads only those.
	 *
	 * The default is {@linkcode DEFAULT_SHUFFLE_WINDOW}, where `0` or `1` writes
	 * arrival order unchanged and consumes no random draw.
	 */
	shuffleWindow?: number

	/**
	 * Seed for {@linkcode BuildCorpusOptions.shuffleWindow}'s draw.
	 *
	 * It is fixed by default, so two builds of one input write the same row order.
	 */
	shuffleSeed?: number

	/**
	 * Reports each build stage.
	 * An error thrown from it aborts the build.
	 */
	onProgress?: (stage: BuildStage, message: string) => void

	/**
	 * License prefixes the operator named in `--exclude-licenses`.
	 *
	 * A row whose `license` starts with one is dropped at ingest.
	 * The default excludes no prefix.
	 */
	excludeLicenses?: readonly RegExp[]
	/**
	 * Which rows this build admits on the evidence of their license obligations.
	 *
	 * Defaults to {@linkcode LicensePolicy.All}, which admits every row an adapter yields.
	 *
	 * A weights build that must carry no share-alike obligation
	 * passes {@linkcode LicensePolicy.ShareAlikeFree}.
	 */
	licensePolicy?: LicensePolicy
	/**
	 * What this corpus is being built for.
	 * The default is {@linkcode BuildProfile.Exploratory}.
	 */
	profile?: BuildProfile
}

/**
 * What a corpus build is for, which decides whether a source has to be eligible before its
 * rows enter; `excludeLicenses` is orthogonal, a refusal rather than positive eligibility.
 */
export const BuildProfile = {
	/**
	 * Include every row an adapter yields.
	 * A measurement runs under this profile.
	 */
	Exploratory: "exploratory",
	/**
	 * Include a row only when the register says its source is eligible for ingest.
	 * A source whose terms remain unread is refused here.
	 */
	ReleaseEligible: "release-eligible",
} as const

export type BuildProfile = (typeof BuildProfile)[keyof typeof BuildProfile]

/**
 * Every register source's ingest-eligibility reasons keyed by the adapter id its
 * rows carry, where an empty array is the only value a caller may read as permission
 * and an absent source is refused rather than admitted.
 */
async function readSourceEligibility(): Promise<ReadonlyMap<string, readonly string[]>> {
	const register = await readAddressSourceRegister()

	return new Map(register.sources.map((source) => [source.sourceID, ingestEligibilityProblems(source, register)]))
}

/**
 * The register's license decisions keyed by the label a row carries, where an unmatched
 * adapter label records a `null` decision rather than inventing one.
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
	 * Resolved license set across all included rows (license string → row count);
	 * the model card derives its data-attribution table from it.
	 */
	licenses: Record<string, number>
	excluded_by_license: number
	/**
	 * The policy this build admitted rows under, so a consumer can tell a corpus that
	 * was never filtered from one filtered and found clean.
	 */
	license_policy: LicensePolicy
	/**
	 * Rows refused per {@linkcode LicenseRefusalKind}, summing to `excluded_by_license`.
	 *
	 * The classes rest on different evidence and a reader deciding what to do needs them apart.
	 */
	refused_by_license_kind: Record<string, number>
	/**
	 * Every distinct license value this build refused, with the class it was refused under.
	 *
	 * A build that dropped rows records the values it dropped them for rather than only the count.
	 */
	refused_license_values: Record<string, LicenseRefusalKind>
	/**
	 * Admitted rows whose license resolves to no SPDX expression, whose obligations
	 * are therefore unknown rather than known to be empty.
	 *
	 * Under {@linkcode LicensePolicy.ResolvedOnly} this reads zero because those rows are refused instead.
	 */
	admitted_unresolved_license_rows: number
	/**
	 * The profile this build ran under, so a consumer can tell whether the corpus's sources were checked.
	 */
	profile: BuildProfile
	/**
	 * Rows dropped because the register does not call their source eligible.
	 *
	 * This reads zero under {@linkcode BuildProfile.Exploratory}, which applies no eligibility check.
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

	const adapterRuns: AdapterRunManifest[] = []
	const skipped: string[] = []

	for (const adapter of adapters) {
		const adapterOptions = opts.adapterInputs[adapter.id]

		if (!adapterOptions) {
			skipped.push(adapter.id)
			opts.onProgress?.("adapter-run", `skipped ${adapter.id} (no input configured)`)

			continue
		}

		// The manifest is written only after the canonical file is fully flushed,
		// so its presence guarantees completeness and preserves downstream split determinism.
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
	const licensePolicy = opts.licensePolicy ?? LicensePolicy.All
	const licenses: LicenseVerdictCache = createLicenseVerdictCache(licensePolicy, opts.excludeLicenses ?? [])
	const licenseCounts = new Map<string, number>()
	const refusedByKind = new Map<LicenseRefusalKind, number>()
	let excludedByLicense = 0
	let admittedUnresolved = 0

	const profile = opts.profile ?? BuildProfile.Exploratory
	const eligibility = profile === BuildProfile.ReleaseEligible ? await readSourceEligibility() : null
	const rowsBySource = new Map<string, { rows: number; license: string }>()
	const registerDecisions = await readRegisterDecisions()
	const ineligibleSources = new Map<string, readonly string[]>()
	let excludedByEligibility = 0

	/**
	 * Why a row's source may not enter a release-eligible corpus, or `null` when it may.
	 *
	 * A source the register does not record is refused rather than admitted.
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

			// The license count is incremented before the drop, so the manifest's license set
			// reflects what the corpus contained and `excluded_by_license` what was removed.
			const verdict = licenses.read(row.license)

			if (verdict.refusal) {
				excludedByLicense++
				refusedByKind.set(verdict.refusal, (refusedByKind.get(verdict.refusal) ?? 0) + 1)

				continue
			}

			// An admitted row whose license resolves to no expression entered with
			// unknown obligations rather than with none.
			// The manifest states the count so a consumer can tell the two apart.
			if (!verdict.resolved) {
				admittedUnresolved++
			}

			// Eligibility runs before augmentation: a synthetic row carries its ancestor's `source`,
			// so refusing the ancestor here refuses everything fanned from it.
			const ineligible = ineligibleBecause(row)

			if (ineligible) {
				excludedByEligibility++

				writeQuarantine(row, `source-ineligible:${ineligible.join("; ")}`)

				continue
			}

			// Counted after both refusals, so the frozen manifest records what a source
			// contributed rather than what it offered.
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
					// No single row may crash a multi-hour build.
					// An unknown throw is quarantined as `align-threw`, and a rise in
					// that reason's count is a finding.
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

	opts.onProgress?.("split", `splitting ${aligned} aligned rows`)
	const splitsDir = outputDir("splits")

	const splitCounts = await writeSplitManifestsFromLabeledFiles({
		labeledPaths,
		outputDir: splitsDir,
		corpusVersion: opts.corpusVersion,
		counts,
		holdouts,
	})

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

	const licenseSummary = [...licenseCounts.entries()].toSorted((a, b) => b[1] - a[1])

	const refusedValues = licenses.refusedValues()
	const refusalTally = [...refusedByKind.entries()].map(([kind, rows]) => `${kind}=${rows}`).join(", ")

	opts.onProgress?.(
		"manifest",
		`license set: ${licenseSummary.map(([l, c]) => `${l}=${c}`).join(", ")}` +
			` | policy ${licensePolicy}` +
			(excludedByLicense > 0
				? ` | refused ${excludedByLicense} rows over ${refusedValues.size} values (${refusalTally})`
				: ` | refused 0 rows`) +
			` | admitted ${admittedUnresolved} rows whose license resolves to no expression`
	)

	opts.onProgress?.("manifest", "writing top-level MANIFEST.json")

	// Frozen from what this build observed rather than re-derived later, because the register moves
	// as terms are reviewed and a re-derived record would describe a build that never happened.
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
		license_policy: licensePolicy,
		refused_by_license_kind: Object.fromEntries(refusedByKind),
		refused_license_values: Object.fromEntries(refusedValues),
		admitted_unresolved_license_rows: admittedUnresolved,
		profile,
		excluded_by_eligibility: excludedByEligibility,
		ineligible_sources: Object.fromEntries(ineligibleSources),
		training_manifest_digest: trainingManifest.contentDigest,
	}

	await writeLocalJSONFile(manifest, outputDir("MANIFEST.json"))

	return manifest
}

async function* streamJSONL<T>(path: PathBuilderLike): AsyncIterable<T> {
	// `JSONSpliterator` yields parsed rows and throws `SyntaxError` on a malformed row;
	// `preferCompressed` and `delimitedSource` are called inline because each yields
	// a source that may only be consumed once.
	yield* JSONSpliterator.fromAsync<T>(delimitedSource(await preferCompressed(path)))
}
