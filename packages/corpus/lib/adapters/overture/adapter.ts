// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `overture`: Overture Maps Addresses adapter.
 *
 * The `street` value keeps the locale's street keyword verbatim.
 * The downstream affix-relabel step splits `street_prefix` from that value.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { CA_PROVINCES } from "@mailwoman/codex/ca/province"
import { COUNTRY_SURFACE_FORMS } from "@mailwoman/codex/country"
import { writtenPostcode } from "@mailwoman/codex/labels/postcode/written-groups"
import { mxStatePostalAbbreviation } from "@mailwoman/codex/mx/state"
import { sample } from "@mailwoman/core/math/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { tryParsingJSON } from "@mailwoman/core/values/json"
import { TextSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/source-id"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id stamped into every row this adapter emits, so a corpus record traces back to its dataset.
 */
export const OVERTURE_ADAPTER_ID = "overture"
/**
 * License assigned by this source (`cdla-Permissive-2.0`, attribution-only
 * rather than share-alike), attached to every row.
 */
export const OVERTURE_DEFAULT_LICENSE = "CDLA-Permissive-2.0"

const DEFAULT_COUNTRY_SEED = 20_260_922

/**
 * One attested written form of a country's name.
 *
 * Raises rather than returning empty when the codex has no entry, so a requested
 * fraction cannot silently produce no country rows.
 */
function countrySurfaceForm(country: string, random: () => number): string {
	const forms = COUNTRY_SURFACE_FORMS[country as keyof typeof COUNTRY_SURFACE_FORMS]

	if (!forms?.length) {
		throw new Error(
			`No COUNTRY_SURFACE_FORMS entry for ${country} — add it to codex/country/country.ts before using --country-fraction`
		)
	}

	return sample(forms, random)
}

/**
 * The flattened per-row shape `mailwoman gazetteer overture-ingest --corpus-jsonl` emits.
 *
 * `region` is Overture's first address level.
 * A file written before the ingest emitted it has none.
 */
interface OvertureCorpusRow {
	street?: string | null
	number?: string | null
	unit?: string | null
	postcode?: string | null
	locality?: string | null
	region?: string | null
}

/**
 * What Overture's `unit` field holds in a country where it isn't a secondary unit.
 *
 * - `orientation-number`: the street number (`číslo orientační`) of a building whose
 *   `number` is its district-wide descriptive number (`číslo popisné`).
 *   The two are written `descriptive/orientation`.
 * - `number-suffix`: a letter written against the house number.
 */
type OvertureUnitFieldRole = "orientation-number" | "number-suffix"

/**
 * The role of Overture's `unit` field in each country where it isn't a secondary unit.
 *
 * Read off the 2026-06-17.0 per-country corpus JSONL: every filled Czech `unit` is digits
 * beside a digit `number` (101,127 of 394,880 rows, such as `Nad Stadiónem` `320` `28`),
 * and in the first 400,000 German rows 17,250 of the 17,304 filled ones are one
 * or two letters (`Neutrale Straße` `28` `a`).
 */
const OVERTURE_UNIT_FIELD_ROLES: Readonly<Record<string, OvertureUnitFieldRole>> = {
	// UPU, Czech Rep. (02/2018): `The street number often consists of two numbers separated by a slash.
	// The first number is a unique district-related building number [...], the second number is the
	// street number`, as in `Hrušovská 455/10`.
	CZ: "orientation-number",
	// UPU, Germany (01/2015): `Wacholderweg 52a`.
	DE: "number-suffix",
}

/**
 * The house number with the `unit` field joined into it as the country's role for that
 * field states, or `null` when the field doesn't belong in the number.
 */
function joinUnitIntoNumber(number: string, unit: string, role: OvertureUnitFieldRole | null): string | null {
	if (!role || !/^\d/u.test(number)) return null

	if (role === "orientation-number") return /^\d+\p{Letter}?$/u.test(unit) ? `${number}/${unit}` : null

	return /^\p{Letter}{1,2}$/u.test(unit) ? `${number}${unit}` : null
}

/**
 * How a region value in Overture's first address level becomes the form the country's
 * operator prints, for each country where Overture's value can be read as that form.
 *
 * A country absent here renders no region from Overture.
 * Its first level is a unit the operator doesn't print: Italy's is `Sardegna`,
 * where the operator prints the province `RM`.
 */
const OVERTURE_REGION_FORMS: Readonly<Record<string, (value: string) => string | null>> = {
	// UPU, Brazil (03/2012): `The state abbreviation (two characters) must follow the town's name separated
	// by a dash`, as in `GUARAPUAVA – PR`. Overture writes the two-letter UF (`RS`).
	BR: (value) => (/^[A-Z]{2}$/u.test(value) ? value : null),
	// UPU, Canada (09/2014): `MONTREAL QC H3Z 2Y7`, `QC is the province abbreviation`.
	// Overture writes the ISO 3166-2:CA code, and the code is that abbreviation.
	CA: (value) => (Object.hasOwn(CA_PROVINCES, value) ? value : null),
	// UPU, Mexico (03/2017): `02860 MEXICO, CDMX`.
	// Overture writes the state's name (`Michoacán de Ocampo`).
	MX: mxStatePostalAbbreviation,
}

/**
 * Whether an Overture `unit` value is a secondary-unit designator
 * (a digit or a single bare word) rather than a name.
 *
 * Overture-SG puts an estate name in this field on 91,818 of 142,210 rows and the literal
 * `NIL` on 47,407 more, so a name taught as `unit` would teach a trailing proper name.
 */
export function unitFieldIsDesignator(value: string): boolean {
	const trimmed = value.trim()

	if (!trimmed || trimmed.toUpperCase() === "NIL") return false

	return /\d/u.test(trimmed) || !/\s/u.test(trimmed)
}

function parseLine(line: string): OvertureCorpusRow | null {
	const t = line.trim()

	if (!t || t.startsWith("#")) return null

	const o = tryParsingJSON(t)

	return o && typeof o === "object" ? (o as OvertureCorpusRow) : null
}

export function createOvertureAdapter(): CorpusAdapter {
	return {
		id: OVERTURE_ADAPTER_ID,
		defaultLicense: OVERTURE_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		// Overture rows include their own `sources[].dataset` and `sources[].license`,
		// so this declares the aggregator rather than asserting a national grant.
		register: SourceRegister.Overture,
		surface: SurfaceOrigin.Rendered,
		description: "Overture Maps Addresses (global): per-country JSONL of street/number/postcode/locality.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (!opts.country) {
				throw new Error(
					"overture adapter: --country is required (the Overture JSONL is per-country and rows omit a country field)"
				)
			}

			const country = opts.country
			const countryFraction = opts.countryFraction ?? 0
			const random = makeMulberry32(opts.seed ?? DEFAULT_COUNTRY_SEED)
			const code = country.toUpperCase()
			const unitRole = Object.hasOwn(OVERTURE_UNIT_FIELD_ROLES, code) ? OVERTURE_UNIT_FIELD_ROLES[code]! : null
			const regionForm = Object.hasOwn(OVERTURE_REGION_FORMS, code) ? OVERTURE_REGION_FORMS[code]! : null

			// The path string lets `TextSpliterator` own and dispose the file handle, including on an early `break`.
			const lines = TextSpliterator.fromAsync(opts.inputPath)

			let emitted = 0

			for await (const line of lines) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const r = parseLine(line)

				if (!r) continue

				const street = r.street?.trim() ?? ""
				const number = r.number?.trim() ?? ""
				const unit = r.unit?.trim() ?? ""
				const postcode = r.postcode?.trim() ?? ""
				const locality = r.locality?.trim() ?? ""

				// Only useful with a street + (postcode or locality); point-only rows quarantine anyway.
				if (!street) continue

				if (!postcode && !locality) continue

				const components: CanonicalRow["components"] = {}
				const joined = unit ? joinUnitIntoNumber(number, unit, unitRole) : null

				// Overture "S-N" / "S/N" = sin número; only keep a real numeric house number.
				if (/^\d/.test(number)) {
					components.house_number = joined ?? number
				}

				components.street = street

				if (!joined && unitFieldIsDesignator(unit)) {
					components.unit = unit
				}

				if (postcode) {
					components.postcode = writtenPostcode(postcode, country)
				}

				if (locality) {
					components.locality = locality
				}

				const region = regionForm && r.region?.trim() ? regionForm(r.region.trim()) : null

				if (region) {
					components.region = region
				}

				// Overture rows are country-implicit, so the surface form goes into `components`
				// and each country's layout decides where the country lands in the rendered string.
				if (countryFraction > 0 && random() < countryFraction) {
					components.country = countrySurfaceForm(country, random)
				}

				const rendered = formatAddressRow(components, country, { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				yield {
					raw,
					components: aligned,
					country,
					source: OVERTURE_ADAPTER_ID,
					source_id: stableSourceID(OVERTURE_ADAPTER_ID, aligned),
					license: OVERTURE_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const overtureAdapter = createOvertureAdapter()
