/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The OWN-NAME VARIANT predicate (#1882): is an alias surface the holder's own primary name in
 *   another orthography — a romanization (`Брэст` → `brest`), a spacing/diacritic variant
 *   (`George Town` → `georgetown`), an abbreviation expansion (`St. George's` → `Saint George's`)
 *   — rather than a different name that merely shares the folded key?
 *
 *   The comparator is `levenshteinSimilarity`, NOT Jaro-Winkler: JW's common-prefix bonus scores
 *   the required NEGATIVE case (`chanchun` vs `cancun`, 0.925) above real positives
 *   (`saint george s` vs `st georges` expanded, 0.914), so no JW threshold separates them.
 *   Measured on the #1882 census contests, edit similarity separates every case with margin:
 *
 *   - IN: `brest`/`brest` 1.0 · `george town`/`georgetown` 0.909 · `saint george s`/`saint georges`
 *       0.929 · `adamovka`/`adamowka` 0.875
 *   - OUT: `lievin`/`levin` 0.833 (Liévin FR vs Levin NZ — different places with near-identical
 *       names; the panel's `41 Weraroa Road, Levin` row needs this side) · `chanchun`/`cancun` 0.75 ·
 *       `augsburg`/`augusta` 0.375 · `west bay`/`west end` 0.625 · `derry`/`londonderry` 0.455
 *       (Derry/Londonderry is a DUAL NAME, not a variant — its own follow-up on #1882)
 *
 *   An unhandled script (Arabic, Hebrew, CJK — the romanizer covers Cyrillic only) answers NULL,
 *   never "different name": absence of a verdict must not stamp anything (the meaning-of-zero rule).
 *   The #1882 census counted 396 demoted Arabic/Hebrew-primary aliases left unclassified by this.
 */

import { levenshteinSimilarity } from "@mailwoman/match/comparators"

/**
 * Edit-similarity floor for the variant verdict. The measured band: nearest admitted pair 0.875
 * (`adamovka`/`adamowka`), nearest refused pair 0.833 (`lievin`/`levin`).
 */
export const VARIANT_SIMILARITY_MIN = 0.85

/**
 * BGN/PCGN-flavored Cyrillic romanization, folded to the name-key alphabet. Digraph outputs (zh, kh, ts, ch, sh, shch,
 * yu, ya) match the dominant transliteration conventions the gazetteer's Latin aliases actually use; the `w`/`v` and
 * `kh`/`h` style variance between systems is what the edit-similarity threshold absorbs.
 */
const CYRILLIC_TO_LATIN: Record<string, string> = {
	а: "a",
	б: "b",
	в: "v",
	г: "g",
	д: "d",
	е: "e",
	ё: "e",
	ж: "zh",
	з: "z",
	и: "i",
	і: "i",
	й: "i",
	к: "k",
	л: "l",
	м: "m",
	н: "n",
	о: "o",
	п: "p",
	р: "r",
	с: "s",
	т: "t",
	у: "u",
	ў: "u",
	ф: "f",
	х: "kh",
	ц: "ts",
	ч: "ch",
	ш: "sh",
	щ: "shch",
	ъ: "",
	ы: "y",
	ь: "",
	э: "e",
	ю: "yu",
	я: "ya",
	ґ: "g",
	є: "e",
	ї: "i",
}

/**
 * Leading-word abbreviations expanded BEFORE comparison, so `st georges` meets `saint george s` inside the edit
 * threshold. Whole-word only — `st` inside `stanley` never expands.
 */
const NAME_ABBREVIATIONS: ReadonlyArray<[RegExp, string]> = [
	[/\bst\b/g, "saint"],
	[/\bste\b/g, "sainte"],
	[/\bmt\b/g, "mount"],
	[/\bft\b/g, "fort"],
]

/**
 * Expand the whole-word abbreviations above.
 */
export function expandNameAbbreviations(key: string): string {
	let out = key

	for (const [pattern, replacement] of NAME_ABBREVIATIONS) {
		out = out.replaceAll(pattern, replacement)
	}

	return out
}

/**
 * Romanize a folded name key to the a–z0–9/space alphabet. `null` when characters outside the covered scripts remain —
 * an unhandled script is NO VERDICT, not a mismatch.
 */
export function romanizeNameKey(key: string): string | null {
	let out = ""

	for (const ch of key.toLowerCase()) {
		out += CYRILLIC_TO_LATIN[ch] ?? ch
	}

	out = out
		.normalize("NFD")
		.replaceAll(/[̀-ͯ]/g, "")
		.replaceAll(/\s+/g, " ")
		.trim()

	return /^[a-z0-9 ]*$/.test(out) ? out : null
}

/**
 * Edit similarity between a holder's primary name key and one of its alias keys, both romanized and
 * abbreviation-expanded. `null` when either side's script is uncovered.
 */
export function ownNameSimilarity(primaryKey: string, aliasKey: string): number | null {
	const primary = romanizeNameKey(primaryKey)
	const alias = romanizeNameKey(aliasKey)

	if (primary == null || alias == null || !primary || !alias) return null

	return levenshteinSimilarity(expandNameAbbreviations(primary), expandNameAbbreviations(alias))
}

/**
 * The stamp predicate: the alias surface is the holder's own name in another orthography.
 */
export function isOwnNameVariant(primaryKey: string, aliasKey: string): boolean {
	const similarity = ownNameSimilarity(primaryKey, aliasKey)

	return similarity != null && similarity >= VARIANT_SIMILARITY_MIN
}
