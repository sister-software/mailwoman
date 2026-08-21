/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   @file Surface-form primitives for the sub-venue lexicon: the normalizer every phrase passes
 *   through, the phrase → record index built over the surfaces accumulated so far, and the operator
 *   that decides whether a feature's name contains a known designator.
 *
 *   The two matching rules here are script-conditional, and both narrowings are load-bearing — see
 *   {@link NON_SPACING_SCRIPT} and {@link nameContainsSurfaces}.
 */

import type { SubVenueSurface } from "./table.ts"

/**
 * Scripts whose case is meaningful to fold. Everything else is left as written — see {@link SubVenueSurface.phrase}.
 */
const CASE_FOLDING_SCRIPT = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\d\s\p{P}]+$/u

/**
 * Scripts written without spaces between words, where a token split cannot find a designator and a SUBSTRING test is
 * the correct operator. Han, Hiragana, Katakana; Hangul is excluded because Korean does space its words.
 *
 * The Germanic-compound argument that keeps {@link nameContainsSurfaces} token-bounded for Latin script does not
 * transfer here — there is no `-gate`/`-hall` street-name suffix class in Japanese, and `第1ターミナル` is unreachable by any
 * token split. Measured on the Japan extract: see the harvest counts in `corpus/data/PROVENANCE.md`.
 */
const NON_SPACING_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/**
 * Normalize a surface for the table: trim, collapse internal whitespace, and lowercase ONLY when the string is entirely
 * in a bicameral script. `ターミナルビル` and `航站楼` pass through untouched; `Flughafenterminal` folds.
 */
export function normalizeSurface(text: string): string {
	const trimmed = text.trim().replaceAll(/\s+/gu, " ")

	return CASE_FOLDING_SCRIPT.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

/**
 * A phrase → record index, keyed on the normalized phrase. Built by {@link buildSurfaceIndex} from the surfaces present
 * before the harvest runs, and the reason a matched phrase can be attributed to the record it actually names.
 */
export type SurfaceIndex = ReadonlyMap<string, { recordID: string; recordKind: "designator" | "modifier" }>

/**
 * Index the surfaces accumulated so far by phrase. First writer wins, so a seed record beats a Wikidata alias that
 * happens to collide — `terminal` stays the `terminal` designator even though it is also an Italian alias for it.
 */
export function buildSurfaceIndex(surfaces: readonly SubVenueSurface[]): SurfaceIndex {
	const index = new Map<string, { recordID: string; recordKind: "designator" | "modifier" }>()

	for (const surface of surfaces) {
		if (index.has(surface.phrase)) continue
		index.set(surface.phrase, { recordID: surface.recordID, recordKind: surface.recordKind })
	}

	return index
}

/**
 * Every known phrase found in `name`, as whole-token runs for spacing scripts and as substrings for non-spacing ones.
 *
 * Token-boundary matching for Latin script, not substring: `Nordterminal` is a real German compound in which `terminal`
 * is a suffix, and a substring test would also fire on `Terminalstraße`. The compound case is a genuine miss and it is
 * the right miss — admitting suffix matches would fire on every `-hall`/`-gate` compound in Germanic and Nordic street
 * naming, which is exactly the confound class `Briggate`/`Kirkgate` represents.
 *
 * For Han/Kana names that rule finds nothing at all, because the script has no word boundaries: `第1ターミナル` splits into
 * one token that matches no surface. There the LONGEST known substring is the correct operator, and the compound
 * objection does not transfer — Japanese has no `-gate` street-name suffix class.
 */
export function nameContainsSurfaces(name: string, index: SurfaceIndex): string[] {
	const normalized = normalizeSurface(name)
	const hits = new Set<string>()

	for (const token of normalized.split(/[\s,()/]+/u)) {
		const stripped = token.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")

		if (stripped && index.has(stripped)) {
			hits.add(stripped)
		}
	}

	if (NON_SPACING_SCRIPT.test(normalized)) {
		for (const [phrase] of index) {
			if (NON_SPACING_SCRIPT.test(phrase) && normalized.includes(phrase)) {
				hits.add(phrase)
			}
		}
	}

	return [...hits]
}
