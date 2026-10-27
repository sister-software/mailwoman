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

import { layoutForCountry, layoutPrintsLargestFirst, lineJoinForCountry } from "@mailwoman/codex/address/layouts"
import type { ComponentTag } from "@mailwoman/codex/component"
import { countrySurfaceForms } from "@mailwoman/codex/country/country"
import { OFFICIAL_LANGUAGES } from "@mailwoman/codex/country/official-languages"
import { hashFNV1a } from "@mailwoman/core/coarse-placer/fnv-hash"
import { isPresent } from "@mailwoman/core/objects"
import type { WhosOnFirstPlacetype } from "@mailwoman/gazetteer/whosonfirst"

import { regionCodeFor } from "#adapters/wof/admin/json/region-codes"
import {
	COUNTRY_DISPLAY_NAME,
	emitWOFJSONRows,
	LOCALE_BY_COUNTRY,
	nameSlotsFor as wofNameSlotsFor,
	type NameSlot,
	type WOFVariantSpec,
} from "#adapters/wof/json-rows"
import { walkFeaturesCached } from "#adapters/wof/record-cache"
import { RowSampler } from "#adapters/wof/sample"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { buildAncestorRecordIndex, nameValues, preferredName, type AncestorRecords, type WOFRecord } from "#utils"

/**
 * Map a WOF placetype to a Mailwoman `ComponentTag`, or `undefined` to skip.
 *
 * Per-adapter deliberately (the postalcode adapter has its own): each table is a record
 * filter for its adapter's emission set rather than a shared vocabulary.
 */
export function placetypeToTag(placetype: WhosOnFirstPlacetype | string): ComponentTag | null {
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
 * The record's country's official languages and `SERVED_NAME_LANGUAGES` always keep their
 * hierarchies, and the rest, by language code, fill whatever of the cap those leave.
 */
const LOCALIZED_HIERARCHY_CAP = 8

/**
 * The name languages a shipped model reads, ranked after the record country's official
 * languages when the cap chooses which localized hierarchies to render.
 *
 * The CJK family reads Japanese, Korean and Chinese, and the Latin family's locale packages read the rest.
 * A language outside the list still renders when the cap leaves room, in language-code order.
 */
const SERVED_NAME_LANGUAGES: readonly string[] = ["jpn", "kor", "zho", "eng", "fra", "deu", "spa", "ita", "por"]

/**
 * The country whose hierarchy order and line join a language's own hierarchies are written in.
 *
 * A language official in several countries resolves to the layout (order and join) that
 * more than half of them write, and the first such country in table order is returned.
 * Korean resolves in both Koreas.
 *
 * Chinese resolves to China's unseparated largest-first layout, which China,
 * Taiwan and Hong Kong write in Chinese script.
 *
 * A language whose countries have no majority layout resolves to `null`,
 * and its hierarchies take the record's own country's layout.
 */
export function layoutCountryForLanguage(language: string): string | null {
	const cached = LANGUAGE_LAYOUTS.get(language)

	if (cached !== undefined) return cached

	const countries = Object.entries(OFFICIAL_LANGUAGES)
		.filter(([, entry]) => entry.official.includes(language))
		.map(([code]) => code)

	// The local-script layout's order, because a language's own hierarchies are written in its script.
	// A country whose local layout states no order (Macau, Singapore) does not vote.
	const layoutOf = (code: string): string | null => {
		const layout = layoutForCountry(code, "local")
		const largestFirst = layout ? layoutPrintsLargestFirst(layout) : null

		return typeof largestFirst === "boolean" ? `${largestFirst}\u0000${lineJoinForCountry(code, "local")}` : null
	}

	const voters = countries.filter((code) => layoutOf(code) != null)
	const tally = new Map<string, number>()

	for (const code of voters) {
		const layout = layoutOf(code)!

		tally.set(layout, (tally.get(layout) ?? 0) + 1)
	}

	const majority = [...tally].find(([, count]) => count * 2 > voters.length)?.[0]
	const resolved = majority ? (voters.find((code) => layoutOf(code) === majority) ?? null) : null

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
 * A slot that carries a language renders only chains written in that
 * language ({@linkcode localizedVariants}).
 * Every other slot takes its ancestor names from each ancestor's canonical `wof:name`.
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

	if (CHAIN_LEVELS[selfTag] && slot.language) {
		return localizedVariants(row, selfTag, selfName, ancestry, slot.language)
	}

	if (isStructuralSlot(slot) && CHAIN_LEVELS[selfTag]) {
		return structuralVariants(row, selfTag, selfName, ancestry)
	}

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

	return variants
}

/**
 * An ancestor level a record's chain can include.
 */
type ChainLevel = "locality" | "subregion" | "region" | "country"

/**
 * The ancestor levels each record's chain can include, nearest first.
 *
 * A dependent locality such as Brooklyn is written inside its locality, county,
 * region and country (`Brooklyn, Kings County, New York, USA`).
 * A country is written alone.
 */
const CHAIN_LEVELS: Partial<Record<ComponentTag, readonly ChainLevel[]>> = {
	dependent_locality: ["locality", "subregion", "region", "country"],
	locality: ["subregion", "region", "country"],
	subregion: ["region", "country"],
	region: ["country"],
}

/**
 * Whether a slot renders every structural chain.
 *
 * The canonical name and each colloquial name (`NYC`, `Big Apple`) do.
 * Every other name renders the three chains a localized or variant name needs,
 * which keeps a record with names in two hundred languages to a few hundred rows.
 */
function isStructuralSlot(slot: NameSlot): boolean {
	return slot.key === "default" || slot.key.includes("_x_colloquial")
}

/**
 * The forms one ancestor level is written in, its canonical form first.
 *
 * - A country is written in its OpenCage-canonical display name, then each
 *   surface form the codex lists for it (`United States`, `USA`, `US`, `U.S.A.`),
 *   or its own `wof:name` when the codex lists none.
 * - A region is written in its name, then in the code the country's addresses
 *   write for it (`NY`), from libaddressinput.
 *   A country whose addresses write region names gets no code.
 * - Every level below the country adds its colloquial names in English
 *   and in the country's official languages (`NYC`).
 */
function levelForms(level: ChainLevel, ancestor: WOFRecord, country: string): string[] {
	const forms: string[] = []

	const add = (value: string | null | undefined) => {
		const trimmed = value?.trim()

		if (trimmed && !forms.includes(trimmed)) {
			forms.push(trimmed)
		}
	}

	if (level === "country") {
		add(COUNTRY_DISPLAY_NAME[ancestor.country] ?? ancestor.name)

		const curated = countrySurfaceForms(ancestor.country)

		if (curated.length) {
			curated.forEach(add)
		} else {
			add(ancestor.name)
		}
	} else {
		add(ancestor.name)
	}

	if (level === "region") {
		add(regionCodeFor(country, ancestor.name))
	}

	// A country's curated surface forms are the forms addresses write.
	// Its colloquial names are historical or poetic (France's `Gallia`), so a country takes none of them.
	if (level === "country") return forms

	for (const language of ["eng", ...(OFFICIAL_LANGUAGES[country]?.official ?? [])]) {
		nameValues(ancestor.nameVariants.get(`name:${language}_x_colloquial`)).forEach(add)
	}

	return forms
}

/**
 * Every chain a record's name can be written in: the name alone, then the name
 * with each ordered subset of its ancestor levels.
 *
 * Each chain is rendered once in every level's canonical form.
 * A chain with a level that has other forms is rendered once more, each such level taking
 * one of its other forms, chosen by a hash of the record id and the chain.
 *
 * Across all the records of a country every form appears, while each record adds at most two rows per chain.
 *
 * A county is left out of a chain when it carries the record's own name or its locality's,
 * because `Paris, Paris` repeats one place rather than naming two levels.
 *
 * With a `language`, every level is written in its ancestor's preferred name in that
 * language, in one form, and a level whose ancestor has no such name is left out,
 * so a chain never mixes `東京` with `Japan`.
 * `keep` selects which subsets of the levels are rendered.
 */
function structuralVariants(
	row: WOFRecord,
	selfTag: ComponentTag,
	selfName: string,
	ancestry: AncestorRecords,
	localized?: {
		language: string
		layoutCountry?: string
		keep?: (subset: readonly ChainLevel[], levels: readonly ChainLevel[]) => boolean
	}
): WOFVariantSpec[] {
	const nameOf = (ancestor: WOFRecord) => (localized ? preferredName(ancestor, localized.language) : ancestor.name)

	const levels = (CHAIN_LEVELS[selfTag] ?? []).filter((level) => {
		const ancestor = ancestry[level]

		if (!ancestor) return false

		const name = nameOf(ancestor)

		if (!name) return false

		return level !== "subregion" || (name !== selfName && name !== (ancestry.locality && nameOf(ancestry.locality)))
	})

	const forms = new Map(
		levels.map((level) => [
			level,
			localized ? [nameOf(ancestry[level]!)!] : levelForms(level, ancestry[level]!, row.country),
		])
	)

	const variants: WOFVariantSpec[] = []

	for (let mask = 0; mask < 1 << levels.length; mask++) {
		const subset = levels.filter((_, i) => mask & (1 << i))

		if (localized?.keep && !localized.keep(subset, levels)) continue

		const suffix = subset.length ? `with-${subset.join("-")}` : "self"
		const canonical: Partial<Record<ComponentTag, string>> = { [selfTag]: selfName }
		const alternate: Partial<Record<ComponentTag, string>> = { [selfTag]: selfName }
		let differs = false

		for (const level of subset) {
			const levelForm = forms.get(level)!

			canonical[level] = levelForm[0]

			if (levelForm.length > 1) {
				alternate[level] = levelForm[1 + (hashFNV1a(`${row.id}:${mask}:${level}`) % (levelForm.length - 1))]
				differs = true
			} else {
				alternate[level] = levelForm[0]
			}
		}

		const layoutCountry = localized?.layoutCountry

		variants.push({ hierarchy: true, suffix, components: canonical, layoutCountry })

		if (differs) {
			variants.push({ hierarchy: true, suffix: `${suffix}-form`, components: alternate, layoutCountry })
		}
	}

	return variants
}

/**
 * A record's chains written entirely in one language.
 *
 * A language official in the record's country renders every ordered subset of the levels,
 * in the country's own order and join: `Zürich, Zürich, Schweiz` in German.
 * Any other language renders the name alone, with every level but the country, and with every
 * level, in the order and join of the countries that write that language: `日本東京` in Japanese.
 */
function localizedVariants(
	row: WOFRecord,
	selfTag: ComponentTag,
	selfName: string,
	ancestry: AncestorRecords,
	language: string
): WOFVariantSpec[] {
	if (OFFICIAL_LANGUAGES[row.country]?.official.includes(language)) {
		return structuralVariants(row, selfTag, selfName, ancestry, { language })
	}

	return structuralVariants(row, selfTag, selfName, ancestry, {
		language,
		layoutCountry: layoutCountryForLanguage(language) ?? undefined,
		keep: (subset, levels) => {
			const below = levels.filter((level) => level !== "country")

			return !subset.length || subset.length === levels.length || subset.join() === below.join()
		},
	})
}

/**
 * Build the per-record name-slot list.
 *
 * The canonical `"default"` slot uses the OpenCage-canonical country form
 * when the record is itself a country (matches SQLite-adapter behavior);
 * every other placetype's default slot uses `wof:name` verbatim.
 *
 * The official and served languages keep their language, and other languages keep
 * theirs within {@linkcode LOCALIZED_HIERARCHY_CAP}.
 * A kept language is what makes {@linkcode variantsFor} render a localized hierarchy for a slot.
 */
export function nameSlotsFor(rec: WOFRecord): NameSlot[] {
	const official = new Set(OFFICIAL_LANGUAGES[rec.country]?.official)

	// Official languages first, then the served languages in their listed order, then every other language.
	const rank = (language: string): number => {
		if (official.has(language)) return -1

		const served = SERVED_NAME_LANGUAGES.indexOf(language)

		return served === -1 ? SERVED_NAME_LANGUAGES.length : served
	}

	const slots = wofNameSlotsFor(rec, {
		canonicalName: (record) =>
			placetypeToTag(record.placetype) === "country"
				? (COUNTRY_DISPLAY_NAME[record.country] ?? record.name)
				: record.name,
		languageRank: rank,
	})

	const ranked = slots
		.map((slot) => slot.language)
		.filter(isPresent)
		.toSorted((a, b) => rank(a) - rank(b) || a.localeCompare(b))

	// Every official and served language keeps its hierarchy, and other languages fill the cap's remaining room.
	const required = ranked.filter((language) => rank(language) < SERVED_NAME_LANGUAGES.length)
	const others = ranked.filter((language) => !required.includes(language))
	const kept = new Set([...required, ...others.slice(0, Math.max(LOCALIZED_HIERARCHY_CAP - required.length, 0))])

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

			for await (const rec of walkFeaturesCached(opts.inputPath, { signal: opts.signal })) {
				if (opts.signal?.aborted) return

				if (opts.country && rec.country !== opts.country) continue

				if (!placetypeToTag(rec.placetype)) continue
				byID.set(rec.id, rec)
			}

			const ancestry = buildAncestorRecordIndex(byID, placetypeToTag)
			const sampler = opts.sample ? new RowSampler(opts.sample) : undefined

			// Pass 2: emit rows in sorted-id order for deterministic jsonl.
			yield* emitWOFJSONRows({
				records: byID,
				ancestry,
				adapterOptions: opts,
				adapterID: WOF_ADMIN_ADAPTER_ID,
				localeByCountry: LOCALE_BY_COUNTRY,
				nameSlotsFor,
				variantsFor,
				sampler,
			})

			await sampler?.writeCounts()
		},
	}
}

/**
 * Single shared instance, suitable for `defaultAdapterRegistry`.
 */
export const wofAdminAdapter = createWOFAdminAdapter()
