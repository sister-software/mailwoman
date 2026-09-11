/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Invariance fixture loading.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { TextSpliterator } from "spliterator"

/**
 * Suite the invariance runner loads when no path is given.
 */
export const DEFAULT_SUITE_PATH = "packages/mailwoman/lib/eval-harness/invariance/suite.jsonl"

//#region fixture loading

export interface InvarianceRow {
	id: string
	raw: string
	country: string
	/**
	 * Transform ids (see transforms.ts) that apply to this row.
	 */
	transforms: string[]
}

/**
 * Load `suite.jsonl`-shaped rows. Blank lines and `//`-prefixed comment lines (the fixture header) are skipped.
 */
export async function loadSuite(path: string = DEFAULT_SUITE_PATH): Promise<InvarianceRow[]> {
	if (!(await pathExists(path))) throw new Error(`invariance suite not found: ${path}`)

	const rows: InvarianceRow[] = []

	// The suite is JSONL with a `//` comment header, so the rows are parsed here rather than by
	// `JSONSpliterator`, which would throw on the first comment.
	for (const line of TextSpliterator.from(await readLocalTextFile(path))) {
		const trimmed = line.trim()

		if (!trimmed || trimmed.startsWith("//")) continue

		rows.push(parseJSONStrict<InvarianceRow>(trimmed))
	}

	return rows
}

//#endregion
