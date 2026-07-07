/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the UN/LOCODE lookup DB from the UNECE code list CSV (datasets/un-locode `code-list.csv`:
 *   columns Change, Country, Location, Name, NameWoDiacritics, Subdivision, Status, Function, Date,
 *   IATA, Coordinates, Remarks). One row per assigned location; coordinates parsed where present.
 */

import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { parse } from "csv-parse/sync"

import { foldName, parseUnLocodeCoords } from "./index.js"

interface CSVRow {
	Country: string
	Location: string
	Name: string
	NameWoDiacritics: string
	Coordinates: string
}

/** Read the code-list CSV at `csvPath` and write the lookup DB to `dbPath`. */
export function buildUnLocodeDB(csvPath: string, dbPath: string): { rows: number; withCoords: number } {
	const records = parse(readFileSync(csvPath), {
		columns: true,
		skip_empty_lines: true,
		relax_quotes: true,
	}) as CSVRow[]
	const db = new DatabaseSync(dbPath)
	db.exec("DROP TABLE IF EXISTS un_locode")
	db.exec(
		"CREATE TABLE un_locode (country TEXT NOT NULL, location TEXT NOT NULL, name TEXT, nameNorm TEXT, lat REAL, lon REAL)"
	)
	const insert = db.prepare("INSERT INTO un_locode (country, location, name, nameNorm, lat, lon) VALUES (?,?,?,?,?,?)")

	let withCoords = 0
	db.exec("BEGIN")

	for (const r of records) {
		if (!r.Country || !r.Location) continue // header/country rows carry no Location
		const coords = r.Coordinates ? parseUnLocodeCoords(r.Coordinates) : null

		if (coords) {
			withCoords++
		}
		const name = r.NameWoDiacritics || r.Name || ""
		insert.run(r.Country, r.Location, r.Name || name, foldName(name), coords?.lat ?? null, coords?.lon ?? null)
	}
	db.exec("COMMIT")
	db.exec("CREATE INDEX idx_locode_name ON un_locode (country, nameNorm)")
	db.exec("CREATE INDEX idx_locode_bbox ON un_locode (lat, lon)")
	db.close()

	return { rows: records.length, withCoords }
}
