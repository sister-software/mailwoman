/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The OpenAddresses eval row — its shape on disk and how a run reads it.
 */

import { JSONSpliterator } from "spliterator"

/**
 * One OpenAddresses row: a real address string plus the government point it was published with. `expected` is the admin
 * truth the resolver is graded against; `lat`/`lon` are the coordinate truth.
 */
export interface OARow {
	input: string
	lat: number
	lon: number
	expected: { locality?: string; region?: string; postcode?: string }
	state: string
	source: string
}

/**
 * Read the eval JSONL, capped at `limit` rows. `Infinity` reads the file whole.
 */
export async function readOARows(evalPath: string, limit: number): Promise<OARow[]> {
	return (await Array.fromAsync(JSONSpliterator.fromAsync<OARow>(evalPath))).slice(
		0,
		limit === Infinity ? undefined : limit
	)
}
