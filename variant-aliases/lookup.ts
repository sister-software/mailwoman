/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regional variant alias lookup. Given a token (or short phrase) and a detected locale, return the
 *   canonical amenity category or brand it refers to.
 *
 *   This is the data-side foundation for #166 (variant alias table + locale-gated category matching).
 *   The runtime integration into the kind classifier is v0.6.0+ work.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { AliasLookupResult, VariantAlias, VariantAliasTable } from "./types.js"

const moduleDir = dirname(fileURLToPath(import.meta.url))

function loadTable(): VariantAliasTable {
	const candidates = [
		resolve(moduleDir, "data/aliases.json"),
		resolve(moduleDir, "../data/aliases.json"),
		resolve(moduleDir, "../../variant-aliases/data/aliases.json"),
	]

	for (const path of candidates) {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as VariantAliasTable
		} catch {
			// try next
		}
	}
	throw new Error("variant-aliases: could not find data/aliases.json")
}

const TABLE = loadTable()

/**
 * Indexed by lowercased variant string for O(1) lookup. Multiple entries can share the same variant key (e.g. ambiguous
 * "takeaway" only matches GB but not AU if both list it differently), so each entry is an array of all aliases that
 * share the key.
 */
const INDEX: ReadonlyMap<string, ReadonlyArray<VariantAlias>> = (() => {
	const map = new Map<string, VariantAlias[]>()

	for (const a of TABLE.aliases) {
		const key = a.variant.toLowerCase()
		const existing = map.get(key) ?? []
		existing.push(a)
		map.set(key, existing)
	}

	return map
})()

/**
 * Match a query token against the variant alias table, gated by detected locale.
 *
 * Confidence:
 *
 * - `1.0` when the detected locale (e.g. `en-AU`) is in the alias's `locales` list.
 * - `0.5` when only the language part matches (e.g. detected `en-IE`, alias supports `en-AU`). This is intentionally
 *   weaker because regional variants are by definition regional.
 * - No match when neither holds.
 *
 * Returns ALL matches sorted by confidence descending. Multi-locale variants (like "petrol station" →
 * en-GB/en-AU/en-NZ/en-ZA) return one entry per locale list — the caller picks.
 */
export function lookupVariantAliases(text: string, locale: string): AliasLookupResult[] {
	const norm = text.trim().toLowerCase()

	if (!norm) return []

	const candidates = INDEX.get(norm)

	if (!candidates || candidates.length === 0) return []

	const language = locale.split(/[-_]/)[0]
	const results: AliasLookupResult[] = []

	for (const alias of candidates) {
		if (alias.locales.includes(locale)) {
			results.push({ alias, confidence: 1.0 })
			continue
		}
		// Relaxed match: any locale in `locales` that shares the same language part.
		const langMatch = alias.locales.some((l) => l.split(/[-_]/)[0] === language)

		if (langMatch) {
			results.push({ alias, confidence: 0.5 })
		}
	}

	results.sort((a, b) => b.confidence - a.confidence)

	return results
}

/** Pure-data accessor for callers that want to enumerate the table (e.g. corpus synthesis). */
export function getAllAliases(): ReadonlyArray<VariantAlias> {
	return TABLE.aliases
}

export const VARIANT_ALIAS_VERSION = TABLE.version
