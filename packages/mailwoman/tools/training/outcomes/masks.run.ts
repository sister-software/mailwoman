// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes a corpus's outcome mask file.
 *
 *   The trainer's outcome head and hint read it beside
 *   `packages/trainer/data/outcome_readings.json` (`trainer-loop/src/outcomes.rs`).
 *
 *   The file holds two lists:
 *
 *   - `geonames_unknown_class_ids`: the `geonames-features` ids whose GeoNames
 *     feature class is outside the table's `geonames_natural_classes`, read from
 *     the country dumps under `<data root>/geonames/`.
 *     The adapter also reads class `L` (parks and areas), which holds no single
 *     reading, so those rows are masked.
 *   - `shared_surfaces`: each folded single-span surface that rows of two readings
 *     or more write, an unknown reading counted as one.
 *     Such a cue-less name needs a soft target weighted by sitelinks
 *     (`docs/engineering/reference/outcome-kinds.mdx`), and the corpus holds no
 *     sitelink count, so its rows are masked.
 *
 *   The fold is DuckDB's `lower(regexp_replace(trim(raw), '\s+', ' ', 'g'))`,
 *   which `fold_surface` reproduces.
 *   It prints the row count of each reading and mask reason.
 *
 *   Usage:
 *     node --env-file=.env packages/mailwoman/tools/training/outcomes/masks.run.ts --corpus <corpus dir> --out <json>
 */

import { DuckDBInstance } from "@duckdb/node-api"
import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

interface ReadingTable {
	family_prefixes: Record<string, string>
	geonames_natural_classes: string[]
	sources: Record<string, string>
}

interface CorpusManifest {
	files: Array<{ source: string; path: string }>
}

const { values } = parseArguments({
	options: {
		corpus: { type: "string" },
		out: { type: "string" },
	},
})

if (!values.corpus || !values.out) throw new Error("--corpus and --out are required")

const volumePath = (path: string) => path.replace(/^\/data\//, `${dataRootPath()}/`)
const table = await readLocalJSONFile<ReadingTable>(repoRootPath("packages/trainer/data/outcome_readings.json"))
const manifest = await readLocalJSONFile<CorpusManifest>(`${volumePath(values.corpus)}/MANIFEST.json`)
const sources = [...new Set(manifest.files.map((f) => f.source))].toSorted()
const readings = new Map<string, string>()

for (const source of sources) {
	const prefix = Object.keys(table.family_prefixes).find((p) => source.startsWith(p))
	const reading = table.sources[source] ?? (prefix ? table.family_prefixes[prefix] : undefined)

	if (!reading) throw new Error(`outcome_readings.json maps no reading for source ${source}`)
	readings.set(source, reading)
}

const sql = (s: string) => `'${s.replaceAll("'", "''")}'`
const files = `[${manifest.files.map((f) => sql(volumePath(f.path))).join(",")}]`
const db = await DuckDBInstance.create(":memory:")
const conn = await db.connect()

await conn.run(`SET memory_limit='8GB'`)

await conn.run(
	`CREATE TABLE readings AS SELECT * FROM (VALUES ${[...readings].map(([s, r]) => `(${sql(s)}, ${sql(r)})`).join(",")}) t(source, reading)`
)

const geonamesID = `TRY_CAST(regexp_extract(source_id, '^geonames-features-([0-9]+)-', 1) AS BIGINT)`
// The GeoNames dump's 19 columns: the id, then 18 read as text.
const dumpColumns = `{${Array.from({ length: 19 }, (_, i) => `'c${i}': '${i === 0 ? "BIGINT" : "VARCHAR"}'`).join(", ")}}`

await conn.run(`
	CREATE TABLE unknown_class AS
	WITH ids AS (SELECT DISTINCT ${geonamesID} id FROM read_parquet(${files}) WHERE source = 'geonames-features'),
	dump AS (SELECT c0 id, c6 cls FROM read_csv(${sql(`${dataRootPath()}/geonames/[A-Z][A-Z].txt`)}, delim='\t', header=false,
		quote='', null_padding=true, columns=${dumpColumns}))
	SELECT ids.id FROM ids LEFT JOIN dump USING (id)
	WHERE dump.cls IS NULL OR dump.cls NOT IN (${table.geonames_natural_classes.map(sql).join(",")})
	ORDER BY ids.id`)

// Only a single-span row can be masked for its surface, so only those rows keep their text.
await conn.run(`
	CREATE TABLE singles AS
	SELECT p.source, r.reading, span_tags[1] first,
		lower(regexp_replace(trim(raw), '\\s+', ' ', 'g')) surface,
		CASE WHEN p.source = 'geonames-features' THEN ${geonamesID} END gid
	FROM read_parquet(${files}) p JOIN readings r USING (source)
	WHERE len(span_tags) = 1`)

await conn.run(`
	CREATE TABLE shared AS
	SELECT surface FROM (
		SELECT surface, CASE WHEN gid IN (SELECT id FROM unknown_class) THEN 'unknown' ELSE reading END reading
		FROM singles WHERE first <> 'postcode')
	GROUP BY surface HAVING count(DISTINCT reading) >= 2 ORDER BY surface`)

const ids = (await conn.runAndReadAll(`SELECT id FROM unknown_class`)).getRowObjectsJson().map((r) => Number(r.id))

const surfaces = (await conn.runAndReadAll(`SELECT surface FROM shared`))
	.getRowObjectsJson()
	.map((r) => String(r.surface))

await writeLocalJSONFile(
	{
		corpus: values.corpus,
		geonames_unknown_class_ids: ids,
		shared_surfaces: surfaces,
	},
	values.out
)

const counts = await conn.runAndReadAll(`
	WITH multi AS (
		SELECT r.reading, CASE
				WHEN r.reading = 'unknown' OR (p.source = 'geonames-features' AND ${geonamesID} IN (SELECT id FROM unknown_class))
				THEN 'unknown-reading' ELSE 'target' END status
		FROM read_parquet(${files}) p JOIN readings r USING (source) WHERE len(span_tags) <> 1),
	single AS (
		SELECT reading, CASE
				WHEN first = 'postcode' THEN 'recognizer'
				WHEN reading = 'unknown' OR gid IN (SELECT id FROM unknown_class) THEN 'unknown-reading'
				WHEN surface IN (SELECT surface FROM shared) THEN 'shared-name-no-prominence'
				ELSE 'target' END status
		FROM singles)
	SELECT reading, status, count(*) n FROM (SELECT * FROM multi UNION ALL SELECT * FROM single)
	GROUP BY ALL ORDER BY ALL`)

console.log(`${ids.length} geonames-features ids without a reading, ${surfaces.length} shared surfaces`)

for (const row of counts.getRowObjectsJson()) {
	console.log(`${row.reading}\t${row.status}\t${row.n}`)
}
