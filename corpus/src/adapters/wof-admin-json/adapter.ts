/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `wof-admin`: Who's On First admin GeoJSON-bundle adapter.
 *
 *   **Phase 1.5.1 pivot.** The original Phase 1.5 SQLite adapter (formerly at
 *   `packages/corpus/src/adapters/wof-admin/`, removed in this same change) was replaced by this
 *   one because the SQLite distribution path was unworkable for the real corpus build:
 *
 *   1. `dist.whosonfirst.org/sqlite/` is dead (NXDOMAIN); the Geocode-Earth mirror is the only one.
 *   2. The Geocode-Earth-hosted postalcode DB tags every row `mz:is_current = -1` ("unknown but treated
 *        as active"); the SQLite adapter's `is_current = 1` predicate emitted zero rows.
 *   3. The `names` table in the SQLite distribution is empty — localized `name:*` variants live in a
 *        separate distribution. The St. Petersburg / Mt. Vernon / Ft. Lauderdale alternation cases
 *        (the original Phase 1.5.1 motivator) cannot be solved on the SQLite path even with a
 *        patched `is_current` predicate.
 *
 *   Input: a directory containing one or more cloned `whosonfirst-data-admin-<cc>` GitHub repos. Each
 *   repo has `data/XXX/YYY/ZZZ/<wof-id>.geojson` files; `**\/*.geojson` walks the tree recursively.
 *   Alternate-geometry siblings (`-alt-*`) are skipped — they're separate exports of the same
 *   record, not new records.
 *
 *   Per record, the adapter emits one row per `(name-variant, hierarchy-variant)` pair:
 *
 *   - **Name variants**: the canonical `wof:name` (slot key `default`) plus every `name:*` localized
 *       variant present on the feature (`name:eng_x_preferred`, `name:eng_x_colloquial`,
 *       `name:rus_x_preferred`, ...). This is the Phase 1.5.1 fix for the St. Petersburg case:
 *       `"Saint Petersburg"` (canonical) and `"St. Petersburg"` (eng_x_colloquial) both become
 *       training rows for the same WOF id.
 *   - **Hierarchy variants** (unchanged from the SQLite adapter): locality → 3 variants, region → 2,
 *       country → 1, county → 1.
 *
 *   `source_id` is `wof-admin-<wof_id>-<name-slot>-<hierarchy-variant>`. The previous SQLite adapter
 *   used `wof-admin-<wof_id>-<hierarchy-variant>` (no name slot); the new format adds a name-slot
 *   segment so the colloquial / preferred / per-locale variants survive dedup independently.
 *
 *   License: CC0. The adapter stamps every row with `CC0-1.0`.
 */

import type { WhosOnFirstPlacetype } from "@mailwoman/core/resources/whosonfirst"
import type { ComponentTag } from "@mailwoman/core/types"

import { formatAddress, reconcileComponents } from "../../format.ts"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.ts"
import { buildAncestryIndex, normalizeNameKey, walkFeatures, type WOFRecord } from "../../wof-json.ts"

/**
 * Display name for the country, keyed by ISO 3166-1 alpha-2.
 *
 * Must be the **OpenCage-canonical** surface form: the `address-formatter` library expands some country names en route
 * to its output (e.g. `"United States"` → `"United States of America"`). If `components.country` and the formatted
 * `raw` disagree, alignment will fail downstream. Keying off the canonical form keeps the two in lockstep.
 *
 * Phase 1 US + FR only; extend as new locales come online. Missing countries fall back to the country row's `wof:name`,
 * accepting the alignment risk for non-canonicalized names.
 */
const COUNTRY_DISPLAY_NAME: Record<string, string> = {
	US: "United States of America",
	FR: "France",
}

/** BCP-47 locale defaulting for the corpus row's `locale` field. Defaulted by country. */
const LOCALE_BY_COUNTRY: Record<string, string> = {
	US: "en-US",
	FR: "fr-FR",
}

/** Map a WOF placetype to a Mailwoman `ComponentTag`, or `undefined` to skip. */
function placetypeToTag(placetype: WhosOnFirstPlacetype | string): ComponentTag | undefined {
	switch (placetype) {
		case "country":
		case "nation":
			return "country"
		case "macroregion":
		case "region":
			return "region"
		case "macrocounty":
		case "county":
		case "localadmin":
			return "subregion"
		case "locality":
			return "locality"
		case "borough":
		case "macrohood":
		case "neighbourhood":
		case "microhood":
			return "dependent_locality"
		default:
			return undefined
	}
}

interface VariantSpec {
	/** Hierarchy-variant id appended to `source_id`. */
	suffix: string

	/** Component tag → display string the adapter will hand to the runner. */
	components: Partial<Record<ComponentTag, string>>
}

/**
 * Compute the hierarchy variants for a record given its ancestry chain and the chosen `selfName`.
 *
 * `selfName` is the surface form to use for the record's own component (locality / region / country / subregion).
 * Callers pass the canonical `wof:name` for the `"default"` slot and a `name:*` localized value for variant slots;
 * ancestor names always come from the ancestor's canonical `wof:name`.
 *
 * Country variants substitute `COUNTRY_DISPLAY_NAME` for the default slot so the OpenCage template produces the
 * canonicalized form (`"United States of America"`), matching the legacy SQLite adapter's behavior.
 */
export function variantsFor(row: WOFRecord, ancestry: WOFRecord[], selfName: string): VariantSpec[] {
	const selfTag = placetypeToTag(row.placetype)

	if (!selfTag) return []

	const region = ancestry.find((a) => placetypeToTag(a.placetype) === "region")
	const country = ancestry.find((a) => placetypeToTag(a.placetype) === "country")
	const countryDisplay = COUNTRY_DISPLAY_NAME[row.country] ?? country?.name ?? row.country

	const variants: VariantSpec[] = []

	switch (selfTag) {
		case "locality":
		case "dependent_locality": {
			variants.push({ suffix: "self", components: { [selfTag]: selfName } })

			if (region) {
				variants.push({
					suffix: "with-region",
					components: { [selfTag]: selfName, region: region.name },
				})
			}

			if (region && country) {
				variants.push({
					suffix: "with-region-country",
					components: { [selfTag]: selfName, region: region.name, country: countryDisplay },
				})
			} else if (!region && country) {
				variants.push({
					suffix: "with-country",
					components: { [selfTag]: selfName, country: countryDisplay },
				})
			}

			return variants
		}

		case "region": {
			variants.push({ suffix: "self", components: { region: selfName } })

			if (country) {
				variants.push({
					suffix: "with-country",
					components: { region: selfName, country: countryDisplay },
				})
			}

			return variants
		}

		case "country": {
			variants.push({ suffix: "self", components: { country: selfName } })

			return variants
		}

		case "subregion": {
			variants.push({ suffix: "self", components: { subregion: selfName } })

			return variants
		}

		default:
			return []
	}
}

/**
 * Build the per-record name-slot list. The canonical `"default"` slot uses the OpenCage-canonical country form when the
 * record is itself a country (matches SQLite-adapter behavior); every other placetype's default slot uses `wof:name`
 * verbatim.
 *
 * Subsequent slots come from `name:*` variants, deduplicated against the default name so we don't emit a redundant
 * `"default"`-equivalent row under a localized key.
 */
export function nameSlotsFor(rec: WOFRecord): Array<{ key: string; value: string }> {
	const selfTag = placetypeToTag(rec.placetype)
	const canonicalSelfName = selfTag === "country" ? (COUNTRY_DISPLAY_NAME[rec.country] ?? rec.name) : rec.name

	const seen = new Set<string>([canonicalSelfName])
	const slots: Array<{ key: string; value: string }> = [{ key: "default", value: canonicalSelfName }]

	for (const [rawKey, value] of rec.nameVariants) {
		if (seen.has(value)) continue
		seen.add(value)
		slots.push({ key: normalizeNameKey(rawKey), value })
	}

	return slots
}

export const WOF_ADMIN_ADAPTER_ID = "wof-admin"

/**
 * Construct the wof-admin JSON-bundle adapter. The adapter is stateless across runs; calling this twice with the same
 * input directory produces byte-identical `canonical.jsonl` (records are emitted in sorted `wof:id` order to be
 * insensitive to filesystem walk ordering).
 */
export function createWOFAdminAdapter(): CorpusAdapter {
	return {
		id: WOF_ADMIN_ADAPTER_ID,
		defaultLicense: "CC0-1.0",
		description:
			"Who's On First admin GeoJSON bundles (countries, regions, counties, localities) — multi-name variants per record.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			// Pass 1: scan every GeoJSON file once, build the in-memory record index.
			// We keep only records whose placetype maps to a ComponentTag — irrelevant placetypes
			// (campus, county-region hybrids on which Mailwoman has no opinion) are dropped here so
			// they don't inflate the ancestry index. Country-filtered runs prune to the matching
			// country code too; the ancestors of a same-country record live in the same admin repo.
			const byID = new Map<number, WOFRecord>()

			for await (const rec of walkFeatures(opts.inputPath, { signal: opts.signal })) {
				if (opts.signal?.aborted) return

				if (opts.country && rec.country !== opts.country) continue

				if (!placetypeToTag(rec.placetype)) continue
				byID.set(rec.id, rec)
			}

			const ancestry = buildAncestryIndex(byID)

			// Pass 2: emit rows in sorted-id order for deterministic JSONL.
			const ids = [...byID.keys()].sort((a, b) => a - b)
			let emitted = 0

			for (const id of ids) {
				if (opts.signal?.aborted) return
				const rec = byID.get(id)!
				const chain = ancestry.get(id) ?? []
				const slots = nameSlotsFor(rec)

				for (const slot of slots) {
					const variants = variantsFor(rec, chain, slot.value)

					for (const variant of variants) {
						if (opts.limit !== undefined && emitted >= opts.limit) return

						const raw = formatAddress(variant.components, rec.country, { separator: ", " })

						if (!raw) continue
						const aligned = reconcileComponents(variant.components, raw)

						if (Object.keys(aligned).length === 0) continue

						yield {
							raw,
							components: aligned,
							country: rec.country,
							locale: LOCALE_BY_COUNTRY[rec.country],
							source: WOF_ADMIN_ADAPTER_ID,
							source_id: `${WOF_ADMIN_ADAPTER_ID}-${rec.id}-${slot.key}-${variant.suffix}`,
							corpus_version: "",
							license: "CC0-1.0",
						}
						emitted++
					}
				}
			}
		},
	}
}

/** Single shared instance, suitable for `defaultAdapterRegistry`. */
export const wofAdminAdapter = createWOFAdminAdapter()
