/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `wof-admin`: Who's On First admin SQLite distribution adapter.
 *
 *   Input: a `.spatial.db` from `whosonfirst-data-admin-<cc>-latest`. The adapter only reads the
 *   `spr` table — name, placetype, parent_id, country, is_current — and walks the parent chain to
 *   assemble ancestry. Geometry, geojson, names (localized variants), concordances are ignored at
 *   this layer. They're addressed by future adapters or downstream synthesis.
 *
 *   For every `spr` row whose placetype maps to a `ComponentTag` (country, region, county, locality,
 *   ...), the adapter emits hierarchical variants per the Phase 1 spec:
 *
 *   Locality alone → "Portland" locality + region → "Portland, Oregon" locality + region + country →
 *   "Portland, Oregon, United States"
 *
 *   Region rows emit 2 variants (alone + with country); country rows emit 1. County/subregion rows
 *   emit `self` only — they're rarely standalone addresses.
 *
 *   `source_id` is `wof-admin-<id>-<variant>` so each variant survives dedup independently (otherwise
 *   the locality-alone and locality+region rows over the same WOF id would share the canonical
 *   dedup key for the locality, since prefix+suffix differ only in the region component).
 *
 *   License: CC0. The adapter stamps every row with `CC0-1.0`.
 */

import type { WhosOnFirstPlacetype } from "@mailwoman/core/resources/whosonfirst"
import type { ComponentTag } from "@mailwoman/core/types"
import Database from "better-sqlite3"
import { formatAddress, reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

/**
 * Display name for the country, keyed by ISO 3166-1 alpha-2.
 *
 * Must be the **OpenCage-canonical** surface form: the `address-formatter` library expands some
 * country names en route to its output (e.g. `"United States"` → `"United States of America"`). If
 * `components.country` and the formatted `raw` disagree, alignment will fail downstream. Keying off
 * the canonical form keeps the two in lockstep.
 *
 * Phase 1 US + FR only; extend as new locales come online. Missing countries fall back to the
 * country row's `name` field, accepting the alignment risk for non-canonicalized names.
 */
const COUNTRY_DISPLAY_NAME: Record<string, string> = {
	US: "United States of America",
	FR: "France",
}

/**
 * BCP-47 locale defaulting for the corpus row's `locale` field. WOF doesn't carry locales on admin
 * rows directly; the country-derived default is sufficient for Phase 1 US + FR.
 */
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

/** Row shape pulled from the `spr` table. */
interface SprRow {
	id: number
	parent_id: number | null
	name: string
	placetype: string
	country: string
}

/**
 * Cached parent chain. Stored as a Map<id, ancestors[]> where `ancestors` is the chain walking
 * parent_id upward, oldest (country) last. Skips superseded records (`is_current=0`).
 */
type AncestryIndex = Map<number, SprRow[]>

function buildAncestryIndex(db: Database.Database): AncestryIndex {
	const rows = db
		.prepare<[], SprRow>(`SELECT id, parent_id, name, placetype, country FROM spr WHERE is_current = 1`)
		.all()
	const byId = new Map<number, SprRow>(rows.map((r) => [r.id, r]))
	const index: AncestryIndex = new Map()
	for (const row of rows) {
		const chain: SprRow[] = []
		let cur = row.parent_id
		const guard = new Set<number>([row.id])
		while (cur !== null && cur !== undefined && cur > 0) {
			const parent = byId.get(cur)
			if (!parent) break
			if (guard.has(parent.id)) break // cycle guard
			chain.push(parent)
			guard.add(parent.id)
			cur = parent.parent_id
		}
		index.set(row.id, chain)
	}
	return index
}

interface VariantSpec {
	/** Variant id appended to source_id; keeps rows from the same WOF id deduped independently. */
	suffix: string

	/** Component tag → display string the adapter will hand to the runner. */
	components: Partial<Record<ComponentTag, string>>
}

/**
 * Compute the per-row variants the adapter emits. The same shape any downstream caller can reuse
 * for testing or for variant-count assertions.
 */
export function variantsFor(row: SprRow, ancestry: SprRow[]): VariantSpec[] {
	const selfTag = placetypeToTag(row.placetype)
	if (!selfTag) return []

	const region = ancestry.find((a) => placetypeToTag(a.placetype) === "region")
	const country = ancestry.find((a) => placetypeToTag(a.placetype) === "country")
	const countryDisplay = COUNTRY_DISPLAY_NAME[row.country] ?? country?.name ?? row.country

	const variants: VariantSpec[] = []

	switch (selfTag) {
		case "locality":
		case "dependent_locality": {
			variants.push({ suffix: "self", components: { [selfTag]: row.name } })
			if (region) {
				variants.push({
					suffix: "with-region",
					components: { [selfTag]: row.name, region: region.name },
				})
			}
			if (region && country) {
				variants.push({
					suffix: "with-region-country",
					components: { [selfTag]: row.name, region: region.name, country: countryDisplay },
				})
			} else if (!region && country) {
				variants.push({
					suffix: "with-country",
					components: { [selfTag]: row.name, country: countryDisplay },
				})
			}
			return variants
		}

		case "region": {
			variants.push({ suffix: "self", components: { region: row.name } })
			if (country) {
				variants.push({
					suffix: "with-country",
					components: { region: row.name, country: countryDisplay },
				})
			}
			return variants
		}

		case "country": {
			// Use the canonical display name when available so the country-self variant aligns
			// with OpenCage's expansion for downstream alignment.
			variants.push({ suffix: "self", components: { country: countryDisplay } })
			return variants
		}

		case "subregion": {
			// Counties / arrondissements rarely appear standalone; emit a "self" only.
			variants.push({ suffix: "self", components: { subregion: row.name } })
			return variants
		}

		default:
			return []
	}
}

export const WOF_ADMIN_ADAPTER_ID = "wof-admin"

/**
 * Construct the wof-admin adapter. The adapter is stateless across runs; calling this twice with
 * the same input path produces byte-identical canonical.jsonl.
 */
export function createWofAdminAdapter(): CorpusAdapter {
	return {
		id: WOF_ADMIN_ADAPTER_ID,
		defaultLicense: "CC0-1.0",
		description: "Who's On First admin SQLite distribution (countries, regions, counties, localities).",
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
								   AND country = @country
								 ORDER BY id ASC`
							)
							.iterate({ country: opts.country })
					: db
							.prepare<[], SprRow>(
								`SELECT id, parent_id, name, placetype, country
								 FROM spr
								 WHERE is_current = 1
								 ORDER BY id ASC`
							)
							.iterate()

				let emitted = 0
				for (const row of iter) {
					if (opts.signal?.aborted) break
					if (opts.country && row.country !== opts.country) continue

					const chain = ancestry.get(row.id) ?? []
					const variants = variantsFor(row, chain)

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
							source: WOF_ADMIN_ADAPTER_ID,
							source_id: `${WOF_ADMIN_ADAPTER_ID}-${row.id}-${variant.suffix}`,
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

/** Single shared instance, suitable for `defaultAdapterRegistry`. */
export const wofAdminAdapter = createWofAdminAdapter()
