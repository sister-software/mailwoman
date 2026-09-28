/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Count, per country and split, the held-out `source_id`s that also appear in train.
 *
 *   `holdout-leakage.run.ts` counts train rows the holdout policy says belong in val or test. This report checks
 *   the other direction: a row can sit in val and share its `source_id` with a train row. This happens when a
 *   file's split was chosen by hand rather than by `splitForRow`. Zero is the expected value.
 *
 *   Measured over `v0.6.0-register-surface` on 2026-09-28, this tool's own denominators: DE's val split holds
 *   40,918 distinct `source_id`s and 770 of them are in train (1.88%), all 770 from
 *   `part-synth-german-val.parquet`, which a hand-written list routed. Against that one file's 3,987 ids the
 *   share is 19.3%, which is the figure #2359 records. GB, routed through `corpus split-slice`, reads 37 of
 *   109,096 in val (0.03%) and 31 of 109,792 in test. FR and US read 0.
 *
 *   **Why the raw-string count is a lower bound.** `base_source_id` is NULL for 4,176,539 of the 4,206,561
 *   `composed` rows of that corpus, so two rows composed from one underlying address under different
 *   `source_id`s are indistinguishable from two unrelated rows. The raw column counts rows whose `raw` string
 *   is byte-equal across the splits. It misses any pair the recipe rendered differently. DE val reads 513
 *   of 38,056 there.
 *
 *   Usage:
 *   node packages/mailwoman/lib/dev-tools/corpus/holdout/overlap.run.ts --corpus <corpus dir> [--json <out>]
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { join } from "path-ts"

const { values } = parseArguments({
	options: {
		corpus: { type: "string", description: "The corpus directory holding train/, val/ and test/" },
		json: { type: "string", description: "Write the per-country rows to this path" },
	},
})

const corpus = values.corpus

if (!corpus) throw new Error("--corpus <corpus dir> is required")

/**
 * One country and held-out split's overlap with train.
 */
interface Overlap {
	country: string
	split: "val" | "test"
	heldOutIDs: number
	idsAlsoInTrain: number
	heldOutRaw: number
	rawAlsoInTrain: number
}

const globFor = (split: string) => escapeSQLString(join(corpus, split, "*.parquet"))

using db = await openDuckDB()

// The row order of this report's intermediate tables carries no information.
// Holding it costs memory from the query's bounded allocation.
// This is the setting DuckDB's own out-of-memory message names first.
await db.run("SET preserve_insertion_order=false")

const rows: Overlap[] = []

for (const split of ["val", "test"] as const) {
	// The held-out side is small — DE's val split holds 3,987 distinct ids —
	// and the train side is the corpus.
	// Materializing the small side first and then streaming train through a join against
	// it keeps the hash table at the size of the held-out set.
	// Aggregating both sides in one statement instead makes DuckDB build a distinct set over every train row.
	// That exhausts the memory limit and reports an out-of-memory error naming a 32 KiB allocation.
	await db.run(
		`CREATE OR REPLACE TEMP TABLE held AS SELECT DISTINCT country, source_id, raw FROM read_parquet('${globFor(split)}')`
	)

	await db.run(
		`CREATE OR REPLACE TEMP TABLE shared_ids AS SELECT DISTINCT h.country, h.source_id ` +
			`FROM read_parquet('${globFor("train")}') t ` +
			`JOIN held h ON h.country = t.country AND h.source_id = t.source_id`
	)

	await db.run(
		`CREATE OR REPLACE TEMP TABLE shared_raw AS SELECT DISTINCT h.country, h.raw ` +
			`FROM read_parquet('${globFor("train")}') t ` +
			`JOIN held h ON h.country = t.country AND h.raw = t.raw`
	)

	const result = await db.runAndReadAll(
		`SELECT h.country AS country, ` +
			`  COUNT(DISTINCT h.source_id) AS held_out_ids, ` +
			`  COUNT(DISTINCT h.raw) AS held_out_raw, ` +
			`  (SELECT COUNT(*) FROM shared_ids s WHERE s.country = h.country) AS ids_also_in_train, ` +
			`  (SELECT COUNT(*) FROM shared_raw s WHERE s.country = h.country) AS raw_also_in_train ` +
			`FROM held h GROUP BY h.country ORDER BY ids_also_in_train DESC`
	)

	for (const row of result.getRowObjectsJS() as Array<Record<string, bigint | number | string>>) {
		rows.push({
			country: String(row["country"]),
			split,
			heldOutIDs: Number(row["held_out_ids"]),
			idsAlsoInTrain: Number(row["ids_also_in_train"]),
			heldOutRaw: Number(row["held_out_raw"]),
			rawAlsoInTrain: Number(row["raw_also_in_train"]),
		})
	}
}

console.log(`${corpus}\n`)
console.log("country | split | held-out ids | also in train | share | held-out raw | raw also in train")

for (const row of rows) {
	const share = row.heldOutIDs ? `${((100 * row.idsAlsoInTrain) / row.heldOutIDs).toFixed(2)}%` : "—"

	console.log(
		`${row.country} | ${row.split} | ${row.heldOutIDs.toLocaleString()} | ${row.idsAlsoInTrain.toLocaleString()} | ` +
			`${share} | ${row.heldOutRaw.toLocaleString()} | ${row.rawAlsoInTrain.toLocaleString()}`
	)
}

const offending = rows.filter((row) => row.idsAlsoInTrain > 0)

console.log(
	`\n${offending.length} of ${rows.length} country-and-split pairs share a source_id with train. ` +
		`Zero is the expected value: a held-out row whose id is in train was never held out.`
)

if (values.json) {
	await writeLocalJSONFile({ corpus, measuredAt: new Date().toISOString(), rows }, values.json)

	console.log(`wrote ${values.json}`)
}
