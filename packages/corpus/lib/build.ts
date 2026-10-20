/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The corpus build, as the four phases it runs in order: adapters, align, split, parquet.
 *
 *   Each phase is its own module. This module defines their sequence and shared paths.
 *   It assembles the manifest from the phase reports.
 */

import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { heapLimitBytes } from "@mailwoman/core/utils/system"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { defaultAdapterRegistry } from "#adapters/registry"
import { runAdapterPhase } from "#build/adapters"
import { runAlignPhase } from "#build/align"
import { adapterModules, moduleGraphHashes } from "#build/code-hash"
import { readRegisterDecisions, readSourceEligibility } from "#build/eligibility"
import { settlePriorWork } from "#build/prior-output"
import { streamJSONL } from "#build/rows"
import {
	BuildProfile,
	PriorOutput,
	TRAINING_MANIFEST_FILE,
	type BuildCorpusManifest,
	type BuildCorpusOptions,
} from "#build/types"
import { extractFingerprint, type FileDerivation } from "#parquet/record"
import { ROWS_PER_FILE } from "#parquet/schema"
import {
	DEFAULT_SHUFFLE_SEED,
	DEFAULT_SHUFFLE_WINDOW,
	shuffleWithinSourceRuns,
	sourceShuffleSeed,
} from "#parquet/shuffle"
import { writeParquetSplits } from "#parquet/writers"
import { openSourceRightsAdmission } from "#source-register/corpus-inputs"
import { committedRowLicenses } from "#source-register/row-license"
import { freezeTrainingManifest } from "#source-register/training-manifest"
import type { AdapterOptions, CorpusAdapter, LabeledRow } from "#types"
import { LicensePolicy } from "#utils/license"
import { defaultHoldouts, writeSplitManifestsFromLabeledFiles, type SplitName } from "#utils/split"

export * from "#build/heap"
export * from "#build/types"

/**
 * The extract hash of one adapter's rows: its options with its input replaced by the input's fingerprint.
 *
 * A base row's `source` is its adapter's id (the runner refuses any other), a synthesized
 * row keeps its ancestor's `source`, and the runner deduplicates within one adapter's run.
 * A source's files therefore read only that adapter's input.
 *
 * `outputDir` is left out: it locates an adapter's side state and does not change a row.
 */
async function adapterExtractHash(options: AdapterOptions): Promise<string> {
	const { inputPath, outputDir: _outputDir, ...rest } = options

	return sha256Hex(canonicalJSON({ ...rest, input: await extractFingerprint(inputPath) }))
}

/**
 * This module, repository-relative: the root of the build pipeline every base source passes through.
 */
const BUILD_MODULE = "packages/corpus/lib/build.ts"

/**
 * The derivation of each configured adapter's files, from one cruise of the module graph.
 *
 * A source's code hash covers the build pipeline (`lib/build.ts` and what it reaches) and the
 * adapter's own module graph, so an edit to one adapter changes only that adapter's files.
 */
async function adapterDerivations(
	adapters: readonly CorpusAdapter[],
	adapterInputs: Record<string, AdapterOptions>,
	config: Record<string, unknown>
): Promise<(source: string) => Promise<FileDerivation>> {
	const modules = await adapterModules(adapters)

	const codeHashes = await moduleGraphHashes(
		Object.fromEntries([...modules].map(([id, module]) => [id, [BUILD_MODULE, module]]))
	)

	return async (source) => {
		const options = adapterInputs[source]
		const codeHash = codeHashes.get(source)

		if (!options || !codeHash) {
			throw new Error(`buildCorpus: rows of ${source} reached the parquet phase and no configured adapter has that id`)
		}

		return { extractHash: await adapterExtractHash(options), codeHash, config }
	}
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
	const profile = opts.profile ?? BuildProfile.Exploratory
	const licensePolicy = opts.licensePolicy ?? LicensePolicy.All
	const priorOutput = opts.priorOutput ?? PriorOutput.Refuse
	const resume = priorOutput === PriorOutput.Resume
	const built_at = new Date().toISOString()

	// The build reports heap state when it aborts with SIGABRT.
	// These aborts arrive twelve minutes into the adapter phase.
	const heapLimit = heapLimitBytes()
	const configured = adapters.filter((adapter) => opts.adapterInputs[adapter.id]).map((adapter) => adapter.id)

	opts.onProgress?.(
		"adapter-run",
		`heap limit ${(heapLimit / 1024 / 1024 / 1024).toFixed(1)} GiB, ${configured.length} adapters configured`
	)

	// An adapter stamps its own id into each row's `source`, so the configured
	// adapters are the sources this build will emit.
	// Checking them here refuses before hours of adapter work rather than after.
	const rights = await openSourceRightsAdmission({
		context: `corpus build ${opts.corpusVersion}`,
		unshippableReason: opts.unshippableReason ?? null,
		log: (line) => {
			console.error(line)

			opts.onProgress?.("adapter-run", line)
		},
	})

	rights.admitAll(configured)

	const outputDir = PathBuilder.from(opts.outputDir)
	const intermediateDir = outputDir("intermediate")

	await makeDirectories(outputDir, intermediateDir)

	const labeledPaths: Record<SplitName, PathBuilder> = {
		train: intermediateDir("labeled-train.jsonl"),
		val: intermediateDir("labeled-val.jsonl"),
		test: intermediateDir("labeled-test.jsonl"),
	}

	const sourceIDPaths: Record<SplitName, PathBuilder> = {
		train: intermediateDir("source-ids-train.txt"),
		val: intermediateDir("source-ids-val.txt"),
		test: intermediateDir("source-ids-test.txt"),
	}

	const quarantinePath = intermediateDir("quarantine.jsonl")
	const checkpointPath = intermediateDir("align-checkpoint.json")

	// Settled before any phase opens an output, because both phases overwrite unless they resume.
	await settlePriorWork(priorOutput, {
		intermediateDir,
		checkpointPath,
		alignPaths: {
			...labeledPaths,
			quarantine: quarantinePath,
			"source-ids-train": sourceIDPaths.train,
			"source-ids-val": sourceIDPaths.val,
			"source-ids-test": sourceIDPaths.test,
		},
		adapterIDs: configured,
	})

	const { runs: adapterRuns, skipped } = await runAdapterPhase({
		adapters,
		adapterInputs: opts.adapterInputs,
		corpusVersion: opts.corpusVersion,
		intermediateDir,
		resume,
		onProgress: opts.onProgress,
	})

	const holdouts = defaultHoldouts()
	const registerDecisions = await readRegisterDecisions()

	const align = await runAlignPhase({
		adapterRuns,
		corpusVersion: opts.corpusVersion,
		synthesize,
		profile,
		licensePolicy,
		excludeLicenses: opts.excludeLicenses ?? [],
		holdouts,
		eligibility: profile === BuildProfile.ReleaseEligible ? await readSourceEligibility() : null,
		labeledPaths,
		sourceIDPaths,
		quarantinePath,
		checkpointPath,
		resume,
		onProgress: opts.onProgress,
	})

	// A row's `source` can differ from its adapter's id, so every source the align phase
	// admitted is checked again before any of its rows reach a split or a parquet file.
	rights.admitAll(align.rowsBySource.keys())

	opts.onProgress?.("split", `splitting ${align.aligned} aligned rows`)

	const splitCounts = await writeSplitManifestsFromLabeledFiles({
		labeledPaths,
		sourceIDPaths: align.sourceIDPaths,
		outputDir: outputDir("splits"),
		corpusVersion: opts.corpusVersion,
		counts: align.counts,
		holdouts,
	})

	opts.onProgress?.("parquet", "writing parquet files")

	// Each split and source gets its own generator seeded from one base, so a file's row order depends
	// only on its own source's rows and not on how many rows other splits or sources happened to contain.
	const shuffled = (path: PathBuilderLike, salt: number) =>
		shuffleWithinSourceRuns(
			streamJSONL<LabeledRow>(path),
			(source) => makeMulberry32(sourceShuffleSeed(shuffleSeed + salt, source)),
			shuffleWindow
		)

	opts.onProgress?.(
		"parquet",
		shuffleWindow > 1
			? `shuffling each split within a ${shuffleWindow.toLocaleString("en-US")}-row window, seed ${shuffleSeed}`
			: "writing rows in arrival order (shuffle window disabled)"
	)

	const derivationFor = await adapterDerivations(
		adapters.filter((adapter) => configured.includes(adapter.id)),
		opts.adapterInputs,
		{
			tool: "build",
			synthesize,
			profile,
			licensePolicy,
			excludeLicenses: (opts.excludeLicenses ?? []).map((pattern) => pattern.source),
			holdouts,
			shuffleSeed,
			shuffleWindow,
		}
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
			resume,
			derivationFor,
		}
	)

	const licenseSummary = [...align.licenseCounts.entries()].toSorted((a, b) => b[1] - a[1])
	const refusedValues = align.licenses.refusedValues()
	const refusalTally = [...align.refusedByKind.entries()].map(([kind, rows]) => `${kind}=${rows}`).join(", ")

	opts.onProgress?.(
		"manifest",
		`license set: ${licenseSummary.map(([l, c]) => `${l}=${c}`).join(", ")}` +
			` | policy ${licensePolicy}` +
			(align.excludedByLicense > 0
				? ` | refused ${align.excludedByLicense} rows over ${refusedValues.size} values (${refusalTally})`
				: ` | refused 0 rows`) +
			` | admitted ${align.admittedUnresolved} rows whose license resolves to no expression`
	)

	opts.onProgress?.("manifest", "writing top-level MANIFEST.json")

	// `writeParquetSplits` stamped each source's register id into the files' `license` column.
	// The record states that id rather than the producer's statement the align phase read.
	const rowLicenses = await committedRowLicenses()

	const rowsBySource = new Map(
		[...align.rowsBySource].map(([source, contributed]) => [
			source,
			{ ...contributed, license: rowLicenses.require(source, `corpus build ${opts.corpusVersion}`) },
		])
	)

	// Frozen from what this build observed rather than re-derived later, because the register moves
	// as terms are reviewed and a re-derived record would describe a build that never happened.
	const trainingManifest = freezeTrainingManifest({
		corpusVersion: opts.corpusVersion,
		builtAt: built_at,
		profile,
		rowsBySource,
		decisionsByLicense: registerDecisions,
		refused: align.ineligibleSources,
	})

	await writeLocalJSONFile(trainingManifest, outputDir(TRAINING_MANIFEST_FILE))

	const manifest: BuildCorpusManifest = {
		corpus_version: opts.corpusVersion,
		built_at,
		adapters: adapterRuns,
		skipped_adapters: skipped,
		splits: { counts: splitCounts, holdouts },
		slices: { counts: parquetManifest.counts, total_rows: parquetManifest.total_rows },
		quarantine_count: align.quarantined,
		total_aligned_rows: align.aligned,
		licenses: Object.fromEntries(licenseSummary),
		licenses_cover:
			"the rows this build aligned from its adapters. An overlay parquet assembled afterwards carries its " +
			"own licenses, and the overlay corpus's own MANIFEST.json states no license set at all, so a reader " +
			"attributing an overlay corpus reads this set plus each overlay's own record rather than this set alone.",
		excluded_by_license: align.excludedByLicense,
		license_policy: licensePolicy,
		refused_by_license_kind: Object.fromEntries(align.refusedByKind),
		refused_license_values: Object.fromEntries(refusedValues),
		refused_rows_by_source: Object.fromEntries(align.refusedBySource),
		admitted_unresolved_license_rows: align.admittedUnresolved,
		profile,
		excluded_by_eligibility: align.excludedByEligibility,
		ineligible_sources: Object.fromEntries(align.ineligibleSources),
		training_manifest_digest: trainingManifest.contentDigest,
		source_rights: rights.record(),
	}

	await writeLocalJSONFile(manifest, outputDir("MANIFEST.json"))

	return manifest
}
