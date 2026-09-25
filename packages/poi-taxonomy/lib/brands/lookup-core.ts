/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { compareByCodePoint, createPhraseIndex } from "#phrase-index"
import type { BrandRecord, POIBrandTable } from "#types"

/**
 * Describes a brand whose name or alias exactly matched the looked-up text, with the phrase that matched.
 */
export interface BrandMatch {
	brand: BrandRecord

	/**
	 * The brand's name or alias that matched, as written in the lexicon.
	 */
	matchedPhrase: string

	/**
	 * Always 1, because brand matching is exact-phrase only with no locale filtering.
	 */
	confidence: number
}

/**
 * Looks up POI brands by exact case-insensitive name or alias and by Wikidata id.
 *
 * When several brands share a phrase, `lookupPOIBrand` orders them by row count,
 * so `resolveBrandName` returns the most common one.
 */
export interface POIBrandLookup {
	lookupPOIBrand(text: string): BrandMatch[]

	/**
	 * Returns the brand with the most rows among exact-phrase matches for `name`, if any.
	 */
	resolveBrandName(name: string): BrandRecord | undefined
	getBrand(wikidata: string): BrandRecord | undefined
	getAllBrands(): ReadonlyArray<BrandRecord>
}

interface PhraseEntry {
	brand: BrandRecord
	phrase: string
}

/**
 * Builds the matching core over an in-memory {@link POIBrandTable}.
 */
export function createBrandLookupCore(table: POIBrandTable): POIBrandLookup {
	const byWikidata: ReadonlyMap<string, BrandRecord> = new Map(table.brands.map((b) => [b.wikidata, b]))

	const byPhrase: ReadonlyMap<string, ReadonlyArray<PhraseEntry>> = createPhraseIndex<PhraseEntry>((add) => {
		for (const brand of table.brands) {
			add(brand.name, { brand, phrase: brand.name })

			for (const alias of brand.aliases) {
				add(alias, { brand, phrase: alias })
			}
		}
	})

	function lookupPOIBrand(text: string): BrandMatch[] {
		const norm = text.trim().toLowerCase()

		if (!norm) return []

		const entries = byPhrase.get(norm)

		if (!entries || !entries.length) return []

		const best = new Map<string, BrandMatch>()

		for (const entry of entries) {
			if (!best.has(entry.brand.wikidata)) {
				best.set(entry.brand.wikidata, { brand: entry.brand, matchedPhrase: entry.phrase, confidence: 1 })
			}
		}

		return [...best.values()].toSorted(
			(a, b) => b.brand.rows - a.brand.rows || compareByCodePoint(a.brand.wikidata, b.brand.wikidata)
		)
	}

	function resolveBrandName(name: string): BrandRecord | undefined {
		return lookupPOIBrand(name)[0]?.brand
	}

	function getBrand(wikidata: string): BrandRecord | undefined {
		return byWikidata.get(wikidata)
	}

	function getAllBrands(): ReadonlyArray<BrandRecord> {
		return table.brands
	}

	return { lookupPOIBrand, resolveBrandName, getBrand, getAllBrands }
}
