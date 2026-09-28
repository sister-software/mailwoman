/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ratio alone does not separate a mis-recorded city from a namesake village under a large
 *   district: what separates them is how common the name is and whether a second register agrees.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { renderMarkdownTable } from "@mailwoman/core/strings/markdown-table"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

const { values: args } = parseArguments({
	options: {
		admin: { type: "string" },
		ratio: { type: "string" },
		bearers: { type: "string" },
		json: { type: "string" },
	},
})

const RATIO = Number(args.ratio ?? 10)

/**
 * At or below this many same-name localities in the country, a tiny population under a
 * huge same-name parent reads as a mis-recorded settlement rather than a village.
 */
const RARE_NAME_MAX = Number(args.bearers ?? 3)

/**
 * Placetypes a locality's same-name parent may be.
 *
 * A locality inside a same-name `region` is the ordinary capital-of-its-region shape and is not this defect.
 */
const PARENT_PLACETYPES = ["county", "localadmin", "borough"]

/**
 * Aurangabad, Maharashtra (renamed Chhatrapati Sambhajinagar), the row this detector
 * must reach, reported at the end so a run says whether it still does.
 */
const AURANGABAD_MAHARASHTRA = 102_030_887

using db = new DatabaseClient<WOFDatabase>(args.admin ?? wofDatabasePath("admin-global-priority.db"), {
	readOnly: true,
})

/**
 * The comparison surface, diacritic- and case-folded but not emptied for a
 * non-Latin name the way the resolver's `foldName`.
 *
 * That function would fold a Han or Cyrillic locality equal to its parent.
 */
const nameKey = (name: string): string =>
	name
		.normalize("NFD")
		.replaceAll(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replaceAll(/[^\p{L}\p{N}]+/gu, "")

interface Row {
	id: number
	name: string
	country: string
	population: number
	parentID: number
	parentPlacetype: string
	parentPopulation: number
	ratio: number
	nameBearers: number
}

const placeholders = PARENT_PLACETYPES.map(() => "?").join(",")

const candidates = db
	.prepare(
		`SELECT s.id AS id, s.name AS name, s.country AS country, p.population AS population,
			a.ancestor_id AS parentID, ps.placetype AS parentPlacetype, ps.name AS parentName,
			pp.population AS parentPopulation
		 FROM spr s
		 JOIN place_population p ON p.id = s.id
		 JOIN ancestors a ON a.id = s.id AND a.ancestor_id <> s.id
		 JOIN spr ps ON ps.id = a.ancestor_id
		 JOIN place_population pp ON pp.id = ps.id
		 WHERE s.placetype = 'locality' AND p.population > 0
		   AND ps.placetype IN (${placeholders})
		   AND pp.population >= p.population * ?`
	)
	.all(...PARENT_PLACETYPES, RATIO) as Array<{
	id: number
	name: string
	country: string
	population: number
	parentID: number
	parentPlacetype: string
	parentName: string
	parentPopulation: number
}>

const sameName = candidates.filter((row) => nameKey(row.name) === nameKey(row.parentName))

// How many reported rows carry the `gn:id` link a second register would be read through,
// counted rather than followed because the GeoNames population file is a separate download.
const wanted = new Set(sameName.map((row) => row.id))

const linked = (
	db.prepare(`SELECT id FROM concordances WHERE other_source = 'gn:id'`).all() as Array<{ id: number }>
).filter((link) => wanted.has(link.id)).length

// Counted in SQL on the exact name because folding every one of `spr`'s 4,386,926
// keying each locality by name in JS costs the whole scan.
const bearerCount = db.prepare(
	`SELECT COUNT(*) AS n FROM spr WHERE placetype = 'locality' AND country = ? AND name = ?`
)

const rows: Row[] = sameName
	.map((row) => ({
		id: row.id,
		name: row.name,
		country: row.country,
		population: row.population,
		parentID: row.parentID,
		parentPlacetype: row.parentPlacetype,
		parentPopulation: row.parentPopulation,
		ratio: row.parentPopulation / row.population,
		nameBearers: (bearerCount.get(row.country, row.name) as { n: number }).n,
	}))
	.toSorted((a, b) => b.ratio - a.ratio)

const rare = rows.filter((row) => row.nameBearers <= RARE_NAME_MAX)

console.log(`localities whose same-name ${PARENT_PLACETYPES.join("/")} parent carries ${RATIO}x their population`)
console.log(`  reported:                  ${rows.length.toLocaleString()}`)
console.log(`  carrying a gn:id link:     ${linked.toLocaleString()} — the second register the queue can be ordered by`)
console.log(
	`  name borne by <= ${RARE_NAME_MAX}:        ${rare.length.toLocaleString()} — the mis-recorded-settlement shape`
)
console.log(
	`  name borne by more:        ${(rows.length - rare.length).toLocaleString()} — a common name under a large district`
)

const byCountry = new Map<string, number>()

for (const row of rows) {
	byCountry.set(row.country, (byCountry.get(row.country) ?? 0) + 1)
}

const table = (header: readonly string[], body: ReadonlyArray<readonly string[]>): string =>
	renderMarkdownTable(header, body).join("\n")

console.log(`\nby country, top 12:\n`)
console.log(
	table(
		["country", "reported", `of which name borne by <= ${RARE_NAME_MAX}`],
		[...byCountry]
			.toSorted((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([country, n]) => [country, String(n), String(rare.filter((row) => row.country === country).length)])
	)
)

console.log(`\nthe review queue — worst 20 by ratio among names borne by <= ${RARE_NAME_MAX} localities:\n`)
console.log(
	table(
		["locality", "country", "id", "population", "parent population", "ratio", "bearers"],
		rare
			.slice(0, 20)
			.map((row) => [
				row.name,
				row.country,
				String(row.id),
				row.population.toLocaleString(),
				row.parentPopulation.toLocaleString(),
				`${row.ratio.toFixed(0)}x`,
				String(row.nameBearers),
			])
	)
)

const aurangabad = rows.find((row) => row.id === AURANGABAD_MAHARASHTRA)

console.log(
	`\nAurangabad, Maharashtra (102030887): ${
		aurangabad
			? `reported at ${aurangabad.ratio.toFixed(0)}x, name borne by ${aurangabad.nameBearers} IN localities`
			: "NOT reported — the detector does not reach the row it was written for"
	}`
)

if (args.json) {
	await writeLocalTextFile(
		prettyJSON({ ratio: RATIO, rareNameMax: RARE_NAME_MAX, parentPlacetypes: PARENT_PLACETYPES, linked, rows }),
		args.json
	)

	console.log(`\njson → ${args.json}`)
}
