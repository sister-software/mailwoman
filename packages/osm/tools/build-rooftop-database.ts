/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a per-country OSM rooftop address-point extract from a Geofabrik `.osm.pbf` extract, on the
 *   shared situs schema (`@mailwoman/resolver-wof-sqlite/address-point-schema`). The existing
 *   `AddressPointSqliteLookup` reads it with zero changes.
 *
 *   The output is an OpenStreetMap Derivative Database under ODbL 1.0. This code contains no OpenStreetMap
 *   data, and the license applies to the built `.db`, whose rows carry `source = openstreetmap:<cc>`. The
 *   builder prints the license notice before it starts and after it finishes, and records the extract's URL
 *   and SHA-256 in the database's `layer_manifest`. `README.md` states the licensing boundary.
 *
 *   The extract needs the receipt `tools/fetch/extract.ts` writes beside it, or `--source-url` naming where
 *   it was downloaded from.
 *
 *   Usage:
 *     node packages/osm/tools/build-rooftop-database.ts \
 *       --country fr --slug idf --release 260627 \
 *       --created-at 2026-06-27T00:00:00.000Z --build-sha $(git rev-parse head) \
 *       --pbf $MAILWOMAN_DATA_ROOT/db/osm/geofabrik/ile-de-france-260627.osm.pbf
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { removePath, makeDirectories } from "@mailwoman/core/fs/writers"
import { scriptBuildCommand, writeLayerManifest } from "@mailwoman/core/layers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { createAddressPointIndexes } from "@mailwoman/resolver-wof-sqlite/address"
import {
	canonicalizeRouteKey,
	normalizeLocalityForKey,
	normalizeStreetForKeyLocale,
	streetLocaleForSurface,
} from "@mailwoman/resolver-wof-sqlite/street"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed/db"
import { latLngToCell } from "h3-js"
import { dirname, resolvePath } from "path-ts"

import {
	createOSMAddressPointIndexes,
	createOSMAddressPointTables,
	OSM_ADDRESS_H3_RESOLUTION,
	OSM_ADDRESS_POINT_COLUMNS,
	type OSMAddressPointDatabase,
} from "#address-point-schema"
import { osmLicenseNotice } from "#license"
import { osmDatabasePath } from "#paths"
import { extractAddrPoints } from "#sdk/extract"
import { readExtractProvenance } from "#sdk/extract-receipt"
import { buildStreetRecoveryIndex } from "#sdk/street/recovery"
import { streetLocaleForCountry } from "#street-locale"
import { osmAddressPointLayerManifest } from "#tools/layer-manifest"
import { streetNameForms } from "#tools/street-names"

interface BuildArgs {
	country: string
	slug: string
	pbf: string
	release: string
	createdAt: string
	buildSHA: string
	output: string
	/**
	 * Recover the street for points with no `addr:street` from the nearest highway with a name.
	 */
	recover: boolean
	recoverRadiusKm: number
	/**
	 * Where the extract was downloaded from, required when it has no receipt.
	 */
	sourceURL: string | undefined
}

async function parse(): Promise<BuildArgs> {
	const { values } = parseArguments({
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
			"source-url": { type: "string" },
		},
	})

	const country = values.country?.toLowerCase()
	const pbf = values.pbf

	if (!country || !pbf) {
		throw new Error(
			"required: --country <cc> --pbf <path.osm.pbf> --created-at <ISO-8601> --build-sha <git-sha> " +
				"[--slug <slug>] [--release <tag>] [--out <path>] [--source-url <url, when the extract has no receipt>]"
		)
	}

	if (!(await pathExists(pbf))) throw new Error(`PBF not found: ${pbf}`)
	// Throws for an unsupported country, so the build fails loud and never keys with the wrong normalizer.
	streetLocaleForCountry(country)
	const slug = values.slug?.toLowerCase() || country
	const release = values.release || "unknown"
	const createdAt = values["created-at"]
	const buildSHA = values["build-sha"]

	if (!createdAt || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
		throw new Error("required: --created-at <ISO-8601 timestamp>; the builder never invents provenance time")
	}

	if (!buildSHA) throw new Error("required: --build-sha <git-sha>")
	const output = resolvePath(values.out || osmDatabasePath(`address-points-${country}-${slug}.db`))
	const recover = Boolean(values.recover)
	const recoverRadiusKm = Number(values["recover-radius-m"] ?? "30") / 1000

	return {
		country,
		slug,
		pbf,
		release,
		createdAt,
		buildSHA,
		output,
		recover,
		recoverRadiusKm,
		sourceURL: values["source-url"],
	}
}

async function main(): Promise<void> {
	const args = await parse()
	const locale = streetLocaleForCountry(args.country)

	for (const line of osmLicenseNotice(args.output)) {
		console.error(`[osm] ${line}`)
	}

	// Hashed before the build starts, so a file that changed since its receipt stops the build
	// before it spends an hour on bytes the manifest would misidentify.
	const provenance = await readExtractProvenance(args.pbf, { sourceURL: args.sourceURL })

	console.error(`[osm] extract ${provenance.sourceURL} sha256 ${provenance.sourceSHA256}`)

	const source = `openstreetmap:${args.country}`
	const recoverSource = `${source}#recovered`
	const recoveryIndex = args.recover ? await buildStreetRecoveryIndex(args.pbf) : null

	if (recoveryIndex) {
		console.error(
			`[osm] recovery index: ${recoveryIndex.size.toLocaleString()} highway vertices (radius ${args.recoverRadiusKm * 1000}m)`
		)
	}

	const tmp = `${args.output}.tmp-${process.pid}`

	await makeDirectories(dirname(args.output))

	if (await pathExists(tmp)) {
		await removePath(tmp)
	}

	let badCoord = 0
	let noStreet = 0
	let recovered = 0
	let bilingual = 0
	let total = 0
	let written = 0

	{
		using kdb = new DatabaseClient<OSMAddressPointDatabase>(tmp)
		kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")
		await createOSMAddressPointTables(kdb)

		const insert = kdb.prepare(
			`INSERT INTO address_point VALUES (${OSM_ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`
		)

		const BATCH = 50_000

		console.error(`[osm] building ${args.country}/${args.slug} rooftop extract from ${args.pbf}`)

		kdb.exec("BEGIN")

		for await (const rec of extractAddrPoints(args.pbf)) {
			total++

			if (!Number.isFinite(rec.lat) || !Number.isFinite(rec.lon)) {
				badCoord++

				continue
			}

			let street = rec.street
			let rowSource = source

			if (!street) {
				const hit = recoveryIndex?.nearest(rec.lon, rec.lat, args.recoverRadiusKm)

				if (!hit) {
					noStreet++

					continue
				}

				street = hit.name
				rowSource = recoverSource

				recovered++
			}

			// Per-surface locale routing.
			// A French-lead surface folds under the fr rules regardless of the country default.
			// and the probe side routes with the same shared function.
			const streetNorms = [
				...new Set(
					streetNameForms(street)
						.map((form) => normalizeStreetForKeyLocale(form, streetLocaleForSurface(form, locale)))
						.filter((norm) => norm.length > 0)
				),
			]

			const number = rec.housenumber.trim().toLowerCase()

			if (!streetNorms.length || !number) {
				noStreet++

				continue
			}

			const h3Cell = shortCellToInt(latLngToCell(rec.lat, rec.lon, OSM_ADDRESS_H3_RESOLUTION) as H3Cell)
			const locality = rec.suburb ?? rec.city

			// A bilingual street gets one row per language form, each keyed on that form,
			// so a query in either language reaches the same rooftop.
			// `street_raw` keeps the mapped value on every row.
			for (const streetNorm of streetNorms) {
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
					// OSM states no commune key and no certification flag.
					null,
					null,
					h3Cell
				)
			}

			if (streetNorms.length > 1) {
				bilingual++
			}

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

		await writeLayerManifest(
			kdb,
			osmAddressPointLayerManifest({
				country: args.country,
				slug: args.slug,
				release: args.release,
				createdAt: args.createdAt,
				buildSHA: args.buildSHA,
				buildCmd: scriptBuildCommand(import.meta.url),
				provenance,
			})
		)

		kdb.exec("ANALYZE")
	}

	// Build-on-copy.
	// The freshly-built extract is swapped into place only after the build completes.
	await swapDatabaseIntoPlace(tmp, args.output)
	await sealDatabase(args.output)

	const gap = total > 0 ? ((noStreet / total) * 100).toFixed(1) : "0.0"

	console.error(
		`[osm] DONE ${args.output}\n` +
			`      total addr:housenumber features : ${total.toLocaleString()}\n` +
			`      written total                    : ${written.toLocaleString()}  (of which recovered: ${recovered.toLocaleString()})\n` +
			`      bilingual streets (one row per form): ${bilingual.toLocaleString()}\n` +
			`      skipped (no addr:street)         : ${noStreet.toLocaleString()}  (${gap}% raw association gap)\n` +
			`      skipped (bad coord)              : ${badCoord.toLocaleString()}\n` +
			`      source                           : ${source}  release=${args.release}  recover=${args.recover}`
	)

	for (const line of osmLicenseNotice(args.output)) {
		console.error(`[osm] ${line}`)
	}
}

await main()
