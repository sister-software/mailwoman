/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `overture`: Overture Maps Addresses adapter; the `street` value keeps the locale's street keyword
 * verbatim, and the downstream affix-relabel splits `street_prefix` from it.
 */

import { formatAddressRow } from "@mailwoman/codex/address-format"
import { COUNTRY_SURFACE_FORMS } from "@mailwoman/codex/country"
import { tryParsingJSON } from "@mailwoman/core/json"
import { sample } from "@mailwoman/core/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { TextSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/utils"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id stamped into every row this adapter emits, so a corpus record traces back to its dataset.
 */
export const OVERTURE_ADAPTER_ID = "overture"
/**
 * License carried by this source (`cdla-Permissive-2.0`, attribution-only
 * rather than share-alike), attached to every row.
 */
export const OVERTURE_DEFAULT_LICENSE = "CDLA-Permissive-2.0"

const DEFAULT_COUNTRY_SEED = 20_260_922

/**
 * One attested written form of a country's name; raises rather than returning empty
 * when the codex has no entry, so a requested fraction cannot silently produce no country rows.
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
 * The flattened per-row shape emitted by `ingest-overture-addresses.ts --corpus-jsonl`.
 */
interface OvertureCorpusRow {
	street?: string
	number?: string
	unit?: string
	postcode?: string
	locality?: string
}

/**
 * Whether an Overture `unit` value is a secondary-unit designator (a digit or a single bare word)
 * rather than a name; Overture-SG puts an estate name in this field on 91,818 of 142,210 rows
 * and the literal `NIL` on 47,407 more, so a name taught as `unit` would teach a trailing proper name.
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
		// Overture rows carry their own `sources[].dataset` and `sources[].license`,
		// so this declares the aggregator rather than asserting a national grant.
		register: SourceRegister.Overture,
		surface: SurfaceOrigin.Attested,
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

			// The path string lets `TextSpliterator` own and dispose the file handle, including on an early `break`.
			const lines = TextSpliterator.fromAsync(opts.inputPath)

			let emitted = 0

			for await (const line of lines) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

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

				// Overture "S-N" / "S/N" = sin número; only keep a real numeric house number.
				if (/^\d/.test(number)) {
					components.house_number = number
				}

				components.street = street

				if (unitFieldIsDesignator(unit)) {
					components.unit = unit
				}

				if (postcode) {
					components.postcode = postcode
				}

				if (locality) {
					components.locality = locality
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
					corpus_version: "",
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
