/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The held-out span check as the step that admits a corpus manifest.
 *
 *   The parquet writer stages its manifest under {@linkcode UNCHECKED_PARQUET_MANIFEST_FILE}. This step counts, over
 *   the files that manifest lists, the train rows that still hold a declared held-out key and the train supply of
 *   every region of every declared country, writes the result to {@linkcode HOLDOUT_CHECK_FILE} beside it, and moves
 *   the manifest to `MANIFEST.json` only when the check passes. A corpus whose split removed a label from
 *   training or left a held-out place in it therefore has no `MANIFEST.json` for a training run to read, and the
 *   receipt beside the staged manifest lists each finding (#2777, #2823).
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { movePath, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import type { PathBuilder } from "path-ts"

import type { BuildStage } from "#build/types"
import type { DuckDBLimits } from "#parquet/duckdb"
import { countHoldoutSpans, type HoldoutSpanFinding, holdoutSpanFindings } from "#tools/overlay/held-out-spans"
import type { CountryHoldout } from "#utils/split"

/**
 * The parquet manifest's name while the check has not admitted it.
 */
export const UNCHECKED_PARQUET_MANIFEST_FILE = "MANIFEST.unchecked.json"

/**
 * The parquet manifest's name once the check admitted it, the name every reader of a corpus opens.
 */
export const PARQUET_MANIFEST_FILE = "MANIFEST.json"

/**
 * The check's receipt, written beside the manifest on every outcome.
 */
export const HOLDOUT_CHECK_FILE = "HOLDOUT_CHECK.json"

/**
 * The count of findings the refusal message lists before it points at the receipt.
 */
const FINDINGS_IN_MESSAGE = 12

/**
 * What the check read and found, as {@linkcode HOLDOUT_CHECK_FILE} records it.
 */
export interface HoldoutCheckRecord {
	checked_at: string
	/**
	 * The countries whose declared holdouts were checked, sorted.
	 */
	countries: string[]
	files_read: number
	findings: HoldoutSpanFinding[]
	/**
	 * True when `findings` is empty and the manifest was admitted.
	 */
	admitted: boolean
}

/**
 * Moves an admitted manifest back under its unchecked name when a build resumes, so the parquet
 * writer reads the files it recorded and the check admits the manifest again at the end.
 *
 * With no admitted manifest, or with a staged one already present, the directory is left as it is.
 */
export async function stageAdmittedManifestForResume(corpusDir: PathBuilder): Promise<void> {
	const staged = corpusDir(UNCHECKED_PARQUET_MANIFEST_FILE)
	const admitted = corpusDir(PARQUET_MANIFEST_FILE)

	if ((await pathExists(admitted)) && !(await pathExists(staged))) {
		await movePath(admitted, staged)
	}
}

export interface AdmitParquetManifestOptions {
	/**
	 * The corpus directory holding the staged manifest, `<out>/corpus-v<version>`.
	 */
	corpusDir: PathBuilder
	holdouts: Record<string, CountryHoldout>
	limits?: DuckDBLimits
	onProgress?: (stage: BuildStage, message: string) => void
}

/**
 * Runs the held-out span check over the staged parquet manifest, writes the receipt,
 * and moves the manifest to {@linkcode PARQUET_MANIFEST_FILE} when the check passes.
 *
 * A manifest already admitted, with no staged manifest beside it, is read as admitted by an earlier run
 * and checked again in place, so a resumed build reports the same receipt a fresh one would.
 *
 * @throws When the check finds a declared key in training or a region whose
 * train supply fell below the floor.
 * The staged manifest stays under its unchecked name and the receipt lists every finding.
 */
export async function admitParquetManifest(opts: AdmitParquetManifestOptions): Promise<HoldoutCheckRecord> {
	const staged = opts.corpusDir(UNCHECKED_PARQUET_MANIFEST_FILE)
	const admitted = opts.corpusDir(PARQUET_MANIFEST_FILE)
	const subject = (await pathExists(staged)) ? staged : admitted
	const countries = Object.keys(opts.holdouts).toSorted()

	opts.onProgress?.("manifest", `held-out span check over ${countries.length} declared countries`)

	const result = await countHoldoutSpans(subject.toString(), opts.holdouts, opts.limits)
	const findings = holdoutSpanFindings(result, opts.holdouts)

	const record: HoldoutCheckRecord = {
		checked_at: new Date().toISOString(),
		countries,
		files_read: result.filesRead,
		findings,
		admitted: findings.length === 0,
	}

	await writeLocalJSONFile(record, opts.corpusDir(HOLDOUT_CHECK_FILE))

	if (findings.length) {
		const listed = findings
			.slice(0, FINDINGS_IN_MESSAGE)
			.map(
				(finding) =>
					`${finding.country} ${finding.reason} ${finding.key}: ${finding.trainRows} train rows, ${finding.heldOutRows} held out`
			)

		throw new Error(
			`corpus build: the held-out span check refused the corpus, so ${PARQUET_MANIFEST_FILE} was not written. ` +
				`${findings.length} finding(s), each a key the split left in training or a region whose train supply fell ` +
				`below the floor; the full list is in ${opts.corpusDir(HOLDOUT_CHECK_FILE)}.\n${listed.join("\n")}` +
				(findings.length > FINDINGS_IN_MESSAGE ? `\n… ${findings.length - FINDINGS_IN_MESSAGE} more` : "")
		)
	}

	if (subject === staged) {
		await movePath(staged, admitted)
	}

	opts.onProgress?.("manifest", `held-out span check admitted the corpus over ${result.filesRead} files`)

	return record
}
