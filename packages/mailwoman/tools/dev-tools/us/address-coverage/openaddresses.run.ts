/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Merges the OpenAddresses source runs a plan file lists into their state address-point databases.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/us/address-coverage/openaddresses.run.ts \
 *   --plan <plan.json> --release <date> [--states nh,nv]
 *
 *   The plan is a JSON array of `{ member, license }`, such as `{ "member": "us/nh/statewide", "license": null }`.
 *   Each state builds beside its database and swaps into place once sealed.
 */

import { currentSourcePath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { openWriteStream, pipeline, Readable } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, movePath, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { extractZipEntry } from "@mailwoman/core/fs/zip"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { isAdmittedSource } from "@mailwoman/corpus/address-records/admission"
import { ADDRESS_POINT_H3_RESOLUTION } from "@mailwoman/resolver-wof-sqlite/address/point/spine-schema"
import { addressPointDatabasePath, interpolationDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { shortCellToInt } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed/db"
import { latLngToCell } from "@sister.software/h3"
import { CSVSpliterator } from "spliterator"

import {
	type OpenAddressesRecord,
	openAddressesRow,
	postcodeNearPoint,
	repeatsStoredPoint,
} from "#tools/dev-tools/us/address-coverage/openaddresses"

const { values } = parseArguments({
	options: { plan: { type: "string" }, release: { type: "string" }, states: { type: "string" } },
})

if (!values.plan || !values.release) throw new Error("--plan and --release are required")

const release = values.release
const plan = await readLocalJSONFile<Array<{ member: string; license: unknown }>>(values.plan)
const only = values.states ? new Set(values.states.split(",")) : null
const cache = currentSourcePath("openaddresses")

await makeDirectories(cache)

const admitted = plan.filter((source) => isAdmittedSource(source.member, source.license))
const states = new Map<string, string[]>()

for (const { member } of admitted) {
	const state = member.split("/")[1]!

	if (!only || only.has(state)) {
		states.set(state, [...(states.get(state) ?? []), member])
	}
}

console.log(`plan ${plan.length}, admitted ${admitted.length}, states ${states.size}`)

await using scratch = await temporaryDirectory("us-openaddresses-")

for (const [state, members] of states) {
	const out = addressPointDatabasePath(`address-points-us-${state}.db`)
	const tmp = `${out.toString()}.tmp-${process.pid}`

	await removePathIfPresent(tmp)

	if (await pathExists(out)) {
		using source = new DatabaseClient<never>(out, { readOnly: true })

		source.exec(`VACUUM INTO '${tmp}'`)
	} else {
		throw new Error(`No address-point database for ${state} at ${out.toString()}`)
	}

	let read = 0
	let added = 0
	let repeated = 0
	let unusable = 0
	const missing: string[] = []

	{
		using db = new DatabaseClient<never>(tmp)

		const columns = (db.prepare("PRAGMA table_info(address_point)").all() as Array<{ name: string }>).map(
			(column) => column.name
		)

		// The repeat check below reads this index, and the lookup's search around a locality requires it.
		db.exec("CREATE INDEX IF NOT EXISTS idx_ap_street ON address_point (street_norm, number)")

		// A rerun replaces its own earlier rows.
		// A bare `openaddresses` source came from another build and stays.
		db.exec("DELETE FROM address_point WHERE source LIKE 'openaddresses:us/%'")

		const hasCell = columns.includes("h3_cell")
		const stored = db.prepare("SELECT lat, lon FROM address_point WHERE street_norm = ? AND number = ?")

		const insert = db.prepare(
			`INSERT INTO address_point (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
		)

		// Most runs state no postcode, and a street segment holding the number states one.
		using segments = new DatabaseClient<never>(interpolationDatabasePath(`interpolation-us-${state}.db`), {
			readOnly: true,
		})

		const segmentPostcode = segments.prepare(
			"SELECT postcode, geometry FROM street_segment WHERE street_norm = ? AND min_hn <= ? AND max_hn >= ? AND postcode IS NOT NULL"
		)

		for (const member of members) {
			const zip = cache(`${member.replaceAll("/", "__")}.zip`)

			if (!(await pathExists(zip))) {
				// A failed transfer is reported with the state's counts, and a rerun retries it because no file was kept.
				const partial = `${zip.toString()}.part`

				try {
					const response = await fetch(`https://results.openaddresses.io/latest/run/${member}.zip`)

					if (!response.ok || !response.body) {
						missing.push(`${member} (${response.status})`)

						continue
					}

					await pipeline(Readable.fromWeb(response.body), openWriteStream(partial))
					await movePath(partial, zip)
				} catch (error) {
					await removePathIfPresent(partial)
					missing.push(`${member} (${String(error)})`)

					continue
				}
			}

			const csv = scratch.path(`${member.replaceAll("/", "__")}.csv`)

			try {
				await extractZipEntry(zip, `${member}.csv`, csv)
			} catch (error) {
				missing.push(`${member} (${String(error)})`)

				continue
			}

			db.exec("BEGIN")

			for await (const record of CSVSpliterator.fromAsync<OpenAddressesRecord>(csv, { normalizeKeys: true })) {
				read++

				const row = openAddressesRow(record, member, release)

				if (!row) {
					unusable++

					continue
				}

				if (repeatsStoredPoint(row, stored.all(row.street_norm, row.number) as Array<{ lat: number; lon: number }>)) {
					repeated++

					continue
				}

				const houseNumber = Number.parseInt(row.number, 10)

				if (!row.postcode && !Number.isNaN(houseNumber)) {
					row.postcode = postcodeNearPoint(
						row,
						segmentPostcode.all(row.street_norm, houseNumber, houseNumber) as Array<{
							postcode: string
							geometry: string
						}>
					)
				}

				const cell = hasCell ? shortCellToInt(latLngToCell(row.lat, row.lon, ADDRESS_POINT_H3_RESOLUTION)) : null

				insert.run(...columns.map((column) => (column === "h3_cell" ? cell : row[column as keyof typeof row])))

				added++
			}

			db.exec("COMMIT")
			await removePathIfPresent(csv)
		}

		db.exec("ANALYZE")
	}

	await swapDatabaseIntoPlace(tmp, out)
	await sealDatabase(out)

	console.log(
		`${state}: sources ${members.length}, read ${read}, added ${added}, repeated ${repeated}, unusable ${unusable}`
	)

	if (missing.length) {
		console.log(`  unread: ${missing.join("; ")}`)
	}
}
