/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Emits corpus rows from Who's On First postalcode GeoJSON repositories.
 *
 *   The input directory must hold the `whosonfirst-data-postalcode-<cc>` repositories and the matching
 *   `whosonfirst-data-admin-<cc>` repositories. Postcode records point to their ancestors by `wof:parent_id`, so the
 *   admin records must be in the same walk.
 *
 *   Each postcode record produces one row per pair of name slot and hierarchy variant. The name slots are the canonical
 *   `wof:name` (slot `default`) plus any `name:*` variants. The hierarchy variants are the postcode by itself, then with
 *   locality, region and country added in turn. Ancestor names always use the canonical `wof:name`.
 *
 *   `source_id` has the form `wof-postalcode-<wof_id>-<name-slot>-<hierarchy-variant>`.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import type { WhosOnFirstPlacetype } from "@mailwoman/core/resources/whosonfirst"

import {
	COUNTRY_DISPLAY_NAME,
	emitWOFJSONRows,
	LOCALE_BY_COUNTRY,
	nameSlotsFor as wofNameSlotsFor,
	type WOFVariantSpec,
} from "#adapters/wof/json-rows"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { US_STATE_BY_ABBREVIATION } from "#us/fips-state"
import { buildAncestorNameIndex, walkFeatures, type AncestorNames, type WOFRecord } from "#utils"

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
function placetypeToTag(placetype: WhosOnFirstPlacetype | string): ComponentTag | null {
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
 * `selfName` is the postcode text for the current name slot.
 */
export function postcodeVariantsFor(row: WOFRecord, ancestry: AncestorNames, selfName: string): WOFVariantSpec[] {
	if (placetypeToTag(row.placetype) !== "postcode") return []

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
export function nameSlotsFor(rec: WOFRecord): Array<{ key: string; value: string }> {
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
			// The index keeps admin records as well as postcodes so that postcode ancestry resolves.
			const byID = new Map<number, WOFRecord>()

			for await (const rec of walkFeatures(opts.inputPath, { signal: opts.signal })) {
				if (opts.signal?.aborted) return

				if (opts.country && rec.country !== opts.country) continue

				if (!placetypeToTag(rec.placetype)) continue
				byID.set(rec.id, rec)
			}

			const ancestry = buildAncestorNameIndex(byID, placetypeToTag)

			// The adapter read admin records so postcode ancestry resolves.
			// The index above now holds the three ancestor names read by each postcode variant.
			// Their removal here releases every admin record's `nameVariants` map before the emit pass.
			// `shouldEmit` skipped those records anyway.
			for (const [id, record] of byID) {
				if (placetypeToTag(record.placetype) !== "postcode") {
					byID.delete(id)
				}
			}

			yield* emitWOFJSONRows({
				records: byID,
				ancestry,
				adapterOptions: opts,
				adapterID: WOF_POSTALCODE_ADAPTER_ID,
				localeByCountry: LOCALE_BY_COUNTRY,
				shouldEmit: (record) => placetypeToTag(record.placetype) === "postcode",
				nameSlotsFor,
				variantsFor: postcodeVariantsFor,
			})
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const wofPostalcodeAdapter = createWOFPostalcodeAdapter()
