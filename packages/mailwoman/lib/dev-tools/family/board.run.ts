/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Resolves, grades and writes the target-family board rows to `gauntlet/cases/<cc>/family-<slug>.jsonl`.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { allRows, isoDate } from "@mailwoman/core/utils"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { FAMILY_ROWS, type FamilyRow, type PlaceLookup, type TargetFamily } from "#dev-tools/family/board-rows"
import { gradeSeedCases, reportGradedGroups, writeSeedCaseFile } from "#dev-tools/grade-seed-cases"
import { CASES_DIR } from "#eval-harness/gauntlet/cases/load"
import type { SeedCase } from "#eval-harness/gauntlet/cases/seed-case"

const { values } = parseArguments({
	options: {
		"admin-db": { type: "string" },
		"skip-grade": { type: "boolean", default: false },
	},
})

const ADMIN_DB = values["admin-db"] ?? wofDatabasePath("admin-global-priority-importance.db")
const SOURCE = `family-board:${isoDate()}`
const ADDED_AT = isoDate()

const FAMILY_SLUG: Record<TargetFamily, string> = {
	F3: "district-city",
	F5: "locality-postcode",
	F7: "possessive-qualifier",
	F9: "po-box",
}

const FAMILY_ISSUE: Record<TargetFamily, string> = {
	F3: "#1914",
	F5: "#1821",
	F7: "#1754",
	F9: "#517",
}

/**
 * Lists the placetypes a lookup tries when it sets none, in order.
 * The first placetype with a record wins.
 */
const DISTRICT_PLACETYPES = ["borough", "localadmin", "macrohood", "neighbourhood", "microhood", "locality"] as const

/**
 * Holds one gazetteer record returned by a place lookup.
 */
interface PlaceRecord {
	id: number
	placetype: string
	latitude: number
	longitude: number
	population: number
}

using db = new DatabaseClient<WOFDatabase>(ADMIN_DB, { readOnly: true })

const lookupStatement = db.prepare(`
	SELECT s.id, s.placetype, s.latitude, s.longitude, coalesce(p.population, 0) AS population
	FROM spr s LEFT JOIN place_population p ON p.id = s.id
	WHERE s.country = ? AND s.name = ? AND s.is_current = 1
	  AND (? = '' OR EXISTS (
	    SELECT 1 FROM ancestors a JOIN spr q ON q.id = a.ancestor_id WHERE a.id = s.id AND q.name = ?
	  ))
	ORDER BY population DESC
`)

/**
 * Resolves a lookup to exactly one gazetteer record, preferring the higher population within a placetype.
 *
 * The chosen record is printed beside each row so the choice can be audited.
 *
 * @throws If no record matches, or if two records tie on population at the first matching placetype.
 */
function resolvePlace(lookup: PlaceLookup): PlaceRecord {
	const parent = lookup.parent ?? ""
	const records = allRows<PlaceRecord>(lookupStatement, lookup.country, lookup.name, parent, parent)
	const placetypes = lookup.placetypes ?? DISTRICT_PLACETYPES

	for (const placetype of placetypes) {
		const matches = records.filter((record) => record.placetype === placetype)

		if (matches.length === 1) return matches[0]!

		if (matches.length > 1 && matches[0]!.population > matches[1]!.population) return matches[0]!

		if (matches.length > 1) {
			throw new Error(
				`${lookup.name}, ${lookup.country} under ${parent || "-"}: ${matches.length} ${placetype} records tie — name the parent or the placetype`
			)
		}
	}

	throw new Error(
		`${lookup.name}, ${lookup.country} under ${parent || "-"}: no record among placetypes ${placetypes.join(", ")} (${records.length} records of other placetypes)`
	)
}

function toSeedCase(row: FamilyRow): SeedCase {
	const seed: SeedCase = {
		id: row.id,
		input: row.input,
		source: SOURCE,
		addressKind: row.addressKind,
		country: row.country,
		status: "improvement_target",
		expectComponents: row.expectComponents,
		addedAt: ADDED_AT,
		bugRef: FAMILY_ISSUE[row.family],
		note: row.note ?? `${row.family} (${FAMILY_ISSUE[row.family]}): authored from the issue's attested set.`,
	}

	if (row.place) {
		const record = resolvePlace(row.place)

		seed.expectLat = Number(record.latitude.toFixed(6))
		seed.expectLon = Number(record.longitude.toFixed(6))
		seed.expectToleranceM = row.toleranceM
		seed.note = `${seed.note} Point: ${row.place.name} (${record.placetype} ${record.id}).`

		console.log(
			`  ${row.id}: ${row.place.name} → ${record.placetype} ${record.id} (${seed.expectLat}, ${seed.expectLon})`
		)
	}

	return seed
}

const cases = FAMILY_ROWS.map(toSeedCase)

if (!values["skip-grade"]) {
	const graded = await gradeSeedCases(cases)

	console.log(`\n=== Target-family board (${cases.length} rows) ===`)

	reportGradedGroups(graded, (seed) => FAMILY_ROWS.find((row) => row.id === seed.id)!.family)
}

const byFile = new Map<string, SeedCase[]>()

for (const row of FAMILY_ROWS) {
	const seed = cases.find((c) => c.id === row.id)!
	// The path is converted to a string because it keys `byFile`.
	const path = CASES_DIR(row.country.toLowerCase(), `family-${FAMILY_SLUG[row.family]}.jsonl`).toString()
	const list = byFile.get(path) ?? []

	list.push(seed)
	byFile.set(path, list)
}

for (const [path, list] of byFile) {
	await writeSeedCaseFile(list, path)
}
