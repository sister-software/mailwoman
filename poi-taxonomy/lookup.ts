/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phrase → category lookup over `data/taxonomy.json`. Same loader + locale-gating shape as
 *   `@mailwoman/variant-aliases` (its slang table resolves INTO these category ids). Matching is
 *   exact-phrase over a lowercased index; n-gram extraction from longer queries is the kind
 *   classifier's job, not this package's.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { CategoryRecord, POITaxonomyTable, SynonymEntry } from "./types.ts"

const moduleDir = import.meta.dirname

function loadTable(): POITaxonomyTable {
	const candidates = [
		resolve(moduleDir, "data/taxonomy.json"),
		resolve(moduleDir, "../data/taxonomy.json"),
		resolve(moduleDir, "../../poi-taxonomy/data/taxonomy.json"),
	]

	for (const path of candidates) {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as POITaxonomyTable
		} catch {
			// try next
		}
	}
	throw new Error("poi-taxonomy: could not find data/taxonomy.json")
}

const TABLE = loadTable()

const BY_ID: ReadonlyMap<string, CategoryRecord> = new Map(TABLE.categories.map((c) => [c.id, c]))

interface PhraseEntry {
	category: CategoryRecord
	phrase: string
	locales?: string[]
}

/**
 * Lowercased phrase index. Sources, in insertion order: each category's id (underscores as spaces), its label, then the
 * synonym table. Multiple entries may share a phrase.
 */
const BY_PHRASE: ReadonlyMap<string, ReadonlyArray<PhraseEntry>> = (() => {
	const map = new Map<string, PhraseEntry[]>()

	const add = (phrase: string, entry: PhraseEntry) => {
		const key = phrase.toLowerCase()
		const existing = map.get(key) ?? []
		existing.push(entry)
		map.set(key, existing)
	}

	for (const category of TABLE.categories) {
		add(category.id.replaceAll("_", " "), { category, phrase: category.id.replaceAll("_", " ") })
		add(category.label, { category, phrase: category.label.toLowerCase() })
	}
	for (const synonym of TABLE.synonyms as SynonymEntry[]) {
		const category = BY_ID.get(synonym.categoryID)
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

export interface CategoryMatch {
	category: CategoryRecord
	/** The lexicon phrase that matched (lowercased). */
	matchedPhrase: string
	/** 1.0 = ungated or exact-locale; 0.5 = language-only locale match. */
	confidence: number
}

/**
 * Exact-phrase category lookup. `locale` gates locale-restricted synonyms with the variant-aliases semantics: exact
 * locale 1.0, language-only 0.5, otherwise no match. Ungated phrases always match at 1.0. Deduplicated by category
 * (best confidence wins), sorted by confidence descending.
 */
export function lookupPOICategory(text: string, locale?: string): CategoryMatch[] {
	const norm = text.trim().toLowerCase()

	if (!norm) return []

	const entries = BY_PHRASE.get(norm)

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
export function getPOICategory(id: string): CategoryRecord | undefined {
	return BY_ID.get(id)
}

/** Enumerate the full table (corpus synthesis, builders, docs). */
export function getAllCategories(): ReadonlyArray<CategoryRecord> {
	return TABLE.categories
}

/** True when the category's data exists only in ODbL sources — answering needs a build-local layer. */
export function requiresBuildLocalLayer(category: CategoryRecord): boolean {
	return category.source === "mailwoman-infra"
}

export const POI_TAXONOMY_VERSION = TABLE.version
