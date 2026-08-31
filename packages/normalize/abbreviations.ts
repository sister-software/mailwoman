/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Abbreviation expansion — a small bounded dictionary per locale: en-US street suffixes +
 *   directional prefixes, fr-FR and es-* street types, plus a locale-UNKNOWN set for the geocode path,
 *   which has to expand before the parse that would establish the locale. Others added as needed.
 *
 *   This is the INVERSE of the corpus synthesis pass (which produces `Ave` from `Avenue` for
 *   augmentation). Both sides should eventually share dictionaries; for v1 this dict is duplicated
 *   intentionally — refactoring sharing is a separate task.
 */

import type { SpanRange } from "#types"

export interface AbbreviationEntry {
	from: string // short form (case-insensitive match)
	to: string // canonical long form
}

const EN_US_DICT: ReadonlyArray<AbbreviationEntry> = [
	// Directional prefixes / suffixes
	{ from: "N", to: "North" },
	{ from: "S", to: "South" },
	{ from: "E", to: "East" },
	{ from: "W", to: "West" },
	{ from: "NE", to: "Northeast" },
	{ from: "NW", to: "Northwest" },
	{ from: "SE", to: "Southeast" },
	{ from: "SW", to: "Southwest" },
	// Street suffixes
	{ from: "St", to: "Street" },
	{ from: "Ave", to: "Avenue" },
	{ from: "Blvd", to: "Boulevard" },
	{ from: "Rd", to: "Road" },
	{ from: "Dr", to: "Drive" },
	{ from: "Ct", to: "Court" },
	{ from: "Ln", to: "Lane" },
	{ from: "Pl", to: "Place" },
	{ from: "Pkwy", to: "Parkway" },
	{ from: "Hwy", to: "Highway" },
	{ from: "Sq", to: "Square" },
	{ from: "Ter", to: "Terrace" },
]

const FR_FR_DICT: ReadonlyArray<AbbreviationEntry> = [
	{ from: "R", to: "Rue" },
	{ from: "Bd", to: "Boulevard" },
	{ from: "Av", to: "Avenue" },
	{ from: "Bvd", to: "Boulevard" },
	{ from: "Pl", to: "Place" },
	{ from: "Imp", to: "Impasse" },
	{ from: "Sq", to: "Square" },
]

const ES_ES_DICT: ReadonlyArray<AbbreviationEntry> = [
	// Spanish writes Avenida short as `Av.`, `Avda.` or `Avd.`. English never abbreviates it `Av` (it
	// uses `Ave`), so there is no en collision — but FRENCH does, and there it means Avenue. That
	// collision is why this table has to exist rather than the entry being folded into a shared set:
	// the same three letters resolve to different words, and only the locale can decide which.
	{ from: "Av", to: "Avenida" },
	{ from: "Avda", to: "Avenida" },
	{ from: "Avd", to: "Avenida" },
]

/**
 * #1002: the locale-UNKNOWN expansion set — the entries safe to apply when the input's locale hasn't been established
 * yet (the geocode path expands BEFORE the parse, which is what determines the locale). Safe = multi-char,
 * collision-free across the locale dictionaries, and never a plausible standalone token in the other locale (FR
 * `Bd`/`Bvd`/`Imp` have no EN reading). Deliberately EXCLUDED: the FR single letters (`R` → Rue would fire on
 * Washington DC's literal "R St") and the EN suffixes (`St`, `Ave`, `Dr`, … — the model is trained-robust on those, and
 * `St`/`Dr` are ambiguous with Saint/Doctor).
 *
 * `Av` VIOLATES that criterion and is here anyway — a tracked defect, not an oversight. It was admitted on the claim
 * that it "reads Avenue in both", which is true of en/fr and false of es/pt, where it is Avenida. So Spanish input
 * through the geocode path acquires an ENGLISH street type: the 2026-08-05 gauntlet batch caught "Av. Los Meros" →
 * "Avenue Los Meros" and "Av. Aurelio Ortega" → "Avenue Aurelio Ortega", and both rows
 * (`pr-op3-place-at-the-sea-ponce`, `mx-op3-san-miguel-canada-zapopan`) had to leave `street` unasserted because of it.
 * Dropping the entry is NOT a table edit: `fr-op3-halles-market-bonneuil` is a passing row that asserts street "Avenue
 * de la Convention" and an `address_point` tier, so it pins the current behaviour and a removal has to be measured on a
 * resolver-gauntlet run. The real repair is upstream — the geocode path hardcodes `locale: "und"` because Stage 1
 * precedes the parse, and `@mailwoman/locale-gate` cannot presently detect Spanish (it scores script class + known
 * postcode formats, and a 5-digit ES/MX code is indistinguishable from a US ZIP).
 */
const LOCALE_UNKNOWN_DICT: ReadonlyArray<AbbreviationEntry> = [
	{ from: "Bd", to: "Boulevard" },
	{ from: "Bvd", to: "Boulevard" },
	{ from: "Boul", to: "Boulevard" },
	{ from: "Av", to: "Avenue" },
	{ from: "Imp", to: "Impasse" },
]

function getDictionary(locale: string | undefined): ReadonlyArray<AbbreviationEntry> {
	const lc = (locale ?? "en-US").toLowerCase()

	// BCP-47 "und" (undetermined) — the caller knows it does NOT know the locale yet (the geocode path
	// expands before the parse). Only the collision-free multi-locale set applies; `undefined` keeps its
	// historical en-US default.
	if (lc === "und") return LOCALE_UNKNOWN_DICT

	if (lc.startsWith("fr")) return FR_FR_DICT

	// Every `es-*` region: es-ES, es-MX, es-AR, … all abbreviate Avenida the same way. Before this
	// existed they fell through to en-US, whose table has no `Av` entry, so `Av.` simply survived — the
	// visible symptom was "nothing happens", which is why the collision only surfaced on the `und` path.
	if (lc.startsWith("es")) return ES_ES_DICT

	return EN_US_DICT
}

/**
 * The per-locale abbreviation table (short↔long), exposed so consumers can reuse the SAME data instead of duplicating
 * it. The metamorphic gauntlet inverts this table to generate expanded→abbreviated perturbations (`Avenue`→`Ave`); the
 * "no required trivia" rule means that data lives in exactly one place — here.
 */
export function abbreviationDictionary(locale?: string): ReadonlyArray<AbbreviationEntry> {
	return getDictionary(locale)
}

export interface AbbreviationResult {
	text: string
	map: number[]
	expansions: Array<{ from: string; to: string; at: SpanRange }>
}

/**
 * Expand known abbreviations. Walks the input token-by-token (whitespace-delimited) and rewrites matching tokens to
 * their canonical long form. The output map points every char of the expanded form to its position in the original
 * short form (first char of input token).
 *
 * Case rules: match case-insensitively. Output form preserves the dictionary's canonical casing (`St` → `Street`, `st`
 * → `Street`, `ST` → `Street`).
 */
export function expandAbbreviations(input: string, locale?: string): AbbreviationResult {
	const dict = getDictionary(locale)
	const lookup = new Map<string, string>()

	for (const entry of dict) {
		lookup.set(entry.from.toLowerCase(), entry.to)
	}

	const out: string[] = []
	const map: number[] = []
	const expansions: Array<{ from: string; to: string; at: SpanRange }> = []

	let i = 0

	while (i < input.length) {
		const ch = input[i]!
		// Walk to end of token (non-whitespace, non-punctuation). Unicode-letter-aware so
		// "République" stays one token instead of fragmenting on 'é'.
		const isTokenChar = (c: string) => /[\p{L}\p{N}'_-]/u.test(c)

		if (!isTokenChar(ch)) {
			out.push(ch)
			map.push(i)
			i += 1

			continue
		}

		const start = i

		while (i < input.length && isTokenChar(input[i]!)) {
			i += 1
		}

		const token = input.slice(start, i)
		const tokenWithTrailingDot = i < input.length && input[i] === "." ? `${token}.` : token
		const lookupKey = token.replace(/\.$/, "").toLowerCase()
		const expansion = lookup.get(lookupKey)

		if (!expansion) {
			for (let k = 0; k < token.length; k++) {
				out.push(token[k]!)
				map.push(start + k)
			}

			continue
		}

		// Emit expansion; map every char back to start of source token.
		for (let k = 0; k < expansion.length; k++) {
			out.push(expansion[k]!)
			map.push(start + Math.min(k, token.length - 1))
		}

		expansions.push({
			from: tokenWithTrailingDot,
			to: expansion,
			at: { start, end: i, body: token },
		})

		// Skip the trailing period if we consumed an abbreviation with one (e.g. "St." → "Street").
		if (i < input.length && input[i] === ".") {
			i += 1
		}
	}

	return { text: out.join(""), map, expansions }
}
