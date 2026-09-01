/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the national FR ROOFTOP address-point extract from the BAN `adresses-<dept>.csv` dumps
 *   (adresse.data.gouv.fr), on the SHARED situs schema (`@mailwoman/resolver-wof-sqlite/address-point-schema`)
 *   so the existing `AddressPointSqliteLookup` reads it with zero changes (#1012). BAN is a structured
 *   government register — every row carries `numero`/`nom_voie`/`code_postal`/`nom_commune`/`lon`/`lat`,
 *   so there is no OSM-style association gap: we write the exact source coordinate for every valid row.
 *
 *   The `rep` (repetition: bis/ter/…) is folded into the house-number key (`"8 bis"`), so a parsed
 *   `"8 bis Rue X"` matches; plain-number rows are keyed on the bare number, unchanged. Keying uses THE
 *   shared FR normalizer (`normalizeStreetForKeyLocale(street, "fr")`) — the identical function the
 *   lookup tier applies at query time, so build-side and probe-side can't drift.
 *
 *   Build discipline (house rules): stream → positional prepared INSERT (batched) → indexes → ANALYZE →
 *   atomic swap into place → SEAL 0444 → record md5 + provenance in `ban/ATTRIBUTION.json`. The output
 *   is a NEW, purely-additive artifact (`ban/address-points-fr.db`); it never touches the OSM extract.
 *
 *   BAN is published under the Licence Ouverte / Etalab 2.0 (attribution, NO share-alike), so the built
 *   extract ships under the same terms as the permissive core — no ODbL lawyer gate. `source = "ban:fr"`.
 *
 *   Usage:
 *     node ban/out/scripts/build-address-point-extract.js \
 *       --csv-dir $MAILWOMAN_DATA_ROOT/corpus/sources/ban --release 2026-05-18
 *     # validate on a few départements first:
 *     node ban/out/scripts/build-address-point-extract.js --depts 48,2A,05 --out /tmp/ban-sample.db
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readDirectory, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, removePathIfPresent, makeDirectories } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import {
	ADDRESS_POINT_COLUMNS,
	type AddressPointDatabase,
	createAddressPointIndexes,
	createAddressPointTable,
} from "@mailwoman/resolver-wof-sqlite/address"
import {
	canonicalizeRouteKey,
	normalizeLocalityForKey,
	normalizeStreetForKeyLocale,
	stripArrondissement,
} from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { dirname, resolvePath } from "path-ts"

import { extractBANAddrPoints } from "#sdk/extract"
import { BAN_ATTRIBUTION, BAN_CSV_BASE, BAN_LICENSE } from "#sdk/fetch"
import { streetLocaleForBANCountry } from "#sdk/street-locale"

interface BuildArgs {
	country: string
	csvDir: string
	release: string
	output: string
	depts: string[] | null
}

async function parse(): Promise<BuildArgs> {
	const { values } = parseArguments({
		options: {
			country: { type: "string" },
			"csv-dir": { type: "string" },
			release: { type: "string" },
			out: { type: "string" },
			depts: { type: "string" },
		},
	})

	const country = (values.country ?? "fr").toLowerCase()
	// Throws for an unsupported country — fail loud, never key with the wrong normalizer.
	streetLocaleForBANCountry(country)
	const csvDir = resolvePath(values["csv-dir"] ?? dataRootPath("corpus", "sources", "ban"))

	if (!(await pathExists(csvDir))) throw new Error(`BAN CSV dir not found: ${csvDir}`)
	const release = values.release ?? "2026-05-18"
	const output = resolvePath(values.out ?? dataRootPath("ban", `address-points-${country}.db`))

	const depts = values.depts
		? values.depts
				.split(",")
				.map((d) => d.trim())
				.filter((d) => d.length > 0)
		: null

	return { country, csvDir, release, output, depts }
}

/**
 * Enumerate the per-département BAN dumps in `csvDir`, keyed by département code. Excludes the `merged` / `france`
 * aggregates (they duplicate the per-département rows), and prefers an uncompressed `.csv` over a `.csv.gz` when both
 * exist (the same dept, faster read). When `depts` is set, restricts to that list (for a fast validation build).
 */
async function departementFiles(csvDir: string, depts: string[] | null): Promise<Map<string, string>> {
	const byDept = new Map<string, string>()
	const wanted = depts ? new Set(depts.map((d) => d.toLowerCase())) : null

	for (const name of (await readDirectory(csvDir)).toSorted()) {
		const m = /^adresses-(.+?)\.csv(\.gz)?$/.exec(name)

		if (!m) continue
		const dept = m[1]!

		// The aggregate dumps double-count the per-département rows — skip them.
		if (dept === "merged" || dept === "france") continue

		if (wanted && !wanted.has(dept.toLowerCase())) continue

		const path = `${csvDir}/${name}`
		const existing = byDept.get(dept)

		// Prefer the uncompressed .csv over a .csv.gz for the same dept.
		if (!existing || (existing.endsWith(".gz") && !name.endsWith(".gz"))) {
			byDept.set(dept, path)
		}
	}

	return byDept
}

async function main(): Promise<void> {
	const args = await parse()
	const locale = streetLocaleForBANCountry(args.country)
	const source = `ban:${args.country}`
	const files = await departementFiles(args.csvDir, args.depts)

	if (!files.size) throw new Error(`no BAN département dumps found in ${args.csvDir}`)
	const tmp = `${args.output}.building-${process.pid}.db`

	await makeDirectories(dirname(args.output))

	for (const sfx of ["", "-wal", "-shm"]) {
		await removePathIfPresent(tmp + sfx)
	}

	const deptList = [...files.keys()].toSorted()
	let noStreet = 0
	let total = 0
	let written = 0

	{
		using kdb = new DatabaseClient<AddressPointDatabase>(tmp)
		kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")
		await createAddressPointTable(kdb)

		const insert = kdb.prepare(`INSERT INTO address_point VALUES (${ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`)

		const BATCH = 50_000

		console.error(`[ban] building ${args.country} rooftop extract from ${files.size} départements in ${args.csvDir}`)

		kdb.exec("BEGIN")

		for (const dept of deptList) {
			const path = files.get(dept)!

			for await (const rec of extractBANAddrPoints(path)) {
				total++
				const streetNorm = normalizeStreetForKeyLocale(rec.street, locale)
				const numTrim = rec.numero.trim().toLowerCase()

				if (!streetNorm || !numTrim) {
					noStreet++

					continue
				}

				// Fold `rep` into the house-number key: "8" + "bis" → "8 bis" (matches a parsed "8 bis Rue X").
				const number = rec.rep ? `${numTrim} ${rec.rep}` : numTrim

				// Positional, in ADDRESS_POINT_COLUMNS order: street_norm, street_key, number, unit, postcode,
				// locality_norm, street_raw, lat, lon, source, release.
				insert.run(
					streetNorm,
					canonicalizeRouteKey(streetNorm),
					number,
					null,
					rec.postcode,
					// Arrondissement communes fold to the base city ("paris 13e arrondissement" → "paris") —
					// the SAME both-sides discipline the #1042 street-centroid key uses, so a query's
					// "Paris" hits directly (fr-chevaleret-bare). No-op for every other commune.
					rec.city ? stripArrondissement(normalizeLocalityForKey(rec.city)) : null,
					rec.street,
					rec.lat,
					rec.lon,
					source,
					args.release
				)

				written++

				if (written % BATCH === 0) {
					kdb.exec("COMMIT")
					kdb.exec("BEGIN")

					if (written % 2_000_000 === 0) {
						console.error(`[ban]   ${written.toLocaleString()} written…`)
					}
				}
			}

			console.error(`[ban]   dept ${dept}: ${written.toLocaleString()} cumulative`)
		}

		kdb.exec("COMMIT")

		console.error(`[ban] indexing…`)

		await createAddressPointIndexes(kdb)
		kdb.exec("ANALYZE")
	}

	await swapDatabaseIntoPlace(tmp, args.output)
	await sealDatabase(args.output)

	const md5 = await md5File(args.output)
	const bytes = (await statPath(args.output)).size

	// Provenance manifest — additive, written at creation (house discipline). Only for a FULL national build
	// (the fast --depts validation builds are transient and don't rewrite the record).
	if (!args.depts) {
		const attributionPath = dataRootPath("ban", "ATTRIBUTION.json")

		await writeLocalTextFile(
			JSON.stringify(
				{
					artifact: `address-points-${args.country}.db`,
					source,
					sourceURL: BAN_CSV_BASE,
					license: BAN_LICENSE,
					attribution: BAN_ATTRIBUTION,
					release: args.release,
					departements: deptList.length,
					totalPoints: written,
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
	}

	console.error(
		`[ban] DONE ${args.output}\n` +
			`      départements                     : ${deptList.length}\n` +
			`      total source rows                : ${total.toLocaleString()}\n` +
			`      written points                   : ${written.toLocaleString()}\n` +
			`      skipped (no street/number)       : ${noStreet.toLocaleString()}\n` +
			`      bytes                            : ${bytes.toLocaleString()}\n` +
			`      md5                              : ${md5}\n` +
			`      source                           : ${source}  release=${args.release}  license=${BAN_LICENSE}`
	)
}

await main()
