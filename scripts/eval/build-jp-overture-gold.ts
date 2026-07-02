/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render the JP Overture eval-gold JSONL (#473 How-JP): an INDEPENDENT check on the shipped JP
 *   resolver, whose 94.9% number was measured against KEN_ALL alone (`jp-resolver-eval.ts`).
 *
 *   What Overture contributes (release 2026-06-17.0, 19.59M JP address points, 100% OA lineage —
 *   Japanese Ministry of Land, Infrastructure and Transport): a REAL-ADDRESS sampling frame (points
 *   where addresses actually exist, vs KEN_ALL's uniform postcode-row enumeration), the municipality
 *   attribution at each point, and a gold COORDINATE per row. What it cannot contribute: postcodes —
 *   the JP postcode fill is ZERO in this release (0/19,587,926, re-verified after the 2026-05-20.0
 *   probe on #473), so the postcode each rendered row carries is joined from KEN_ALL by
 *   (prefecture, municipality) kanji. The postcode→municipality PAIRING therefore still descends
 *   from KEN_ALL (it is the only JP postcode source in existence here — document, don't pretend);
 *   the independent signals are the sampling frame, the municipality gold, and the coordinate.
 *
 *   Row shape (data/eval/external/jp-overture-gold.jsonl): `text` is the native-order 〒 form the
 *   full pipeline would see; `city` + `postcode` are the resolver-level query inputs (mirroring
 *   `jp-resolver-eval.ts`, so the number is comparable to the shipped 94.9%); `muni`/`muni_romaji`/
 *   `pref` are the gold labels; `lat`/`lon` the gold coordinate; `dataset` the per-row provenance.
 *
 *   The representative postcode per municipality is the LOWEST (KEN_ALL lists the NNN-0000
 *   catch-all first) — deterministic, and the catch-all is the postcode that names the municipality
 *   as a whole rather than one 町域.
 *
 *   OOM discipline: reservoir sample via stream()+fetchChunk() (the national-situs pattern);
 *   DuckDB threads/memory capped.
 *
 *   Usage: node scripts/eval/build-jp-overture-gold.ts [--n 4000] [--seed 42]\
 *   [--out data/eval/external/jp-overture-gold.jsonl]
 */

import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"
import { dataRootPath } from "@mailwoman/core/utils"

const RELEASE = "2026-06-17.0"

const { values } = parseArgs({
	options: {
		n: { type: "string" },
		seed: { type: "string" },
		out: { type: "string" },
	},
})

const N = values.n ? Number.parseInt(values.n, 10) : 4000
const SEED = values.seed ? Number.parseInt(values.seed, 10) : 42
const OUT = values.out ?? "data/eval/external/jp-overture-gold.jsonl"
const KENALL = dataRootPath("KEN_ALL_ROME", "KEN_ALL_ROME.CSV")
const PARQUET = path.join(dataRootPath("overture"), RELEASE, "addresses-jp.parquet")

/** Join key: kanji with ideographic + ASCII spaces stripped (KEN_ALL writes 札幌市　中央区; Overture 札幌市中央区). */
function kanjiKey(s: string): string {
	return s.normalize("NFC").replace(/[\s　]/g, "")
}

// ---- KEN_ALL_ROME: (pref kanji, muni kanji) -> { postcode, muni romaji } ----------------------
// Columns: 0 postcode(7), 1 pref kanji, 2 muni kanji, 3 town kanji, 4 pref romaji, 5 muni romaji.
const kenall = new Map<string, { postcode: string; muniRomaji: string }>()
const text = new TextDecoder("shift_jis").decode(readFileSync(KENALL))

for (const raw of text.split("\n")) {
	const f = raw
		.replace(/[\r\n]+$/, "")
		.split(",")
		.map((c) => c.replace(/^"+/, "").replace(/"+$/, ""))

	if (f.length < 6 || f[0]!.length !== 7 || !/^[0-9]+$/.test(f[0]!)) continue
	const key = `${kanjiKey(f[1]!)}|${kanjiKey(f[2]!)}`
	const postcode = `${f[0]!.slice(0, 3)}-${f[0]!.slice(3)}`
	const existing = kenall.get(key)

	// Keep the LOWEST postcode (deterministic; the NNN-0000 catch-all when present).
	if (!existing || postcode < existing.postcode) kenall.set(key, { postcode, muniRomaji: f[5]! })
}

// ---- Sample the Overture points (stream + fetchChunk) -----------------------------------------

const instance = await DuckDBInstance.create()
const duck = await instance.connect()
await duck.run("SET threads=4;")
await duck.run("SET memory_limit='8GB';")

interface GoldRow {
	text: string
	city: string
	postcode: string
	muni: string
	muni_romaji: string
	pref: string
	lat: number
	lon: number
	dataset: string
	source: string
}

const rows: GoldRow[] = []
let noKenallJoin = 0
const stream = await duck.stream(`
	SELECT
		address_levels[1].value AS pref,
		address_levels[2].value AS muni,
		lat, lon,
		sources[1].dataset AS dataset
	FROM read_parquet('${PARQUET}')
	USING SAMPLE reservoir(${N} ROWS) REPEATABLE (${SEED})
`)
const colNames = stream.columnNames()

for (let chunk = await stream.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await stream.fetchChunk()) {
	for (const r of chunk.getRowObjects(colNames) as Array<Record<string, unknown>>) {
		const pref = String(r.pref ?? "")
		const muni = String(r.muni ?? "")
		const lat = Number(r.lat)
		const lon = Number(r.lon)

		if (!pref || !muni || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
		const hit = kenall.get(`${kanjiKey(pref)}|${kanjiKey(muni)}`)

		if (!hit) {
			noKenallJoin++
			continue
		}
		// The romaji CITY TOKEN the resolver-level harness queries with (the first token — the city
		// for designated-city wards, the ward itself for Tokyo specials), matching jp-resolver-eval.ts.
		const city = hit.muniRomaji.split(" ")[0] || hit.muniRomaji
		rows.push({
			text: `〒${hit.postcode} ${pref}${muni}`,
			city,
			postcode: hit.postcode,
			muni,
			muni_romaji: hit.muniRomaji,
			pref,
			lat,
			lon,
			dataset: String(r.dataset ?? "unknown"),
			source: `overture-${RELEASE}`,
		})
	}
}
duck.closeSync()

writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
console.log(
	`jp-overture-gold: ${rows.length} rows -> ${OUT} ` +
		`(sampled ${rows.length + noKenallJoin}, ${noKenallJoin} dropped: no KEN_ALL (pref,muni) join — ` +
		`${((100 * noKenallJoin) / (rows.length + noKenallJoin)).toFixed(1)}%)`
)
