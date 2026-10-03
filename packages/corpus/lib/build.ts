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
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { heapLimitBytes } from "@mailwoman/core/utils/system"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { defaultAdapterRegistry } from "#adapters/registry"
import { runAdapterPhase } from "#build/adapters"
import { runAlignPhase } from "#build/align"
import { readRegisterDecisions, readSourceEligibility } from "#build/eligibility"
import { streamJSONL } from "#build/rows"
import { BuildProfile, TRAINING_MANIFEST_FILE, type BuildCorpusManifest, type BuildCorpusOptions } from "#build/types"
import { $public } from "#env"
import { ROWS_PER_FILE } from "#parquet/schema"
import { DEFAULT_SHUFFLE_SEED, DEFAULT_SHUFFLE_WINDOW, shuffleWithinWindow } from "#parquet/shuffle"
import { writeParquetSplits } from "#parquet/writers"
import { freezeTrainingManifest } from "#source-register/training-manifest"
import type { LabeledRow } from "#types"
import { LicensePolicy } from "#utils/license"
import { defaultHoldouts, writeSplitManifestsFromLabeledFiles, type SplitName } from "#utils/split"

export * from "#build/heap"
export * from "#build/types"

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
	const built_at = new Date().toISOString()

	// The build reports heap state when it aborts with SIGABRT.
	// These aborts arrive twelve minutes into the adapter phase.
	const heapLimit = heapLimitBytes()
	const configured = adapters.filter((adapter) => opts.adapterInputs[adapter.id]).map((adapter) => adapter.id)

	opts.onProgress?.(
		"adapter-run",
		`heap limit ${(heapLimit / 1024 / 1024 / 1024).toFixed(1)} GiB, ${configured.length} adapters configured`
	)

	const outputDir = PathBuilder.from(opts.outputDir)
	const intermediateDir = outputDir("intermediate")

	await makeDirectories(outputDir, intermediateDir)

	const { runs: adapterRuns, skipped } = await runAdapterPhase({
		adapters,
		adapterInputs: opts.adapterInputs,
		corpusVersion: opts.corpusVersion,
		intermediateDir,
		onProgress: opts.onProgress,
	})

	const labeledPaths: Record<SplitName, PathBuilder> = {
		train: intermediateDir("labeled-train.jsonl"),
		val: intermediateDir("labeled-val.jsonl"),
		test: intermediateDir("labeled-test.jsonl"),
	}

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
		quarantinePath: intermediateDir("quarantine.jsonl"),
		checkpointPath: intermediateDir("align-checkpoint.json"),
		onProgress: opts.onProgress,
	})

	opts.onProgress?.("split", `splitting ${align.aligned} aligned rows`)

	const splitCounts = await writeSplitManifestsFromLabeledFiles({
		labeledPaths,
		outputDir: outputDir("splits"),
		corpusVersion: opts.corpusVersion,
		counts: align.counts,
		holdouts,
	})

	opts.onProgress?.("parquet", "writing parquet files")

	// Each split gets its own generator seeded from one base, so a split's row order does
	// not depend on how many rows the earlier splits happened to contain.
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
			resume: $public.MAILWOMAN_RESUME === "1",
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

	// Frozen from what this build observed rather than re-derived later, because the register moves
	// as terms are reviewed and a re-derived record would describe a build that never happened.
	const trainingManifest = freezeTrainingManifest({
		corpusVersion: opts.corpusVersion,
		builtAt: built_at,
		profile,
		rowsBySource: align.rowsBySource,
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
	}

	await writeLocalJSONFile(manifest, outputDir("MANIFEST.json"))

	return manifest
}
