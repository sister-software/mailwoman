/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the DERIVED street-centroid extract (`ban/street-centroids-<cc>.db`, #1042) from the SEALED
 *   rooftop address-point extract (`ban/address-points-<cc>.db`, #1012). No new data source: it is a
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
 *   `ban/street-centroids-<cc>.ATTRIBUTION.json`. Purely additive; it never touches the rooftop extract.
 *
 *   Usage:
 *     node ban/out/scripts/build-street-centroid-extract.js            # fr, default paths
 *     node ban/out/scripts/build-street-centroid-extract.js --country fr --out /tmp/sc-fr.db
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalTextFile, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, removePathIfPresent, makeDirectories } from "@mailwoman/core/fs/writers"
import { gitHead } from "@mailwoman/core/git"
import { md5File } from "@mailwoman/core/hash"
import { tryParsingJSON } from "@mailwoman/core/json"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	type LayerContractDatabase,
	LayerFreshnessPolicy,
	LayerTier,
	writeLayerCoverage,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import { repoRootPath } from "@mailwoman/core/paths"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { isoSeconds } from "@mailwoman/core/utils"
import { foldStreetSurface } from "@mailwoman/resolver"
import type { AddressPointDatabase } from "@mailwoman/resolver-wof-sqlite/address"
import {
	createStreetCentroidIndexes,
	createStreetCentroidTable,
	STREET_CENTROID_COLUMNS,
	type StreetCentroidDatabase,
	type NameKey,
	stripArrondissement,
} from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { dirname, resolvePath } from "path-ts"

import {
	certifiedCoverageCells,
	type CoveragePoint,
	STREET_CENTROID_COVERAGE_RESOLUTION,
	wholeCommunes,
} from "#sdk/coverage"
import { BAN_ATTRIBUTION, BAN_CSV_BASE, BAN_LICENSE } from "#sdk/fetch"
import { streetLocaleForBANCountry } from "#sdk/street-locale"

interface BuildArgs {
	country: string
	source: string
	release: string
	output: string
}

async function parse(): Promise<BuildArgs> {
	const { values } = parseArguments({
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
	const source = resolvePath(values.source ?? dataRootPath("ban", `address-points-${country}.db`))

	if (!(await pathExists(source)))
		throw new Error(`sealed BAN rooftop extract not found: ${source} (build it via #1012 first)`)

	const release = values.release ?? "2026-05-18"
	const output = resolvePath(values.out ?? dataRootPath("ban", `street-centroids-${country}.db`))

	return { country, source, release, output }
}

/**
 * The md5 the #1012 build recorded for the sealed rooftop input, for the derivation provenance chain.
 */
async function sourceMD5(country: string): Promise<string | null> {
	try {
		const rec = tryParsingJSON<{ artifact?: string; md5?: string }>(
			await readLocalTextFile(dataRootPath("ban", "ATTRIBUTION.json")),
			{}
		)

		return rec.artifact === `address-points-${country}.db` ? (rec.md5 ?? null) : null
	} catch {
		return null
	}
}

async function main(): Promise<void> {
	const args = await parse()
	const source = `ban:${args.country}`
	const tmp = `${args.output}.building-${process.pid}.db`

	await makeDirectories(dirname(args.output))

	for (const sfx of ["", "-wal", "-shm"]) {
		await removePathIfPresent(tmp + sfx)
	}

	// The SEALED input — READ-ONLY, immutable; register the base-commune folder as a scalar SQL function.
	using src = new DatabaseClient<AddressPointDatabase>(args.source, { readOnly: true })

	// SQLite hands a scalar function its argument as `unknown`, which erases the key brand. The value is
	// `address_point.locality_norm`, which the shared schema declares a `NameKey` (the builder wrote it through
	// `normalizeLocalityForKey`), so re-minting it here restores a fact the SQL boundary dropped rather than asserting a
	// new one — the fold is NOT re-applied, because a second fold of an already-folded key is what would drift.
	src.function("ban_base_commune", { deterministic: true }, (loc: unknown): string =>
		typeof loc === "string" && loc ? stripArrondissement(loc as NameKey) : ""
	)

	let written = 0

	{
		using kdb = new DatabaseClient<StreetCentroidDatabase & LayerContractDatabase>(tmp)
		kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-1000000;")

		await createStreetCentroidTable(kdb)

		const insert = kdb.prepare(
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

		const BATCH = 50_000

		console.error(`[ban] deriving ${args.country} street-centroid tier from ${args.source}`)

		kdb.exec("BEGIN")

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
				foldStreetSurface(row.street_raw.replaceAll('"', ""))
			)

			written++

			if (written % BATCH === 0) {
				kdb.exec("COMMIT")
				kdb.exec("BEGIN")

				if (written % 500_000 === 0) {
					console.error(`[ban]   ${written.toLocaleString()} streets…`)
				}
			}
		}

		kdb.exec("COMMIT")

		console.error(`[ban] indexing…`)

		await createStreetCentroidIndexes(kdb)

		// The layer contract's two tables (#2150): coverage per res-9 cell from BAN's own certification flag, the
		// commune's whole total deciding the basis, and the manifest that names where the cells live.
		console.error(`[ban] coverage from certification (per commune, ${STREET_CENTROID_COVERAGE_RESOLUTION} cells)…`)

		const flags = new Map<string, number | null>()

		for (const row of src
			.prepare(
				`SELECT admin_code, MIN(COALESCE(certified, -1)) AS minimum FROM address_point
				 WHERE admin_code IS NOT NULL GROUP BY admin_code`
			)
			.iterate() as Iterable<{ admin_code: string; minimum: number }>) {
			flags.set(row.admin_code, row.minimum < 0 ? null : row.minimum)
		}

		const whole = wholeCommunes(flags)

		const cells = certifiedCoverageCells(
			(function* points(): Iterable<CoveragePoint> {
				for (const row of src.prepare(`SELECT lat, lon, admin_code FROM address_point`).iterate() as Iterable<{
					lat: number
					lon: number
					admin_code: string | null
				}>) {
					yield { lat: row.lat, lon: row.lon, adminCode: row.admin_code }
				}
			})(),
			whole
		)

		await createLayerCoverageTable(kdb)
		await createLayerManifestTable(kdb)
		await writeLayerCoverage(kdb, cells)

		await writeLayerManifest(kdb, {
			name: `street-centroids-${args.country}`,
			version: args.release,
			schemaVersion: 1,
			tier: LayerTier.BuildLocal,
			// The SPDX identifier the obligations table knows; `BAN_LICENSE` is the display string ATTRIBUTION.json carries.
			license: "etalab-2.0",
			attribution: BAN_ATTRIBUTION,
			source,
			sourceVintage: args.release,
			buildCmd: "node packages/ban/out/scripts/build-street-centroid-database.js",
			buildSHA: await gitHead(repoRootPath(), { short: true }),
			freshnessPolicy: LayerFreshnessPolicy.VersionedRefresh,
			spineKeys: { h3: { column: "layer_coverage.h3_cell", resolution: STREET_CENTROID_COVERAGE_RESOLUTION } },
			createdAt: isoSeconds(),
		})

		const designated = cells.filter((cell) => cell.basis === "designated").length

		console.error(
			`[ban]   ${whole.size.toLocaleString()} of ${flags.size.toLocaleString()} communes whole; ` +
				`${designated.toLocaleString()} of ${cells.length.toLocaleString()} cells designated`
		)

		kdb.exec("ANALYZE")
	}

	await swapDatabaseIntoPlace(tmp, args.output)
	await sealDatabase(args.output)

	const md5 = await md5File(args.output)
	const bytes = (await statPath(args.output)).size
	const srcMD5 = await sourceMD5(args.country)

	// Provenance manifest — additive, written at creation (house discipline). Records the DERIVATION chain: this
	// artifact is derived from the sealed #1012 rooftop extract, itself derived from the BAN release.
	const attributionPath = dataRootPath("ban", `street-centroids-${args.country}.ATTRIBUTION.json`)

	await writeLocalTextFile(
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
		) + "\n",
		attributionPath
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
