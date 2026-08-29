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
 *     node osm/scripts/build-rooftop-shard.ts \
 *       --country fr --slug idf --release 260627 \
 *       --created-at 2026-06-27T00:00:00.000Z --build-sha $(git rev-parse HEAD) \
 *       --pbf $MAILWOMAN_DATA_ROOT/osm/geofabrik/ile-de-france-260627.osm.pbf
 */

import { LayerFreshnessPolicy, LayerTier, writeLayerManifest } from "@mailwoman/core/layers"
import { dataRootPath } from "@mailwoman/core/utils"
import { existsSync, mkdirSync, rmSync } from "@mailwoman/platform/fs"
import { dirname } from "@mailwoman/platform/path"
import { parseArgs } from "@mailwoman/platform/util"
import { createAddressPointIndexes } from "@mailwoman/resolver-wof-sqlite/address-point-schema"
import { canonicalizeRouteKey, normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { latLngToCell } from "h3-js"

import {
	createOSMAddressPointIndexes,
	createOSMAddressPointTables,
	OSM_ADDRESS_H3_RESOLUTION,
	OSM_ADDRESS_POINT_COLUMNS,
	type OSMAddressPointDatabase,
} from "../sdk/address-point-schema.ts"
import { extractAddrPoints } from "../sdk/extract.ts"
import { normalizeStreetForKeyLocale, streetLocaleForCountry, streetLocaleForSurface } from "../sdk/street-locale.ts"
import { buildStreetRecoveryIndex } from "../sdk/street-recovery.ts"

interface BuildArgs {
	country: string
	slug: string
	pbf: string
	release: string
	createdAt: string
	buildSHA: string
	output: string
	/**
	 * #250: recover the street for no-`addr:street` points from the nearest named highway.
	 */
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
			"created-at": { type: "string" },
			"build-sha": { type: "string" },
			out: { type: "string" },
			recover: { type: "boolean" },
			"recover-radius-m": { type: "string" },
		},
	})

	const country = values.country?.toLowerCase()
	const pbf = values.pbf

	if (!country || !pbf) {
		throw new Error(
			"required: --country <cc> --pbf <path.osm.pbf> --created-at <ISO-8601> --build-sha <git-sha> " +
				"[--slug <slug>] [--release <tag>] [--out <path>]"
		)
	}

	if (!existsSync(pbf)) throw new Error(`PBF not found: ${pbf}`)
	// Throws for an unsupported country — fail loud, never key with the wrong normalizer.
	streetLocaleForCountry(country)
	const slug = values.slug?.toLowerCase() || country
	const release = values.release || "unknown"
	const createdAt = values["created-at"]
	const buildSHA = values["build-sha"]

	if (!createdAt || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
		throw new Error("required: --created-at <ISO-8601 timestamp>; the builder never invents provenance time")
	}

	if (!buildSHA) throw new Error("required: --build-sha <git-sha>")
	const output = values.out || dataRootPath("osm", `address-points-${country}-${slug}.db`)
	const recover = Boolean(values.recover)
	const recoverRadiusKm = Number(values["recover-radius-m"] ?? "30") / 1000

	return { country, slug, pbf, release, createdAt, buildSHA, output, recover, recoverRadiusKm }
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

	if (existsSync(tmp)) {
		rmSync(tmp)
	}

	const kdb = new DatabaseClient<OSMAddressPointDatabase>(tmp)
	kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")
	await createOSMAddressPointTables(kdb)

	const insert = kdb.prepare(
		`INSERT INTO address_point VALUES (${OSM_ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`
	)

	let total = 0
	let written = 0
	let recovered = 0
	let noStreet = 0
	let badCoord = 0
	const BATCH = 50_000

	console.error(`[osm] building ${args.country}/${args.slug} rooftop shard from ${args.pbf}`)

	kdb.exec("BEGIN")

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

		// Per-SURFACE locale routing (the Québec finishing move): a French-lead surface folds under the fr
		// rules whatever the country default; the probe side routes with the same shared function.
		const streetNorm = normalizeStreetForKeyLocale(street, streetLocaleForSurface(street, locale))
		const number = rec.housenumber.trim().toLowerCase()

		if (!streetNorm || !number) {
			noStreet++

			continue
		}

		const h3Cell = shortCellToInt(latLngToCell(rec.lat, rec.lon, OSM_ADDRESS_H3_RESOLUTION) as H3Cell)
		const locality = rec.suburb ?? rec.city

		// Positional, in OSM_ADDRESS_POINT_COLUMNS order: the shared address columns, then h3_cell.
		insert.run(
			streetNorm,
			canonicalizeRouteKey(streetNorm),
			number,
			null,
			rec.postcode?.trim() || null,
			locality ? normalizeLocalityForKey(locality) : null,
			street,
			rec.lat,
			rec.lon,
			rowSource,
			args.release,
			h3Cell
		)

		written++

		if (written % BATCH === 0) {
			kdb.exec("COMMIT")
			kdb.exec("BEGIN")

			if (written % 500_000 === 0) {
				console.error(`[osm]   ${written.toLocaleString()} written…`)
			}
		}
	}

	kdb.exec("COMMIT")

	console.error(`[osm] indexing…`)

	await createAddressPointIndexes(kdb)
	await createOSMAddressPointIndexes(kdb)

	await writeLayerManifest(kdb, {
		name: `osm-address-points-${args.country}-${args.slug}`,
		version: args.release,
		schemaVersion: 1,
		tier: LayerTier.BuildLocal,
		license: "ODbL-1.0",
		attribution: "© OpenStreetMap contributors",
		source,
		sourceVintage: args.release,
		// The path this recorded — `osm/out/scripts/build-rooftop-shard.js` — moved under `packages/` in the
		// workspace regroup, and the literal survived INSIDE every shard built before then, where no lint can
		// reach it. `mailwoman data inventory` is what surfaced it, on three shipped artifacts that pass every
		// "has a manifest" check and cannot be rebuilt from what they say.
		buildCmd: "node packages/osm/out/scripts/build-rooftop-shard.js",
		buildSHA: args.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: { h3: { column: "h3_cell", resolution: OSM_ADDRESS_H3_RESOLUTION } },
		createdAt: args.createdAt,
	})

	kdb.exec("ANALYZE")
	await kdb.destroy()

	// Build-on-copy: only now swap the freshly-built shard into place.
	swapDatabaseIntoPlace(tmp, args.output)
	sealDatabase(args.output)

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
