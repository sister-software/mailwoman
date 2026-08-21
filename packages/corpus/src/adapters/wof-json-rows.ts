/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Deterministic canonical-row emission shared by WOF GeoJSON adapters.
 */

import type { ComponentTag } from "@mailwoman/core/types"
import { formatAddress, reconcileComponents } from "@mailwoman/formatter"

import type { AdapterOptions, CanonicalRow } from "#types"
import type { WOFRecord } from "#utils"

export interface WOFVariantSpec {
	suffix: string
	components: Partial<Record<ComponentTag, string>>
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
		nameSlotsFor,
		variantsFor,
	} = options

	let emitted = 0

	for (const id of [...records.keys()].toSorted((a, b) => a - b)) {
		if (adapterOptions.signal?.aborted) return
		const record = records.get(id)!

		if (!shouldEmit(record)) continue

		for (const slot of nameSlotsFor(record)) {
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
