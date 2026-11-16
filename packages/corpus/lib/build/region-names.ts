// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Every country's first-level division names, abbreviations and ISO 3166-2 codes from the WOF
 *   admin database and libaddressinput's subdivision keys, for the component check's `region:unknown` rule.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { isPresent } from "@mailwoman/core/objects"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { subdivisionWrittenForms } from "#adapters/wof/admin/json/region-codes"

/**
 * The WOF placetypes a row's `region` may name: a region, or the macroregion above it where a country's
 * addresses write that level (England, Scotland, Wales and Northern Ireland are GB macroregions).
 */
const REGION_PLACETYPES = ["region", "macroregion"] as const

/**
 * The WOF concordances that hold a region's current ISO 3166-2 code, such as `CH-ZH`.
 */
const ISO_SUBDIVISION_SOURCES = ["iso:id", "iso:code"] as const

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
 * The fold the resolver keys its region lookups with.
 */
export const foldRegionName = (name: string): string => normalizeLocalityForKey(name)

/**
 * Reads every current region's `spr` name, `names` rows, `place_abbr` abbreviations
 * and the written part of its ISO 3166-2 code, per country.
 *
 * @throws When the database holds no region at all, because an empty table would leave every row unjudged.
 */
export async function readRegionNames(path: PathBuilderLike): Promise<RegionNames> {
	using db = new DatabaseClient<WOFDatabase>(path, { readOnly: true })

	const regions = db
		.selectFrom("spr")
		.select(["id", "country"])
		.where("placetype", "in", REGION_PLACETYPES)
		.where("is_deprecated", "=", 0)

	const rows = await db
		.selectFrom("spr")
		.select(["country", "name"])
		.where("placetype", "in", REGION_PLACETYPES)
		.where("is_deprecated", "=", 0)
		.unionAll(
			db
				.selectFrom("names")
				.innerJoin(regions.as("r"), "r.id", "names.id")
				.select(["r.country as country", "names.name as name"])
		)
		.unionAll(
			db
				.selectFrom("place_abbr")
				.innerJoin(regions.as("r"), "r.id", "place_abbr.id")
				.select(["r.country as country", "place_abbr.abbr as name"])
		)
		.execute()

	const isoRows = await db
		.selectFrom("concordances")
		.innerJoin(regions.as("r"), "r.id", "concordances.id")
		.select(["r.country as country", "concordances.other_id as code"])
		.where("concordances.other_source", "in", ISO_SUBDIVISION_SOURCES)
		.execute()

	const byCountry = new Map<string, Set<string>>()

	const add = (rawCountry: string | null, name: string | null): void => {
		const country = rawCountry?.toUpperCase()
		const key = name ? foldRegionName(name) : ""

		if (!country || !key) return

		const names = byCountry.get(country) ?? new Set<string>()

		byCountry.set(country, names)
		names.add(key)
	}

	for (const row of rows) {
		add(row.country, row.name)
	}

	for (const row of isoRows) {
		if (row.country) {
			add(row.country, writtenISOSubdivisionCode(row.country, row.code))
		}
	}

	if (!byCountry.size) {
		throw new Error(`${path.toString()} holds no region or macroregion row, so no region value can be judged`)
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
		}

		return byCountry.get(country)
	}

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

	return {
		path: path.toString(),
		holds(country, region) {
			const code = country.toUpperCase()
			const names = namesOf(code)

			if (!names) return null

			return names.has(foldRegionName(region)) || holdsTruncation(code, names, region)
		},
	}
}

/**
 * The default WOF admin database's region names, or `null` when the database isn't on this host.
 */
export async function tryReadDefaultRegionNames(): Promise<RegionNames | null> {
	const path = wofDatabasePath("admin-global-priority.db")

	return (await pathExists(path)) ? readRegionNames(path) : null
}
