/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure phrase → category matching core, shared by the node entry (`lookup.ts`, `node:fs` loader) and the
 *   browser-safe entry (`table.ts`, injected table). Holds the index construction + locale-gating logic — zero
 *   node imports, so it stays bundler-safe. Not exported via a subpath of its own.
 */

import type { CategoryRecord, POITaxonomyTable, SynonymEntry } from "./types.ts"

export interface CategoryMatch {
	category: CategoryRecord
	/** The lexicon phrase that matched (lowercased). */
	matchedPhrase: string
	/** 1.0 = ungated or exact-locale; 0.5 = language-only locale match. */
	confidence: number
}

export interface POITaxonomyLookup {
	lookupPOICategory(text: string, locale?: string): CategoryMatch[]
	getPOICategory(id: string): CategoryRecord | undefined
	getAllCategories(): ReadonlyArray<CategoryRecord>
	requiresBuildLocalLayer(category: CategoryRecord): boolean
}

interface PhraseEntry {
	category: CategoryRecord
	phrase: string
	locales?: string[]
}

/**
 * Builds the matching core over an in-memory {@link POITaxonomyTable}. Throws at construction when a synonym's
 * `categoryID` points at an unknown category — the same integrity check regardless of how the table was loaded.
 */
export function createLookupCore(table: POITaxonomyTable): POITaxonomyLookup {
	const byID: ReadonlyMap<string, CategoryRecord> = new Map(table.categories.map((c) => [c.id, c]))

	/**
	 * Lowercased phrase index. Sources, in insertion order: each category's id (underscores as spaces), its label, then
	 * the synonym table. Multiple entries may share a phrase.
	 */
	const byPhrase: ReadonlyMap<string, ReadonlyArray<PhraseEntry>> = (() => {
		const map = new Map<string, PhraseEntry[]>()

		const add = (phrase: string, entry: PhraseEntry) => {
			const key = phrase.toLowerCase()
			const existing = map.get(key) ?? []
			existing.push(entry)
			map.set(key, existing)
		}

		for (const category of table.categories) {
			add(category.id.replaceAll("_", " "), { category, phrase: category.id.replaceAll("_", " ") })
			add(category.label, { category, phrase: category.label.toLowerCase() })
		}

		for (const synonym of table.synonyms as SynonymEntry[]) {
			const category = byID.get(synonym.categoryID)

			if (!category) {
				throw new Error(
					`poi-taxonomy: synonym ${JSON.stringify(synonym.phrase)} points at unknown category ${synonym.categoryID}`
				)
			}
			add(synonym.phrase, {
				category,
				phrase: synonym.phrase,
				...(synonym.locales ? { locales: synonym.locales } : {}),
			})
		}

		return map
	})()

	/**
	 * Exact-phrase category lookup. `locale` gates locale-restricted synonyms with the variant-aliases semantics: exact
	 * locale 1.0, language-only 0.5, otherwise no match. Ungated phrases always match at 1.0. Deduplicated by category
	 * (best confidence wins), sorted by confidence descending.
	 */
	function lookupPOICategory(text: string, locale?: string): CategoryMatch[] {
		const norm = text.trim().toLowerCase()

		if (!norm) return []

		const entries = byPhrase.get(norm)

		if (!entries || entries.length === 0) return []

		const language = locale?.split(/[-_]/)[0]
		const best = new Map<string, CategoryMatch>()

		for (const entry of entries) {
			let confidence: number

			if (!entry.locales) {
				confidence = 1.0
			} else if (locale && entry.locales.includes(locale)) {
				confidence = 1.0
			} else if (language && entry.locales.some((l) => l.split(/[-_]/)[0] === language)) {
				confidence = 0.5
			} else {
				continue
			}

			const existing = best.get(entry.category.id)

			if (!existing || existing.confidence < confidence) {
				best.set(entry.category.id, { category: entry.category, matchedPhrase: entry.phrase, confidence })
			}
		}

		return [...best.values()].sort((a, b) => b.confidence - a.confidence)
	}

	/** Fetch a category by id. */
	function getPOICategory(id: string): CategoryRecord | undefined {
		return byID.get(id)
	}

	/** Enumerate the full table (corpus synthesis, builders, docs). */
	function getAllCategories(): ReadonlyArray<CategoryRecord> {
		return table.categories
	}

	/** True when the category's data exists only in ODbL sources — answering needs a build-local layer. */
	function requiresBuildLocalLayer(category: CategoryRecord): boolean {
		return category.source === "mailwoman-infra"
	}

	return { lookupPOICategory, getPOICategory, getAllCategories, requiresBuildLocalLayer }
}
