/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `tiger`: Adapter for US Census TIGER/Line data.
 *
 * This reads a prebuilt SQLite database (from TIGER shapefiles) and emits:
 * - Street rows from `tiger_streets`
 * - Locality rows from `tiger_places`
 *
 * TIGER is public domain, so every emitted row is stamped `"Public Domain"`.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { TIGERDatabase } from "@mailwoman/tiger/schema"

import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { decomposeStreet } from "#us/adapters/tiger/street-decompose"
import { lookupFipsState } from "#us/fips-state"

/**
 * Registry ID for this adapter.
 */
export const TIGER_ADAPTER_ID = "tiger"
/**
 * Default license for rows from this source.
 */
export const TIGER_DEFAULT_LICENSE = "Public Domain"

/**
 * Country display name used by `formatAddress`.
 */
const US_COUNTRY_DISPLAY = "United States of America"

interface TigerStreetRow {
	linearid: string
	fullname: string
	zipl: string | null
	zipr: string | null
	statefp: string
}

interface TigerPlaceRow {
	geoid: string
	name: string
	statefp: string
	lsad: string | null
}

/**
 * Build one or more street variants from a TIGER street segment.
 */
function* streetVariants(row: TigerStreetRow): Iterable<{
	components: CanonicalRow["components"]
	variantKey: string
}> {
	const fullname = row.fullname.trim()

	if (!fullname) return
	const state = lookupFipsState(row.statefp)

	if (!state) return

	const zipl = row.zipl?.trim() ?? ""
	const zipr = row.zipr?.trim() ?? ""

	const decomposed = decomposeStreet(fullname)

	const baseComponents: CanonicalRow["components"] = {
		region: state.abbreviation,
		street: decomposed.street,
	}

	if (decomposed.prefix) {
		baseComponents.street_prefix = decomposed.prefix
	}

	if (decomposed.suffix) {
		baseComponents.street_suffix = decomposed.suffix
	}

	if (!zipl && !zipr) {
		yield { components: baseComponents, variantKey: "no-zip" }

		return
	}

	if (zipl && zipr && zipl === zipr) {
		yield {
			components: { ...baseComponents, postcode: zipl },
			variantKey: `zip-${zipl}`,
		}

		return
	}

	if (zipl) {
		yield { components: { ...baseComponents, postcode: zipl }, variantKey: `zipl-${zipl}` }
	}

	if (zipr && zipr !== zipl) {
		yield { components: { ...baseComponents, postcode: zipr }, variantKey: `zipr-${zipr}` }
	}
}

/**
 * Build locality variants for a TIGER place.
 */
function* placeVariants(row: TigerPlaceRow): Iterable<{
	components: CanonicalRow["components"]
	variantKey: string
}> {
	const name = row.name.trim()

	if (!name) return
	const state = lookupFipsState(row.statefp)

	if (!state) return

	yield {
		components: { locality: name },
		variantKey: "locality-only",
	}

	yield {
		components: { locality: name, region: state.abbreviation },
		variantKey: "with-region",
	}

	yield {
		components: { locality: name, region: state.abbreviation, country: US_COUNTRY_DISPLAY },
		variantKey: "with-region-country",
	}
}

/**
 * Build a TIGER adapter.
 */
export function createTigerAdapter(): CorpusAdapter {
	return {
		id: TIGER_ADAPTER_ID,
		defaultLicense: TIGER_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.CensusTIGER,
		surface: SurfaceOrigin.Rendered,
		description:
			"US Census TIGER/Line streets + places consumer (public-domain); SQLite DB built via `mailwoman tiger fetch`.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`tiger adapter: only US supported, got country=${opts.country}`)
			}

			const db = new DatabaseClient<TIGERDatabase>(opts.inputPath, { readOnly: true })
			let emitted = 0

			try {
				const streetStmt = db.prepare(`SELECT linearid, fullname, zipl, zipr, statefp FROM tiger_streets`)
				const placeStmt = db.prepare(`SELECT geoid, name, statefp, lsad FROM tiger_places`)

				for (const row of streetStmt.iterate() as IterableIterator<TigerStreetRow>) {
					if (opts.signal?.aborted) return

					for (const variant of streetVariants(row)) {
						if (opts.limit !== undefined && emitted >= opts.limit) return
						const rendered = formatAddressRow(variant.components, "US", { singleLine: true })

						if (!rendered) continue

						const { raw, components: aligned } = rendered

						yield {
							raw,
							components: aligned,
							country: "US",
							locale: "en-US",
							source: TIGER_ADAPTER_ID,
							source_id: `${TIGER_ADAPTER_ID}-st-${row.linearid}-${variant.variantKey}`,
							corpus_version: "",
							license: TIGER_DEFAULT_LICENSE,
						}

						emitted++
					}
				}

				for (const row of placeStmt.iterate() as IterableIterator<TigerPlaceRow>) {
					if (opts.signal?.aborted) return

					for (const variant of placeVariants(row)) {
						if (opts.limit !== undefined && emitted >= opts.limit) return
						const rendered = formatAddressRow(variant.components, "US", { singleLine: true })

						if (!rendered) continue

						const { raw, components: aligned } = rendered

						yield {
							raw,
							components: aligned,
							country: "US",
							locale: "en-US",
							source: TIGER_ADAPTER_ID,
							source_id: `${TIGER_ADAPTER_ID}-pl-${row.geoid}-${variant.variantKey}`,
							corpus_version: "",
							license: TIGER_DEFAULT_LICENSE,
						}

						emitted++
					}
				}
			} finally {
				await db.destroy()
			}
		},
	}
}

/**
 * Configured adapter instance.
 */
export const tigerAdapter = createTigerAdapter()
