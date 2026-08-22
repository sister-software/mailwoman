/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The BACKEND's name key, for fake gazetteers to key on.
 *
 *   It models `normalizeLocalityForKey` (`@mailwoman/resolver-wof-sqlite/street-normalize`) rather
 *   than importing it: `@mailwoman/resolver` is backend-agnostic by design and must not take a
 *   dependency on a query backend, not even in tests.
 *
 *   Three fake gazetteers had grown their own copy of this, and two of them had it WRONG in the same
 *   way the production fold did (#1764) — replacing a combining mark with a space instead of
 *   deleting it. A mock keyed that way models a backend that does not exist, so it passes while the
 *   real comparison fails. One copy, so the next one cannot drift.
 */

/**
 * Fold diacritics AWAY (`Zürich` → `zurich`), the way `normalizeLocalityForKey` does.
 *
 * Dropping the combining mark rather than replacing it with a space is the whole point: replace, and `Zürich` keys as
 * `zu rich` and matches nothing it should. Measured on the shipped shard, 0 of 32,539 distinct `locality_base` keys
 * carry a mark.
 */
export function backendNameKey(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/\p{M}/gu, "")
		.replaceAll(/[^a-z0-9 ]/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim()
}
