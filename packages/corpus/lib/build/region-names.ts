// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Every country's first-level division names, abbreviations and ISO 3166-2 codes from the WOF
 *   admin database and libaddressinput's subdivision keys, for the component check's `region:unknown` rule.
 */

import { dependentTerritories, hasCountry } from "@mailwoman/codex/country/sets"
import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { isPresent } from "@mailwoman/core/values/objects"
import { regionKeys } from "@mailwoman/resolver-wof-sqlite/labels/region"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
||||||| parent of d4c6ad109b (layout: `resolver-wof-sqlite/lib` groups its label modules under `labels/` (#3388))
import { isPresent } from "@mailwoman/core/objects"
import { regionKeys } from "@mailwoman/resolver-wof-sqlite/labels/region"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import {
	normalizeLocalityForKey,
	withArabicLetterVariantsFolded,
	type NameKey,
} from "@mailwoman/resolver-wof-sqlite/labels/street/normalize"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { loadAdmin1 } from "#adapters/geonames/adapter"
import { subdivisionWrittenForms } from "#adapters/wof/admin/json/region-codes"
import { codeCountry, SUBDIVISION_OF_SOURCES } from "#utils/wof-json"

/**
 * The WOF placetypes a row's `region` may name: a region, or the macroregion above it where a country's
 * addresses write that level (England, Scotland, Wales and Northern Ireland are GB macroregions).
 */
const REGION_PLACETYPES = ["region", "macroregion"] as const

/**
 * The WOF placetype of the second-level division a country's rows may write in
 * the region slot, such as a Peruvian province.
 */
const SECOND_LEVEL_PLACETYPES = ["county"] as const

/**
 * The WOF concordances that hold a region's current ISO 3166-2 code, such as `CH-ZH`.
 */
const ISO_SUBDIVISION_SOURCES = ["iso:id", "iso:code"] as const

/**
 * The committed table of the countries whose rows write a second-level name in the region slot.
 */
const SECOND_LEVEL_REGION_TABLE_PATH = resolveModulePath("@mailwoman/corpus/data/region-slot-second-level.json")

/**
 * One country's counts in {@link SECOND_LEVEL_REGION_TABLE_PATH}.
 */
interface SecondLevelRegionCount {
	/**
	 * Base rows of the country with a region.
	 */
	withRegion: number
	/**
	 * Those whose region is a second-level name of the country and no region name of it.
	 */
	secondLevelOnly: number
}

/**
 * The census {@link SECOND_LEVEL_REGION_TABLE_PATH} holds.
 */
export interface SecondLevelRegionTable {
	$description: string
	/**
	 * The corpus manifest the counts were read from.
	 */
	manifest: string
	countries: Record<string, SecondLevelRegionCount>
}

/**
 * The least share of a country's rows with a region that must write a second-level name there
 * before the rule admits that country's second-level names.
 *
 * Over v0.8.10 the shares fall in two groups: CD, PE, PR and PS at 7.5 % to 76 %,
 * then Mali at 3.2 % on one value and every other country at 0.5 % or less.
 */
const SECOND_LEVEL_MIN_SHARE = 0.05

/**
 * The fewest such rows, so a country isn't admitted on a few rows.
 */
const SECOND_LEVEL_MIN_ROWS = 100

/**
 * The countries whose rows write a second-level name in the region slot at
 * {@link SECOND_LEVEL_MIN_SHARE} or more, in {@link SECOND_LEVEL_MIN_ROWS} rows or more.
 */
export function secondLevelAdmitted(table: Pick<SecondLevelRegionTable, "countries">): string[] {
	return Object.entries(table.countries)
		.filter(
			([, count]) =>
				count.secondLevelOnly >= SECOND_LEVEL_MIN_ROWS &&
				count.secondLevelOnly >= SECOND_LEVEL_MIN_SHARE * count.withRegion
		)
		.map(([country]) => country)
}

/**
 * The part of an ISO 3166-2 code an address writes for `country`'s subdivision, `ZH` for
 * `CH-ZH`, or `null` when the code belongs to another country or its part holds no letter.
 *
 * A numeric part, such as Thailand's `TH-10` or Latvia's `LV-088`, is a register number
 * rather than a written form, and as a region it would admit a misplaced postcode or house number.
 */
export function writtenISOSubdivisionCode(country: string, isoCode: string): string | null {
	const prefix = `${country.toUpperCase()}-`

	if (!isoCode.toUpperCase().startsWith(prefix)) return null

	const code = isoCode.slice(prefix.length)

	return /\p{L}/u.test(code) ? code : null
}

/**
 * A word written as its leading letters and a full stop, `nov.` for `novads` or `obl.` for `oblast`.
 */
const TRUNCATED_WORD = /^(\p{L}{2,})\.$/u

/**
 * The placeholder that stands for the truncated word in an abbreviation key.
 */
const TRUNCATED_SLOT = "\u0001"

/**
 * The folded names and abbreviations of each country's regions.
 */
export interface RegionNames {
	/**
	 * The database the names were read from.
	 */
	path: string
	/**
	 * Whether `region` folds to a name or abbreviation of one of `country`'s regions, or `null`
	 * when neither source holds a region of `country` and the value cannot be judged.
	 */
	holds(country: string, region: string): boolean | null
}

/**
 * The fold the resolver keys its region lookups with, with Arabic letter variants folded together.
 */
export const foldRegionName = (name: string): string => withArabicLetterVariantsFolded(normalizeLocalityForKey(name))

/**
 * A folded region name with its spaces, dashes and format characters removed,
 * `nakhonphanom` for `nakhon phanom`, `bariavungtau` for `ba ria - vung tau`,
 * and `ชลบุรี` for `ชลบุรี` written with a trailing zero-width space.
 *
 * Over the WOF admin database of 2026-11-14, 11 of 5,095 regions and macroregions share a
 * compact key with another region of their country that no spaced key of theirs shares.
 */
export const compactRegionKey = (key: string): string => key.replaceAll(/[\s\p{Pd}\p{Cf}]/gu, "")

const LATIN_INITIAL = /^\p{Script=Latin}/u

/**
 * The fewest words a name needs before all of it collapses to initials, so no initialism
 * of a whole name is two letters long and meets a two-letter subdivision code.
 */
const WHOLE_NAME_INITIALISM_MIN_WORDS = 3

/**
 * The compact keys a folded name of Latin words gives when a run of two or more of its
 * words is written as their initials: `ntb` and `ntbarat` for `nusa tenggara barat`,
 * `diyogyakarta` for `daerah istimewa yogyakarta`.
 *
 * The whole name collapses only when it has three or more words, so no two-letter key comes of it.
 * Over the WOF admin database of 2026-11-14 the 67,031 keys this gives include 143 that
 * are another country's region key, such as `slp` for San Luis Potosí.
 */
export function regionInitialisms(key: string): string[] {
	const words = key.split(" ")

	if (words.length < 2 || !words.every((word) => LATIN_INITIAL.test(word))) return []

	const initialisms: string[] = []

	for (let start = 0; start < words.length; start++) {
		for (let end = start + 2; end <= words.length; end++) {
			if (start === 0 && end === words.length && words.length < WHOLE_NAME_INITIALISM_MIN_WORDS) continue

			const initials = words
				.slice(start, end)
				.map((word) => word[0])
				.join("")

			initialisms.push(compactRegionKey([...words.slice(0, start), initials, ...words.slice(end)].join("")))
		}
	}

	return initialisms
}

/**
 * The keys a row's region value is looked up under: the resolver's region-qualifier expansion
 * ({@link regionKeys}, which strips the `County` and `Co.` prefixes and the `Province` suffix
 * and adds the codex subdivision names), each with Arabic letter variants folded.
 */
function lookupKeys(country: string, region: string): string[] {
	return [...regionKeys(region, country)].map((key) => withArabicLetterVariantsFolded(key as NameKey)).filter(isPresent)
}

/**
 * The names of the places `ids` lists, from `spr`, `names` and `place_abbr`.
 */
async function readNamesOfIDs(db: DatabaseClient<WOFDatabase>, ids: readonly number[]) {
	if (!ids.length) return []

	return db
		.selectFrom("spr")
		.select(["id", "name"])
		.where("id", "in", ids)
		.unionAll(db.selectFrom("names").select(["id", "name"]).where("id", "in", ids))
		.unionAll(db.selectFrom("place_abbr").select(["id", "place_abbr.abbr as name"]).where("id", "in", ids))
		.execute()
}

/**
 * The `country` and name of every current place of `placetypes`, from `spr`, `names`
 * and `place_abbr`, limited to `countries` when given.
 */
async function readAdminNames(
	db: DatabaseClient<WOFDatabase>,
	placetypes: readonly string[],
	countries: readonly string[] | null
) {
	if (countries && !countries.length) return []

	let places = db
		.selectFrom("spr")
		.select(["id", "country"])
		.where("placetype", "in", placetypes)
		.where("is_deprecated", "=", 0)

	if (countries) {
		places = places.where("country", "in", countries)
	}

	let own = db
		.selectFrom("spr")
		.select(["country", "name"])
		.where("placetype", "in", placetypes)
		.where("is_deprecated", "=", 0)

	if (countries) {
		own = own.where("country", "in", countries)
	}

	return own
		.unionAll(
			db
				.selectFrom("names")
				.innerJoin(places.as("p"), "p.id", "names.id")
				.select(["p.country as country", "names.name as name"])
		)
		.unionAll(
			db
				.selectFrom("place_abbr")
				.innerJoin(places.as("p"), "p.id", "place_abbr.id")
				.select(["p.country as country", "place_abbr.abbr as name"])
		)
		.execute()
}

/**
 * Folded names keyed by upper-case country code.
 */
type NamesByCountry = Map<string, Set<string>>

function addName(byCountry: NamesByCountry, rawCountry: string | null, name: string | null): void {
	const country = rawCountry?.toUpperCase()
	const key = name ? foldRegionName(name) : ""

	if (!country || !key) return

	const names = byCountry.get(country) ?? new Set<string>()

	byCountry.set(country, names)
	names.add(key)
}

/**
 * Whether a region value is held by a country's folded names: under one of its {@link lookupKeys},
 * as a slash-joined pair of names (`Cataluña/Catalunya`), or with one word truncated to a full stop.
 */
function createNameMatcher(namesOf: (country: string) => Set<string> | undefined) {
	const truncationsByCountry = new Map<string, Map<string, Set<string>>>()

	// Each name of two or more words, keyed once per word with that word replaced by the slot,
	// so `rezeknes nov` finds `rezeknes novads` under `rezeknes \u0001`.
	const truncationsOf = (country: string, names: Set<string>): Map<string, Set<string>> => {
		const cached = truncationsByCountry.get(country)

		if (cached) return cached

		const truncations = new Map<string, Set<string>>()

		for (const name of names) {
			const words = name.split(" ")

			if (words.length < 2) continue

			for (const [i, word] of words.entries()) {
				const key = words.with(i, TRUNCATED_SLOT).join(" ")
				const full = truncations.get(key) ?? new Set<string>()

				truncations.set(key, full)
				full.add(word)
			}
		}

		truncationsByCountry.set(country, truncations)

		return truncations
	}

	// A region written with one word truncated to its leading letters and a full stop,
	// `Rēzeknes nov.` for `Rēzeknes novads`, matches a name whose other words it writes in full.
	const holdsTruncation = (country: string, names: Set<string>, region: string): boolean => {
		const words = region.split(/\s+/u).filter(isPresent)

		if (words.length < 2) return false

		for (const [i, word] of words.entries()) {
			const stem = TRUNCATED_WORD.exec(word)?.[1]

			if (!stem) continue

			const folded = words.map((other, j) => (j === i ? TRUNCATED_SLOT : foldRegionName(other)))

			if (folded.some((other) => !other)) continue

			const prefix = foldRegionName(stem)
			const full = truncationsOf(country, names).get(folded.join(" "))

			if (full && [...full].some((candidate) => candidate.length > prefix.length && candidate.startsWith(prefix))) {
				return true
			}
		}

		return false
	}

	const compactByCountry = new Map<string, Set<string>>()

	// Each name with its spaces and dashes removed, and with each run of two or more
	// of its words written as their initials, so `NakhonPhanom` finds `nakhon phanom`
	// and `DIY` finds `daerah istimewa yogyakarta`.
	const compactOf = (country: string, names: Set<string>): Set<string> => {
		const cached = compactByCountry.get(country)

		if (cached) return cached

		const compact = new Set<string>()

		for (const name of names) {
			compact.add(compactRegionKey(name))

			for (const initialism of regionInitialisms(name)) {
				compact.add(initialism)
			}
		}

		compactByCountry.set(country, compact)

		return compact
	}

	const holdsValue = (country: string, names: Set<string>, region: string): boolean => {
		const keys = lookupKeys(country, region)

		if (keys.some((key) => names.has(key)) || holdsTruncation(country, names, region)) return true

		const compact = compactOf(country, names)

		return keys.some((key) => {
			const folded = compactRegionKey(key)

			return folded.length > 0 && compact.has(folded)
		})
	}

	return (country: string, region: string): boolean | null => {
		const code = country.toUpperCase()
		const names = namesOf(code)

		if (!names) return null

		if (holdsValue(code, names, region)) return true

		// A bilingual region written as both its names, `Cataluña/Catalunya`.
		const parts = region.split("/")

		return parts.length > 1 && parts.every((part) => part.trim() && holdsValue(code, names, part.trim()))
	}
}

/**
 * Options for {@link readRegionNames}.
 */
export interface ReadRegionNamesOptions {
	/**
	 * The countries whose second-level (WOF `county`) names a row's region may also hold.
	 */
	secondLevelCountries?: readonly string[]
	/**
	 * The GeoNames directory whose `admin1CodesASCII.txt` names each country's first-level divisions.
	 *
	 * Those names widen the country's set with the names GeoNames-derived rows
	 * write (`Munster`, `Lesser Poland`).
	 */
	geonamesDirectory?: PathBuilderLike
}

/**
 * The GeoNames file of first-level division names, under a GeoNames directory.
 */
const GEONAMES_ADMIN1_FILE = "admin1CodesASCII.txt"

/**
 * Reads every current region's `spr` name, `names` rows, `place_abbr` abbreviations
 * and the written part of its ISO 3166-2 code, per country.
 *
 * A dependent territory also holds the names of the regions whose ISO or HASC code is the territory's,
 * as France's region `French Guiana` (ISO `GF`) is for `GF`, and of its own WOF country record.
 * Those names and the second-level names of `secondLevelCountries` widen a country
 * that already holds a region, and leave a country with none unjudged.
 *
 * @throws When the database holds no region at all, because an empty table would leave every row unjudged.
 */
export async function readRegionNames(
	path: PathBuilderLike,
	options: ReadRegionNamesOptions = {}
): Promise<RegionNames> {
	using db = new DatabaseClient<WOFDatabase>(path, { readOnly: true })

	const regions = db
		.selectFrom("spr")
		.select(["id", "country"])
		.where("placetype", "in", REGION_PLACETYPES)
		.where("is_deprecated", "=", 0)

	const rows = await readAdminNames(db, REGION_PLACETYPES, null)

	const codeRows = await db
		.selectFrom("concordances")
		.innerJoin(regions.as("r"), "r.id", "concordances.id")
		.select([
			"concordances.id as id",
			"r.country as country",
			"concordances.other_id as code",
			"concordances.other_source as source",
		])
		.where("concordances.other_source", "in", SUBDIVISION_OF_SOURCES)
		.execute()

	const byCountry: NamesByCountry = new Map()

	for (const row of rows) {
		addName(byCountry, row.country, row.name)
	}

	if (!byCountry.size) {
		throw new Error(`${path.toString()} holds no region or macroregion row, so no region value can be judged`)
	}

	const dependents = dependentTerritories()
	// The dependent territory whose code leads each region's code, where that differs from the region's own country.
	const dependencyOf = new Map<number, Set<string>>()
	// Names that widen a country's set but never make a country judged on their own: a dependency's
	// names from its sovereign's region or its own record, and an admitted country's second-level names.
	// Saint-Martin's (`MF`) one-name country record would otherwise refuse its other spellings.
	const widening: NamesByCountry = new Map()

	for (const row of codeRows) {
		if (!row.country) continue

		if ((ISO_SUBDIVISION_SOURCES as readonly string[]).includes(row.source)) {
			addName(byCountry, row.country, writtenISOSubdivisionCode(row.country, row.code))
		}

		const named = codeCountry(row.code)

		if (!named || named === row.country.toUpperCase() || !hasCountry(dependents, named)) continue

		dependencyOf.set(row.id, (dependencyOf.get(row.id) ?? new Set()).add(named))
		addName(widening, named, writtenISOSubdivisionCode(named, row.code))
	}

	const ownRecords = await db
		.selectFrom("spr")
		.select(["id", "country"])
		.where("placetype", "in", ["country", "dependency"])
		.where("is_deprecated", "=", 0)
		.where("country", "in", [...dependents])
		.execute()

	for (const record of ownRecords) {
		if (record.country) {
			dependencyOf.set(record.id, (dependencyOf.get(record.id) ?? new Set()).add(record.country.toUpperCase()))
		}
	}

	for (const row of await readNamesOfIDs(db, [...dependencyOf.keys()])) {
		for (const country of dependencyOf.get(row.id) ?? []) {
			addName(widening, country, row.name)
		}
	}

	for (const row of await readAdminNames(db, SECOND_LEVEL_PLACETYPES, options.secondLevelCountries ?? [])) {
		addName(widening, row.country, row.name)
	}

	if (options.geonamesDirectory) {
		const directory = PathBuilder.from(options.geonamesDirectory)

		if (!(await pathExists(directory(GEONAMES_ADMIN1_FILE)))) {
			throw new Error(
				`${directory(GEONAMES_ADMIN1_FILE).toString()} is missing, so no GeoNames region name can be read`
			)
		}

		// Keyed `<CC>.<admin1 code>`.
		for (const [code, name] of await loadAdmin1(directory)) {
			addName(widening, code.split(".")[0] ?? null, name)
		}
	}

	// WOF's abbreviations and ISO codes miss some postal codes addresses write
	// for a subdivision (Italian provinces' `TO`, US `PR` and the military `AE`),
	// so libaddressinput's keys and names join each country's set.
	const merged = new Set<string>()

	const namesOf = (country: string): Set<string> | undefined => {
		if (!merged.has(country)) {
			merged.add(country)

			const forms = subdivisionWrittenForms(country).map(foldRegionName).filter(isPresent)

			if (forms.length) {
				byCountry.set(country, new Set([...(byCountry.get(country) ?? []), ...forms]))
			}

			const own = byCountry.get(country)

			if (own) {
				for (const name of widening.get(country) ?? []) {
					own.add(name)
				}
			}
		}

		return byCountry.get(country)
	}

	return { path: path.toString(), holds: createNameMatcher(namesOf) }
}

/**
 * Every country's second-level (WOF `county`) names, for counting the rows of
 * each country that write one in the region slot.
 *
 * `holds` answers `null` for a country with no county in the database.
 */
export async function readSecondLevelNames(path: PathBuilderLike): Promise<RegionNames> {
	using db = new DatabaseClient<WOFDatabase>(path, { readOnly: true })

	const byCountry: NamesByCountry = new Map()

	for (const row of await readAdminNames(db, SECOND_LEVEL_PLACETYPES, null)) {
		addName(byCountry, row.country, row.name)
	}

	return { path: path.toString(), holds: createNameMatcher((country) => byCountry.get(country)) }
}

/**
 * The countries {@link SECOND_LEVEL_REGION_TABLE_PATH} admits.
 */
async function readSecondLevelRegionCountries(): Promise<string[]> {
	return secondLevelAdmitted(await readLocalJSONFile<SecondLevelRegionTable>(SECOND_LEVEL_REGION_TABLE_PATH))
}

/**
 * The default WOF admin database's region names, with the second-level names of the
 * countries {@link SECOND_LEVEL_REGION_TABLE_PATH} admits and the data root's GeoNames
 * first-level names, or `null` when the database isn't on this host.
 *
 * @throws When the database is on this host and the GeoNames first-level file isn't.
 */
export async function tryReadDefaultRegionNames(): Promise<RegionNames | null> {
	const path = wofDatabasePath("admin-global-priority.db")

	if (!(await pathExists(path))) return null

	return readRegionNames(path, {
		secondLevelCountries: await readSecondLevelRegionCountries(),
		geonamesDirectory: dataRootPath("geonames"),
	})
}
