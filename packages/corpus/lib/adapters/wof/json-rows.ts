/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Deterministic canonical-row emission shared by WOF GeoJSON adapters.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import {
	adminRunJoinForCountry,
	isLargestFirstSystem,
	lineJoinForCountry,
	type AddressScript,
} from "@mailwoman/codex/address/layouts"
import type { ComponentTag } from "@mailwoman/codex/component"
import { classifyTokenScript } from "@mailwoman/query-shape/character-class"
import type { ScriptCode } from "@mailwoman/query-shape/types"

import type { AdapterOptions, CanonicalRow } from "#types"
import { nameValues, normalizeNameKey, type WOFRecord } from "#utils"

/**
 * The order an admin hierarchy is written in, smallest unit first.
 *
 * A country that writes largest-first reverses it.
 */
const HIERARCHY_ORDER: readonly ComponentTag[] = [
	"postcode",
	"dependent_locality",
	"locality",
	"subregion",
	"region",
	"country",
]

/**
 * Render an admin-hierarchy variant: the components it contains, in hierarchy order,
 * joined the way the country joins a line.
 *
 * This adapter emits a gazetteer query.
 * It follows the gazetteer path without a postal layout.
 *
 * A country whose postal layout drops the region would collapse `Paris, Île-de-France` back into `Paris`.
 */
export function renderHierarchy(
	components: Partial<Record<ComponentTag, string>>,
	country: string
): { raw: string; components: Partial<Record<ComponentTag, string>> } | null {
	const order = isLargestFirstSystem(country) ? [...HIERARCHY_ORDER].toReversed() : HIERARCHY_ORDER
	const present: Partial<Record<ComponentTag, string>> = {}
	const parts: Array<{ tag: ComponentTag; value: string }> = []

	for (const tag of order) {
		const value = components[tag]?.trim()

		if (!value) continue

		present[tag] = value
		parts.push({ tag, value })
	}

	if (!parts.length) return null

	const script = hierarchyScript(parts.map((part) => part.value))
	const lineJoin = lineJoinForCountry(country, script)
	const adminJoin = adminRunJoinForCountry(country, script)

	// Two adjacent admin units share a line and take the admin-run join.
	// The postcode and the country sit on lines of their own.
	const raw = parts
		.map((part, index) => {
			if (!index) return part.value

			const shared = ADMIN_RUN_TAGS.has(part.tag) && ADMIN_RUN_TAGS.has(parts[index - 1]!.tag)

			return (shared ? adminJoin : lineJoin) + part.value
		})
		.join("")

	return { raw, components: present }
}

/**
 * The hierarchy tags a layout prints together on its admin line.
 */
const ADMIN_RUN_TAGS: ReadonlySet<ComponentTag> = new Set(["dependent_locality", "locality", "subregion", "region"])

/**
 * Scripts whose addresses join their units without a separator or with a single space.
 */
const CJK_SCRIPTS: ReadonlySet<ScriptCode> = new Set(["Hani", "Hira", "Kana", "Hang"])

/**
 * Chooses the join script for a hierarchy from the names being joined.
 *
 * A country's local join, such as China's empty separator, belongs to names written in its CJK script.
 * A romanized or other non-CJK name joined that way runs into its neighbor (`HEBEICHAOZHITUN`).
 *
 * A part with no script letters, such as a number, leaves the choice to the other parts.
 */
function hierarchyScript(parts: readonly string[]): AddressScript {
	const allCJK = parts.every((part) => {
		const script = classifyTokenScript(part)

		return script === "Zyyy" || CJK_SCRIPTS.has(script)
	})

	return allCJK ? "local" : "latin"
}

/**
 * Display name for the country, keyed by ISO 3166-1 alpha-2.
 *
 * Must be the **OpenCage-canonical** surface form: the `address-formatter` library expands some
 * country names en route to its output (e.g. `"United States"` → `"United States of America"`).
 * If `components.country` and the formatted `raw` disagree, alignment will fail downstream.
 *
 * The canonical form keeps the two in lockstep.
 *
 * Phase 1 US + FR only.
 * Extend as new locales come online.
 *
 * A missing country uses the country row's `wof:name`; this preserves the
 * alignment risk for non-canonicalized names.
 */
export const COUNTRY_DISPLAY_NAME: Record<string, string> = {
	US: "United States of America",
	FR: "France",
}

/**
 * BCP-47 locale defaulting for the corpus row's `locale` field.
 *
 * Defaulted by country.
 */
export const LOCALE_BY_COUNTRY: Record<string, string> = {
	US: "en-US",
	FR: "fr-FR",
}

export interface WOFVariantSpec {
	suffix: string
	components: Partial<Record<ComponentTag, string>>
	/**
	 * Render this variant as an admin hierarchy rather than as a postal address.
	 *
	 * A hierarchy variant is a query — `Paris`, then `Paris, Île-de-France`, then
	 * `Paris, Île-de-France, France` — and several of its steps are not addresses at all.
	 * France's postal layout has no region, so rendering `{ locality, region }` through
	 * it prints `Paris` and the whole variant collapses into the one below it.
	 *
	 * So the hierarchy is joined in its own order: smallest unit first, or largest first
	 * for the systems that write that way, with the country's own separator.
	 */
	hierarchy?: boolean
	/**
	 * The country whose hierarchy order and line join render this variant,
	 * when it differs from the record's own.
	 */
	layoutCountry?: string
}

export interface NameSlotOptions {
	/**
	 * Canonical surface for the record's own `"default"` slot.
	 *
	 * The admin adapter substitutes the OpenCage-canonical {@link COUNTRY_DISPLAY_NAME} for country records.
	 *
	 * @defaultValue `rec.name` verbatim.
	 */
	canonicalName?: (rec: WOFRecord) => string
	/**
	 * Ranks a preferred-name language for one record, lower first.
	 *
	 * Keys are visited in rank order, and a value two keys share goes to the first,
	 * so the rank decides which language a shared name renders under.
	 * Brooklyn's `name:wuu_x_preferred` and `name:zho_x_preferred` both hold 布鲁克林区,
	 * and in source order `wuu` would claim it.
	 *
	 * Keys without a preferred-name language follow the ranked ones in source order.
	 *
	 * @defaultValue Source order.
	 */
	languageRank?: (language: string) => number
}

/**
 * One name a record's rows are rendered from.
 */
export interface NameSlot {
	/**
	 * The `source_id` fragment: `default`, a normalized `name:*` key, or that key
	 * with `-2`, `-3`… for a key's later values.
	 */
	key: string
	value: string
	/**
	 * The ISO 639-3 language of a `name:<language>_x_preferred` slot, which the
	 * admin adapter renders a localized hierarchy for.
	 */
	language?: string
}

const PREFERRED_KEY = /^name:([a-z]{3})_x_preferred$/

/**
 * Build the per-record name-slot list: the canonical `"default"` slot, then every
 * value of every `name:*` variant, deduplicated so a redundant `"default"`-equivalent
 * row is not emitted under a localized key.
 */
export function nameSlotsFor(rec: WOFRecord, options: NameSlotOptions = {}): NameSlot[] {
	const canonicalSelfName = options.canonicalName?.(rec) ?? rec.name

	const seen = new Set<string>([canonicalSelfName])
	const slots: NameSlot[] = [{ key: "default", value: canonicalSelfName }]

	const rank = options.languageRank

	const keyRank = (rawKey: string): number => {
		const language = PREFERRED_KEY.exec(rawKey)?.[1]

		return rank && language ? rank(language) : Number.POSITIVE_INFINITY
	}

	const entries = rank ? [...rec.nameVariants].toSorted(([a], [b]) => keyRank(a) - keyRank(b) || 0) : rec.nameVariants

	for (const [rawKey, variant] of entries) {
		const values = nameValues(variant)
		const language = PREFERRED_KEY.exec(rawKey)?.[1]

		for (const [position, value] of values.entries()) {
			if (seen.has(value)) continue
			seen.add(value)

			const key = position ? `${normalizeNameKey(rawKey)}-${position + 1}` : normalizeNameKey(rawKey)

			slots.push(language && !position ? { key, value, language } : { key, value })
		}
	}

	return slots
}

interface EmitWOFJSONRowsOptions<A extends object> {
	records: ReadonlyMap<number, WOFRecord>
	/**
	 * The ancestors each record's variants read: names for `wof-postalcode`, records for `wof-admin`.
	 *
	 * A record absent from the map resolves to an empty object.
	 * Records with no resolvable ancestor produce the same value.
	 */
	ancestry: ReadonlyMap<number, A>
	adapterOptions: AdapterOptions
	adapterID: string
	localeByCountry: Readonly<Record<string, string>>
	shouldEmit?: (record: WOFRecord) => boolean
	nameSlotsFor: (record: WOFRecord) => NameSlot[]
	variantsFor: (record: WOFRecord, ancestry: A, slot: NameSlot) => WOFVariantSpec[]
}

/**
 * The value a record uses in place of ancestors when they do not resolve.
 *
 * Frozen and shared, because the emitter reaches it once per such record
 * and constructing a fresh object per row would allocate one per name slot.
 */
const NO_ANCESTORS = Object.freeze({})

/**
 * Emit aligned rows in WOF-id order, enforcing the adapter limit across all name and hierarchy variants.
 *
 * A variant's `country` renders it in another country's order and join
 * (a Japanese hierarchy of a US place is written largest first with no separator),
 * while the row keeps the record's own country.
 */
export function* emitWOFJSONRows<A extends object>(options: EmitWOFJSONRowsOptions<A>): Generator<CanonicalRow> {
	const {
		records,
		ancestry,
		adapterOptions,
		adapterID,
		localeByCountry,
		shouldEmit = () => true,
		nameSlotsFor: slotsForRecord,
		variantsFor,
	} = options

	let emitted = 0

	for (const id of [...records.keys()].toSorted((a, b) => a - b)) {
		if (adapterOptions.signal?.aborted) return
		const record = records.get(id)!

		if (!shouldEmit(record)) continue

		for (const slot of slotsForRecord(record)) {
			for (const variant of variantsFor(record, ancestry.get(id) ?? (NO_ANCESTORS as A), slot)) {
				if (typeof adapterOptions.limit === "number" && emitted >= adapterOptions.limit) return

				const rendered = variant.hierarchy
					? renderHierarchy(variant.components, variant.layoutCountry ?? record.country)
					: formatAddressRow(variant.components, record.country, { singleLine: true })

				if (!rendered) continue

				const { raw, components } = rendered

				yield {
					raw,
					components,
					country: record.country,
					locale: localeByCountry[record.country],
					source: adapterID,
					source_id: `${adapterID}-${record.id}-${slot.key}-${variant.suffix}`,
					license: "CC0-1.0",
				}

				emitted++
			}
		}
	}
}
