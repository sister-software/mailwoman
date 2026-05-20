/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `tiger`: US Census TIGER/Line consumer adapter.
 *
 *   TIGER/Line is the canonical US street + locality dataset published by the Census Bureau as a
 *   **public-domain** product (no ODbL share-alike concerns for US-only corpora). Coverage extends
 *   to every named street segment + every incorporated place + CDP across the 50 states + DC + the
 *   five primary territories — substantially better US street-name coverage than OSM, especially in
 *   rural areas.
 *
 *   Following the `wof-admin` / `wof-postalcode` pattern, this adapter consumes a SQLite database the
 *   operator pre-builds from the raw TIGER shapefiles (see the README for the schema and a
 *   suggested `ogr2ogr` pipeline). The mailwoman side does not parse Shapefile binary directly —
 *   keeping the adapter narrow lets the operator pick their own ingestion tool (ogr2ogr / shp2pgsql
 *   / a custom Python script / etc.) without forcing a heavy native dep into `@mailwoman/corpus`.
 *
 *   Two row classes are emitted:
 *
 *   - **Street-level** (`tiger_streets`): one row per segment, optionally with up to two postcode
 *       variants if `zipl` / `zipr` differ. Components: `{ street, region, postcode? }`. Streets
 *       without a recognized state FIPS are dropped — there's no useful row without `region`.
 *   - **Locality-level** (`tiger_places`): up to three variants per place: locality-only,
 *       locality-with-region, locality-with-region-country (mirrors `wof-admin`'s fan-out for
 *       consistency).
 *
 *   Salvaged components from `isp-nexus/universe@6eeb7bd9`:
 *
 *   - `packages/corpus/src/codex/us-fips-state.ts` — the FIPS → `{abbreviation, name}` lookup table
 *       (originally `tiger/state.ts`, AGPL-3.0 → AGPL-3.0). The full isp-nexus TIGER module ships a
 *       TypeORM-backed service layer; mailwoman only needs the lookup data so we don't carry the
 *       service layer over.
 *
 *   License: stamped `"Public Domain"` per Census Bureau guidance on TIGER/Line. No per-row override
 *   needed — every row in TIGER is the same license.
 */

import { DatabaseSync } from "node:sqlite"
import { lookupFipsState } from "../../codex/us-fips-state.js"
import { formatAddress, reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const TIGER_ADAPTER_ID = "tiger"
export const TIGER_DEFAULT_LICENSE = "Public Domain"

/**
 * The country surface form used in `formatAddress` for US. Matches the canonical OpenCage US
 * template output so reconciliation doesn't strip it when the row carries `country` explicitly.
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
 * Yield one or more `CanonicalRow`s per street segment. Postcode variants:
 *
 * - No ZIP set → one row, street + region.
 * - `zipl === zipr` → one row, street + region + postcode.
 * - `zipl !== zipr` → two rows (one per side's ZIP).
 */
function* streetVariants(row: TigerStreetRow): Iterable<{
	components: CanonicalRow["components"]
	variantKey: string
}> {
	const street = row.fullname.trim()
	if (!street) return
	const state = lookupFipsState(row.statefp)
	if (!state) return

	const zipl = row.zipl?.trim() ?? ""
	const zipr = row.zipr?.trim() ?? ""

	const baseComponents: CanonicalRow["components"] = {
		street,
		region: state.abbreviation,
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
	if (zipl) yield { components: { ...baseComponents, postcode: zipl }, variantKey: `zipl-${zipl}` }
	if (zipr && zipr !== zipl) yield { components: { ...baseComponents, postcode: zipr }, variantKey: `zipr-${zipr}` }
}

/** Three locality-level variants, mirroring `wof-admin`'s fan-out. */
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

/** Build a TIGER adapter. Pure factory so multiple instances can be created in tests. */
export function createTigerAdapter(): CorpusAdapter {
	return {
		id: TIGER_ADAPTER_ID,
		defaultLicense: TIGER_DEFAULT_LICENSE,
		description:
			"US Census TIGER/Line streets + places consumer (public-domain); SQLite DB the operator builds via ogr2ogr.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`tiger adapter: only US supported, got country=${opts.country}`)
			}

			const db = new DatabaseSync(opts.inputPath, { readOnly: true })
			let emitted = 0
			try {
				const streetStmt = db.prepare(`SELECT linearid, fullname, zipl, zipr, statefp FROM tiger_streets`)
				const placeStmt = db.prepare(`SELECT geoid, name, statefp, lsad FROM tiger_places`)

				for (const row of streetStmt.iterate() as IterableIterator<TigerStreetRow>) {
					if (opts.signal?.aborted) return
					for (const variant of streetVariants(row)) {
						if (opts.limit !== undefined && emitted >= opts.limit) return
						const raw = formatAddress(variant.components, "US", { separator: ", " })
						if (!raw) continue
						const aligned = reconcileComponents(variant.components, raw)
						if (Object.keys(aligned).length === 0) continue

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
						const raw = formatAddress(variant.components, "US", { separator: ", " })
						if (!raw) continue
						const aligned = reconcileComponents(variant.components, raw)
						if (Object.keys(aligned).length === 0) continue

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
				db.close()
			}
		},
	}
}

export const tigerAdapter = createTigerAdapter()
