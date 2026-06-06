#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the points-only slim WOF DB the demo resolver opens — the geojson-free sibling of
 *   `build-slim`. `build-slim` requires a `geojson` table (to derive bbox + population), which we
 *   no longer have as a SQLite distribution for non-US locales. But everything the resolver needs
 *   at query time already lives WITHOUT geojson: `place_bbox` builds from `spr.min/max_lat/lon`,
 *   `place_search` from `names`, and `place_population` is its own copyable table in the priority
 *   DB.
 *
 *   So this re-creates `wof-hot.db` (read-only inputs, nothing mutated) for an arbitrary country set
 *   from the spr-format sources: the unified admin priority DB (localities + the ancestor chain,
 *   ranked by the `place_population` table) plus per-locale postcode DBs (US ZIPs, DE/intl
 *   postcodes). Output schema is identical to build-slim's, so `WofSqlitePlaceLookup` / the WASM
 *   resolver open it with zero code change. The crisp polygons are a SEPARATE DB
 *   (build-wof-polygons) loaded lazily.
 *
 *   Usage: node scripts/build-wof-points.mjs --out <wof-hot.db> --countries US,DE [--top 5000]
 */

import { existsSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { buildPlaceSearchFts } from "../resolver-wof-sqlite/out/fts.js"

const WOF = "/mnt/playpen/mailwoman-data/wof"
const ADMIN = `${WOF}/admin-global-priority.db`
const POSTCODE_SOURCES = [`${WOF}/postalcode-us.db`, `${WOF}/postalcode-intl.db`]
const ANCESTORS = ["country", "region", "county", "borough", "macroregion"]

function parseArgs() {
	const a = process.argv.slice(2)
	const out = { output: "", countries: ["US", "DE"], top: 5000 }
	for (let i = 0; i < a.length; i++) {
		if (a[i] === "--out") out.output = a[++i]
		else if (a[i] === "--countries") out.countries = a[++i].split(",").map((c) => c.trim().toUpperCase())
		else if (a[i] === "--top") out.top = parseInt(a[++i], 10)
	}
	if (!out.output) {
		console.error("usage: build-wof-points.mjs --out <wof-hot.db> --countries US,DE [--top 5000]")
		process.exit(2)
	}
	return out
}

const opts = parseArgs()
const inList = opts.countries.map((c) => `'${c.replace(/'/g, "")}'`).join(",")

if (existsSync(opts.output)) rmSync(opts.output)
const out = new DatabaseSync(opts.output)

// Schema mirrors the priority DB (spr carries the bbox columns place_bbox is built from).
const src0 = new DatabaseSync(ADMIN, { readOnly: true })
for (const t of ["spr", "names", "place_population"]) {
	const r = src0.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(t)
	if (!r?.sql) throw new Error(`admin priority DB missing required table '${t}'`)
	out.exec(r.sql)
}
src0.close()
out.exec(`CREATE INDEX IF NOT EXISTS names_id_idx ON names(id);`)

// Explicit column lists keep INSERT…SELECT safe across schemas that share names but differ in order.
const sprCols = out
	.prepare(`SELECT name FROM pragma_table_info('spr')`)
	.all()
	.map((r) => r.name)
const sprColList = sprCols.join(", ")
const namesCols = out
	.prepare(`SELECT name FROM pragma_table_info('names')`)
	.all()
	.map((r) => r.name)
	.join(", ")

function hasTable(db, name) {
	return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)
}

function copyFrom(path, { localities, postcodes }) {
	if (!existsSync(path)) {
		console.error(`  skip (absent): ${path}`)
		return
	}
	out.exec(`ATTACH DATABASE '${path.replace(/'/g, "''")}' AS src;`)
	try {
		const srcSprCols = out
			.prepare(`SELECT name FROM pragma_table_info('spr', 'src')`)
			.all()
			.map((r) => r.name)
		const shared = sprCols.filter((c) => srcSprCols.includes(c)).join(", ")
		const base = `is_current!=0 AND is_deprecated=0 AND country IN (${inList})`

		// Ancestor chain — always kept so parent_id resolution stays intact.
		out.exec(
			`INSERT OR IGNORE INTO spr (${shared}) SELECT ${shared} FROM src.spr WHERE ${base} AND placetype IN (${ANCESTORS.map((p) => `'${p}'`).join(",")});`
		)
		const srcHasPop = !!out
			.prepare(`SELECT 1 FROM src.sqlite_master WHERE type='table' AND name='place_population'`)
			.get()
		if (localities) {
			const hasPop = srcHasPop
			for (const c of opts.countries) {
				const join = hasPop ? `LEFT JOIN src.place_population p ON p.id=s.id` : ``
				const order = hasPop ? `ORDER BY COALESCE(p.population,0) DESC` : ``
				out.exec(
					`INSERT OR IGNORE INTO spr (${shared}) SELECT ${shared
						.split(", ")
						.map((c2) => `s.${c2}`)
						.join(
							", "
						)} FROM src.spr s ${join} WHERE s.is_current!=0 AND s.is_deprecated=0 AND s.country='${c}' AND s.placetype='locality' ${order} LIMIT ${opts.top};`
				)
			}
		}
		if (postcodes) {
			out.exec(
				`INSERT OR IGNORE INTO spr (${shared}) SELECT ${shared} FROM src.spr WHERE ${base} AND placetype='postalcode';`
			)
		}
		// names + place_population for the IDs we just pulled.
		const srcNamesCols = out
			.prepare(`SELECT name FROM pragma_table_info('names', 'src')`)
			.all()
			.map((r) => r.name)
		const sharedNames = namesCols
			.split(", ")
			.filter((c) => srcNamesCols.includes(c))
			.join(", ")
		out.exec(
			`INSERT OR IGNORE INTO names (${sharedNames}) SELECT ${sharedNames} FROM src.names WHERE id IN (SELECT id FROM spr);`
		)
		if (srcHasPop) {
			out.exec(
				`INSERT OR IGNORE INTO place_population SELECT * FROM src.place_population WHERE id IN (SELECT id FROM spr);`
			)
		}
	} finally {
		out.exec(`DETACH DATABASE src;`)
	}
}

console.error(`Building ${opts.output} for [${opts.countries.join(",")}], top ${opts.top} localities/country`)
copyFrom(ADMIN, { localities: true, postcodes: true })
for (const pc of POSTCODE_SOURCES) copyFrom(pc, { postcodes: true })

console.error(`spr=${out.prepare("SELECT count(*) n FROM spr").get().n}, building FTS + bbox...`)
buildPlaceSearchFts(out, { drop: true })
out.exec(`VACUUM;`)
const counts = {
	spr: out.prepare("SELECT count(*) n FROM spr").get().n,
	postcodes: out.prepare("SELECT count(*) n FROM spr WHERE placetype='postalcode'").get().n,
	localities: out.prepare("SELECT count(*) n FROM spr WHERE placetype='locality'").get().n,
	population: out.prepare("SELECT count(*) n FROM place_population").get().n,
}
out.close()
console.error(`✓ ${opts.output}: ${JSON.stringify(counts)}`)
