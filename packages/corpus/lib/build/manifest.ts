/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The build's top-level `MANIFEST.json` and frozen `TRAINING_SOURCES.json`, assembled from the phase reports.
 *
 *   The serial build passes its own align phase's totals. The parallel coordinator passes the totals it merged from
 *   each source's completion record. Both reach the same two files through this one function.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import type { PathBuilder } from "path-ts"

import type { AlignTotals } from "#build/align-totals"
import { TRAINING_MANIFEST_FILE, type BuildCorpusManifest, type BuildProfile, type BuildStage } from "#build/types"
import type { ParquetManifest } from "#parquet/writers"
import type { AdapterRunManifest } from "#runner"
import type { SourceRightsAdmission } from "#source-register/corpus-inputs"
import { committedRowLicenses } from "#source-register/row-license"
import { freezeTrainingManifest } from "#source-register/training-manifest"
import type { LicenseDecision } from "#source-register/types"
import type { LicensePolicy } from "#utils/license"
import type { CountryHoldout, SplitManifest } from "#utils/split"

export interface BuildManifestInputs {
	outputDir: PathBuilder
	corpusVersion: string
	builtAt: string
	profile: BuildProfile
	licensePolicy: LicensePolicy
	adapterRuns: AdapterRunManifest[]
	skipped: string[]
	splitCounts: SplitManifest["counts"]
	holdouts: Record<string, CountryHoldout>
	parquetManifest: ParquetManifest
	totals: AlignTotals
	rights: SourceRightsAdmission
	registerDecisions: ReadonlyMap<string, LicenseDecision>
	onProgress?: (stage: BuildStage, message: string) => void
}

/**
 * Write `TRAINING_SOURCES.json` and `MANIFEST.json` under the output directory and return the manifest.
 */
export async function writeBuildManifests(inputs: BuildManifestInputs): Promise<BuildCorpusManifest> {
	const { totals, onProgress } = inputs
	const licenseSummary = [...totals.licenseCounts.entries()].toSorted((a, b) => b[1] - a[1])
	const refusedValues = totals.refusedValues
	const refusalTally = [...totals.refusedByKind.entries()].map(([kind, rows]) => `${kind}=${rows}`).join(", ")

	onProgress?.(
		"manifest",
		`license set: ${licenseSummary.map(([l, c]) => `${l}=${c}`).join(", ")}` +
			` | policy ${inputs.licensePolicy}` +
			(totals.excludedByLicense > 0
				? ` | refused ${totals.excludedByLicense} rows over ${refusedValues.size} values (${refusalTally})`
				: ` | refused 0 rows`) +
			` | admitted ${totals.admittedUnresolved} rows whose license resolves to no expression`
	)

	onProgress?.("manifest", "writing top-level MANIFEST.json")

	// `writeParquetSplits` stamped each source's register id into the files' `license` column.
	// The record states that id rather than the producer's statement the align phase read.
	const rowLicenses = await committedRowLicenses()

	const rowsBySource = new Map(
		[...totals.rowsBySource].map(([source, contributed]) => [
			source,
			{ ...contributed, license: rowLicenses.require(source, `corpus build ${inputs.corpusVersion}`) },
		])
	)

	// Frozen from what this build observed rather than re-derived later, because the register moves
	// as terms are reviewed and a re-derived record would describe a build that never happened.
	const trainingManifest = freezeTrainingManifest({
		corpusVersion: inputs.corpusVersion,
		builtAt: inputs.builtAt,
		profile: inputs.profile,
		rowsBySource,
		decisionsByLicense: inputs.registerDecisions,
		refused: totals.ineligibleSources,
	})

	await writeLocalJSONFile(trainingManifest, inputs.outputDir(TRAINING_MANIFEST_FILE))

	const manifest: BuildCorpusManifest = {
		corpus_version: inputs.corpusVersion,
		built_at: inputs.builtAt,
		adapters: inputs.adapterRuns,
		skipped_adapters: inputs.skipped,
		splits: { counts: inputs.splitCounts, holdouts: inputs.holdouts },
		slices: { counts: inputs.parquetManifest.counts, total_rows: inputs.parquetManifest.total_rows },
		quarantine_count: totals.quarantined,
		total_aligned_rows: totals.aligned,
		licenses: Object.fromEntries(licenseSummary),
		licenses_cover:
			"the rows this build aligned from its adapters. An overlay parquet assembled afterwards carries its " +
			"own licenses, and the overlay corpus's own MANIFEST.json states no license set at all, so a reader " +
			"attributing an overlay corpus reads this set plus each overlay's own record rather than this set alone.",
		excluded_by_license: totals.excludedByLicense,
		license_policy: inputs.licensePolicy,
		refused_by_license_kind: Object.fromEntries(totals.refusedByKind),
		refused_license_values: Object.fromEntries(refusedValues),
		refused_rows_by_source: Object.fromEntries(totals.refusedBySource),
		admitted_unresolved_license_rows: totals.admittedUnresolved,
		profile: inputs.profile,
		excluded_by_eligibility: totals.excludedByEligibility,
		ineligible_sources: Object.fromEntries(totals.ineligibleSources),
		training_manifest_digest: trainingManifest.contentDigest,
		source_rights: inputs.rights.record(),
	}

	await writeLocalJSONFile(manifest, inputs.outputDir("MANIFEST.json"))

	return manifest
}
