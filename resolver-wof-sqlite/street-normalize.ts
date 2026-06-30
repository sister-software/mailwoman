/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   THE street normalizer for the address-point tier (#476). One function, used by BOTH the shard
 *   builder (`scripts/build-address-point-shard.ts`) and the lookup tier (`address-point.ts`) —
 *   never two implementations (the PLACETYPE_ORDER lesson: parallel copies silently corrupt).
 *
 *   Normalization contract (deliberately aggressive — both sides apply the same function, so
 *   collisions only need to be _consistent_, not linguistically perfect):
 *
 *   1. Lowercase, NFKD-fold diacritics, collapse whitespace, strip punctuation (periods, commas,
 *        apostrophes).
 *   2. Expand USPS directional abbreviations at the FIRST and LAST token position (`n` → `north`, `se` →
 *        `southeast`) — Overture sources abbreviate inconsistently.
 *   3. Canonicalize a trailing USPS street-type token via the codex suffix table to its canonical full
 *        form (`st`/`str`/`street` → `street`).
 *
 *   Numbered streets are left as digits (`5th` stays `5th`); a SPELLED ordinal before a street suffix
 *   folds to its digit form (`tenth street` → `10th street`, #723) so the grid-city ordinal
 *   cross-streets the source data spells with digits become reachable.
 */

import { AbbreviationToDirectional, US_STREET_SUFFIX_LOOKUP } from "@mailwoman/codex/us"

/**
 * Spelled ordinal street names → their digit-ordinal form ("tenth" → "10th"), applied ONLY when a street-type suffix
 * follows (#723 admin-tail) — so the ordinal cross-streets common in grid cities ("Tenth Street", "Fifth Avenue") match
 * the shards' digit keys, WITHOUT rewriting ordinal-WORD names where the next token is not a suffix ("First National
 * Bank Rd" stays "first national …"). Digit-source shards are unaffected (a digit token isn't in this map), so the
 * existing keys need no rebuild; a future rebuild folds any spelled-source key the same way (the one-function
 * discipline).
 */
const SPELLED_ORDINAL_TO_DIGIT = new Map<string, string>([
	["first", "1st"],
	["second", "2nd"],
	["third", "3rd"],
	["fourth", "4th"],
	["fifth", "5th"],
	["sixth", "6th"],
	["seventh", "7th"],
	["eighth", "8th"],
	["ninth", "9th"],
	["tenth", "10th"],
	["eleventh", "11th"],
	["twelfth", "12th"],
	["thirteenth", "13th"],
	["fourteenth", "14th"],
	["fifteenth", "15th"],
	["sixteenth", "16th"],
	["seventeenth", "17th"],
	["eighteenth", "18th"],
	["nineteenth", "19th"],
	["twentieth", "20th"],
	["thirtieth", "30th"],
	["fortieth", "40th"],
	["fiftieth", "50th"],
	["sixtieth", "60th"],
	["seventieth", "70th"],
	["eightieth", "80th"],
	["ninetieth", "90th"],
	["hundredth", "100th"],
])

/** Lowercase + diacritic-fold + punctuation strip + whitespace collapse. */
function fold(input: string): string {
	return input
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[.,'’]/g, "")
		.replace(/\s+/g, " ")
		.trim()
}

/**
 * Normalize a street name for address-point keying. Same function at build time and lookup time — see module docstring
 * for the contract.
 */
export function normalizeStreetForKey(street: string): string {
	const tokens = fold(street).split(" ")

	if (tokens.length === 0) return ""

	// Spelled-ordinal street names → digit form when a street suffix follows ("Tenth Street" →
	// "10th street", #723). Gated on the next token being a suffix so ordinal-WORD names are untouched.
	for (let i = 0; i < tokens.length - 1; i++) {
		const digit = SPELLED_ORDINAL_TO_DIGIT.get(tokens[i]!)

		if (digit && US_STREET_SUFFIX_LOOKUP.has(tokens[i + 1]!)) tokens[i] = digit
	}

	// Directional expansion at the edges only ("N Main St" / "Main St N" — never interior
	// tokens, where "W" may be an initial in a person-named street). The codex expands
	// compounds to two words ("SE" → "SOUTH EAST"); we key on the spaceless form
	// ("southeast"), and also merge an already-written two-token pair ("South East …").
	const edgeDirectional = (raw: string) =>
		AbbreviationToDirectional.get(raw.toUpperCase())?.toLowerCase().replace(" ", "")
	const mergePair = (a?: string, b?: string) =>
		a && b && /^(north|south)$/.test(a) && /^(east|west)$/.test(b) ? a + b : undefined

	const leadPair = mergePair(tokens[0], tokens[1])

	if (leadPair && tokens.length > 2) tokens.splice(0, 2, leadPair)
	const first = edgeDirectional(tokens[0]!)

	if (first && tokens.length > 1) tokens[0] = first

	const tailPair = mergePair(tokens[tokens.length - 2], tokens[tokens.length - 1])

	if (tailPair && tokens.length > 3) tokens.splice(tokens.length - 2, 2, tailPair)

	if (tokens.length > 2) {
		const last = edgeDirectional(tokens[tokens.length - 1]!)

		if (last) tokens[tokens.length - 1] = last
	}

	// Street-type canonicalization via the codex table (lowercase keys, UPPER canonical
	// values). The suffix is usually the last token, but sits second-to-last when a trailing
	// directional follows ("Main St N") — check both positions, canonicalize the first hit.
	for (const at of [tokens.length - 1, tokens.length - 2]) {
		if (at < 1) continue // never canonicalize the only/first token ("Street Road" exists)
		const canonical = US_STREET_SUFFIX_LOOKUP.get(tokens[at]!)

		if (canonical) {
			tokens[at] = canonical.toLowerCase()
			break
		}
	}

	return tokens.join(" ")
}

/**
 * Street-name locale for the address-point key. The US path is the full USPS pipeline ({@link normalizeStreetForKey});
 * the international paths fold + apply a SMALL, consistent per-locale type-token canonicalization. Same discipline as
 * the US normalizer: build side and probe side call the identical function, so the key only needs to be CONSISTENT, not
 * linguistically perfect — a folded "rue du chevaleret" keys the same on both sides whether or not we reorder the
 * article, so no salient-token / multi-key index is built yet (deferred until probing shows the normalizer can't absorb
 * the false-negatives).
 */
export type StreetLocale = "us" | "fr" | "de" | "nl"

/**
 * French street-type abbreviations → canonical full form, applied per token after {@link fold}. French address types
 * LEAD the name ("Av. de…", "Bd …", "Pl. …") and "St"/"Ste" abbreviate Saint/Sainte inside names ("Rue St-Honoré" →
 * "rue saint honore"). fold() has already stripped the trailing period, so the keys are point-free ("av", "bd").
 */
const FR_STREET_ABBREV = new Map<string, string>([
	["av", "avenue"],
	["ave", "avenue"],
	["bd", "boulevard"],
	["bld", "boulevard"],
	["bvd", "boulevard"],
	["boul", "boulevard"],
	["pl", "place"],
	["imp", "impasse"],
	["all", "allee"],
	["ch", "chemin"],
	["che", "chemin"],
	["sq", "square"],
	["pas", "passage"],
	["fg", "faubourg"],
	["fbg", "faubourg"],
	["rte", "route"],
	["st", "saint"],
	["ste", "sainte"],
	["sts", "saints"],
])

/**
 * Normalize a street name for the address-point key in a non-US locale. Same function build-side and probe-side (the
 * one-function discipline). US delegates to {@link normalizeStreetForKey}.
 *
 * - **fr** — fold + expand leading type abbreviations and Saint/Sainte (token map).
 * - **de** — fold + ß→ss + canonicalize the GLUED `-str(.)` suffix to `-strasse` ("Lindenstr." → "lindenstrasse",
 *   "Lindenstraße" → "lindenstrasse"); an already-full "-strasse" is left intact.
 * - **nl** — fold + canonicalize the glued `-str` suffix to `-straat` ("Kerkstr." → "kerkstraat").
 */
export function normalizeStreetForKeyLocale(street: string, locale: StreetLocale): string {
	if (locale === "us") return normalizeStreetForKey(street)

	// Hyphen → space so a compound name keys the same whether the source or the query writes the
	// hyphen ("Champs-Élysées", "St-Honoré") or a space — both sides fold identically, so this is pure
	// robustness. It also splits a hyphenated abbreviation ("St-Honoré" → "st honore") into tokens the
	// per-locale type/Saint map can see.
	const tokens = fold(street).replace(/ß/g, "ss").replace(/-/g, " ").split(/\s+/).filter(Boolean)

	if (tokens.length === 0) return ""

	switch (locale) {
		case "fr":
			for (let i = 0; i < tokens.length; i++) tokens[i] = FR_STREET_ABBREV.get(tokens[i]!) ?? tokens[i]!
			break
		case "de":
			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i]!

				if (t.endsWith("str") && !t.endsWith("strasse")) tokens[i] = t.replace(/str$/, "strasse")
			}
			break
		case "nl":
			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i]!

				if (t.endsWith("str") && !t.endsWith("straat")) tokens[i] = t.replace(/str$/, "straat")
			}
			break
	}

	return tokens.join(" ")
}

/** Normalize a locality name for address-point keying (fold only — no street semantics). */
export function normalizeLocalityForKey(locality: string): string {
	return fold(locality)
}

/**
 * Strip a locality QUALIFIER for a query-side fallback — when an OA locality's exact normalized name misses the
 * gazetteer's canonical name, retry with the qualifier removed. OA address data carries disambiguating qualifiers the
 * gazetteer's canonical name omits: Austrian `Kraubath/Mur` and `Hart b.Graz` → `Hart`; Swiss `Lenk im Simmental` →
 * `Lenk`, `Roche VD` → `Roche`; Danish `Odense S`, `Hurup Thy`. A FALLBACK ONLY — the exact name is tried first, and
 * the region-bbox disambiguation resolves any base-name ambiguity downstream. The candidate table is unchanged (this is
 * purely query-side); feed the result back through {@link normalizeLocalityForKey}. Returns "" when nothing was stripped
 * (no point re-probing the identical key).
 *
 * Measured (`scripts/eval/candidate-recall.ts --strip-fallback`, EU OA holdouts): recovers AT 74.1→88.2% (+14.1pp), DK
 * 91.5→96.2%, CH 90.4→92.6%; +1.3pp overall (diluted by the already-100% locales). Conservative by design — only the
 * qualifier forms above; FI/PT/SI misses are untouched.
 */
export function stripLocalityQualifier(locality: string): string {
	let s = locality.trim()

	if (s.includes("/")) s = s.split("/")[0]!.trim() // "Kraubath/Mur", "St.Kanzian/Klopeiner See"
	s = s.replace(/\s+[a-zà-ÿ]\.\s*\S.*$/iu, "") // abbreviated " b.Graz" / " o.Bleiburg" / " a.d. …"
	s = s.replace(/\s+(im|an der|ob|bei|in der|unter|vor)\s+\S.*$/iu, "") // " im Simmental", " bei Graz"
	s = s.replace(/\s+(S|N|E|W|V|Ø|Sø|Fyn|Thy|Sjælland|Jylland|[A-ZÅÄÖ]{2})$/u, "") // " S", " VD", " Thy"
	s = s.trim()

	return s === locality.trim() ? "" : s
}

/**
 * Fold numbered-route designators to a canonical key, applied AFTER {@link normalizeStreetForKey}. Sources disagree
 * systematically on how they spell a route: TIGER says `State Rte 100` / `US Hwy 5` where E911/Overture say `VT ROUTE
 * 100` / `US ROUTE 5` — the dominant street-name miss class in the #483 interpolation eval (rural addresses live on
 * routes). `us <designator> N…` folds to `us route N…`; `state <designator> N…` and `<2-letter-prefix> <designator> N…`
 * (the state abbreviation form) fold to `state route N…`. Only digit-leading route numbers fold — `State Street` and
 * friends never match.
 *
 * Used by BOTH the segment-shard builder (`scripts/build-interpolation-shard.ts`) and the interpolation lookup — same
 * one-function discipline as {@link normalizeStreetForKey}. The address-point tier (#476) does NOT apply it yet:
 * adopting it there requires a shard rebuild (noted on #483).
 *
 * A same-numbered US and state route stay DISTINCT keys (`us route 5` vs `state route 5`); only the BARE `route N` form
 * is ambiguous (designator unknown) and it stays unfolded — a bare-route query therefore misses rather than guessing a
 * designator.
 */
export function canonicalizeRouteKey(streetNorm: string): string {
	const match = /^(us|state|[a-z]{2}) (?:route|rte|rt|highway|hwy) (\d.*)$/.exec(streetNorm)

	if (!match) return streetNorm

	return `${match[1] === "us" ? "us" : "state"} route ${match[2]}`
}
