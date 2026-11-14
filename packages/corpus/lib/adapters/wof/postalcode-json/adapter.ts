// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Emits corpus rows from Who's On First postalcode GeoJSON repositories.
 *
 *   The input directory must hold the `whosonfirst-data-postalcode-<cc>` repositories
 *   and the matching `whosonfirst-data-admin-<cc>` repositories.
 *   Postcode records point to their ancestors by `wof:parent_id`, so the admin
 *   records must be in the same walk.
 *
 *   Each postcode record produces one row per pair of name slot and hierarchy variant.
 *   The name slots are the canonical `wof:name` (slot `default`) plus any `name:*` variants.
 *
 *   The hierarchy variants are the postcode by itself, then with locality,
 *   region and country added in turn.
 *   Ancestor names always use the canonical `wof:name`.
 *
 *   `source_id` has the form `wof-postalcode-<wof_id>-<name-slot>-<hierarchy-variant>`.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import type { WhosOnFirstPlacetype } from "@mailwoman/gazetteer/whosonfirst"

import {
	COUNTRY_DISPLAY_NAME,
	emitWOFJSONRows,
	LOCALE_BY_COUNTRY,
	nameSlotsFor as wofNameSlotsFor,
	type NameSlot,
	type WOFVariantSpec,
} from "#adapters/wof/json-rows"
import { RowSampler } from "#adapters/wof/sample"
import { openStoredRecordEntries } from "#adapters/wof/stored-records"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { US_STATE_BY_ABBREVIATION } from "#us/fips-state"
import type { AncestorNames, WOFRecord } from "#utils"
import { ancestorNamesOf, ancestorRecordsOf } from "#utils/wof-json"

/**
 * Maps a lowercase US state name to its USPS code.
 *
 * WOF stores full state names such as `Oregon`, and the address layout prints components unchanged.
 * The adapter substitutes the USPS code so the row matches how a US postal address is written.
 */
const US_STATE_ABBREVIATION_BY_NAME: ReadonlyMap<string, string> = new Map(
	Object.values(US_STATE_BY_ABBREVIATION).map((state) => [state.name.toLowerCase(), state.abbreviation])
)

/**
 * Returns the region text to print.
 *
 * The adapter converts US state names to USPS codes.
 * Other names pass through.
 */
function regionSurface(country: string, name: string): string {
	// country-branch: the codex holds a name-to-code table for US states only.
	// The WOF admin database's `place_abbr` holds codes for ten countries
	// and an ISO 3166-2 table would cover every country.
	// The tree holds neither as a lookup yet.
	if (country !== "US") return name

	return US_STATE_ABBREVIATION_BY_NAME.get(name.trim().toLowerCase()) ?? name
}

/**
 * Maps a WOF placetype to a component tag, or returns `undefined` for a placetype this adapter skips.
 *
 * The mapping also filters records, so it covers only `postalcode`
 * and the ancestor placetypes the variants use.
 * The admin adapter keeps its own mapping.
 */
function postcodePlacetypeToTag(placetype: WhosOnFirstPlacetype | string): ComponentTag | null {
	switch (placetype) {
		case "country":
		case "nation":
			return "country"
		case "macroregion":
		case "region":
			return "region"
		case "locality":
			return "locality"
		case "postalcode":
			return "postcode"
		default:
			return null
	}
}

/**
 * Builds the hierarchy variants for a postcode record, or returns an empty list for any other placetype.
 *
 * The slot's value is the postcode text.
 */
export function postcodeVariantsFor(row: WOFRecord, ancestry: AncestorNames, slot: NameSlot): WOFVariantSpec[] {
	if (postcodePlacetypeToTag(row.placetype) !== "postcode") return []

	const selfName = slot.value

	const locality = ancestry.locality
	const region = ancestry.region
	const country = ancestry.country
	const countryDisplay = COUNTRY_DISPLAY_NAME[row.country] ?? country ?? row.country

	const variants: WOFVariantSpec[] = [{ suffix: "self", components: { postcode: selfName } }]

	if (locality) {
		variants.push({
			suffix: "with-locality",
			components: { postcode: selfName, locality },
		})
	}

	if (locality && region) {
		variants.push({
			suffix: "with-locality-region",
			components: { postcode: selfName, locality, region },
		})
	}

	if (locality && region && country) {
		variants.push({
			suffix: "with-locality-region-country",
			components: {
				postcode: selfName,
				locality,
				region: regionSurface(row.country, region),
				country: countryDisplay,
			},
		})
	}

	return variants
}

/**
 * Returns a record's name slots.
 *
 * The `default` slot holds `wof:name` unchanged.
 * The other slots hold `name:*` variants that differ from it.
 */
export function nameSlotsFor(rec: WOFRecord): NameSlot[] {
	return wofNameSlotsFor(rec)
}

/**
 * The source ID on rows from this adapter.
 */
export const WOF_POSTALCODE_ADAPTER_ID = "wof-postalcode"

/**
 * Creates the WOF postalcode adapter.
 */
export function createWOFPostalcodeAdapter(): CorpusAdapter {
	return {
		id: WOF_POSTALCODE_ADAPTER_ID,
		defaultLicense: "CC0-1.0",
		addressRole: AddressRole.Premise,
		register: SourceRegister.WhosOnFirst,
		surface: SurfaceOrigin.Rendered,
		description:
			"Who's On First postalcode GeoJSON bundles (postcode → locality/region pairs). Ancestor names from sibling admin repos.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			// Admin records are kept so a postcode's ancestry resolves, and only postcodes are rendered.
			using stored = await openStoredRecordEntries(opts, {
				keep: (record) => Boolean(postcodePlacetypeToTag(record.placetype)),
				render: (record) => postcodePlacetypeToTag(record.placetype) === "postcode",
				resolve: (record, lookup) => ancestorNamesOf(ancestorRecordsOf(record, lookup, postcodePlacetypeToTag)),
			})

			const sampler = opts.sample ? new RowSampler<CanonicalRow>(opts.sample) : undefined

			yield* emitWOFJSONRows({
				records: stored.entries,
				adapterOptions: opts,
				adapterID: WOF_POSTALCODE_ADAPTER_ID,
				localeByCountry: LOCALE_BY_COUNTRY,
				nameSlotsFor,
				variantsFor: postcodeVariantsFor,
				sampler,
			})

			await sampler?.writeOutputs()
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const wofPostalcodeAdapter = createWOFPostalcodeAdapter()
