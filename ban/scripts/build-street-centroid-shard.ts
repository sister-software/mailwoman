/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the DERIVED street-centroid shard (`ban/street-centroids-<cc>.db`, #1042) from the SEALED
 *   rooftop address-point shard (`ban/address-points-<cc>.db`, #1012). No new data source: it is a
 *   `GROUP BY street` roll-up of the register we already ingested — one row per (street_norm, postcode,
 *   commune) carrying the street's CENTROID + bounding-box EXTENT + member-point count. The output feeds
 *   `StreetCentroidSqliteLookup`, the street-level tier for a street-only query (a thoroughfare with NO
 *   house number) that no address-POINT tier can serve by definition.
 *
 *   The commune is the arrondissement-STRIPPED base commune (`stripArrondissement` — BAN names
 *   Paris/Lyon/Marseille rows per arrondissement, but a query names the base commune); the aggregation
 *   groups on the full `locality_norm` and emits the base, so a rare (street, postcode, base) collision
 *   across two arrondissements is merged harmlessly by the reader's weighted aggregate.
 *
 *   The SEALED input is opened READ-ONLY and NEVER modified. Build discipline (house rules): aggregate
 *   in SQLite → stream via `.iterate()` → positional prepared INSERT (batched) into a staging DB →
 *   indexes → ANALYZE → atomic swap into place → SEAL 0444 → record md5 + the derivation provenance in
 *   `ban/street-centroids-<cc>.ATTRIBUTION.json`. Purely additive; it never touches the rooftop shard.
 *
 *   Usage:
 *     node ban/out/scripts/build-street-centroid-shard.js            # fr, default paths
 *     node ban/out/scripts/build-street-centroid-shard.js --country fr --out /tmp/sc-fr.db
 */

import { createHash } from "node:crypto"
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { runIfScript } from "@mailwoman/core/scripting"
import { dataRootPath, sealDatabase } from "@mailwoman/core/utils"
import { foldStreetSurface } from "@mailwoman/resolver"
import {
	createStreetCentroidIndexes,
	createStreetCentroidTable,
	STREET_CENTROID_COLUMNS,
	type StreetCentroidDatabase,
} from "@mailwoman/resolver-wof-sqlite/street-centroid-schema"
import { stripArrondissement } from "@mailwoman/resolver-wof-sqlite/street-normalize"

import { BAN_ATTRIBUTION, BAN_CSV_BASE, BAN_LICENSE } from "../sdk/fetch.ts"
import { streetLocaleForBANCountry } from "../sdk/street-locale.ts"

interface BuildArgs {
	country: string
	source: string
	release: string
	output: string
}

function parse(): BuildArgs {
	const { values } = parseArgs({
		options: {
			country: { type: "string" },
			source: { type: "string" },
			release: { type: "string" },
			out: { type: "string" },
		},
	})

	const country = (values.country ?? "fr").toLowerCase()
	// Throws for an unsupported country — fail loud, never derive a tier keyed with the wrong locale rules.
	streetLocaleForBANCountry(country)
	const source = values.source ?? dataRootPath("ban", `address-points-${country}.db`)

	if (!existsSync(source)) throw new Error(`sealed BAN rooftop shard not found: ${source} (build it via #1012 first)`)
	const release = values.release ?? "2026-05-18"
	const output = values.out ?? dataRootPath("ban", `street-centroids-${country}.db`)

	return { country, source, release, output }
}

/** Streaming md5 of a file (never buffer a multi-GB artifact). */
async function fileMD5(path: string): Promise<string> {
	const hash = createHash("md5")

	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer)
	}

	return hash.digest("hex")
}

/** The md5 the #1012 build recorded for the sealed rooftop input, for the derivation provenance chain. */
function sourceMD5(country: string): string | null {
	try {
		const rec = JSON.parse(readFileSync(dataRootPath("ban", "ATTRIBUTION.json"), "utf8")) as {
			artifact?: string
			md5?: string
		}

		return rec.artifact === `address-points-${country}.db` ? (rec.md5 ?? null) : null
	} catch {
		return null
	}
}

async function main(): Promise<void> {
	const args = parse()
	const source = `ban:${args.country}`
	const tmp = `${args.output}.building-${process.pid}.db`

	mkdirSync(dirname(args.output), { recursive: true })

	for (const sfx of ["", "-wal", "-shm"]) {
		rmSync(tmp + sfx, { force: true })
	}

	// The SEALED input — READ-ONLY, immutable; register the base-commune folder as a scalar SQL function.
	const src = new DatabaseSync(args.source, { readOnly: true })

	src.function("ban_base_commune", { deterministic: true }, (loc: unknown): string =>
		typeof loc === "string" && loc ? stripArrondissement(loc) : ""
	)

	const out = new DatabaseSync(tmp)

	out.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-1000000;")
	const kdb = new DatabaseClient<StreetCentroidDatabase>({ database: out })

	await createStreetCentroidTable(kdb)

	const insert = out.prepare(
		`INSERT INTO street_centroid VALUES (${STREET_CENTROID_COLUMNS.map(() => "?").join(", ")})`
	)

	// GROUP BY the sealed rooftop points into per-(street, postcode, commune) roll-ups. AVG(lat/lon) over the group's
	// member points is the exact centroid; MIN/MAX is the extent; COUNT is the weight for the reader's cross-group mean.
	// The base commune is emitted per group (2.2M calls), NOT per source row.
	const agg = src.prepare(
		`SELECT street_norm,
		        postcode,
		        ban_base_commune(locality_norm) AS locality_base,
		        AVG(lat) AS lat, AVG(lon) AS lon,
		        MIN(lat) AS min_lat, MAX(lat) AS max_lat, MIN(lon) AS min_lon, MAX(lon) AS max_lon,
		        COUNT(*) AS n,
		        MIN(street_raw) AS street_raw
		 FROM address_point
		 GROUP BY street_norm, postcode, locality_norm`
	)

	let written = 0
	const BATCH = 50_000

	console.error(`[ban] deriving ${args.country} street-centroid tier from ${args.source}`)
	out.exec("BEGIN")

	for (const row of agg.iterate() as Iterable<{
		street_norm: string
		postcode: string | null
		locality_base: string
		lat: number
		lon: number
		min_lat: number
		max_lat: number
		min_lon: number
		max_lon: number
		n: number
		street_raw: string
	}>) {
		// Positional, in STREET_CENTROID_COLUMNS order.
		insert.run(
			row.street_norm,
			row.postcode,
			row.locality_base,
			row.lat,
			row.lon,
			row.min_lat,
			row.max_lat,
			row.min_lon,
			row.max_lon,
			row.n,
			row.street_raw,
			source,
			args.release,
			// #727 phase-4c name-existence key: the contract fold of the display name, quotes stripped (a rare CSV
			// artifact). The rerank folds the model's street surface with this SAME function (the fold-parity contract).
			foldStreetSurface(row.street_raw.replace(/"/g, ""))
		)
		written++

		if (written % BATCH === 0) {
			out.exec("COMMIT")
			out.exec("BEGIN")

			if (written % 500_000 === 0) {
				console.error(`[ban]   ${written.toLocaleString()} streets…`)
			}
		}
	}
	out.exec("COMMIT")
	src.close()

	console.error(`[ban] indexing…`)
	await createStreetCentroidIndexes(kdb)
	out.exec("ANALYZE")
	await kdb.destroy()

	// Atomic swap into place (move any prior aside first), then SEAL 0444.
	if (existsSync(args.output)) {
		renameSync(args.output, `${args.output}.prev`)
	}

	for (const sfx of ["-wal", "-shm"]) {
		rmSync(args.output + sfx, { force: true })
	}
	renameSync(tmp, args.output)

	if (existsSync(`${args.output}.prev`)) {
		rmSync(`${args.output}.prev`, { force: true })
	}
	sealDatabase(args.output)

	const md5 = await fileMD5(args.output)
	const bytes = statSync(args.output).size
	const srcMD5 = sourceMD5(args.country)

	// Provenance manifest — additive, written at creation (house discipline). Records the DERIVATION chain: this
	// artifact is derived from the sealed #1012 rooftop shard, itself derived from the BAN release.
	const attributionPath = dataRootPath("ban", `street-centroids-${args.country}.ATTRIBUTION.json`)

	writeFileSync(
		attributionPath,
		JSON.stringify(
			{
				artifact: `street-centroids-${args.country}.db`,
				derivedFrom: {
					artifact: `address-points-${args.country}.db`,
					source,
					release: args.release,
					md5: srcMD5,
					note: `derived from ${source} release=${args.release}${srcMD5 ? ` (md5 ${srcMD5.slice(0, 8)})` : ""}`,
				},
				source,
				sourceURL: BAN_CSV_BASE,
				license: BAN_LICENSE,
				attribution: BAN_ATTRIBUTION,
				release: args.release,
				streets: written,
				bytes,
				md5,
				builtAt: new Date().toISOString(),
			},
			null,
			2
		) + "\n"
	)
	console.error(`[ban] wrote ${attributionPath}`)

	console.error(
		`[ban] DONE ${args.output}\n` +
			`      streets (rows)                   : ${written.toLocaleString()}\n` +
			`      bytes                            : ${bytes.toLocaleString()}\n` +
			`      md5                              : ${md5}\n` +
			`      derived from                     : address-points-${args.country}.db${srcMD5 ? ` (md5 ${srcMD5.slice(0, 8)})` : ""}  release=${args.release}`
	)
}

runIfScript(import.meta, main)
