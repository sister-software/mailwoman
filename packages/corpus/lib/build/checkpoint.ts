/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The align phase's resume point. It records aligned adapters and each output's length at that moment.
 *   It also records every accumulator used to compute the manifest.
 *
 *   The adapter phase recovers from its per-adapter `MANIFEST.json`. Align, split and parquet ran 6 h 35 min
 *   of the 8 h 27 min `v0.7.0-de-holdout` build with no recovery point, because the four labeled streams are
 *   truncated at open and every accumulator is a local. This file is what a resumed align phase reads
 *   instead of starting over.
 *
 *   The phase is replayable only when the same rows produce the same output, so the checkpoint records the
 *   settings that change alignment and refuses a resume under different ones. `align-determinism` in
 *   `build.test.ts` compares four output digests across two builds over one intermediate directory.
 */

import { readLocalJSONFile, pathExists } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { isIdentical } from "@mailwoman/core/identical"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

/**
 * The four append-only outputs of the align phase, by the name in each file.
 */
export const ALIGN_OUTPUTS = ["train", "val", "test", "quarantine"] as const

export type AlignOutputName = (typeof ALIGN_OUTPUTS)[number]

/**
 * The settings that change what the align phase writes for a given input row.
 *
 * A resume under different settings would mix two policies inside one output file,
 * so the checkpoint records these and a mismatch refuses the resume rather than continuing.
 */
export interface AlignSettings {
	corpus_version: string
	synthesize: boolean
	license_policy: string
	exclude_licenses: readonly string[]
	profile: string
	holdout_digest: string
}

/**
 * The align phase's state at an adapter boundary.
 */
export interface AlignCheckpoint {
	settings: AlignSettings

	/**
	 * Adapter ids whose rows are already in the four outputs, in the order they were aligned.
	 *
	 * A resume requires this to be a prefix of the current run's adapter order.
	 * Alignment appends, so a different order would place a later adapter's rows
	 * before an earlier one's and change every split file's contents.
	 */
	completed_adapters: string[]

	/**
	 * Byte length of each output at the checkpoint, after its writes were flushed.
	 *
	 * A resumed build shortens each file to this length.
	 * The shortening discards whatever the interrupted adapter wrote past the boundary.
	 */
	offsets: Record<AlignOutputName, number>

	counts: Record<"train" | "val" | "test", number>
	aligned: number
	quarantined: number
	license_counts: Record<string, number>
	refused_by_kind: Record<string, number>
	/**
	 * Rows the license policy refused, counted per `source`, so a resumed build keeps the tally
	 * rather than restarting it at zero and understating the refusal in its manifest.
	 */
	refused_by_source: Record<string, number>
	excluded_by_license: number
	admitted_unresolved_license_rows: number
	excluded_by_eligibility: number
	rows_by_source: Record<string, { rows: number; license: string }>
	written_at: string
}

/**
 * Read the align checkpoint, or return `null` when the build has not reached one.
 *
 * @throws When the checkpoint describes different settings, or an adapter order
 * the current run does not begin with.
 * Both cases would append this run's rows to a file written under different rules.
 * The resulting corpus could report a row count that later readers accept.
 */
export async function readAlignCheckpoint(
	path: PathBuilderLike,
	expected: { settings: AlignSettings; adapterOrder: readonly string[] }
): Promise<AlignCheckpoint | null> {
	if (!(await pathExists(path))) return null

	const checkpoint = await readLocalJSONFile<AlignCheckpoint>(path)
	const found = stringifyJSON(checkpoint.settings)
	const wanted = stringifyJSON(expected.settings)

	if (found !== wanted) {
		throw new Error(
			`resume refused: ${path.toString()} was written under ${found} and this build runs under ${wanted}. ` +
				`Delete the intermediate directory's labeled and quarantine files together with this checkpoint to ` +
				`align from the start.`
		)
	}

	const prefix = expected.adapterOrder.slice(0, checkpoint.completed_adapters.length)

	if (!isIdentical(prefix, checkpoint.completed_adapters)) {
		throw new Error(
			`resume refused: ${path.toString()} recorded ${stringifyJSON(checkpoint.completed_adapters)} as aligned ` +
				`and this build's adapter order begins ${stringifyJSON(prefix)}. Alignment appends, so the rows would ` +
				`land in a different order than the recorded offsets describe.`
		)
	}

	return checkpoint
}

/**
 * Write the align checkpoint.
 *
 * The caller flushes the four outputs before calling this, so every byte the offsets count is on disk.
 */
export function writeAlignCheckpoint(path: PathBuilderLike, checkpoint: AlignCheckpoint): Promise<void> {
	return writeLocalJSONFile(checkpoint, path).then(() => undefined)
}
