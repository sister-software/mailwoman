/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regional variant alias lookup. Given a token (or short phrase) and a detected locale, return the
 *   canonical amenity category or brand it refers to.
 *
 *   This is the data-side foundation for #166 (variant alias table + locale-restricted category matching).
 *   The runtime integration into the kind classifier is v0.6.0+ work.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackagedDataPath } from "@mailwoman/core/module/packaged-data"

import type { AliasLookupResult, LocaleScopeMatch, VariantAlias, VariantAliasTable } from "#types"

const moduleDir = import.meta.dirname

/**
 * Read the shipped alias table, located by the shared source-tree/`out/` probe in
 * `@mailwoman/core/module/packaged-data`.
 */
async function loadTable(): Promise<VariantAliasTable> {
	return readLocalJSONFile<VariantAliasTable>(await resolvePackagedDataPath(moduleDir, "aliases.json"))
}

const TABLE = await loadTable()

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
 * Decide how a locale-scoped record answers under a detected locale — the rule every locale-restricted vocabulary in
 * the pipeline follows.
 *
 * - `unscoped` (confidence 1) when the record declares no locales at all.
 * - `exact` (confidence 1) when the detected locale is one the record declares.
 * - `language` (confidence 0.5) when only the language subtag agrees — weaker on purpose, because regional variants are
 *   by definition regional.
 * - `null` otherwise, and for any scoped record when the locale is unknown: a phrasing declared regional cannot be
 *   reached without knowing the region.
 */
export function resolveLocaleScope(
	locales: ReadonlyArray<string> | undefined,
	locale: string | undefined
): LocaleScopeMatch | null {
	if (!locales) return { scope: "unscoped", confidence: 1 }

	if (!locale) return null

	if (locales.includes(locale)) return { scope: "exact", confidence: 1 }

	const language = locale.split(/[-_]/)[0]

	if (locales.some((tag) => tag.split(/[-_]/)[0] === language)) return { scope: "language", confidence: 0.5 }

	return null
}

/**
 * Match a query token against the variant alias table, filtered by detected locale.
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

	if (!candidates || !candidates.length) return []

	const results: AliasLookupResult[] = []

	for (const alias of candidates) {
		const match = resolveLocaleScope(alias.locales, locale)

		if (match) {
			results.push({ alias, confidence: match.confidence })
		}
	}

	results.sort((a, b) => b.confidence - a.confidence)

	return results
}

/**
 * Pure-data accessor for callers that want to enumerate the table (e.g. corpus synthesis).
 */
export function getAllAliases(): ReadonlyArray<VariantAlias> {
	return TABLE.aliases
}

/**
 * Version of the bundled variant-alias table, for cache keys and diagnostics.
 */
export const VARIANT_ALIAS_VERSION = TABLE.version
