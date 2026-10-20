/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The corpus build, as the four phases it runs in order: adapters, align, split, parquet.
 *
 *   Each phase is its own module. This module defines their sequence and shared paths.
 *   It assembles the manifest from the phase reports.
 *
 *   With `jobs` above 1 the same phases run per source in worker processes (`#build/parallel`),
 *   and the coordinator assembles the same files from the sources' records.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { heapLimitBytes } from "@mailwoman/core/utils/system"
import { PathBuilder } from "path-ts"

import { defaultAdapterRegistry } from "#adapters/registry"
import { runAdapterPhase } from "#build/adapters"
import { runAlignPhase } from "#build/align"
import { alignTotalsOf } from "#build/align-totals"
import { planWorkerBudget } from "#build/budget"
import { readRegisterDecisions, readSourceEligibility } from "#build/eligibility"
import { acquireBuildLock } from "#build/lock"
import { writeBuildManifests } from "#build/manifest"
import { runParallelBuild } from "#build/parallel"
import { settlePriorWork } from "#build/prior-output"
import { streamJSONL } from "#build/rows"
import { adapterDerivations, derivationConfig, resolveBuildSettings } from "#build/settings"
import { BuildProfile, type BuildCorpusManifest, type BuildCorpusOptions } from "#build/types"
import { shuffleSplitRows, SPLIT_SHUFFLE_SALT } from "#parquet/shuffle"
import { writeParquetSplits } from "#parquet/writers"
import { openSourceRightsAdmission } from "#source-register/corpus-inputs"
import type { LabeledRow } from "#types"
import { defaultHoldouts, writeSplitManifestsFromLabeledFiles, type SplitName } from "#utils/split"

export * from "#build/heap"
export * from "#build/types"

/**
 * Drive the full corpus build to completion.
 */
export async function buildCorpus(opts: BuildCorpusOptions): Promise<BuildCorpusManifest> {
	const adapters = opts.adapters ?? defaultAdapterRegistry.list()
	const settings = resolveBuildSettings(opts)
	const { synthesize, rowsPerFile, shuffleWindow, shuffleSeed, profile, licensePolicy, resume } = settings
	const jobs = opts.jobs ?? 1
	const built_at = new Date().toISOString()

	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new Error(`buildCorpus: jobs is ${jobs}; it is a positive integer, 1 for a serial build.`)
	}

	// The build reports heap state when it aborts with SIGABRT.
	// These aborts arrive twelve minutes into the adapter phase.
	const heapLimit = heapLimitBytes()
	const configured = adapters.filter((adapter) => opts.adapterInputs[adapter.id]).map((adapter) => adapter.id)

	// Refused before any work, since it depends only on the host and the configured adapters.
	const budget =
		jobs > 1 ? planWorkerBudget({ jobs, adapterIDs: configured, hostMemoryBytes: opts.hostMemoryBytes }) : null

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

	// Held until this function returns or throws, so a second build into the same directory refuses.
	await using _lock = await acquireBuildLock(outputDir)

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
	await settlePriorWork(settings.priorOutput, {
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

	// Awaited here, so the lock is released after the build settles rather than when it starts.
	if (budget) {
		return await runParallelBuild({
			opts,
			adapters: adapters.filter((adapter) => configured.includes(adapter.id)),
			skipped: adapters.filter((adapter) => !configured.includes(adapter.id)).map((adapter) => adapter.id),
			settings,
			rights,
			outputDir,
			intermediateDir,
			builtAt: built_at,
			budget,
		})
	}

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
		excludeLicenses: settings.excludeLicenses,
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

	const shuffled = (split: SplitName) =>
		shuffleSplitRows(streamJSONL<LabeledRow>(labeledPaths[split]), {
			seed: shuffleSeed,
			salt: SPLIT_SHUFFLE_SALT[split],
			window: shuffleWindow,
		})

	opts.onProgress?.(
		"parquet",
		shuffleWindow > 1
			? `shuffling each split within a ${shuffleWindow.toLocaleString("en-US")}-row window, seed ${shuffleSeed}`
			: "writing rows in arrival order (shuffle window disabled)"
	)

	const derivationFor = await adapterDerivations(
		adapters.filter((adapter) => configured.includes(adapter.id)),
		opts.adapterInputs,
		derivationConfig(settings, holdouts)
	)

	const parquetManifest = await writeParquetSplits(
		{ train: shuffled("train"), val: shuffled("val"), test: shuffled("test") },
		{
			outputDir,
			corpusVersion: opts.corpusVersion,
			rowsPerFile,
			resume,
			derivationFor,
		}
	)

	return await writeBuildManifests({
		outputDir,
		corpusVersion: opts.corpusVersion,
		builtAt: built_at,
		profile,
		licensePolicy,
		adapterRuns,
		skipped,
		splitCounts,
		holdouts,
		parquetManifest,
		totals: alignTotalsOf(align),
		rights,
		registerDecisions,
		onProgress: opts.onProgress,
	})
}
