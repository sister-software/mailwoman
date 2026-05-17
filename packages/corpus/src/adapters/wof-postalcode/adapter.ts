/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `wof-postalcode`: Who's On First postalcode SQLite distribution adapter.
 *
 *   Input: a `.spatial.db` from `whosonfirst-data-postalcode-<cc>-latest`. Like the wof-admin adapter
 *   it only reads the `spr` table; here the placetype of interest is `postalcode` with a
 *   `parent_id` chasing up the locality / region / country chain.
 *
 *   For every live postalcode row, the adapter emits hierarchical variants:
 *
 *   Postcode alone → "97214" postcode + locality → "97214 Portland" postcode + locality + region →
 *   "97214 Portland, Oregon"
 *
 *   Variant rendering is delegated to `formatAddress`, so country-specific templates produce the
 *   right joining order (FR puts postcode before locality on the same line; US puts postcode after
 *   region with a space).
 *
 *   License: CC0.
 */

import type { WhosOnFirstPlacetype } from "@mailwoman/core/resources/whosonfirst"
import type { ComponentTag } from "@mailwoman/core/types"
import Database from "better-sqlite3"
import { formatAddress, reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

const COUNTRY_DISPLAY_NAME: Record<string, string> = {
	US: "United States of America",
	FR: "France",
}

const LOCALE_BY_COUNTRY: Record<string, string> = {
	US: "en-US",
	FR: "fr-FR",
}

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

interface SprRow {
	id: number
	parent_id: number | null
	name: string
	placetype: string
	country: string
}

function buildAncestryIndex(db: Database.Database): Map<number, SprRow[]> {
	const rows = db
		.prepare<[], SprRow>(`SELECT id, parent_id, name, placetype, country FROM spr WHERE is_current = 1`)
		.all()
	const byId = new Map<number, SprRow>(rows.map((r) => [r.id, r]))
	const index = new Map<number, SprRow[]>()
	for (const row of rows) {
		const chain: SprRow[] = []
		let cur = row.parent_id
		const guard = new Set<number>([row.id])
		while (cur !== null && cur !== undefined && cur > 0) {
			const parent = byId.get(cur)
			if (!parent) break
			if (guard.has(parent.id)) break
			chain.push(parent)
			guard.add(parent.id)
			cur = parent.parent_id
		}
		index.set(row.id, chain)
	}
	return index
}

interface VariantSpec {
	suffix: string
	components: Partial<Record<ComponentTag, string>>
}

/** Compute variants for a postalcode row + its ancestry chain. */
export function postcodeVariantsFor(row: SprRow, ancestry: SprRow[]): VariantSpec[] {
	if (placetypeToTag(row.placetype) !== "postcode") return []

	const locality = ancestry.find((a) => placetypeToTag(a.placetype) === "locality")
	const region = ancestry.find((a) => placetypeToTag(a.placetype) === "region")
	const country = ancestry.find((a) => placetypeToTag(a.placetype) === "country")
	const countryDisplay = COUNTRY_DISPLAY_NAME[row.country] ?? country?.name ?? row.country

	const variants: VariantSpec[] = [{ suffix: "self", components: { postcode: row.name } }]

	if (locality) {
		variants.push({
			suffix: "with-locality",
			components: { postcode: row.name, locality: locality.name },
		})
	}
	if (locality && region) {
		variants.push({
			suffix: "with-locality-region",
			components: { postcode: row.name, locality: locality.name, region: region.name },
		})
	}
	if (locality && region && country) {
		variants.push({
			suffix: "with-locality-region-country",
			components: {
				postcode: row.name,
				locality: locality.name,
				region: region.name,
				country: countryDisplay,
			},
		})
	}

	return variants
}

export const WOF_POSTALCODE_ADAPTER_ID = "wof-postalcode"

export function createWofPostalcodeAdapter(): CorpusAdapter {
	return {
		id: WOF_POSTALCODE_ADAPTER_ID,
		defaultLicense: "CC0-1.0",
		description: "Who's On First postalcode SQLite distribution (postcode → locality/region pairs).",
		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			const db = new Database(opts.inputPath, { readonly: true, fileMustExist: true })
			try {
				const ancestry = buildAncestryIndex(db)
				const iter = opts.country
					? db
							.prepare<{ country: string }, SprRow>(
								`SELECT id, parent_id, name, placetype, country
								 FROM spr
								 WHERE is_current = 1
								   AND placetype = 'postalcode'
								   AND country = @country
								 ORDER BY id ASC`
							)
							.iterate({ country: opts.country })
					: db
							.prepare<[], SprRow>(
								`SELECT id, parent_id, name, placetype, country
								 FROM spr
								 WHERE is_current = 1
								   AND placetype = 'postalcode'
								 ORDER BY id ASC`
							)
							.iterate()

				let emitted = 0
				for (const row of iter) {
					if (opts.signal?.aborted) break
					const chain = ancestry.get(row.id) ?? []
					const variants = postcodeVariantsFor(row, chain)

					for (const variant of variants) {
						if (opts.limit !== undefined && emitted >= opts.limit) return
						const raw = formatAddress(variant.components, row.country, { separator: ", " })
						if (!raw) continue
						const aligned = reconcileComponents(variant.components, raw)
						if (Object.keys(aligned).length === 0) continue

						yield {
							raw,
							components: aligned,
							country: row.country,
							locale: LOCALE_BY_COUNTRY[row.country],
							source: WOF_POSTALCODE_ADAPTER_ID,
							source_id: `${WOF_POSTALCODE_ADAPTER_ID}-${row.id}-${variant.suffix}`,
							corpus_version: "",
							license: "CC0-1.0",
						}
						emitted++
					}
				}
			} finally {
				db.close()
			}
		},
	}
}

export const wofPostalcodeAdapter = createWofPostalcodeAdapter()
