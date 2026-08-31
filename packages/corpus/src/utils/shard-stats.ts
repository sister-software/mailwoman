/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Token/label co-occurrence accounting shared by the corpus-stats builder (`tools/corpus-stats.ts`)
 *   and the shard linter (`tools/lint-shard.ts`). The two sides MUST agree on the bigram key format:
 *   the linter looks its shard's bigrams up in the stats file's `bigrams` table, and a key built with
 *   a different separator never matches — which silently blanks the bigram-collision check.
 */

import { ParquetReader } from "#parquet-wrapper/index"

/**
 * Separator inside a bigram key (`tok1␟tok2`) and a label-bigram value (`lab1␟lab2`): U+001F UNIT SEPARATOR, a
 * character no address token contains. Render a key for humans with `key.split(SHARD_STATS_SEP).join(" ")`.
 */
export const SHARD_STATS_SEP = ""

/**
 * Nested tally: outer key → (inner key → count). Token → label counts, or bigram key → label-bigram counts.
 */
export type CooccurrenceTable = Map<string, Map<string, number>>

/**
 * The token + bigram co-occurrence tables one pass over labeled rows accumulates.
 */
export interface CooccurrenceStats {
	tokens: CooccurrenceTable
	bigrams: CooccurrenceTable
}

/**
 * An empty pair of tables for {@link accumulateCooccurrences}.
 */
export function createCooccurrenceStats(): CooccurrenceStats {
	return { tokens: new Map(), bigrams: new Map() }
}

function bump(table: CooccurrenceTable, key: string, sub: string): void {
	let counter = table.get(key)

	if (!counter) {
		counter = new Map()
		table.set(key, counter)
	}

	counter.set(sub, (counter.get(sub) ?? 0) + 1)
}

/**
 * Fold one row's parallel `tokens`/`labels` into the tables. The caller has already checked the arrays are the same
 * length.
 */
export function accumulateCooccurrences(
	stats: CooccurrenceStats,
	tokens: readonly string[],
	labels: readonly string[]
): void {
	for (let i = 0; i < tokens.length; i++) {
		const tk = tokens[i]!
		const lb = labels[i]!

		bump(stats.tokens, tk, lb)

		if (i + 1 < tokens.length) {
			bump(stats.bigrams, tk + SHARD_STATS_SEP + tokens[i + 1]!, lb + SHARD_STATS_SEP + labels[i + 1]!)
		}
	}
}

/**
 * A shard row projected to the two columns the co-occurrence pass reads.
 */
export interface TokenLabelRow {
	tokens: string[]
	labels: string[]
	[key: string]: unknown
}

/**
 * Stream a shard's `tokens`/`labels` columns.
 *
 * Projected rather than read whole: parquet is columnar, so the unused columns are never touched. `limit` stops the
 * iteration rather than filtering afterwards, so a capped run reads only the row groups it needs.
 */
export async function* streamTokenLabelRows(shardPath: string, limit?: number): AsyncIterable<TokenLabelRow> {
	await using reader = await ParquetReader.openFile<TokenLabelRow>(shardPath)

	let emitted = 0

	for await (const row of reader.project("tokens", "labels")) {
		if (limit !== undefined && emitted >= limit) break

		yield row

		emitted++
	}
}
