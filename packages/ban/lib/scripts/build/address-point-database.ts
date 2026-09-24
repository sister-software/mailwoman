/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the French rooftop address-point extract from BAN département CSV files using the shared
 *   address-point schema. Each valid row supplies its own number, street, postcode, locality, and
 *   coordinates, which are written directly to the database.
 *
 *   The `rep` suffix is appended to the house number (for example, `8 bis`). Street keys use the
 *   same French normalizer as the lookup tier.
 *
 *   The builder streams rows into a temporary database, creates indexes, analyzes, swaps the result
 *   into place, seals it as mode 0444, and records its checksum and provenance. It writes a separate
 *   BAN artifact and does not modify the OSM extract.
 *
 *   BAN uses the Licence Ouverte / Etalab 2.0, which requires attribution and has no share-alike
 *   clause. The extract uses `source = "ban:fr"`.
 *
 *   Examples:
 *     node packages/ban/lib/scripts/build/address-point-database.ts \
 *       --csv-dir $MAILWOMAN_DATA_ROOT/corpus/sources/ban --release 2026-05-18
 *     # validate on a few départements first:
 *     node packages/ban/lib/scripts/build/address-point-database.ts --depts 48,2A,05 --out /tmp/ban-sample.db
 *     # from an installed package, through the `./scripts/*` export:
 *     node node_modules/@mailwoman/ban/out/scripts/build/address-point-database.js --help
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, removePathIfPresent, makeDirectories } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { prettyJSON } from "@mailwoman/core/json"
import { extractDelimited, parseArguments } from "@mailwoman/core/scripting/arguments"
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
import { Globerator } from "spliterator/node/fs"

import { banDatabasePath } from "#paths"
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
	// Reject unsupported countries rather than selecting an incompatible normalizer.
	streetLocaleForBANCountry(country)
	const csvDir = resolvePath(values["csv-dir"] ?? dataRootPath("corpus", "sources", "ban"))

	if (!(await pathExists(csvDir))) throw new Error(`BAN CSV dir not found: ${csvDir}`)
	const release = values.release ?? "2026-05-18"
	const output = resolvePath(values.out ?? banDatabasePath(`address-points-${country}.db`))

	const depts = values.depts ? extractDelimited(values.depts) : null

	return { country, csvDir, release, output, depts }
}

/**
 * Return département dumps keyed by code.
 *
 * Skip aggregate files, prefer uncompressed CSVs, and optionally restrict the
 * result to selected départements.
 */
async function departementFiles(csvDir: string, depts: string[] | null): Promise<Map<string, string>> {
	const byDept = new Map<string, string>()
	const wanted = depts ? new Set(depts.map((d) => d.toLowerCase())) : null

	for (const name of await Globerator.from("*", { cwd: csvDir, absolute: false }).toSorted()) {
		const m = /^adresses-(.+?)\.csv(\.gz)?$/.exec(name)

		if (!m) continue
		const dept = m[1]!

		// Aggregate files duplicate the département rows.
		if (dept === "merged" || dept === "france") continue

		if (wanted && !wanted.has(dept.toLowerCase())) continue

		const path = `${csvDir}/${name}`
		const existing = byDept.get(dept)

		// Prefer the uncompressed file when both formats exist.
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

				// Append the repetition suffix so the key matches parsed numbers such as "8 bis".
				const number = rec.rep ? `${numTrim} ${rec.rep}` : numTrim

				// Values follow ADDRESS_POINT_COLUMNS order.
				insert.run(
					streetNorm,
					canonicalizeRouteKey(streetNorm),
					number,
					null,
					rec.postcode,
					// Normalize arrondissement names to their base city; other commune names are unchanged.
					rec.city ? stripArrondissement(normalizeLocalityForKey(rec.city)) : null,
					rec.street,
					rec.lat,
					rec.lon,
					source,
					args.release,
					rec.codeInsee,
					rec.certified
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

	// Provenance manifest — additive, written at creation (house discipline).
	// Only for a full national build (the fast --depts validation builds are transient
	// and don't rewrite the record).
	if (!args.depts) {
		const attributionPath = banDatabasePath("ATTRIBUTION.json")

		await writeLocalTextFile(
			prettyJSON({
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
			}),
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
