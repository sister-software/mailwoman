/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A populated locality whose own same-name administrative parent dwarfs it.
 *
 *   `Aurangabad`, Maharashtra is a city of roughly 1.2 million. Its `locality` row records 19,172 while its
 *   same-name `county` row records 3,701,282. Nothing in the resolver is wrong there; the number is. That row is
 *   also why a ranking rule cannot settle #2267 — Irvington and Aurangabad are identical on every feature the
 *   ranker can read and opposite in which bearer the query means, so correcting the population resolves one and
 *   changing the ranking to accommodate the wrong number improves nothing.
 *
 *   TWO SIGNALS, BECAUSE THE RATIO ALONE DOES NOT SEPARATE THE CLASS. A mis-recorded city and a namesake village
 *   inside a large district both read as "small locality under big parent". What separates them is how common the
 *   name is — India carries 312 localities called `Sultanpur` and more than sixty called `Aurangabad` — and
 *   whether a second register agrees, which the `gn:id` concordance makes reachable.
 *
 *   Usage:
 *     node packages/mailwoman/lib/dev-tools/undersized-locality-census.run.ts
 *     node packages/mailwoman/lib/dev-tools/undersized-locality-census.run.ts --ratio 10 --json <path>
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { renderMarkdownTable } from "@mailwoman/core/strings/markdown-table"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

const { values: args } = parseArguments({
	options: {
		admin: { type: "string" },
		ratio: { type: "string" },
		bearers: { type: "string" },
		json: { type: "string" },
	},
	strict: false,
})

/**
 * How many times its own population a same-name parent must carry before the locality's row is reported.
 */
const RATIO = Number(args.ratio ?? 10)

/**
 * At or below this many localities of the same name in the country, the name is distinctive enough that a tiny
 * population under a huge same-name parent reads as a mis-recorded settlement rather than a village.
 */
const RARE_NAME_MAX = Number(args.bearers ?? 3)

/**
 * Placetypes a locality's same-name parent may be. A locality nested inside a same-name `region` is the ordinary
 * capital-of-its-region shape (Luxembourg, Djibouti, Kuwait City) and is not this defect.
 */
const PARENT_PLACETYPES = ["county", "localadmin", "borough"]

/**
 * Aurangabad, Maharashtra — renamed Chhatrapati Sambhajinagar, a city of roughly 1.2 million whose `locality` row
 * records 19,172. The row this detector was written for, reported at the end so a run says whether it still reaches
 * it.
 */
const AURANGABAD_MAHARASHTRA = 102_030_887

using db = new DatabaseClient<WOFDatabase>(String(args.admin ?? dataRootPath("wof", "admin-global-priority.db")), {
	readOnly: true,
})

/**
 * The comparison surface. Diacritic-folded and case-folded, but not emptied for a non-Latin name the way the resolver's
 * `foldName` is — a Han or Cyrillic locality would otherwise fold equal to its parent by both being empty.
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
	/**
	 * Localities of this name in this country. High means a common village name; a handful means a real settlement and
	 * its namesakes.
	 */
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

// How many reported rows carry the `gn:id` link a second register would be read through. Counted rather than
// followed: the GeoNames population file is a separate download, and the queue is orderable only once it is read.
const wanted = new Set(sameName.map((row) => row.id))

const linked = (
	db.prepare(`SELECT id FROM concordances WHERE other_source = 'gn:id'`).all() as Array<{ id: number }>
).filter((link) => wanted.has(link.id)).length

// Counted in SQL and on the exact name: `spr` holds 4,386,926 named localities, so folding every one in JS to key a
// map costs the whole scan, and `Sultanpur` is spelled one way across all 312 of its Indian rows.
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
		String(args.json)
	)

	console.log(`\njson → ${args.json}`)
}
