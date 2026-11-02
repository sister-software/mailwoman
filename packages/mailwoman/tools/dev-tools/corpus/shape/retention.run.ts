/**
 * @copyright Sister Software
 * @license AGPL-3.0
 *
 *   Compute the country–shape retention table of a built corpus (HOLDOUT_AND_EVALUATION
 *   section 5.1) and write it as a `split-retention` artifact beside the manifest.
 *
 *   Supply is measured under the corpus's recorded split assignments: each file's
 *   split-attribute JSON lists its val and test `source_id`s, and the remainder is train.
 *   When a combination's independent training groups (`coalesce(base_source_id, source_id)`
 *   at record granularity) fall below `--floor`, the combination joins the artifact's
 *   retention list. The next split with this artifact keeps every one of its rows in
 *   training.
 *
 *   Usage:
 *     node packages/mailwoman/tools/dev-tools/corpus/shape/retention.run.ts --manifest <MANIFEST.json> --floor 10 --out <SPLIT_RETENTION.json>
 *     node packages/mailwoman/tools/dev-tools/corpus/shape/retention.run.ts --manifest <MANIFEST.json> --floor 10 --out <path> --limit-files 2
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { recordIDSQL } from "@mailwoman/corpus/adapters/record-id"
import { openDuckDB, escapeSQLString } from "@mailwoman/corpus/parquet/duckdb"
import {
	readSplitRetention,
	SPLIT_RETENTION_ATTRIBUTE,
	type SplitRetentionFile,
} from "@mailwoman/corpus/tools/overlay/split/attribute"
import type { ShapeSupplyEntry } from "@mailwoman/corpus/utils/retention"

interface ManifestFile {
	path: string
	rows: number
	split_attribute?: { path: string }
}

interface CorpusManifest {
	corpus_version: string
	files: ManifestFile[]
}

const { values: args } = parseArguments({
	options: {
		manifest: { type: "string" },
		floor: { type: "string" },
		out: { type: "string" },
		"limit-files": { type: "string" },
		"memory-gb": { type: "string" },
		"temp-dir": { type: "string" },
	},
})

if (!args.manifest) throw new Error("--manifest <MANIFEST.json> is required")

if (!args.out) throw new Error("--out <SPLIT_RETENTION.json> is required")

const floor = Number(args.floor)

if (!(Number.isInteger(floor) && floor >= 1)) throw new Error("--floor takes a positive integer")

const limitFiles = args["limit-files"] ? Number(args["limit-files"]) : undefined

if (limitFiles !== undefined && !(Number.isInteger(limitFiles) && limitFiles > 0)) {
	throw new Error(`--limit-files takes a positive integer; received ${stringifyJSON(args["limit-files"])}`)
}

const manifest = await readLocalJSONFile<CorpusManifest>(args.manifest)
const files = limitFiles ? manifest.files.slice(0, limitFiles) : manifest.files

console.error(`shape-retention: ${files.length} files, floor ${floor}`)

await using scratch = await temporaryDirectory("shape-retention-")
const splitsJSONL = scratch.path("splits.jsonl").toString()

{
	const out = openWriteStream(splitsJSONL, { encoding: "utf8" })

	for (const file of files) {
		if (!file.split_attribute) throw new Error(`manifest file ${file.path} records no split attribute`)

		const attribute = await readLocalJSONFile<{ val: string[]; test: string[] }>(file.split_attribute.path)

		for (const id of attribute.val) {
			out.write(stringifyJSON({ source_id: id, split: "val" }) + "\n")
		}

		for (const id of attribute.test) {
			out.write(stringifyJSON({ source_id: id, split: "test" }) + "\n")
		}
	}

	await new Promise<void>((resolve, reject) => {
		out.end((error: Error | null) => {
			if (error) {
				reject(error)
			} else {
				resolve()
			}
		})
	})
}

const memoryLimitBytes = args["memory-gb"] ? Number(args["memory-gb"]) * 1024 ** 3 : undefined

if (memoryLimitBytes !== undefined && !(memoryLimitBytes > 0)) {
	throw new Error(`--memory-gb takes a positive number; received ${stringifyJSON(args["memory-gb"])}`)
}

using db = await openDuckDB({
	...(memoryLimitBytes ? { memoryLimitBytes } : {}),
	...(args["temp-dir"] ? { temporaryDirectory: args["temp-dir"] } : {}),
})

await db.run(
	`CREATE TEMP TABLE splits AS SELECT DISTINCT source_id, split FROM read_json('${escapeSQLString(splitsJSONL)}', format='newline_delimited')`
)

const paths = files.map((file) => `'${escapeSQLString(file.path)}'`).join(", ")

const groupHash = `hash(coalesce(nullif(p.base_source_id, ''), ${recordIDSQL("p.source_id")}))`

// The inner pass emits one row per distinct group per combination per split,
// so the outer aggregation reads that relation rather than re-hashing 620M rows per CASE.
const supplyRows = (
	await db.runAndReadAll(`
		WITH per_split AS (
			SELECT
				p.country AS country,
				array_to_string(p.span_tags, ' -> ') AS shape,
				coalesce(s.split, 'train') AS split,
				${groupHash} AS group_hash
			FROM read_parquet([${paths}], union_by_name=true) p
			LEFT JOIN splits s ON s.source_id = p.source_id
			GROUP BY ALL
		)
		SELECT country, shape,
			count(DISTINCT group_hash)::BIGINT AS groups,
			count(DISTINCT CASE WHEN split = 'train' THEN group_hash END)::BIGINT AS trainGroups,
			count(DISTINCT CASE WHEN split = 'val' THEN group_hash END)::BIGINT AS valGroups,
			count(DISTINCT CASE WHEN split = 'test' THEN group_hash END)::BIGINT AS testGroups
		FROM per_split
		GROUP BY ALL
		ORDER BY country, shape
	`)
).getRowObjectsJson() as Array<Record<string, unknown>>

const supply: ShapeSupplyEntry[] = supplyRows.map((row) => ({
	country: String(row["country"]),
	shape: String(row["shape"]),
	groups: Number(row["groups"]),
	trainGroups: Number(row["trainGroups"]),
	valGroups: Number(row["valGroups"]),
	testGroups: Number(row["testGroups"]),
}))

const protectedShapes = supply
	.filter((entry) => Number(entry.trainGroups) < floor)
	.map((entry) => `${entry.country}|${entry.shape}`)

const artifact: SplitRetentionFile = {
	attribute: SPLIT_RETENTION_ATTRIBUTE,
	floor,
	corpusVersion: manifest.corpus_version,
	supply,
	protectedShapes: protectedShapes.toSorted(),
}

await writeLocalJSONFile(artifact, args.out)

// The reader round-trip refuses a malformed artifact rather than letting the split read it.
await readSplitRetention(args.out)

console.log(
	stringifyJSON({
		out: args.out,
		floor,
		combinations: supply.length,
		protectedShapes: protectedShapes.length,
	})
)
