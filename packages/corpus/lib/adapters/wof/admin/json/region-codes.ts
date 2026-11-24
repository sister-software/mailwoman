// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The region codes a country's addresses write in place of the region's name,
 *   from Google libaddressinput.
 *
 *   A libaddressinput country spec lists its subdivisions twice: `sub_keys`,
 *   the value an address writes, and `sub_names`, the subdivision's name.
 *   The United States keys `NY` and names `New York`, so its addresses write `NY`.
 *
 *   France lists no subdivisions and Japan keys each prefecture by its name,
 *   so neither has a code to write.
 *   A country counts as writing codes when most of its keys differ from their names:
 *   AU, BR, CA, ES, HK, IT, KR, MX, SO and US in the vendored specs.
 */

import { layoutCitationForCountry, layoutForCountry, layoutPrintsTag } from "@mailwoman/codex/address/layouts"
import { readLocalTextFileSync } from "@mailwoman/core/fs/readers"
import { isFileSync } from "@mailwoman/core/fs/readers/stat"
import { escapeRegExp } from "@mailwoman/core/strings/regexp"
import { tryParsingJSON } from "@mailwoman/core/values/json"
import { isPresent } from "@mailwoman/core/values/objects"
import { sslAddressSpecsPath } from "@mailwoman/dictionaries/paths"

/**
 * The fields of a libaddressinput country spec this module reads.
 */
interface SubdivisionSpec {
	sub_keys?: string
	sub_names?: string
	sub_lnames?: string
	sub_isoids?: string
}

const CODES_BY_COUNTRY = new Map<string, ReadonlyMap<string, string>>()
const SPECS_BY_COUNTRY = new Map<string, SubdivisionSpec | null>()
const WRITTEN_CODES_BY_COUNTRY = new Map<string, ReadonlyMap<string, string>>()

/**
 * Reads one country's libaddressinput spec, once per country, or `null` when none is vendored.
 *
 * `variantsFor` runs synchronously inside the row generator, so the spec is read synchronously.
 */
function specFor(country: string): SubdivisionSpec | null {
	if (SPECS_BY_COUNTRY.has(country)) return SPECS_BY_COUNTRY.get(country) ?? null

	const path = sslAddressSpecsPath()(`${country}.json`)
	const spec = isFileSync(path) ? tryParsingJSON<SubdivisionSpec>(readLocalTextFileSync(path)) : null

	SPECS_BY_COUNTRY.set(country, spec)

	return spec
}

/**
 * Reads one country's name-to-code map, or an empty map when the country writes no codes.
 */
function codesFor(country: string): ReadonlyMap<string, string> {
	const cached = CODES_BY_COUNTRY.get(country)

	if (cached) return cached

	const codes = new Map<string, string>()
	const spec = specFor(country)
	const keys = spec?.sub_keys?.split("~") ?? []

	for (const names of [spec?.sub_names, spec?.sub_lnames]) {
		const values = names?.split("~") ?? []
		const differing = values.filter((name, i) => keys[i] && name !== keys[i]).length

		// A country whose keys are its names writes the name, so it has no code to substitute.
		if (values.length !== keys.length || differing * 2 <= keys.length) continue

		for (const [i, name] of values.entries()) {
			if (name !== keys[i]) {
				codes.set(name.toLowerCase(), keys[i]!)
			}
		}
	}

	CODES_BY_COUNTRY.set(country, codes)

	return codes
}

/**
 * The code `country`'s addresses use for the region `regionName`, or `null` when they write the name.
 */
export function regionCodeFor(country: string, regionName: string): string | null {
	return codesFor(country.toUpperCase()).get(regionName.toLowerCase()) ?? null
}

/**
 * The ISO 3166-2 code `region` stands for in `country`, when the country's
 * addresses write that code: the subdivision's libaddressinput key is its ISO code,
 * and the region is written as the key or as one of the subdivision's names.
 *
 * United States `TX` and `Texas` both return `TX`.
 * The United Arab Emirates keys Abu Dhabi by its Arabic name, `أبو ظبي`, beside ISO code `AZ`,
 * so its addresses write the name and the region returns `null`.
 * The comparison ignores case.
 */
export function writtenSubdivisionCode(country: string, region: string): string | null {
	const code = country.toUpperCase()
	const written = WRITTEN_CODES_BY_COUNTRY.get(code) ?? writtenCodesFor(code)

	return written.get(region.toLowerCase()) ?? null
}

/**
 * Reads one country's map from each lower-cased form of a code-keyed subdivision
 * to its code, once per country.
 */
function writtenCodesFor(country: string): ReadonlyMap<string, string> {
	const written = new Map<string, string>()
	const spec = specFor(country)
	const keys = spec?.sub_keys?.split("~") ?? []
	const isoIDs = spec?.sub_isoids?.split("~") ?? []
	const nameLists = [spec?.sub_names, spec?.sub_lnames].map((names) => names?.split("~") ?? [])

	for (const [i, key] of keys.entries()) {
		if (isoIDs.length !== keys.length || isoIDs[i]!.toLowerCase() !== key.toLowerCase()) continue

		for (const form of [key, ...nameLists.flatMap((list) => (list.length === keys.length ? [list[i]!] : []))]) {
			if (!written.has(form.toLowerCase())) {
				written.set(form.toLowerCase(), key)
			}
		}
	}

	WRITTEN_CODES_BY_COUNTRY.set(country, written)

	return written
}

/**
 * ISO 3166-2 codes that replaced a code the vendored libaddressinput specs still list,
 * keyed by the current code.
 *
 * ISO 3166-2:IN's change of 2023-11-23 ("Change of subdivision codes") moved Odisha
 * from `IN-OR` to `IN-OD`, Chhattisgarh from `IN-CT` to `IN-CG`, Telangana from
 * `IN-TG` to `IN-TS` and Uttarakhand from `IN-UT` to `IN-UK`.
 * GLEIF's golden copy of 2026-10-03 writes the current codes.
 *
 * The libaddressinput spec and Who's On First's concordances hold the earlier ones.
 */
const ISO_SUBDIVISION_CODES_REPLACED: Readonly<Record<string, string>> = {
	"IN-CG": "IN-CT",
	"IN-OD": "IN-OR",
	"IN-TS": "IN-TG",
	"IN-UK": "IN-UT",
}

/**
 * The form `country`'s addresses write for the subdivision whose ISO 3166-2 code ends in `isoSuffix`:
 * the libaddressinput key listed beside that ISO id, or `null` when the spec lists no such id.
 *
 * India keys Maharashtra by its name beside ISO id `MH`, so `IN`, `MH` returns `Maharashtra`.
 * The United States keys New York as `NY`, so `US`, `NY` returns `NY`.
 * The comparison ignores case.
 */
function writtenSubdivisionForISO(country: string, isoSuffix: string): string | null {
	const code = country.toUpperCase()
	const spec = specFor(code)
	const keys = spec?.sub_keys?.split("~") ?? []
	const isoIDs = spec?.sub_isoids?.split("~") ?? []

	if (isoIDs.length !== keys.length) return null

	const suffix = isoSuffix.toUpperCase()
	const listed = ISO_SUBDIVISION_CODES_REPLACED[`${code}-${suffix}`]?.slice(code.length + 1) ?? suffix
	const at = isoIDs.findIndex((isoID) => isoID.toUpperCase() === listed)

	return at === -1 ? null : keys[at]!
}

const CITED_KEY_FORM_BY_COUNTRY = new Map<string, boolean>()

/**
 * Whether `country`'s codex layout prints a region, has a primary citation, and one of
 * the citation's example lines writes a libaddressinput key as a word of its own.
 *
 * libaddressinput is a compiled dataset, so its key is the written form only where the postal operator's
 * own example agrees: Italy's description writes `00122 ROMA RM`, and its key for Rome is `RM`.
 * Chile's writes `REGION METROPOLITANA`, which isn't a Chilean key, so Chile reads no key.
 */
function citationWritesKeys(country: string): boolean {
	const cached = CITED_KEY_FORM_BY_COUNTRY.get(country)

	if (typeof cached === "boolean") return cached

	const layout = layoutForCountry(country)
	const citation = layoutCitationForCountry(country)
	const keys = specFor(country)?.sub_keys?.split("~").filter(isPresent) ?? []
	const lines = citation?.examples.flat() ?? []

	const writes =
		Boolean(layout && layoutPrintsTag(layout, "region")) &&
		keys.some((key) => {
			const word = new RegExp(`(?:^|[\\s,])${escapeRegExp(key)}(?:$|[\\s,])`, "iu")

			return lines.some((line) => word.test(line))
		})

	CITED_KEY_FORM_BY_COUNTRY.set(country, writes)

	return writes
}

/**
 * {@link writtenSubdivisionForISO}, for a country whose cited layout writes libaddressinput's
 * keys (`citationWritesKeys`), or `null` for any other country.
 */
export function citedSubdivisionForISO(country: string, isoSuffix: string): string | null {
	const code = country.toUpperCase()

	return citationWritesKeys(code) ? writtenSubdivisionForISO(code, isoSuffix) : null
}

/**
 * Every key and name libaddressinput lists for `country`'s subdivisions
 * (`TX`, `Texas`; `AE`, `Armed Forces (AE)`; `TO`, `Torino`), or none when it lists no subdivisions.
 */
export function subdivisionWrittenForms(country: string): string[] {
	const spec = specFor(country.toUpperCase())

	return [spec?.sub_keys, spec?.sub_names, spec?.sub_lnames].flatMap((list) => list?.split("~") ?? []).filter(isPresent)
}

/**
 * The name of the region `country`'s addresses write as `regionCode`, in lower case as the
 * spec table holds it, title-cased word by word, or `null` when they write no such code.
 */
export function regionNameFor(country: string, regionCode: string): string | null {
	const wanted = regionCode.toUpperCase()

	for (const [name, code] of codesFor(country.toUpperCase())) {
		if (code.toUpperCase() === wanted) {
			return name.replaceAll(/(^|\s)\p{L}/gu, (initial) => initial.toUpperCase())
		}
	}

	return null
}
