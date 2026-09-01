/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure phrase → category matching core, shared by the node entry (`lookup.ts`, `node:fs` loader) and the
 *   browser-safe entry (`table.ts`, injected table). Holds the index construction + locale-gating logic — zero
 *   node imports, so it stays bundler-safe. Not exported via a subpath of its own.
 */

import { createPhraseIndex } from "#phrase-index"
import type { CategoryRecord, POITaxonomyTable, SynonymEntry } from "#types"

export interface CategoryMatch {
	category: CategoryRecord
	/**
	 * The lexicon phrase that matched (lowercased).
	 */
	matchedPhrase: string
	/**
	 * 1.0 = ungated or exact-locale; 0.5 = language-only locale match.
	 */
	confidence: number
}

export interface POITaxonomyLookup {
	lookupPOICategory(text: string, locale?: string): CategoryMatch[]
	lookupPOICategoryLocaleNormalized(text: string, locale?: string): CategoryMatch[]
	lookupPOICategoryTypo(text: string, locale?: string): CategoryMatch[]
	getPOICategory(id: string): CategoryRecord | undefined
	getAllCategories(): ReadonlyArray<CategoryRecord>
	requiresBuildLocalLayer(category: CategoryRecord): boolean
	resolveOvertureCategories(seedID: string): string[]
}

interface PhraseEntry {
	category: CategoryRecord
	phrase: string
	locales?: string[]
}

/**
 * Below five characters, one edit changes too much of the signal to infer a category safely.
 */
const MIN_TYPO_LENGTH = 5

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
	const byPhrase: ReadonlyMap<string, ReadonlyArray<PhraseEntry>> = createPhraseIndex<PhraseEntry>((add) => {
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
	})

	/**
	 * Exact-phrase category lookup. `locale` gates locale-restricted synonyms with the variant-aliases semantics
	 * (`@mailwoman/variant-aliases`' `resolveLocaleScope` owns that rule; the copies here stay local to keep this package
	 * dependency-free): exact locale 1.0, language-only 0.5, otherwise no match. Ungated phrases always match at 1.0.
	 * Deduplicated by category (best confidence wins), sorted by confidence descending.
	 */
	function lookupPOICategory(text: string, locale?: string): CategoryMatch[] {
		const norm = text.trim().toLowerCase()

		if (!norm) return []

		const entries = byPhrase.get(norm)

		if (!entries || !entries.length) return []

		const language = locale?.split(/[-_]/)[0]
		const best = new Map<string, CategoryMatch>()

		for (const entry of entries) {
			let confidence: number

			if (!entry.locales) {
				confidence = 1
			} else if (locale && entry.locales.includes(locale)) {
				confidence = 1
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

		return [...best.values()].toSorted((a, b) => b.confidence - a.confidence)
	}

	/**
	 * Diacritic-insensitive matching is deliberately limited to locale-gated synonyms. This lets `hopital` recover the
	 * French `hôpital` without turning every English taxonomy label into a globally fuzzy alias.
	 */
	function lookupPOICategoryLocaleNormalized(text: string, locale?: string): CategoryMatch[] {
		if (!locale) return []

		const norm = foldDiacritics(text.trim().toLowerCase())

		if (!norm || byPhrase.has(text.trim().toLowerCase())) return []

		const language = locale.split(/[-_]/)[0]!
		const best = new Map<string, CategoryMatch>()

		for (const [phrase, entries] of byPhrase) {
			if (foldDiacritics(phrase) !== norm) continue

			for (const entry of entries) {
				if (!entry.locales) continue
				const exact = entry.locales.includes(locale)
				const languageMatch = entry.locales.some((candidate) => candidate.split(/[-_]/)[0] === language)

				if (!exact && !languageMatch) continue

				const confidence = exact ? 0.94 : 0.78
				const existing = best.get(entry.category.id)

				if (!existing || existing.confidence < confidence) {
					best.set(entry.category.id, { category: entry.category, matchedPhrase: entry.phrase, confidence })
				}
			}
		}

		return [...best.values()].toSorted((a, b) => b.confidence - a.confidence)
	}

	/**
	 * One-edit recovery over the same locale-gated phrase index. Returns a result only when the best edit distance maps
	 * to exactly one category; ambiguity is an abstention. Short inputs are excluded because one edit is too permissive.
	 */
	function lookupPOICategoryTypo(text: string, locale?: string): CategoryMatch[] {
		const norm = text.trim().toLowerCase()

		// With no presumed language, a correction is guesswork. Abstention is useful evidence to the caller.
		if (!locale || norm.length < MIN_TYPO_LENGTH || byPhrase.has(norm)) return []

		const language = locale.split(/[-_]/)[0]!
		let bestDistance = 2
		const best = new Map<string, CategoryMatch>()

		for (const [phrase, entries] of byPhrase) {
			if (Math.abs(phrase.length - norm.length) > 1) continue

			const distance = oneEditDistance(norm, phrase)

			if (distance > bestDistance) continue

			for (const entry of entries) {
				// Category ids and labels come from Overture's English taxonomy. Localized synonyms declare their languages.
				if (!entry.locales && language !== "en") continue

				const allowed =
					!entry.locales || entry.locales.includes(locale) || entry.locales.some((l) => l.split(/[-_]/)[0] === language)

				if (!allowed) continue

				if (distance < bestDistance) {
					bestDistance = distance
					best.clear()
				}

				best.set(entry.category.id, {
					category: entry.category,
					matchedPhrase: entry.phrase,
					confidence: 0.82,
				})
			}
		}

		return bestDistance === 1 && best.size === 1 ? [...best.values()] : []
	}

	/**
	 * Fetch a category by id.
	 */
	function getPOICategory(id: string): CategoryRecord | undefined {
		return byID.get(id)
	}

	/**
	 * Enumerate the full table (corpus synthesis, builders, docs).
	 */
	function getAllCategories(): ReadonlyArray<CategoryRecord> {
		return table.categories
	}

	/**
	 * True when the category's data exists only in ODbL sources — answering needs a build-local layer.
	 */
	function requiresBuildLocalLayer(category: CategoryRecord): boolean {
		return category.source === "mailwoman-infra"
	}

	/**
	 * Resolve a canonical seed category id to the Overture `taxonomy.primary` leaf ids a built `poi.db` stores for it
	 * (the missing translation layer). Returns the category's `overtureCategories` when it declares a non-empty list,
	 * else `[seedID]` (identity — the default for the 21 seeds whose id already equals its Overture leaf). An unknown
	 * seed id resolves to `[]` — a clean miss, mirroring `getPOICategory`'s undefined.
	 */
	function resolveOvertureCategories(seedID: string): string[] {
		const category = byID.get(seedID)

		if (!category) return []

		return category.overtureCategories && category.overtureCategories.length
			? [...category.overtureCategories]
			: [category.id]
	}

	return {
		lookupPOICategory,
		lookupPOICategoryLocaleNormalized,
		lookupPOICategoryTypo,
		getPOICategory,
		getAllCategories,
		requiresBuildLocalLayer,
		resolveOvertureCategories,
	}
}

function foldDiacritics(text: string): string {
	return text.normalize("NFD").replaceAll(/\p{M}/gu, "")
}

function oneEditDistance(a: string, b: string): number {
	if (a === b) return 0

	if (Math.abs(a.length - b.length) > 1) return 2

	if (a.length === b.length) {
		const mismatches: number[] = []

		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) {
				mismatches.push(i)
			}

			if (mismatches.length > 2) return 2
		}

		if (mismatches.length === 1) return 1

		if (mismatches.length === 2) {
			const [i, j] = mismatches

			return j === i! + 1 && a[i!] === b[j!] && a[j!] === b[i!] ? 1 : 2
		}

		return 2
	}

	const [shorter, longer] = a.length < b.length ? [a, b] : [b, a]
	let i = 0
	let j = 0
	let edits = 0

	while (i < shorter.length && j < longer.length) {
		if (shorter[i] === longer[j]) {
			i++

			j++
		} else {
			edits++

			j++

			if (edits > 1) return 2
		}
	}

	return 1
}
