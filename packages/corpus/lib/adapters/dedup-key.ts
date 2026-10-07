/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The key that decides two rows describe the same address.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import type { CanonicalRow } from "#types"

/**
 * Canonical dedup key for a row.
 *
 * Two rows that share this key are duplicates and the first one wins.
 * The key combines `country` with the sorted `components` dictionary and the row's
 * `raw` text, lower-cased with whitespace collapsed.
 *
 * License and provenance fields stay out of the key, so two adapters emitting
 * the same address produce the same key.
 * The key store does not deduplicate across adapters: `runAdapter` holds its own as a local and discards it
 * when the adapter returns, so each adapter is deduplicated only against itself.
 *
 * A cross-adapter pass would hold every adapter's keys at once and would have to choose
 * which adapter's copy of an address survives.
 * That choice sets the row's `source`, `license` and `register`, which makes it a
 * corpus-level decision the runner does not take today.
 *
 * An augmented row is never deduplicated against the row it was fanned from, because
 * `recipe.recipe` joins the key when present and each augmentation variant therefore survives.
 */
export function canonicalDedupKey(row: CanonicalRow): string {
	const sortedKeys = Object.keys(row.components).toSorted() as ComponentTag[]
	const compPart = sortedKeys.map((k) => `${k}=${row.components[k] ?? ""}`).join("\u001F")
	const rawNorm = row.raw.toLowerCase().replaceAll(/\s+/g, " ").trim()
	const recipePart = row.recipe ? `\u001E${row.recipe.recipe}` : ""

	return `${row.country}\u001E${rawNorm}\u001E${compPart}${recipePart}`
}
