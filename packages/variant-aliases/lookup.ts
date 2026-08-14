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

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { AliasLookupResult, VariantAlias, VariantAliasTable } from "./types.ts"

const moduleDir = import.meta.dirname

/**
 * Read the shipped alias table.
 *
 * `data/` sits at the package root (it is a `files` entry), and this module sits either at that root — running from
 * source — or under `out/` when compiled, so there are exactly two places to look. The probe tests for the FILE:
 * probing by attempting a parse folds a corrupt table into "not this candidate", and the package then reports a missing
 * table it is looking straight at.
 *
 * `@mailwoman/poi-taxonomy` carries the same loader against its own tables. The duplication is deliberate — both
 * packages declare ZERO dependencies and publish independently, so sharing one would mean one taking a dependency on
 * the other for eight lines.
 */
function loadTable(): VariantAliasTable {
	const candidates = [resolve(moduleDir, "data", "aliases.json"), resolve(moduleDir, "..", "data", "aliases.json")]
	const found = candidates.find((candidate) => existsSync(candidate))

	if (!found) {
		throw new Error(`variant-aliases: could not find data/aliases.json — looked in ${candidates.join(", ")}`)
	}

	// A corrupt shipped table is a broken build, and the SyntaxError names the offset. Zero dependencies here, so
	// `@mailwoman/core`'s parse wrappers are deliberately out of reach.
	// oxlint-disable-next-line no-restricted-properties
	return JSON.parse(readFileSync(found, "utf8")) as VariantAliasTable
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

	if (!candidates || !candidates.length) return []

	const language = locale.split(/[-_]/)[0]
	const results: AliasLookupResult[] = []

	for (const alias of candidates) {
		if (alias.locales.includes(locale)) {
			results.push({ alias, confidence: 1 })

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
