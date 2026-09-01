/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `wof-postalcode`: Who's On First postalcode GeoJSON-bundle adapter.
 *
 *   **Phase 1.5.1 pivot.** Replaces the previous SpatiaLite-backed implementation (formerly at
 *   `packages/corpus/lib/adapters/wof-postalcode/`, removed in this same change). The rationale is
 *   in `wof-admin-json/adapter.ts` and in `DECISIONS.md` — short version: the SQLite distribution
 *   mirror is dead, the live distro tags every postcode row `mz:is_current = -1` which the old
 *   `is_current = 1` predicate excluded, and localized `name:*` variants don't ship in the SQLite
 *   export at all.
 *
 *   Input: a directory containing one or more cloned `whosonfirst-data-postalcode-<cc>` repos plus
 *   the relevant `whosonfirst-data-admin-<cc>` repos (postcode records reference admin ancestry by
 *   `wof:parent_id`, so the locality / region / country records must be in the same walk for the
 *   ancestry chain to resolve). The corpus pipeline clones all four repos under
 *   `/data/corpus/sources/wof/repos/` and points the adapter at that root.
 *
 *   Per live postalcode record, the adapter emits one row per `(name-variant, hierarchy-variant)`
 *   pair:
 *
 *   - **Name variants**: canonical `wof:name` (slot key `default`, typically the postcode digits
 *       themselves) plus any `name:*` variants on the postcode feature. In practice WOF postcode
 *       records rarely carry localized name variants, so this expansion is usually a no-op — but
 *       the code path stays symmetric with the admin adapter for consistency.
 *   - **Hierarchy variants** (unchanged from the SQLite adapter): self, +locality, +locality+region,
 *       +locality+region+country.
 *
 *   `source_id` is `wof-postalcode-<wof_id>-<name-slot>-<hierarchy-variant>`. Ancestor names always
 *   come from the ancestor's canonical `wof:name`; this adapter does NOT iterate ancestor name
 *   variants (e.g. it does not emit `"75008 Париж"` even when Paris has a `name:rus_x_preferred`).
 *   That cross-product belongs to a future synthesis pass; emitting it here would multiply row
 *   counts ~10× without a clear training-value story.
 *
 *   License: CC0.
 */

import type { WhosOnFirstPlacetype } from "@mailwoman/core/resources/whosonfirst"
import type { ComponentTag } from "@mailwoman/core/types"

import {
	COUNTRY_DISPLAY_NAME,
	emitWOFJSONRows,
	LOCALE_BY_COUNTRY,
	nameSlotsFor as wofNameSlotsFor,
	type WOFVariantSpec,
} from "#adapters/wof-json-rows"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "#types"
import { buildAncestryIndex, walkFeatures, type WOFRecord } from "#utils"

/**
 * Map a WOF placetype to a Mailwoman `ComponentTag`, or `undefined` to skip.
 *
 * Per-adapter deliberately (the admin adapter carries its own): each table is a record FILTER for its adapter's
 * emission set — this one keeps `postalcode` plus the ancestry placetypes its variants render — not a shared
 * vocabulary.
 */
function placetypeToTag(placetype: WhosOnFirstPlacetype | string): ComponentTag | undefined {
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
			return undefined
	}
}

/**
 * Compute hierarchy variants for a postcode record. `selfName` is the postcode surface form (canonical `wof:name` for
 * the `default` slot, a `name:*` localized variant otherwise).
 */
export function postcodeVariantsFor(row: WOFRecord, ancestry: WOFRecord[], selfName: string): WOFVariantSpec[] {
	if (placetypeToTag(row.placetype) !== "postcode") return []

	const locality = ancestry.find((a) => placetypeToTag(a.placetype) === "locality")
	const region = ancestry.find((a) => placetypeToTag(a.placetype) === "region")
	const country = ancestry.find((a) => placetypeToTag(a.placetype) === "country")
	const countryDisplay = COUNTRY_DISPLAY_NAME[row.country] ?? country?.name ?? row.country

	const variants: WOFVariantSpec[] = [{ suffix: "self", components: { postcode: selfName } }]

	if (locality) {
		variants.push({
			suffix: "with-locality",
			components: { postcode: selfName, locality: locality.name },
		})
	}

	if (locality && region) {
		variants.push({
			suffix: "with-locality-region",
			components: { postcode: selfName, locality: locality.name, region: region.name },
		})
	}

	if (locality && region && country) {
		variants.push({
			suffix: "with-locality-region-country",
			components: {
				postcode: selfName,
				locality: locality.name,
				region: region.name,
				country: countryDisplay,
			},
		})
	}

	return variants
}

/**
 * Build the per-record name-slot list. The `default` slot uses `wof:name` verbatim (postcode digits); subsequent slots
 * come from `name:*` variants dedup'd against the default.
 */
export function nameSlotsFor(rec: WOFRecord): Array<{ key: string; value: string }> {
	return wofNameSlotsFor(rec)
}

/**
 * Registry id for this adapter. Stamped into every row it emits, so a corpus record can be traced back to the dataset
 * it came from.
 */
export const WOF_POSTALCODE_ADAPTER_ID = "wof-postalcode"

export function createWOFPostalcodeAdapter(): CorpusAdapter {
	return {
		id: WOF_POSTALCODE_ADAPTER_ID,
		defaultLicense: "CC0-1.0",
		description:
			"Who's On First postalcode GeoJSON bundles (postcode → locality/region pairs). Ancestor names from sibling admin repos.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			// Pass 1: full walk. We keep every record whose placetype maps to a ComponentTag — the
			// postcode adapter needs locality / region / country admin records in the index so it
			// can resolve postcode ancestry, even though it only emits rows for postcode records.
			const byID = new Map<number, WOFRecord>()

			for await (const rec of walkFeatures(opts.inputPath, { signal: opts.signal })) {
				if (opts.signal?.aborted) return

				if (opts.country && rec.country !== opts.country) continue

				if (!placetypeToTag(rec.placetype)) continue
				byID.set(rec.id, rec)
			}

			const ancestry = buildAncestryIndex(byID)

			// Pass 2: emit postcode rows only, sorted by id for determinism.
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
