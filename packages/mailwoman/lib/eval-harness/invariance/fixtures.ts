/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Invariance fixture loading.
 */

import { assertPathExists } from "@mailwoman/core/fs/readers/stat"
import { JSONSpliterator } from "spliterator"

/**
 * Suite the invariance runner loads when no path is given. TODO: Resolve this via core's `resolvePackageSpecifier`
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
	await assertPathExists(path, "Invariance suite should exist")

	// `from` splits a CharacterSequence already in memory; `fromAsync` opens a path. Handed a path,
	// `from` parsed the path string itself as the first row — "packages/m…" is not valid JSON.
	return JSONSpliterator.fromAsync<InvarianceRow>(path, { comment: "//" }).toArray()
}

//#endregion
