/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Person-name parsing — split a full name into components for the matcher to canonicalize and
 *   compare.
 *
 *   A rule-based positional parser, the portable recipe from `python-nameparser`: split on a comma to
 *   detect `Last, First` inversion, then classify tokens by position against configurable title /
 *   suffix / particle lists. We deliberately store the surname **particle** (`van`, `de la`, `von`)
 *   separately from the bare surname (the `theiconic/name-parser` pattern) so the matcher can
 *   compare `Vega` independent of `de la` — sources that drop or vary the particle still match.
 *
 *   Scope + honesty (per the name-canonicalization research pass):
 *
 *   - Western / romanized names only. Cultural given-family ORDER variation (East-Asian family-first)
 *       and transliteration are not handled here — a documented follow-up.
 *   - Nickname → canonical-root mapping is intentionally NOT done at parse time: it is lossy and
 *       gendered (Bobbie → Robert _or_ Roberta), so equivalence belongs in the matcher as a fuzzy
 *       agreement level, not a destructive rewrite. We only _extract_ a parenthetical/quoted
 *       nickname.
 *   - A CRF parser (probablepeople) is the gold-standard reference but too heavy to port; this
 *       positional parser covers the documented hard cases (inversion, particles, generational +
 *       professional suffixes) without a model.
 */

/** A parsed person name. All fields optional — the parser fills what it can identify. */
export interface PersonName {
	/** Title / salutation that preceded the name (`Dr`, `Mr`, `Capt`). */
	prefix?: string
	/** First / given name. */
	given?: string
	/** Middle name(s) or initial. */
	middle?: string
	/** Surname, _without_ any particle (`Vega`, not `de la Vega`). */
	family?: string
	/** Surname particle, stored separately (`de la`, `van der`, `von`). */
	familyParticle?: string
	/** Generational or professional suffix (`Jr`, `III`, `PhD`, `MD`). */
	suffix?: string
	/** A parenthetical or quoted nickname (`"Gob"` in `George "Gob" Bluth`). */
	nickname?: string
}

/** Titles / salutations that lead a name. Matched case-insensitively, trailing `.` ignored. */
const TITLES = new Set([
	"airman",
	"br",
	"brig",
	"brigadier",
	"capt",
	"captain",
	"cmdr",
	"col",
	"colonel",
	"commander",
	"commissioner",
	"cpl",
	"cpt",
	"dep",
	"deputy",
	"doctor",
	"dr",
	"father",
	"fr",
	"gen",
	"general",
	"hon",
	"honorable",
	"judge",
	"lt",
	"ltcol",
	"ltgen",
	"maj",
	"major",
	"master",
	"miss",
	"mr",
	"mrs",
	"ms",
	"mx",
	"pastor",
	"pfc",
	"pres",
	"president",
	"private",
	"prof",
	"professor",
	"pvt",
	"rabbi",
	"rep",
	"representative",
	"rev",
	"reverend",
	"sen",
	"senator",
	"sgt",
	"sir",
	"sister",
])

/** Generational + professional suffixes that trail a name. */
const SUFFIXES = new Set([
	// generational
	"jr",
	"sr",
	"i",
	"ii",
	"iii",
	"iv",
	"v",
	"vi",
	"vii",
	"viii",
	// professional / honorific
	"phd",
	"md",
	"do",
	"dds",
	"dmd",
	"dvm",
	"esq",
	"esquire",
	"jd",
	"llm",
	"cpa",
	"rn",
	"lpn",
	"pa",
	"pe",
	"od",
	"dc",
	"dpm",
	"psyd",
	"edd",
	"mba",
	"mfa",
	"msw",
	"pharmd",
])

/**
 * Surname particles. Consecutive particles fold together (`de` + `la` → `de la`), and the next
 * non-particle token begins the bare surname.
 */
const PARTICLES = new Set([
	"al",
	"bin",
	"da",
	"das",
	"de",
	"del",
	"della",
	"den",
	"der",
	"di",
	"do",
	"dos",
	"du",
	"el",
	"ibn",
	"la",
	"le",
	"lo",
	"mac",
	"mc",
	"san",
	"santa",
	"st",
	"ter",
	"van",
	"vande",
	"vanden",
	"vander",
	"vere",
	"von",
	"zu",
	"zur",
])

const isPresent = (s: string | undefined | null): s is string => typeof s === "string" && s.trim().length > 0
const norm = (token: string): string => token.replace(/\.$/, "").toLowerCase()
const countChar = (s: string, c: string): number => s.split(c).length - 1

/**
 * Parse a full name into components. Returns `null` for empty input. Best-effort and non-throwing —
 * ambiguous input degrades gracefully rather than erroring.
 */
export function parsePersonName(input: string | null | undefined): PersonName | null {
	if (!isPresent(input)) return null

	const result: PersonName = {}

	// 1. Extract a parenthetical "(Jim)" or quoted "Jim" nickname, then strip it out.
	let working = input
		.replace(/\s*\(([^)]+)\)\s*/g, (_m, n: string) => {
			if (!result.nickname) result.nickname = n.trim()
			return " "
		})
		.replace(/\s*"([^"]+)"\s*/g, (_m, n: string) => {
			if (!result.nickname) result.nickname = n.trim()
			return " "
		})
		.replace(/\s+/g, " ")
		.trim()

	// 2. Resolve a single comma: "Last, First" inversion, unless the tail is a known suffix
	//    ("John Smith, Jr."), in which case keep order and treat the tail as a suffix.
	if (countChar(working, ",") === 1) {
		const [head, tail] = working.split(",").map((p) => p.trim())
		if (tail && tail.split(/\s+/).every((t) => SUFFIXES.has(norm(t)))) {
			result.suffix = tail
			working = head!
		} else if (head && tail) {
			working = `${tail} ${head}`
		}
	}

	const tokens = working.split(/\s+/).filter(Boolean)
	if (tokens.length === 0) return Object.keys(result).length ? result : null

	// 3. Leading titles → prefix.
	const prefixParts: string[] = []
	while (tokens.length > 1 && TITLES.has(norm(tokens[0]!))) {
		prefixParts.push(tokens.shift()!)
	}
	if (prefixParts.length) result.prefix = prefixParts.join(" ")

	// 4. Trailing suffixes → suffix (a single name token must remain).
	const suffixParts: string[] = []
	while (tokens.length > 1 && SUFFIXES.has(norm(tokens[tokens.length - 1]!))) {
		suffixParts.unshift(tokens.pop()!)
	}
	if (suffixParts.length) {
		result.suffix = isPresent(result.suffix) ? `${suffixParts.join(" ")} ${result.suffix}` : suffixParts.join(" ")
	}

	if (tokens.length === 0) return result

	// 5. Locate the surname particle run; everything from it onward is the (particled) surname.
	let particleStart = -1
	for (let i = 0; i < tokens.length; i++) {
		// A particle only starts a surname if a bare-surname token follows it.
		if (PARTICLES.has(norm(tokens[i]!)) && i < tokens.length - 1) {
			particleStart = i
			break
		}
	}

	if (particleStart >= 0) {
		let i = particleStart
		const particleParts: string[] = []
		while (i < tokens.length - 1 && PARTICLES.has(norm(tokens[i]!))) {
			particleParts.push(tokens[i]!)
			i++
		}
		result.familyParticle = particleParts.join(" ")
		result.family = tokens.slice(i).join(" ")
		const before = tokens.slice(0, particleStart)
		if (before.length) result.given = before[0]
		if (before.length > 1) result.middle = before.slice(1).join(" ")
		return result
	}

	// 6. No particle: last token is the surname, first is given, the rest is middle.
	if (tokens.length === 1) {
		result.given = tokens[0]
		return result
	}
	result.given = tokens[0]
	result.family = tokens[tokens.length - 1]
	if (tokens.length > 2) result.middle = tokens.slice(1, -1).join(" ")

	return result
}
