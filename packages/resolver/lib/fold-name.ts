/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One shared name fold, used by the resolver's commune reconciliation, by the street tier's
 *   locality comparison and by span-rescore's key guards. Its own module because those would
 *   otherwise import each other for it.
 *
 *   `@mailwoman/codex`'s `foldName` (`packages/codex/lib/normalize.ts`) is a near twin and is also
 *   correct; it differs in collapsing every non-alphanumeric RUN, whitespace included. The two are
 *   equivalent on the inputs either sees today. They are kept apart because this one answers to a
 *   comparison contract the resolver owns, not because the codex copy is wrong.
 */

/**
 * Case/diacritic-insensitive fold for commune-name comparison (#1058).
 *
 * Marks are DELETED, never spaced. `[^a-z0-9 ]` alone maps the combining cedilla that NFD has just produced to a SPACE,
 * so `Besançon` keys as `besanc on` and matches nothing it should. The gazetteer side of the same comparison deletes
 * them — 0 of 32,539 distinct `locality_base` keys in `street-centroids-fr.db` carry a mark — so spacing puts the two
 * halves of one comparison on different keys. Order is required: after the class filter the strip is a no-op.
 *
 * Not fixed here, and worth knowing before trusting the fold on a non-Latin-1 name: a letter with no decomposition is
 * DROPPED rather than folded (`Łódź` → `odz`, `Đà Nẵng` → `a nang`). That needs a transliteration table, not a regex,
 * and it is shared with every other fold in the repo.
 */
export function foldName(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/\p{M}/gu, "")
		.replaceAll(/[^a-z0-9 ]/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim()
}
