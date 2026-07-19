/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure phrase → brand matching core, shared by the node entry (`brands.ts`, `node:fs` loader) and the
 *   browser-safe entry (`table.ts`, injected table) — the same split `lookup-core.ts` uses for categories.
 *   Zero node imports, so it stays bundler-safe. Not exported via a subpath of its own.
 */

import type { BrandRecord, POIBrandTable } from "./types.ts"

export interface BrandMatch {
	brand: BrandRecord
	/** The lexicon phrase that matched (lowercased) — the brand's `name` or one of its `aliases`. */
	matchedPhrase: string
	/** Always 1.0 — brand matching is exact-phrase only, no locale gating (unlike category synonyms). */
	confidence: number
}

export interface POIBrandLookup {
	lookupPOIBrand(text: string): BrandMatch[]
	/** Convenience wrapper: the single best (highest-`rows`) brand for an exact-phrase match, if any. */
	resolveBrandName(name: string): BrandRecord | undefined
	getBrand(wikidata: string): BrandRecord | undefined
	getAllBrands(): ReadonlyArray<BrandRecord>
}

interface PhraseEntry {
	brand: BrandRecord
	phrase: string
}

/** Builds the matching core over an in-memory {@link POIBrandTable}. */
export function createBrandLookupCore(table: POIBrandTable): POIBrandLookup {
	const byWikidata: ReadonlyMap<string, BrandRecord> = new Map(table.brands.map((b) => [b.wikidata, b]))

	/**
	 * Lowercased phrase index. Sources, in insertion order: each brand's `name`, then its `aliases`. Multiple brands may
	 * share a phrase (distinct QIDs happening to use the same display string) — `lookupPOIBrand` dedupes per brand and
	 * sorts the survivors deterministically.
	 */
	const byPhrase: ReadonlyMap<string, ReadonlyArray<PhraseEntry>> = (() => {
		const map = new Map<string, PhraseEntry[]>()

		const add = (phrase: string, entry: PhraseEntry) => {
			const key = phrase.toLowerCase()
			const existing = map.get(key) ?? []
			existing.push(entry)
			map.set(key, existing)
		}

		for (const brand of table.brands) {
			add(brand.name, { brand, phrase: brand.name })

			for (const alias of brand.aliases) {
				add(alias, { brand, phrase: alias })
			}
		}

		return map
	})()

	/**
	 * Exact-phrase brand lookup. Deduplicated by brand (a QID can only appear once, keeping its first-seen matched
	 * phrase), sorted by `rows` descending — ties broken by `wikidata` for determinism.
	 */
	function lookupPOIBrand(text: string): BrandMatch[] {
		const norm = text.trim().toLowerCase()

		if (!norm) return []

		const entries = byPhrase.get(norm)

		if (!entries || entries.length === 0) return []

		const best = new Map<string, BrandMatch>()

		for (const entry of entries) {
			if (!best.has(entry.brand.wikidata)) {
				best.set(entry.brand.wikidata, { brand: entry.brand, matchedPhrase: entry.phrase, confidence: 1.0 })
			}
		}

		return [...best.values()].sort(
			(a, b) => b.brand.rows - a.brand.rows || a.brand.wikidata.localeCompare(b.brand.wikidata)
		)
	}

	/** The single best (highest-`rows`) brand for an exact-phrase match, if any. */
	function resolveBrandName(name: string): BrandRecord | undefined {
		return lookupPOIBrand(name)[0]?.brand
	}

	/** Fetch a brand by its Wikidata QID. */
	function getBrand(wikidata: string): BrandRecord | undefined {
		return byWikidata.get(wikidata)
	}

	/** Enumerate the full table (corpus synthesis, builders, docs). */
	function getAllBrands(): ReadonlyArray<BrandRecord> {
		return table.brands
	}

	return { lookupPOIBrand, resolveBrandName, getBrand, getAllBrands }
}
