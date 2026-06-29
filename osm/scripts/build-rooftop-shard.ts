/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a per-country OSM ROOFTOP address-point shard from a Geofabrik `.osm.pbf` extract, on the
 *   SHARED situs schema (`@mailwoman/resolver-wof-sqlite/address-point-schema`) so the existing
 *   `AddressPointSqliteLookup` reads it with zero changes. Address-POINT-first by design: we write the
 *   exact `addr:housenumber` coordinate (node, or building-polygon centroid). Points with no
 *   `addr:street` are COUNTED and skipped (the association gap DeepSeek flagged) — we size that gap
 *   before deciding whether to build the `associatedStreet` / point-in-polygon recovery pass.
 *
 *   ⚠ ODbL: the OUTPUT shard is an OpenStreetMap Derived Database (share-alike). This code carries no
 *   OSM bytes; the obligation rides on the built `.db`. Source = `openstreetmap:<cc>`. See
 *   `osm/README.md` for the licensing boundary + the lawyer sign-off gate before any shard ships.
 *
 *   Usage:
 *     node --experimental-strip-types osm/scripts/build-rooftop-shard.ts \
 *       --country fr --slug idf --release 260627 \
 *       --pbf $MAILWOMAN_DATA_ROOT/osm/geofabrik/ile-de-france-260627.osm.pbf
 */

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"
import { DatabaseClient } from "@mailwoman/core/kysley/client"
import {
	ADDRESS_POINT_COLUMNS,
	type AddressPointDatabase,
	createAddressPointIndexes,
	createAddressPointTable,
} from "@mailwoman/resolver-wof-sqlite/address-point-schema"
import { canonicalizeRouteKey, normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"

import { extractAddrPoints } from "../sdk/extract.js"
import { normalizeStreetForKeyLocale, streetLocaleForCountry } from "../sdk/street-locale.js"
import { buildStreetRecoveryIndex } from "../sdk/street-recovery.js"

interface BuildArgs {
	country: string
	slug: string
	pbf: string
	release: string
	output: string
	/** #250: recover the street for no-`addr:street` points from the nearest named highway. */
	recover: boolean
	recoverRadiusKm: number
}

function parse(): BuildArgs {
	const { values } = parseArgs({
		options: {
			country: { type: "string" },
			slug: { type: "string" },
			pbf: { type: "string" },
			release: { type: "string" },
			out: { type: "string" },
			recover: { type: "boolean" },
			"recover-radius-m": { type: "string" },
		},
	})

	const country = values.country?.toLowerCase()
	const pbf = values.pbf

	if (!country || !pbf) {
		throw new Error("required: --country <cc> --pbf <path.osm.pbf> [--slug <slug>] [--release <tag>] [--out <path>]")
	}

	if (!existsSync(pbf)) throw new Error(`PBF not found: ${pbf}`)
	// Throws for an unsupported country — fail loud, never key with the wrong normalizer.
	streetLocaleForCountry(country)
	const slug = values.slug?.toLowerCase() || country
	const release = values.release || "unknown"
	const output = values.out || dataRootPath("osm", `address-points-${country}-${slug}.db`)
	const recover = Boolean(values.recover)
	const recoverRadiusKm = Number(values["recover-radius-m"] ?? "30") / 1000

	return { country, slug, pbf, release, output, recover, recoverRadiusKm }
}

async function main(): Promise<void> {
	const args = parse()
	const locale = streetLocaleForCountry(args.country)
	const source = `openstreetmap:${args.country}`
	const recoverSource = `${source}#recovered`
	// #250: build the nearest-named-highway index up front (validated ~88% precision @30m on FR ground truth).
	const recoveryIndex = args.recover ? await buildStreetRecoveryIndex(args.pbf) : null

	if (recoveryIndex) {
		console.error(
			`[osm] recovery index: ${recoveryIndex.size.toLocaleString()} highway vertices (radius ${args.recoverRadiusKm * 1000}m)`
		)
	}
	const tmp = `${args.output}.tmp-${process.pid}`

	mkdirSync(dirname(args.output), { recursive: true })

	if (existsSync(tmp)) rmSync(tmp)

	const out = new DatabaseSync(tmp)
	out.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")
	const kdb = new DatabaseClient<AddressPointDatabase>({ database: out })
	await createAddressPointTable(kdb)

	const insert = out.prepare(`INSERT INTO address_point VALUES (${ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`)

	let total = 0
	let written = 0
	let recovered = 0
	let noStreet = 0
	let badCoord = 0
	const BATCH = 50_000

	console.error(`[osm] building ${args.country}/${args.slug} rooftop shard from ${args.pbf}`)
	out.exec("BEGIN")

	for await (const rec of extractAddrPoints(args.pbf)) {
		total++

		if (!Number.isFinite(rec.lat) || !Number.isFinite(rec.lon)) {
			badCoord++
			continue
		}
		// #250: a point with no addr:street recovers its street from the nearest named highway (when --recover).
		let street = rec.street
		let rowSource = source

		if (street == null) {
			const hit = recoveryIndex?.nearest(rec.lon, rec.lat, args.recoverRadiusKm)

			if (!hit) {
				noStreet++
				continue
			}
			street = hit.name
			rowSource = recoverSource
			recovered++
		}
		const streetNorm = normalizeStreetForKeyLocale(street, locale)
		const number = rec.housenumber.trim().toLowerCase()

		if (!streetNorm || !number) {
			noStreet++
			continue
		}
		// Positional, in ADDRESS_POINT_COLUMNS order: street_norm, street_key, number, unit, postcode,
		// locality_norm, street_raw, lat, lon, source, release.
		insert.run(
			streetNorm,
			canonicalizeRouteKey(streetNorm),
			number,
			null,
			rec.postcode?.trim() || null,
			rec.city ? normalizeLocalityForKey(rec.city) : null,
			street,
			rec.lat,
			rec.lon,
			rowSource,
			args.release
		)
		written++

		if (written % BATCH === 0) {
			out.exec("COMMIT")
			out.exec("BEGIN")

			if (written % 500_000 === 0) console.error(`[osm]   ${written.toLocaleString()} written…`)
		}
	}
	out.exec("COMMIT")

	console.error(`[osm] indexing…`)
	await createAddressPointIndexes(kdb)
	out.exec("ANALYZE")
	await kdb.destroy()

	// Build-on-copy: only now swap the freshly-built shard into place (move any prior aside first).
	if (existsSync(args.output)) renameSync(args.output, `${args.output}.prev`)
	renameSync(tmp, args.output)

	if (existsSync(`${args.output}.prev`)) rmSync(`${args.output}.prev`)

	const gap = total > 0 ? ((noStreet / total) * 100).toFixed(1) : "0.0"

	console.error(
		`[osm] DONE ${args.output}\n` +
			`      total addr:housenumber features : ${total.toLocaleString()}\n` +
			`      written total                    : ${written.toLocaleString()}  (of which recovered: ${recovered.toLocaleString()})\n` +
			`      skipped (no addr:street)         : ${noStreet.toLocaleString()}  (${gap}% raw association gap)\n` +
			`      skipped (bad coord)              : ${badCoord.toLocaleString()}\n` +
			`      source                           : ${source}  release=${args.release}  recover=${args.recover}`
	)
}

await main()
