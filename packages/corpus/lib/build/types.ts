/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What a corpus build is asked for and what it records: the options `buildCorpus` takes, the profile
 *   that decides whether a source must be eligible, and the top-level manifest tying every stage together.
 *
 *   These sit apart from `buildCorpus` because every phase module reads them and the orchestrator imports
 *   each phase. Holding them beside the orchestrator would make the phases import it back.
 */

import type { PathBuilderLike } from "path-ts"

import type { ParquetManifest } from "#parquet/writers"
import type { AdapterRunManifest } from "#runner"
import type { AdapterOptions, CorpusAdapter } from "#types"
import type { LicensePolicy, LicenseRefusalKind } from "#utils/license"
import type { SplitManifest } from "#utils/split"

/**
 * Stage tags surfaced to `onProgress`.
 */
export type BuildStage = "adapter-run" | "align" | "split" | "parquet" | "manifest"

/**
 * The frozen source record's filename, beside the build's own `MANIFEST.json`.
 */
export const TRAINING_MANIFEST_FILE = "TRAINING_SOURCES.json"

/**
 * What a corpus build is for, and therefore whether a source has to be eligible before its rows enter.
 *
 * `excludeLicenses` is orthogonal to this: it is a refusal rather than positive eligibility.
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
	 * The default is `DEFAULT_SHUFFLE_WINDOW`, where `0` or `1` writes arrival
	 * order unchanged and consumes no random draw.
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
	 * Defaults to `LicensePolicy.All`, admitting every row an adapter yields.
	 *
	 * A weights build that must carry no share-alike obligation passes `LicensePolicy.ShareAlikeFree`.
	 */
	licensePolicy?: LicensePolicy

	/**
	 * What this corpus is being built for.
	 * The default is {@linkcode BuildProfile.Exploratory}.
	 */
	profile?: BuildProfile
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
	 * Resolved license set across all included rows (license string → row count).
	 *
	 * The model card derives its data-attribution table from it.
	 */
	licenses: Record<string, number>
	excluded_by_license: number
	/**
	 * The policy this build admitted rows under, so a consumer can tell a corpus that
	 * was never filtered from one filtered and found clean.
	 */
	license_policy: LicensePolicy
	/**
	 * Rows refused per `LicenseRefusalKind`, summing to `excluded_by_license`.
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
	 * Under `LicensePolicy.ResolvedOnly` this reads zero because those rows are refused instead.
	 */
	admitted_unresolved_license_rows: number
	/**
	 * The profile this build ran under, so a consumer can tell whether the corpus's sources were checked.
	 */
	profile: BuildProfile
	/**
	 * Rows dropped because the register does not call their source eligible.
	 *
	 * This reads zero under {@linkcode BuildProfile.Exploratory}, applying no eligibility check.
	 */
	excluded_by_eligibility: number
	/**
	 * Every source refused under {@linkcode BuildProfile.ReleaseEligible}, with the reasons
	 * the register gave, so a blocked build says what to fix rather than only that it stopped.
	 */
	ineligible_sources: Record<string, readonly string[]>
	/**
	 * The `contentDigest` of the `TRAINING_SOURCES.json` written beside this manifest.
	 *
	 * That file is the frozen record of which sources contributed and under which terms.
	 */
	training_manifest_digest: string
}
