/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Deterministic canonical-row emission shared by WOF GeoJSON adapters.
 */

import { formatAddressRow } from "@mailwoman/codex/address-format"
import { isLargestFirstSystem, lineJoinForCountry } from "@mailwoman/codex/address-layouts"
import type { ComponentTag } from "@mailwoman/codex/component"

import type { AdapterOptions, CanonicalRow } from "#types"
import { normalizeNameKey, type WOFRecord } from "#utils"

/**
 * The order an admin hierarchy is written in, smallest unit first. A country that writes largest-first reverses it.
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
 * Render an admin-hierarchy variant: the components it carries, in hierarchy order, joined the way the country joins a
 * line. This is a gazetteer QUERY rather than a postal address, which is why it does not go through a layout — a
 * country whose postal layout drops the region would collapse `Paris, Île-de-France` back into `Paris`.
 */
function renderHierarchy(
	components: Partial<Record<ComponentTag, string>>,
	country: string
): { raw: string; components: Partial<Record<ComponentTag, string>> } | null {
	const order = isLargestFirstSystem(country) ? [...HIERARCHY_ORDER].toReversed() : HIERARCHY_ORDER
	const present: Partial<Record<ComponentTag, string>> = {}
	const parts: string[] = []

	for (const tag of order) {
		const value = components[tag]?.trim()

		if (!value) continue

		present[tag] = value
		parts.push(value)
	}

	if (!parts.length) return null

	return { raw: parts.join(lineJoinForCountry(country)), components: present }
}

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
export const COUNTRY_DISPLAY_NAME: Record<string, string> = {
	US: "United States of America",
	FR: "France",
}

/**
 * BCP-47 locale defaulting for the corpus row's `locale` field. Defaulted by country.
 */
export const LOCALE_BY_COUNTRY: Record<string, string> = {
	US: "en-US",
	FR: "fr-FR",
}

export interface WOFVariantSpec {
	suffix: string
	components: Partial<Record<ComponentTag, string>>
	/**
	 * Render this variant as an ADMIN HIERARCHY rather than as a postal address.
	 *
	 * A hierarchy variant is a query — `Paris`, then `Paris, Île-de-France`, then `Paris, Île-de-France, France` — and
	 * several of its steps are not addresses at all. France's postal layout carries no region, so rendering `{ locality,
	 * region }` through it prints `Paris` and the whole variant collapses into the one below it.
	 *
	 * So the hierarchy is joined in its own order: smallest unit first, or largest first for the systems that write that
	 * way, with the country's own separator.
	 */
	hierarchy?: boolean
}

export interface NameSlotOptions {
	/**
	 * Canonical surface for the record's own `"default"` slot. Default `rec.name` verbatim; the admin adapter substitutes
	 * the OpenCage-canonical {@link COUNTRY_DISPLAY_NAME} for country records.
	 */
	canonicalName?: (rec: WOFRecord) => string
}

/**
 * Build the per-record name-slot list: the canonical `"default"` slot, then every `name:*` variant deduplicated against
 * it so a redundant `"default"`-equivalent row is not emitted under a localized key.
 */
export function nameSlotsFor(rec: WOFRecord, options: NameSlotOptions = {}): Array<{ key: string; value: string }> {
	const canonicalSelfName = options.canonicalName?.(rec) ?? rec.name

	const seen = new Set<string>([canonicalSelfName])
	const slots: Array<{ key: string; value: string }> = [{ key: "default", value: canonicalSelfName }]

	for (const [rawKey, value] of rec.nameVariants) {
		if (seen.has(value)) continue
		seen.add(value)
		slots.push({ key: normalizeNameKey(rawKey), value })
	}

	return slots
}

interface EmitWOFJSONRowsOptions {
	records: ReadonlyMap<number, WOFRecord>
	ancestry: ReadonlyMap<number, WOFRecord[]>
	adapterOptions: AdapterOptions
	adapterID: string
	localeByCountry: Readonly<Record<string, string>>
	shouldEmit?: (record: WOFRecord) => boolean
	nameSlotsFor: (record: WOFRecord) => Array<{ key: string; value: string }>
	variantsFor: (record: WOFRecord, ancestry: WOFRecord[], selfName: string) => WOFVariantSpec[]
}

/**
 * Emit aligned rows in WOF-id order, enforcing the adapter limit across all name and hierarchy variants.
 */
export function* emitWOFJSONRows(options: EmitWOFJSONRowsOptions): Generator<CanonicalRow> {
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
			for (const variant of variantsFor(record, ancestry.get(id) ?? [], slot.value)) {
				if (adapterOptions.limit !== undefined && emitted >= adapterOptions.limit) return

				const rendered = variant.hierarchy
					? renderHierarchy(variant.components, record.country)
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
					corpus_version: "",
					license: "CC0-1.0",
				}

				emitted++
			}
		}
	}
}
