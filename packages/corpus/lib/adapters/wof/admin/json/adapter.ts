/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `wof-admin`: Who's On First admin GeoJSON-bundle adapter.
 *
 *   **Phase 1.5.1 pivot.** The original Phase 1.5 SQLite adapter (formerly at
 *   `packages/corpus/lib/adapters/wof-admin/`, removed in this same change) was replaced by this
 *   one because the SQLite distribution path was unworkable for the real corpus build:
 *
 *   1. `dist.whosonfirst.org/sqlite/` is dead (nxdomain); the Geocode-Earth mirror is the only one.
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
 *   record rather than new records.
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

import { isLargestFirstSystem, lineJoinForCountry } from "@mailwoman/codex/address/layouts"
import type { ComponentTag } from "@mailwoman/codex/component"
import { OFFICIAL_LANGUAGES } from "@mailwoman/codex/country/official-languages"
import { isPresent } from "@mailwoman/core/objects"
import type { WhosOnFirstPlacetype } from "@mailwoman/gazetteer/whosonfirst"

import {
	COUNTRY_DISPLAY_NAME,
	emitWOFJSONRows,
	LOCALE_BY_COUNTRY,
	nameSlotsFor as wofNameSlotsFor,
	type NameSlot,
	type WOFVariantSpec,
} from "#adapters/wof/json-rows"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { buildAncestorRecordIndex, preferredName, walkFeatures, type AncestorRecords, type WOFRecord } from "#utils"

/**
 * Map a WOF placetype to a Mailwoman `ComponentTag`, or `undefined` to skip.
 *
 * Per-adapter deliberately (the postalcode adapter has its own): each table is a record
 * filter for its adapter's emission set rather than a shared vocabulary.
 */
function placetypeToTag(placetype: WhosOnFirstPlacetype | string): ComponentTag | null {
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
			return null
	}
}

/**
 * The most localized hierarchies one record renders.
 *
 * New York City carries a preferred name in over 200 languages, and each localized
 * hierarchy adds two rows per record, so an uncapped run multiplies the rows of
 * the best-covered places by the number of languages.
 * The record's country's official languages are chosen first, then the rest by language code.
 */
const LOCALIZED_HIERARCHY_CAP = 8

/**
 * The country whose hierarchy order and line join a language's own hierarchies are written in.
 *
 * A language official in several countries resolves only when all of them write a hierarchy
 * in the same order and with the same join, as Korean does in both Koreas.
 * The first of them in table order is returned.
 *
 * A language whose countries disagree resolves to `null`, and its hierarchies
 * take the record's own country's layout.
 */
export function layoutCountryForLanguage(language: string): string | null {
	const cached = LANGUAGE_LAYOUTS.get(language)

	if (cached !== undefined) return cached

	const countries = Object.entries(OFFICIAL_LANGUAGES)
		.filter(([, entry]) => entry.official.includes(language))
		.map(([code]) => code)

	const layouts = new Set(
		countries.map((code) => `${isLargestFirstSystem(code)}\u0000${lineJoinForCountry(code, "local")}`)
	)

	const resolved = layouts.size === 1 ? countries[0]! : null

	LANGUAGE_LAYOUTS.set(language, resolved)

	return resolved
}

const LANGUAGE_LAYOUTS = new Map<string, string | null>()

/**
 * Compute the hierarchy variants for a record given its ancestors and the name slot being rendered.
 *
 * The slot's value is the surface form of the record's own component
 * (locality, region, country, subregion or dependent locality).
 * The canonical `wof:name` fills the `"default"` slot and a `name:*` value fills the others.
 *
 * Ancestor names in these variants come from each ancestor's canonical `wof:name`.
 * A slot that carries a language also renders that language's hierarchy from each ancestor's
 * preferred name in the language, in the order and join of a country that writes it.
 *
 * The localized variants are skipped when an ancestor lacks the language.
 *
 * A dependent locality also renders with its parent locality (`Brooklyn, New York`),
 * which is how such a place is written in an address.
 *
 * Country variants substitute `COUNTRY_DISPLAY_NAME` for the default slot so the
 * OpenCage template produces the canonicalized form (`"United States of America"`),
 * matching the legacy SQLite adapter's behavior.
 */
export function variantsFor(row: WOFRecord, ancestry: AncestorRecords, slot: NameSlot): WOFVariantSpec[] {
	const selfTag = placetypeToTag(row.placetype)

	if (!selfTag) return []

	const selfName = slot.value

	// Every variant here is a gazetteer hierarchy — `Paris`, `Paris, Île-de-France`,
	// `Paris, Île-de-France, France` — and several steps are not addresses at all.
	// See `WOFVariantSpec.hierarchy`.
	const hierarchy = true

	const region = ancestry.region?.name
	const country = ancestry.country?.name
	const countryDisplay = COUNTRY_DISPLAY_NAME[row.country] ?? country ?? row.country

	const variants: WOFVariantSpec[] = []

	switch (selfTag) {
		case "locality":
		case "dependent_locality": {
			variants.push({ hierarchy, suffix: "self", components: { [selfTag]: selfName } })

			if (region) {
				variants.push({
					hierarchy,
					suffix: "with-region",
					components: { [selfTag]: selfName, region },
				})
			}

			if (region && country) {
				variants.push({
					hierarchy,
					suffix: "with-region-country",
					components: { [selfTag]: selfName, region, country: countryDisplay },
				})
			} else if (!region && country) {
				variants.push({
					hierarchy,
					suffix: "with-country",
					components: { [selfTag]: selfName, country: countryDisplay },
				})
			}

			const locality = selfTag === "dependent_locality" ? ancestry.locality?.name : undefined

			if (locality) {
				variants.push({
					hierarchy,
					suffix: "with-locality",
					components: { dependent_locality: selfName, locality },
				})

				if (region) {
					variants.push({
						hierarchy,
						suffix: "with-locality-region",
						components: { dependent_locality: selfName, locality, region },
					})
				}
			}

			break
		}

		case "region": {
			variants.push({ hierarchy, suffix: "self", components: { region: selfName } })

			if (country) {
				variants.push({
					hierarchy,
					suffix: "with-country",
					components: { region: selfName, country: countryDisplay },
				})
			}

			break
		}

		case "country": {
			variants.push({ hierarchy, suffix: "self", components: { country: selfName } })

			return variants
		}

		case "subregion": {
			variants.push({ hierarchy, suffix: "self", components: { subregion: selfName } })

			return variants
		}

		default:
			return []
	}

	if (slot.language) {
		variants.push(...localizedVariants(selfTag, selfName, ancestry, slot.language))
	}

	return variants
}

/**
 * A record's hierarchy written entirely in one language: without and with the country.
 *
 * Returns no variant when the record has no ancestor to join, or when any ancestor
 * it has lacks a preferred name in the language.
 */
function localizedVariants(
	selfTag: ComponentTag,
	selfName: string,
	ancestry: AncestorRecords,
	language: string
): WOFVariantSpec[] {
	const tags = (
		selfTag === "dependent_locality" ? ["locality", "region"] : selfTag === "locality" ? ["region"] : []
	) as Array<"locality" | "region">

	const components: Partial<Record<ComponentTag, string>> = { [selfTag]: selfName }

	for (const tag of tags) {
		const ancestor = ancestry[tag]

		if (!ancestor) continue

		const name = preferredName(ancestor, language)

		if (!name) return []

		components[tag] = name
	}

	if (Object.keys(components).length === 1) return []

	const layoutCountry = layoutCountryForLanguage(language) ?? undefined

	const variants: WOFVariantSpec[] = [
		{ hierarchy: true, suffix: `localized-${language}`, components: { ...components }, layoutCountry },
	]

	const country = ancestry.country && preferredName(ancestry.country, language)

	if (country) {
		variants.push({
			hierarchy: true,
			suffix: `localized-${language}-country`,
			components: { ...components, country },
			layoutCountry,
		})
	}

	return variants
}

/**
 * Build the per-record name-slot list.
 *
 * The canonical `"default"` slot uses the OpenCage-canonical country form
 * when the record is itself a country (matches SQLite-adapter behavior);
 * every other placetype's default slot uses `wof:name` verbatim.
 *
 * At most {@linkcode LOCALIZED_HIERARCHY_CAP} slots keep their language, which is what
 * makes {@linkcode variantsFor} render a localized hierarchy for them.
 */
export function nameSlotsFor(rec: WOFRecord): NameSlot[] {
	const slots = wofNameSlotsFor(rec, {
		canonicalName: (record) =>
			placetypeToTag(record.placetype) === "country"
				? (COUNTRY_DISPLAY_NAME[record.country] ?? record.name)
				: record.name,
	})

	const official = new Set(OFFICIAL_LANGUAGES[rec.country]?.official)

	const kept = new Set(
		slots
			.map((slot) => slot.language)
			.filter(isPresent)
			.toSorted((a, b) => Number(official.has(b)) - Number(official.has(a)) || a.localeCompare(b))
			.slice(0, LOCALIZED_HIERARCHY_CAP)
	)

	return slots.map((slot) => (slot.language && !kept.has(slot.language) ? { key: slot.key, value: slot.value } : slot))
}

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const WOF_ADMIN_ADAPTER_ID = "wof-admin"

/**
 * Construct the wof-admin JSON-bundle adapter.
 *
 * The adapter is stateless across runs.
 * Two calls with the same input directory produce byte-identical `canonical.jsonl`
 * (records are emitted in sorted `wof:id` order to be insensitive to filesystem walk ordering).
 */
export function createWOFAdminAdapter(): CorpusAdapter {
	return {
		id: WOF_ADMIN_ADAPTER_ID,
		defaultLicense: "CC0-1.0",
		addressRole: AddressRole.Premise,
		register: SourceRegister.WhosOnFirst,
		surface: SurfaceOrigin.Rendered,
		description:
			"Who's On First admin GeoJSON bundles (countries, regions, counties, localities) — multi-name variants per record.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			// Pass 1: scan every GeoJSON file once, build the in-memory record index.
			// We keep only records whose placetype maps to a ComponentTag — irrelevant
			// placetypes (campus, county-region hybrids on which Mailwoman has no opinion)
			// are dropped here so they don't inflate the ancestry index.
			// Country-filtered runs prune to the matching country code too.
			// The ancestors of a same-country record live in the same admin repo.
			const byID = new Map<number, WOFRecord>()

			for await (const rec of walkFeatures(opts.inputPath, { signal: opts.signal })) {
				if (opts.signal?.aborted) return

				if (opts.country && rec.country !== opts.country) continue

				if (!placetypeToTag(rec.placetype)) continue
				byID.set(rec.id, rec)
			}

			const ancestry = buildAncestorRecordIndex(byID, placetypeToTag)

			// Pass 2: emit rows in sorted-id order for deterministic jsonl.
			yield* emitWOFJSONRows({
				records: byID,
				ancestry,
				adapterOptions: opts,
				adapterID: WOF_ADMIN_ADAPTER_ID,
				localeByCountry: LOCALE_BY_COUNTRY,
				nameSlotsFor,
				variantsFor,
			})
		},
	}
}

/**
 * Single shared instance, suitable for `defaultAdapterRegistry`.
 */
export const wofAdminAdapter = createWOFAdminAdapter()
