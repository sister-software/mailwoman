// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Builds the former administrative divisions table and its per-country census.
 *
 *   A former division comes from either of two sources, for every country:
 *
 *   - GeoNames' historical divisions, the `A`-class rows with feature code `ADM1H` through `ADM5H`
 *     or `PCLH`, in each `<CC>.txt` dump.
 *   - Who's On First's ceased admin records: `mz:is_current` 0 or a dated `edtf:cessation`.
 *
 *   A GeoNames division and a ceased WOF record are one division when the WOF record's `gn:id`
 *   concordance is the GeoNames row's id.
 *
 *   Each division is linked to the current places it covered through containment evidence only:
 *
 *   - `geonames_hierarchy`: the children GeoNames' `hierarchy.txt` lists under the division.
 *   - `geonames_admin_codes`: current GeoNames rows that still hold the division's admin code at its
 *     level. A code a current division of the same level also holds is shared rather than retired.
 *     A shared code links no place, because it identifies the current division's area rather than the former one's.
 *   - `wof_supersession`: a ceased WOF record's `wof:superseded_by`.
 *
 *   A linked GeoNames row reaches WOF through the admin database's `gn:id` concordances, or as the
 *   row the GeoNames step wrote for it (`geonamesPlaceID`).
 *
 *   The `ComponentTag` a division takes is its WOF placetype's when a WOF record states one. A GeoNames
 *   division at level n takes the tag of the WOF placetype that the country's current `ADMn` rows
 *   map to in the greatest number, so no per-country table states which level is a county.
 */

import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { geonamesPlaceID } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { FORMER_DIVISION_SHAPES, type FormerDivisionTuple } from "@mailwoman/corpus/recipes/former-divisions"
import type { FormerDivisionLink, FormerDivisionRecord } from "@mailwoman/resolver-wof-sqlite/former-divisions"
import { FormerDivisionEvidence } from "@mailwoman/resolver-wof-sqlite/former-divisions"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { FORMER_DIVISION_PLACETYPES, wofRecordNames } from "#tools/pipeline/wof/slim"

/**
 * The GeoNames feature codes of a historical division, with the admin level each sits at.
 * `PCLH` is a former country, level 0.
 */
export const HISTORICAL_DIVISION_LEVELS: ReadonlyMap<string, number> = new Map([
	["PCLH", 0],
	["ADM1H", 1],
	["ADM2H", 2],
	["ADM3H", 3],
	["ADM4H", 4],
	["ADM5H", 5],
])

/**
 * The current GeoNames division codes, with their admin levels.
 */
const CURRENT_DIVISION_LEVELS: ReadonlyMap<string, number> = new Map([
	["PCLI", 0],
	["ADM1", 1],
	["ADM2", 2],
	["ADM3", 3],
	["ADM4", 4],
	["ADM5", 5],
])

/**
 * The dump holds admin codes for levels 1 to 4 (columns 11 to 14).
 */
const CODED_LEVELS = 4

type DivisionTag = FormerDivisionRecord["tag"]

/**
 * The `ComponentTag` a WOF admin placetype takes in an address.
 */
function tagOfPlacetype(placetype: string): DivisionTag | null {
	switch (placetype) {
		case "country":
		case "dependency":
			return "country"
		case "macroregion":
		case "region":
			return "region"
		case "macrocounty":
		case "county":
			return "subregion"
		case "localadmin":
		case "locality":
		case "borough":
			return "locality"
		default:
			return null
	}
}

/**
 * One historical-division row of a GeoNames dump.
 */
export interface GeonamesHistoricalDivision {
	geonamesID: number
	name: string
	asciiName: string
	featureCode: string
	level: number
	country: string
	codes: readonly string[]
	latitude: number
	longitude: number
}

interface CurrentDivisionRow {
	geonamesID: number
	level: number
	codes: readonly string[]
}

/**
 * How a division's admin code at its own level stands against the country's current divisions.
 */
export const AdminCodeState = {
	/**
	 * The division states no code at its level, or no code at a level above it.
	 */
	Absent: "absent",
	/**
	 * A current division of the same level holds the same code path.
	 */
	Shared: "shared",
	/**
	 * No current division of the level holds the code path, and no other historical
	 * division of the level does.
	 */
	Retired: "retired",
	/**
	 * Another historical division of the level holds the same code path, as GeoNames' placeholder
	 * `00` is held by every historical county of New Zealand, so the code names none of them.
	 */
	Ambiguous: "ambiguous",
	/**
	 * Level 0 or 5.
	 * The dump's codes describe levels 1 to 4 only.
	 */
	Uncoded: "uncoded",
} as const

export type AdminCodeState = (typeof AdminCodeState)[keyof typeof AdminCodeState]

function codePath(codes: readonly string[], level: number): string | null {
	const path = codes.slice(0, level)

	return path.length === level && path.every(Boolean) ? path.join("|") : null
}

/**
 * One country's dump, read once: its historical divisions and its current divisions.
 */
export async function readGeonamesDivisions(path: PathBuilderLike): Promise<{
	historical: GeonamesHistoricalDivision[]
	current: CurrentDivisionRow[]
}> {
	const historical: GeonamesHistoricalDivision[] = []
	const current: CurrentDivisionRow[] = []

	for await (const f of readUnquotedTSV(path)) {
		if (f[6] !== "A") continue

		const code = f[7] ?? ""
		const codes = [f[10] ?? "", f[11] ?? "", f[12] ?? "", f[13] ?? ""].map((c) => c.trim())
		const historicalLevel = HISTORICAL_DIVISION_LEVELS.get(code)

		if (historicalLevel != null) {
			historical.push({
				geonamesID: Number(f[0]),
				name: (f[1] ?? "").trim(),
				asciiName: (f[2] ?? "").trim(),
				featureCode: code,
				level: historicalLevel,
				country: (f[8] ?? "").trim().toUpperCase(),
				codes,
				latitude: Number(f[4]),
				longitude: Number(f[5]),
			})

			continue
		}

		const currentLevel = CURRENT_DIVISION_LEVELS.get(code)

		if (currentLevel != null) {
			current.push({ geonamesID: Number(f[0]), level: currentLevel, codes })
		}
	}

	return { historical, current }
}

/**
 * The state of each historical division's code against `current`, keyed by GeoNames id.
 */
export function adminCodeStates(
	historical: readonly GeonamesHistoricalDivision[],
	current: readonly CurrentDivisionRow[]
): Map<number, { state: AdminCodeState; path: string | null }> {
	const held = new Set<string>()

	for (const row of current) {
		if (row.level < 1 || row.level > CODED_LEVELS) continue

		const path = codePath(row.codes, row.level)

		if (path) {
			held.add(`${row.level}:${path}`)
		}
	}

	const historicalHolders = new Map<string, number>()

	for (const division of historical) {
		const path = division.level >= 1 && division.level <= CODED_LEVELS ? codePath(division.codes, division.level) : null

		if (path) {
			const key = `${division.level}:${path}`

			historicalHolders.set(key, (historicalHolders.get(key) ?? 0) + 1)
		}
	}

	const states = new Map<number, { state: AdminCodeState; path: string | null }>()

	for (const division of historical) {
		if (division.level < 1 || division.level > CODED_LEVELS) {
			states.set(division.geonamesID, { state: AdminCodeState.Uncoded, path: null })

			continue
		}

		const path = codePath(division.codes, division.level)

		if (!path) {
			states.set(division.geonamesID, { state: AdminCodeState.Absent, path: null })
		} else if (held.has(`${division.level}:${path}`)) {
			states.set(division.geonamesID, { state: AdminCodeState.Shared, path })
		} else if ((historicalHolders.get(`${division.level}:${path}`) ?? 0) > 1) {
			states.set(division.geonamesID, { state: AdminCodeState.Ambiguous, path })
		} else {
			states.set(division.geonamesID, { state: AdminCodeState.Retired, path })
		}
	}

	return states
}

/**
 * The current rows of one country's dump that hold a retired code path, keyed by `<level>:<path>`.
 *
 * A current row is any `A` or `P` row other than a historical division.
 */
export async function readRowsCarryingCodes(
	path: PathBuilderLike,
	wanted: ReadonlySet<string>
): Promise<Map<string, number[]>> {
	const rows = new Map<string, number[]>()

	if (!wanted.size) return rows

	const levels = new Set([...wanted].map((key) => Number(key.split(":")[0])))

	for await (const f of readUnquotedTSV(path)) {
		if (f[6] !== "A" && f[6] !== "P") continue

		if (HISTORICAL_DIVISION_LEVELS.has(f[7] ?? "")) continue

		const codes = [f[10] ?? "", f[11] ?? "", f[12] ?? "", f[13] ?? ""].map((c) => c.trim())

		for (const level of levels) {
			const codesPath = codePath(codes, level)
			const key = codesPath && `${level}:${codesPath}`

			if (key && wanted.has(key)) {
				let ids = rows.get(key)

				if (!ids) {
					rows.set(key, (ids = []))
				}

				ids.push(Number(f[0]))
			}
		}
	}

	return rows
}

/**
 * The children `hierarchy.txt` lists under each of `parents`.
 */
export async function readHierarchyChildren(
	path: PathBuilderLike,
	parents: ReadonlySet<number>
): Promise<Map<number, number[]>> {
	const children = new Map<number, number[]>()

	for await (const f of readUnquotedTSV(path)) {
		const parent = Number(f[0])

		if (!parents.has(parent)) continue

		let ids = children.get(parent)

		if (!ids) {
			children.set(parent, (ids = []))
		}

		ids.push(Number(f[1]))
	}

	return children
}

/**
 * A WOF place a GeoNames id maps to.
 */
export interface WOFPlaceRef {
	id: number
	placetype: string
	country: string
}

/**
 * The current WOF places each GeoNames id maps to, through `gn:id` concordances
 * and the rows the GeoNames step wrote.
 *
 * Every id in `geonamesIDs` is answered, with an empty list when it maps to none.
 */
export async function wofPlacesOfGeonamesIDs(
	db: DatabaseClient<WOFDatabase>,
	geonamesIDs: Iterable<number>
): Promise<Map<number, WOFPlaceRef[]>> {
	const ids = [...new Set(geonamesIDs)]
	const mapped = new Map<number, WOFPlaceRef[]>(ids.map((id) => [id, []]))
	const chunk = 900

	for (let start = 0; start < ids.length; start += chunk) {
		const slice = ids.slice(start, start + chunk)

		const concorded = await db
			.selectFrom("concordances")
			.innerJoin("spr", "spr.id", "concordances.id")
			.select([
				"concordances.other_id as other",
				"spr.id as id",
				"spr.placetype as placetype",
				"spr.country as country",
			])
			.where("concordances.other_source", "=", "gn:id")
			.where(
				"concordances.other_id",
				"in",
				slice.map((id) => String(id))
			)
			.where("spr.is_current", "!=", 0)
			.execute()

		for (const row of concorded) {
			mapped.get(Number(row.other))?.push({ id: row.id, placetype: row.placetype ?? "", country: row.country ?? "" })
		}

		const placeIDs = new Map(slice.map((id) => [geonamesPlaceID(id), id]))

		const ownRows = await db
			.selectFrom("spr")
			.select(["id", "placetype", "country"])
			.where("id", "in", [...placeIDs.keys()])
			.execute()

		for (const row of ownRows) {
			const geonamesID = placeIDs.get(row.id)

			if (geonamesID != null) {
				mapped.get(geonamesID)?.push({ id: row.id, placetype: row.placetype ?? "", country: row.country ?? "" })
			}
		}
	}

	return mapped
}

/**
 * A ceased WOF admin record, as the record store holds it.
 */
export interface CeasedWOFDivision {
	id: number
	name: string
	names: string[]
	placetype: string
	country: string
	geonamesID: number | null
	supersededBy: number[]
	latitude: number | null
	longitude: number | null
}

/**
 * Whether a WOF record's properties describe a ceased place.
 */
export function isCeasedRecord(properties: Record<string, unknown>): boolean {
	const cessation = properties["edtf:cessation"]

	return properties["mz:is_current"] === 0 || (typeof cessation === "string" && /^\d/.test(cessation))
}

/**
 * The ceased division one stored WOF feature describes, or `null` when it isn't one.
 */
export function ceasedWOFDivision(id: number, properties: Record<string, unknown>): CeasedWOFDivision | null {
	const placetype = String(properties["wof:placetype"] ?? "")

	if (!FORMER_DIVISION_PLACETYPES.has(placetype) || !isCeasedRecord(properties)) return null

	if (typeof properties["edtf:deprecated"] === "string" && /^\d/.test(properties["edtf:deprecated"])) return null

	const name = String(properties["wof:name"] ?? "").trim()

	if (!name) return null

	const names = new Set([name, ...wofRecordNames(properties)])

	const concordances = properties["wof:concordances"] as Record<string, unknown> | undefined
	const geonamesID = Number(concordances?.["gn:id"])
	const supersededBy = properties["wof:superseded_by"]
	const latitude = Number(properties["lbl:latitude"] ?? properties["geom:latitude"])
	const longitude = Number(properties["lbl:longitude"] ?? properties["geom:longitude"])

	return {
		id,
		name,
		names: [...names],
		placetype,
		country: String(properties["wof:country"] ?? "")
			.trim()
			.toUpperCase(),
		geonamesID: Number.isInteger(geonamesID) && geonamesID > 0 ? geonamesID : null,
		supersededBy: Array.isArray(supersededBy) ? supersededBy.filter((v): v is number => Number.isInteger(v)) : [],
		latitude: Number.isFinite(latitude) ? latitude : null,
		longitude: Number.isFinite(longitude) ? longitude : null,
	}
}

/**
 * One country's census line: its count of former divisions and the count each evidence source links.
 */
export interface FormerDivisionCensusRow {
	country: string
	/**
	 * GeoNames historical divisions, by feature code.
	 */
	geonames: Record<string, number>
	/**
	 * Ceased WOF admin records.
	 */
	wofCeased: number
	/**
	 * Ceased WOF records joined to a GeoNames division by `gn:id`.
	 */
	joined: number
	divisions: number
	/**
	 * GeoNames divisions whose level maps to no tag: the country's current divisions
	 * of that level match no WOF record.
	 */
	untagged: number
	/**
	 * Untagged GeoNames divisions that some evidence links, left out of the table.
	 */
	linkedUntagged: number
	/**
	 * GeoNames divisions by {@link AdminCodeState}.
	 */
	codeStates: Record<AdminCodeState, number>
	/**
	 * Divisions with at least one current WOF place through each evidence source, tagged or not.
	 */
	linked: Record<FormerDivisionEvidence, number>
	/**
	 * Divisions with a link through any source.
	 */
	linkedAny: number
	/**
	 * Linked divisions by tag.
	 */
	linkedByTag: Partial<Record<DivisionTag, number>>
}

export interface BuildFormerDivisionsInput {
	/**
	 * Every country's historical and current GeoNames divisions.
	 */
	geonames: ReadonlyMap<string, { historical: GeonamesHistoricalDivision[]; current: CurrentDivisionRow[] }>
	/**
	 * Current GeoNames rows carrying each country's retired code paths,
	 * keyed by country then `<level>:<path>`.
	 */
	rowsCarryingCodes: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>
	hierarchyChildren: ReadonlyMap<number, readonly number[]>
	/**
	 * The WOF places of every GeoNames id the build reads.
	 */
	wofPlaces: ReadonlyMap<number, readonly WOFPlaceRef[]>
	ceased: readonly CeasedWOFDivision[]
	/**
	 * Whether each WOF id is a current record.
	 */
	isCurrentWOF: (id: number) => boolean
}

/**
 * The tag each country's level takes, from the WOF placetypes its current `ADMn` rows map to.
 */
export function levelTags(
	geonames: BuildFormerDivisionsInput["geonames"],
	wofPlaces: BuildFormerDivisionsInput["wofPlaces"]
): Map<string, DivisionTag> {
	const counts = new Map<string, Map<DivisionTag, number>>()

	for (const [country, { current }] of geonames) {
		for (const row of current) {
			for (const place of wofPlaces.get(row.geonamesID) ?? []) {
				const tag = tagOfPlacetype(place.placetype)

				if (!tag) continue

				const key = `${country}:${row.level}`
				let tally = counts.get(key)

				if (!tally) {
					counts.set(key, (tally = new Map()))
				}

				tally.set(tag, (tally.get(tag) ?? 0) + 1)
			}
		}
	}

	const tags = new Map<string, DivisionTag>()

	for (const [key, tally] of counts) {
		const [top] = [...tally].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

		if (top) {
			tags.set(key, top[0])
		}
	}

	return tags
}

/**
 * Counts a division's links by evidence, whatever tag it takes.
 */
function countLinks(entry: FormerDivisionCensusRow, links: readonly FormerDivisionLink[]): void {
	for (const link of links) {
		entry.linked[link.evidence]++
	}
}

function emptyCensusRow(country: string): FormerDivisionCensusRow {
	return {
		country,
		geonames: {},
		wofCeased: 0,
		joined: 0,
		divisions: 0,
		untagged: 0,
		linkedUntagged: 0,
		codeStates: { absent: 0, shared: 0, retired: 0, ambiguous: 0, uncoded: 0 },
		linked: { geonames_hierarchy: 0, geonames_admin_codes: 0, wof_supersession: 0 },
		linkedAny: 0,
		linkedByTag: {},
	}
}

/**
 * Joins the sources into the linked divisions and the per-country census.
 *
 * A division with no link is counted and left out of `divisions`.
 */
export function buildFormerDivisions(input: BuildFormerDivisionsInput): {
	divisions: FormerDivisionRecord[]
	census: FormerDivisionCensusRow[]
} {
	const census = new Map<string, FormerDivisionCensusRow>()

	const row = (country: string) => {
		let entry = census.get(country)

		if (!entry) {
			census.set(country, (entry = emptyCensusRow(country)))
		}

		return entry
	}

	const tags = levelTags(input.geonames, input.wofPlaces)
	const ceasedByGeonames = new Map<number, CeasedWOFDivision>()

	for (const record of input.ceased) {
		row(record.country).wofCeased++

		if (record.geonamesID != null) {
			ceasedByGeonames.set(record.geonamesID, record)
		}
	}

	const currentWOFIDs = (geonamesIDs: readonly number[], self: number | null): number[] => {
		const ids = new Set<number>()

		for (const geonamesID of geonamesIDs) {
			for (const place of input.wofPlaces.get(geonamesID) ?? []) {
				if (place.id !== self) {
					ids.add(place.id)
				}
			}
		}

		return [...ids].toSorted((a, b) => a - b)
	}

	const supersessionLink = (record: CeasedWOFDivision | undefined): FormerDivisionLink | null => {
		const ids = (record?.supersededBy ?? []).filter((id) => input.isCurrentWOF(id))

		return ids.length
			? { evidence: FormerDivisionEvidence.WOFSupersession, wofIDs: [...new Set(ids)].toSorted((a, b) => a - b) }
			: null
	}

	const divisions: FormerDivisionRecord[] = []
	const joined = new Set<number>()

	const record = (division: FormerDivisionRecord) => {
		const entry = row(division.country)

		entry.divisions++

		if (division.links.length) {
			entry.linkedAny++
			entry.linkedByTag[division.tag] = (entry.linkedByTag[division.tag] ?? 0) + 1
			divisions.push(division)
		}
	}

	for (const [country, { historical, current }] of input.geonames) {
		const states = adminCodeStates(historical, current)
		const carrying = input.rowsCarryingCodes.get(country)

		for (const division of historical) {
			const entry = row(division.country || country)

			entry.geonames[division.featureCode] = (entry.geonames[division.featureCode] ?? 0) + 1

			const code = states.get(division.geonamesID)!

			entry.codeStates[code.state]++

			const wof = ceasedByGeonames.get(division.geonamesID)

			if (wof) {
				joined.add(wof.id)

				entry.joined++
			}

			const links: FormerDivisionLink[] = []
			const hierarchyIDs = currentWOFIDs(input.hierarchyChildren.get(division.geonamesID) ?? [], wof?.id ?? null)

			if (hierarchyIDs.length) {
				links.push({ evidence: FormerDivisionEvidence.GeonamesHierarchy, wofIDs: hierarchyIDs })
			}

			if (code.state === AdminCodeState.Retired && code.path) {
				const codeIDs = currentWOFIDs(carrying?.get(`${division.level}:${code.path}`) ?? [], wof?.id ?? null)

				if (codeIDs.length) {
					links.push({ evidence: FormerDivisionEvidence.GeonamesAdminCodes, wofIDs: codeIDs })
				}
			}

			const superseded = supersessionLink(wof)

			if (superseded) {
				links.push(superseded)
			}

			countLinks(entry, links)

			const tag =
				(wof && tagOfPlacetype(wof.placetype)) ??
				(division.level === 0 ? "country" : (tags.get(`${country}:${Math.min(division.level, 5)}`) ?? null))

			if (!tag) {
				entry.untagged++

				if (links.length) {
					entry.linkedUntagged++
				}

				continue
			}

			const names = [division.name, division.asciiName, ...(wof?.names ?? [])].filter((name) => name.length > 0)

			record({
				country: division.country || country,
				name: division.name,
				names: [...new Set(names)],
				kind: division.featureCode,
				tag,
				geonamesID: division.geonamesID,
				wofID: wof?.id ?? null,
				latitude: Number.isFinite(division.latitude) ? division.latitude : null,
				longitude: Number.isFinite(division.longitude) ? division.longitude : null,
				links,
			})
		}
	}

	for (const wof of input.ceased) {
		if (joined.has(wof.id)) continue

		const tag = tagOfPlacetype(wof.placetype)
		const superseded = supersessionLink(wof)

		countLinks(row(wof.country), superseded ? [superseded] : [])

		if (!tag) continue

		record({
			country: wof.country,
			name: wof.name,
			names: wof.names,
			kind: wof.placetype,
			tag,
			geonamesID: wof.geonamesID,
			wofID: wof.id,
			latitude: wof.latitude,
			longitude: wof.longitude,
			links: superseded ? [superseded] : [],
		})
	}

	return {
		divisions: divisions.toSorted(
			(a, b) => a.country.localeCompare(b.country) || a.name.localeCompare(b.name) || (a.wofID ?? 0) - (b.wofID ?? 0)
		),
		census: [...census.values()].toSorted((a, b) => a.country.localeCompare(b.country)),
	}
}

/**
 * A current WOF locality a former division covered, with the sub-localities WOF places inside it.
 */
export interface CoveredSettlement {
	id: number
	name: string
	dependents: readonly string[]
}

/**
 * The tags a recipe row may give a division: the two the resolver's `formerDivisions` switch reads.
 */
const RECIPE_TAGS: ReadonlySet<string> = new Set(["subregion", "region"])

export interface PlanFormerDivisionTuplesInput {
	divisions: readonly FormerDivisionRecord[]
	settlementsOf: (division: FormerDivisionRecord) => readonly CoveredSettlement[]
	/**
	 * A locality's postcodes and where the country writes them, or `null`
	 * when the country's placement is unattested.
	 */
	postcodesOf: (
		country: string,
		locality: string
	) => { codes: readonly string[]; placement: FormerDivisionTuple["postcode_placement"] } | null
	countryNameOf: (country: string) => string | null
	/**
	 * Rows per country at most.
	 */
	perCountry: number
	/**
	 * Rows per division at most.
	 */
	perDivision: number
}

/**
 * The rows of one division, ordered so the first rows cover distinct localities and both shapes.
 *
 * Every second row writes a postcode where the locality has one, and every third row a country.
 */
function divisionTuples(
	division: FormerDivisionRecord,
	input: PlanFormerDivisionTuplesInput,
	limit: number
): FormerDivisionTuple[] {
	const settlements = input.settlementsOf(division).toSorted((a, b) => a.id - b.id)
	const tuples: FormerDivisionTuple[] = []
	const countryName = input.countryNameOf(division.country)
	const divisionID = division.geonamesID != null ? `geonames:${division.geonamesID}` : `wof:${division.wofID}`
	// Each round writes every locality once, the variant turning with the locality
	// and the round, so the first round already holds both shapes and, where WOF
	// places a sub-locality inside, a dependent locality.
	const variants = FORMER_DIVISION_SHAPES.length * 2

	for (let round = 0; round < variants && tuples.length < limit; round++) {
		for (const [position, settlement] of settlements.entries()) {
			if (tuples.length >= limit) break

			const variant = (position + round) % variants
			const shape = FORMER_DIVISION_SHAPES[variant % FORMER_DIVISION_SHAPES.length]!
			const withDependent = variant >= FORMER_DIVISION_SHAPES.length && settlement.dependents.length > 0
			const dependent = withDependent ? settlement.dependents[round % settlement.dependents.length]! : null

			const postcodes = tuples.length % 2 === 1 ? input.postcodesOf(division.country, settlement.name) : null
			const postcode = postcodes?.codes.length ? postcodes.codes[tuples.length % postcodes.codes.length]! : null

			tuples.push({
				country: division.country,
				division: division.name,
				division_tag: division.tag as FormerDivisionTuple["division_tag"],
				division_id: divisionID,
				settlement_id: settlement.id,
				locality: settlement.name,
				dependent_locality: dependent,
				postcode,
				postcode_placement: postcode ? postcodes!.placement : null,
				country_name: tuples.length % 3 === 2 ? countryName : null,
				shape,
				index: tuples.length,
			})
		}
	}

	return tuples
}

/**
 * The recipe's rows: each `subregion` or `region` division's rows, capped per division,
 * then drawn round-robin across a country's divisions up to the country's cap,
 * so every country is capped by the same rule.
 */
export function planFormerDivisionTuples(input: PlanFormerDivisionTuplesInput): FormerDivisionTuple[] {
	const byCountry = new Map<string, FormerDivisionTuple[][]>()

	for (const division of input.divisions) {
		if (!RECIPE_TAGS.has(division.tag)) continue

		const tuples = divisionTuples(division, input, input.perDivision)

		if (!tuples.length) continue

		let lists = byCountry.get(division.country)

		if (!lists) {
			byCountry.set(division.country, (lists = []))
		}

		lists.push(tuples)
	}

	const planned: FormerDivisionTuple[] = []

	for (const country of [...byCountry.keys()].toSorted()) {
		const lists = byCountry.get(country)!
		let taken = 0

		for (let round = 0; taken < input.perCountry; round++) {
			let any = false

			for (const list of lists) {
				const tuple = list[round]

				if (!tuple || taken >= input.perCountry) continue

				planned.push(tuple)

				taken++
				any = true
			}

			if (!any) break
		}
	}

	return planned
}
