/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Deterministic canonical-row emission shared by WOF GeoJSON adapters.
 */

import type { ComponentTag } from "@mailwoman/core/types"
import { formatAddress, reconcileComponents } from "@mailwoman/formatter"

import type { AdapterOptions, CanonicalRow } from "#types"
import { normalizeNameKey, type WOFRecord } from "#utils"

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

				const raw = formatAddress(variant.components, record.country, { separator: ", " })

				if (!raw) continue
				const components = reconcileComponents(variant.components, raw)

				if (!Object.keys(components).length) continue

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
