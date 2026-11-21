// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `us-county` — US counties written as an address writes them, read from Who's On First.
 *
 *   The recipe writes three sources, so a training config weighs each shape on its own:
 *
 *   - `rendered-us-county`: `Polk County, OR` and `Polk County, Oregon`, two rows per county.
 *   - `rendered-us-city-county`: `Dallas, Polk County, OR 97338`, a WOF locality inside
 *     that county, with one of the locality's ZIP Codes on half the rows that have one.
 *   - `rendered-us-city-state`: `Dallas, OR` and `Dallas, OR 97338`, the same localities without
 *     the county, so a trailing `, CA` has California rows to weigh against the Canadian ones.
 *
 *   The designator (`County`, `Parish`, `Borough`, `Census Area`, `City and Borough`)
 *   is part of the `subregion` span.
 *   WOF's admin database writes a county's name bare (`Polk`), so the designator comes from
 *   the record's own `wof:label` (`Polk County`), else from an English name that writes one.
 *
 *   A county whose records write none, and an independent city (`City of Richmond`), get no county row.
 */

import { splitUSCountyDesignator, type USCountyDesignator } from "@mailwoman/codex/us/county"
import { lookupUSState, US_STATE_BY_ABBREVIATION, type USStateAbbreviation } from "@mailwoman/codex/us/state"
import { dataRootPath } from "@mailwoman/core/data-root"
import { assertPathExists } from "@mailwoman/core/fs/readers/stat"
import { mulberry32, shuffleWith } from "@mailwoman/core/random"
import {
	openWOFRecordStoreReader,
	storedWOFRecords,
	wofRecordStorePathFor,
} from "@mailwoman/gazetteer/whosonfirst/record-store"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { alignAndWrite, type CanonicalRecipeRow, type CorpusRecipe, recipeSourceID } from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { SourceRegister } from "#registers"
import { SurfaceOrigin } from "#types"

/**
 * One county with the designator its WOF records write.
 */
export interface USCounty {
	id: number
	/**
	 * The county as an address writes it: `Polk County`.
	 */
	surface: string
	designator: USCountyDesignator
	state: USStateAbbreviation
}

/**
 * One WOF locality inside exactly one county, with the ZIP Codes whose parent it is.
 */
export interface USCountyLocality {
	id: number
	name: string
	countyID: number
	postcodes: readonly string[]
}

/**
 * What {@link readUSCountyPool} read, and what it set aside with the reason.
 */
export interface USCountyPool {
	counties: readonly USCounty[]
	localities: readonly USCountyLocality[]
	/**
	 * Current US county records the pool holds no county for, keyed by why.
	 */
	setAside: Readonly<Record<"noDesignator" | "noState", readonly string[]>>
}

/**
 * The surface a county's WOF record writes it with: the first of `wof:label`
 * and its English names that's its own name followed by a designator.
 */
export function countySurface(
	name: string,
	written: readonly unknown[]
): { surface: string; designator: USCountyDesignator } | null {
	for (const candidate of written) {
		if (typeof candidate !== "string") continue

		const split = splitUSCountyDesignator(candidate)

		if (split && split.name.toLowerCase() === name.trim().toLowerCase()) {
			return { surface: `${split.name} ${split.designator}`, designator: split.designator }
		}
	}

	return null
}

/**
 * Where {@link readUSCountyPool} reads.
 */
export interface USCountyPoolPaths {
	/**
	 * @defaultValue `$MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority.db`
	 */
	adminDB?: PathBuilderLike
	/**
	 * @defaultValue `$MAILWOMAN_DATA_ROOT/db/wof/postalcode-us.db`
	 */
	postcodeDB?: PathBuilderLike
	/**
	 * The WOF record store.
	 * It keeps each record's `wof:label`.
	 *
	 * @defaultValue the store for `$MAILWOMAN_DATA_ROOT/src/wof-repos`
	 */
	recordStore?: PathBuilderLike
}

/**
 * Reads every current US county, its state and its designator, and every current locality
 * that WOF places in exactly one of those counties, with its ZIP Codes.
 *
 * @throws When a database is absent, because a pool read without one would hold
 * no designators or no ZIP Codes and still look whole.
 */
export async function readUSCountyPool(paths: USCountyPoolPaths = {}): Promise<USCountyPool> {
	const adminDB = paths.adminDB ?? wofDatabasePath("admin-global-priority.db")
	const postcodeDB = paths.postcodeDB ?? wofDatabasePath("postalcode-us.db")
	const recordStore = paths.recordStore ?? wofRecordStorePathFor(dataRootPath("src", "wof-repos"))

	await assertPathExists(adminDB, `us-county: no admin gazetteer at ${adminDB}`)
	await assertPathExists(postcodeDB, `us-county: no US postcode database at ${postcodeDB}`)
	await assertPathExists(recordStore, `us-county: no WOF record store at ${recordStore}`)

	const written = new Map<number, unknown[]>()

	{
		using store = openWOFRecordStoreReader(recordStore)

		for (const record of storedWOFRecords(store, { country: "US", placetypes: new Set(["county"]) })) {
			const properties = record.feature.properties ?? {}
			const variants = properties["name:eng_x_variant"]

			written.set(record.id, [properties["wof:label"], ...(Array.isArray(variants) ? variants : [])])
		}
	}

	using db = new DatabaseClient<WOFDatabase>(adminDB, { readOnly: true })

	const countyRecords = db
		.prepare(
			`SELECT s.id AS id, s.name AS name, min(r.name) AS region
			FROM spr s
			JOIN ancestors a ON a.id = s.id AND a.ancestor_placetype = 'region'
			JOIN spr r ON r.id = a.ancestor_id
			WHERE s.country = 'US' AND s.placetype = 'county' AND s.is_current != 0 AND s.is_deprecated = 0
			GROUP BY s.id ORDER BY s.id`
		)
		.all() as Array<{ id: number; name: string; region: string }>

	const englishVariants = db.prepare(
		`SELECT name FROM names WHERE id = ? AND language = 'eng' AND privateuse = 'variant' ORDER BY name`
	)

	const counties: USCounty[] = []
	const noDesignator: string[] = []
	const noState: string[] = []

	for (const row of countyRecords) {
		const state = lookupUSState(row.region)

		if (!state) {
			noState.push(`${row.id} ${row.name}, ${row.region}`)

			continue
		}

		const variants = (englishVariants.all(row.id) as Array<{ name: string }>).map((v) => v.name)
		const found = countySurface(row.name, [...(written.get(row.id) ?? []), ...variants])

		if (!found) {
			noDesignator.push(`${row.id} ${row.name}, ${state}`)

			continue
		}

		counties.push({ id: row.id, ...found, state })
	}

	const known = new Set(counties.map((county) => county.id))
	const postcodes = new Map<number, string[]>()

	{
		using pc = new DatabaseClient<WOFDatabase>(postcodeDB, { readOnly: true })

		for (const row of pc
			.prepare(
				`SELECT parent_id, name FROM spr WHERE placetype = 'postalcode' AND parent_id > 0 AND is_current != 0 ORDER BY name`
			)
			.all() as Array<{ parent_id: number; name: string }>) {
			const list = postcodes.get(row.parent_id) ?? []

			list.push(row.name)
			postcodes.set(row.parent_id, list)
		}
	}

	// A locality WOF places in two counties names neither as its own.
	const localityRows = db
		.prepare(
			`SELECT s.id AS id, s.name AS name, min(a.ancestor_id) AS county_id
			FROM spr s
			JOIN ancestors a ON a.id = s.id AND a.ancestor_placetype = 'county'
			WHERE s.country = 'US' AND s.placetype = 'locality' AND s.is_current != 0 AND s.is_deprecated = 0
			GROUP BY s.id HAVING count(DISTINCT a.ancestor_id) = 1 ORDER BY s.id`
		)
		.all() as Array<{ id: number; name: string; county_id: number }>

	const localities = localityRows
		.filter((row) => row.name.trim() && known.has(row.county_id))
		.map((row) => ({
			id: row.id,
			name: row.name.trim(),
			countyID: row.county_id,
			postcodes: postcodes.get(row.id) ?? [],
		}))

	return { counties, localities, setAside: { noDesignator, noState } }
}

/**
 * The three sources this recipe writes, in the table spelling {@linkcode defaultRecipeSource} answers.
 */
export const US_COUNTY_SOURCES = {
	county: defaultRecipeSource("synth-us-county"),
	cityCounty: defaultRecipeSource("synth-us-city-county"),
	cityState: defaultRecipeSource("synth-us-city-state"),
} as const

/**
 * One row the recipe writes, before alignment, with the template that shaped it.
 */
export interface USCountyRow {
	canonical: CanonicalRecipeRow
	template: string
}

const LICENSE = "Who's On First — us-county; county, locality and ZIP Code records (CC0/ODC-By per source)"

function recipeRow(
	source: string,
	template: string,
	raw: string,
	components: Record<string, string>,
	parts: Record<string, string>
): USCountyRow {
	return {
		template,
		canonical: {
			raw,
			components,
			country: "US",
			locale: "en-US",
			source,
			source_id: recipeSourceID(source, { template, ...parts }),
			license: LICENSE,
		},
	}
}

/**
 * Every county's two bare rows, `Polk County, OR` and `Polk County, Oregon`.
 */
export function countyRows(counties: readonly USCounty[]): USCountyRow[] {
	return counties.flatMap((county) => {
		const stateName = US_STATE_BY_ABBREVIATION[county.state]
		const parts = { county: String(county.id) }

		return [
			recipeRow(
				US_COUNTY_SOURCES.county,
				"us-county:code",
				`${county.surface}, ${county.state}`,
				{ subregion: county.surface, region: county.state },
				parts
			),
			recipeRow(
				US_COUNTY_SOURCES.county,
				"us-county:name",
				`${county.surface}, ${stateName}`,
				{ subregion: county.surface, region: stateName },
				parts
			),
		]
	})
}

/**
 * Localities in a seeded order that reaches every group before any group's second:
 * each round takes the next locality of every group.
 */
function roundRobin(
	localities: readonly USCountyLocality[],
	groupOf: (locality: USCountyLocality) => string,
	random: () => number
): USCountyLocality[] {
	const groups = new Map<string, USCountyLocality[]>()

	for (const locality of localities) {
		const key = groupOf(locality)
		const list = groups.get(key) ?? []

		list.push(locality)
		groups.set(key, list)
	}

	const order = [...groups.keys()]

	shuffleWith(order, random)

	for (const list of groups.values()) {
		shuffleWith(list, random)
	}

	const out: USCountyLocality[] = []
	const deepest = Math.max(0, ...[...groups.values()].map((list) => list.length))

	for (let round = 0; round < deepest; round++) {
		for (const key of order) {
			const locality = groups.get(key)![round]

			if (locality) {
				out.push(locality)
			}
		}
	}

	return out
}

/**
 * Draws a ZIP Code for every other row whose locality has one, from that locality's own,
 * so the rows with a ZIP Code and those without split the localities that have one.
 */
function postcodeDrawer(random: () => number): (locality: USCountyLocality) => string | null {
	let eligible = 0

	return (locality) => {
		if (!locality.postcodes.length || eligible++ % 2 === 1) return null

		return locality.postcodes[Math.floor(random() * locality.postcodes.length)]!
	}
}

/**
 * `<City>, <Name> County, <ST>[ <ZIP>]` rows, at most `count`, spread so every
 * county contributes a row before any contributes a second.
 */
export function cityCountyRows(pool: USCountyPool, count: number, random: () => number): USCountyRow[] {
	const counties = new Map(pool.counties.map((county) => [county.id, county]))
	const drawPostcode = postcodeDrawer(random)

	return roundRobin(pool.localities, (locality) => String(locality.countyID), random)
		.slice(0, count)
		.map((locality) => {
			const county = counties.get(locality.countyID)!
			const postcode = drawPostcode(locality)
			const tail = postcode ? `${county.state} ${postcode}` : county.state

			return recipeRow(
				US_COUNTY_SOURCES.cityCounty,
				postcode ? "us-county:city-county-zip" : "us-county:city-county",
				`${locality.name}, ${county.surface}, ${tail}`,
				{
					locality: locality.name,
					subregion: county.surface,
					region: county.state,
					...(postcode ? { postcode } : {}),
				},
				{ locality: String(locality.id), county: String(county.id), postcode: postcode ?? "" }
			)
		})
}

/**
 * `<City>, <ST>[ <ZIP>]` rows, at most `count`, spread so every state contributes a row
 * before any contributes a second.
 */
export function cityStateRows(pool: USCountyPool, count: number, random: () => number): USCountyRow[] {
	const counties = new Map(pool.counties.map((county) => [county.id, county]))
	const drawPostcode = postcodeDrawer(random)

	return roundRobin(pool.localities, (locality) => counties.get(locality.countyID)!.state, random)
		.slice(0, count)
		.map((locality) => {
			const state = counties.get(locality.countyID)!.state
			const postcode = drawPostcode(locality)

			return recipeRow(
				US_COUNTY_SOURCES.cityState,
				postcode ? "us-county:city-state-zip" : "us-county:city-state",
				postcode ? `${locality.name}, ${state} ${postcode}` : `${locality.name}, ${state}`,
				{ locality: locality.name, region: state, ...(postcode ? { postcode } : {}) },
				{ locality: String(locality.id), postcode: postcode ?? "" }
			)
		})
}

/**
 * The rows read straight from a published record, so the register is WOF's.
 */
const US_COUNTY_PROVENANCE = {
	register: SourceRegister.WhosOnFirst,
	surface: SurfaceOrigin.Composed,
	// The WOF ids that make each row are in its `source_id` parts.
	// No corpus row stands behind it.
	baseSourceID: null,
}

/**
 * Recipe registered with the corpus builder.
 */
export const usCountyRecipe: CorpusRecipe = {
	name: "us-county",
	description:
		"US counties from WOF: 'Polk County, OR', 'Polk County, Oregon', 'Dallas, Polk County, OR 97338' and 'Dallas, OR[ 97338]'",
	mode: "generate",
	options: [
		{
			flag: "--count <n>",
			description:
				"Rows for each of rendered-us-city-county and rendered-us-city-state. Every county writes its two rendered-us-county rows regardless.",
		},
		{
			flag: "--admin-db <path>",
			description: "WOF admin database. Default $MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority.db",
		},
	],
	async run(opts, write) {
		const count = opts.count ?? 0

		if (!(count >= 0)) throw new Error(`us-county: --count must be a non-negative number, got ${opts.count}`)

		const pool = await readUSCountyPool({ adminDB: opts.adminDB })

		console.error(
			`  us-county: ${pool.counties.length} counties, ${pool.localities.length} localities; ` +
				`set aside ${pool.setAside.noDesignator.length} with no designator (${pool.setAside.noDesignator.join("; ")}) ` +
				`and ${pool.setAside.noState.length} with no state`
		)

		const random = mulberry32(opts.seed)

		const rows = [
			...countyRows(pool.counties),
			...cityCountyRows(pool, count, random),
			...cityStateRows(pool, count, random),
		]

		let emitted = 0
		let skipped = 0

		for (const { canonical, template } of rows) {
			if (alignAndWrite(write, canonical, template, US_COUNTY_PROVENANCE)) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read: pool.counties.length + pool.localities.length, emitted, skipped }
	},
}
