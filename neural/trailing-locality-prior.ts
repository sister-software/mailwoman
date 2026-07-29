/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Trailing-locality emission prior — the comma-free "street + trailing city" fix (fork B, after
 *   fork A failed the pre-registered bars 2026-07-25: the broad FST bias is geometrically opposed
 *   to the #1142 street-context gate, because a trailing city sits in exactly the syntactic
 *   position the gate suppresses).
 *
 *   Geometry-first (§0.5: restrict WHERE a prior may fire, then tune magnitude inside it). The
 *   prior fires only when ALL of the following hold:
 *
 *   1. **Trailing span** — the last 1–3 non-empty word-groups (longest-first) match a gazetteer
 *      LOCALITY entry by PRESENCE, not importance (the 220k-FST's importance-zero places —
 *      Sainte-Livrade-sur-Lot — are exactly where fork A's importance-multiplied bias structurally
 *      could not reach; the FST's place COVERAGE is the signal here).
 *   2. **Post-street evidence** — some word-group strictly before the span is a street-type affix
 *      per the street-morphology FST. Bare single-affix streets ("10 Downing Street") are silent:
 *      the affix is inside/at the end of the street, nothing affix-shaped precedes the trailing
 *      token. Also silent: house-number-headed place names ("500 Washington" — no affix anywhere).
 *   3. **Not the street name itself** — if the span's immediate predecessor is itself a street
 *      affix, the span is the street NAME in a prefix-locale ("45 Cours Lafayette") UNLESS the
 *      affix is in suffix position (a non-affix, non-house-number word precedes it: "Downing
 *      Street London" — "Street" follows "Downing" → suffix → "London" is the trailing city).
 *
 *   On fire: positive bias toward `B/I-locality` on the span's pieces (importance-free, one
 *   magnitude) plus a mild street suppression on the same pieces (the fused failure shape is the
 *   city absorbed into an I-street continuation). Composes with the other priors via
 *   {@linkcode addEmissionMatrix} — same shape, same additive semantics.
 *
 *   ⚠ **Known limitation (measured 2026-07-25, the #1143 retest):** the geometry CANNOT separate
 *   "Rue des Lyonnais Paris" (trailing city) from "Avenue Marceau Julien" (person-name street
 *   whose surname is a gazetteer locality) — identical Affix-Name₁-Name₂ syntax, the #1288
 *   open-vocabulary wall from the other side. On the BAN bare-street population the W1 cell
 *   regressed 50/400 bare-street and 60/400 street-housenumber rows (net-negative against its
 *   +21 fused-row win on the big-city comma-free board). The prior therefore stays
 *   **opt-in per call only** — nothing in the pipeline or CLI auto-activates it. Suitable for
 *   callers who know their input register (e.g. comma-free forms over notable-city traffic);
 *   NOT safe as a default-on channel over open-vocabulary street text.
 */

import { groupPiecesIntoWords, type FSTMatcherLike, type FSTPlaceEntryLike, type WordGroup } from "./fst-prior.ts"
import type { TokenLike } from "./query-shape-prior.ts"

/**
 * House-number shape — "45 Cours Lafayette": the number before a prefix affix must not count as street-name evidence.
 */
const HOUSE_NUMBER_RE = /^\d{1,6}[a-z]?$/

/**
 * Admin placetypes that count as a "place match" for the R1 longest-match-wins guard. The span search finds the LONGEST
 * trailing match across these; the prior fires only when that longest match carries a `locality` entry — a region-only
 * longer match ("North Dakota") blocks firing on its 1-token locality suffix ("Dakota"). `postalcode` included so a
 * trailing postcode blocks rather than falls through to a shorter span.
 */
const ADMIN_PLACETYPES: ReadonlySet<string> = new Set([
	"country",
	"region",
	"county",
	"localadmin",
	"locality",
	"dependent_locality",
	"borough",
	"neighbourhood",
	"postalcode",
])

/**
 * Street-name particles (R2) — transparent when finding a span's effective predecessor, so "Rue de Montfaucon" / "Route
 * de Roquelaure" / "Rue de la Chaudière" see the prefix-position AFFIX, not the particle, and correctly read the
 * trailing place-name token as the street NAME (don't fire). Closed list, Romance + Germanic; deliberately NOT
 * locale-gated — a particle that never occurs in a locale's inputs is simply never skipped there.
 */
const STREET_NAME_PARTICLES: ReadonlySet<string> = new Set([
	"de",
	"du",
	"des",
	"la",
	"le",
	"les",
	"del",
	"van",
	"von",
	"der",
	"den",
	"ten",
	"ter",
	"di",
	"da",
])

export interface TrailingLocalityPriorOpts {
	/**
	 * Gazetteer matcher (the admin FST). Span acceptance requires a `locality`-placetype entry.
	 */
	fst: FSTMatcherLike
	/**
	 * Street-morphology matcher — the street-affix signal source.
	 */
	streetMorphology: FSTMatcherLike
	/**
	 * Positive bias magnitude (logits) toward `B/I-locality` on the span. Default 6.0 — the W1 cell, the only sweep
	 * magnitude that cleared all 7 pre-registered bars (2026-07-25 #4): the fused comma-free reading needs ~+6 to lose to
	 * B-locality (the FR fused rows hold out below it).
	 */
	bias?: number
	/**
	 * Negative bias magnitude (logits) toward `B/I-street` on the span. Default 1.5 (the W1 cell).
	 */
	streetPenalty?: number
	/**
	 * Maximum span length in word-groups. Default 3 ("New York", "Sainte-Livrade-sur-Lot" are 1–2).
	 */
	maxSpanGroups?: number
	/**
	 * The classifier's current emission matrix (R3). When provided and the argmax of ANY piece is already `B/I-locality`,
	 * the prior returns a zero matrix — the comma-free bug is locality-MISSING, so a locality-present parse has nothing
	 * to fix and re-firing only re-labels correct rows ("Long Island City, New York"). Absent → the guard is skipped
	 * (measurement harnesses that lack emissions should pass them — this guard carries real collateral weight).
	 */
	emissions?: ReadonlyArray<ReadonlyArray<number>>
}

function isStreetAffix(fst: FSTMatcherLike, token: string): boolean {
	const match = fst.walk([token])

	if (!match?.accepted) return false

	return fst.accepting(match.stateID).some((e) => e.placetype === "street_affix")
}

/**
 * Walk the FST over a token sequence; returns the accepting entries iff the full path is accepted with at least one
 * ADMIN-placetype entry (the R1 "place match" definition), else null.
 */
function matchAdminEntries(fst: FSTMatcherLike, tokens: string[]): FSTPlaceEntryLike[] | null {
	if (!tokens.length) return null

	let current = fst.walk([tokens[0]!])

	if (!current) return null

	for (let i = 1; i < tokens.length; i++) {
		const next = fst.walkFrom(current, tokens[i]!)

		if (!next) return null
		current = next
	}

	if (!current.accepted) return null

	const entries = fst.accepting(current.stateID).filter((e) => ADMIN_PLACETYPES.has(e.placetype))

	return entries.length ? entries : null
}

/**
 * Index of the first non-particle word at or left of `fromWord`, or -1. (R2 particle transparency.)
 */
function effectivePredecessor(words: ReadonlyArray<{ group: WordGroup; idx: number }>, fromWord: number): number {
	for (let i = fromWord; i >= 0; i--) {
		if (!STREET_NAME_PARTICLES.has(words[i]!.group.fstToken)) return i
	}

	return -1
}

/**
 * Build a `[seqLen][numLabels]` bias matrix for the trailing-locality prior. Zero matrix (a no-op under
 * {@linkcode addEmissionMatrix}) unless every geometry gate fires — see the module docstring.
 */
export function buildTrailingLocalityPriors(
	pieces: ReadonlyArray<TokenLike & { piece: string }>,
	labels: ReadonlyArray<string>,
	opts: TrailingLocalityPriorOpts
): number[][] {
	const T = pieces.length
	const L = labels.length
	const bias = opts.bias ?? 6
	const streetPenalty = opts.streetPenalty ?? 1.5
	const maxSpanGroups = opts.maxSpanGroups ?? 3

	const matrix: number[][] = []

	for (let t = 0; t < T; t++) {
		matrix.push(new Array<number>(L).fill(0))
	}

	const bLoc = labels.indexOf("B-locality")
	const iLoc = labels.indexOf("I-locality")

	if (bLoc === -1) return matrix

	// R3 — locality-present ⇒ silent. The bug is locality-MISSING; re-firing on a parse whose argmax
	// already emits locality only re-labels correct rows.
	if (opts.emissions && iLoc !== -1) {
		for (const row of opts.emissions) {
			let best = 0

			for (let c = 1; c < row.length; c++) {
				if (row[c]! > row[best]!) {
					best = c
				}
			}

			if (best === bLoc || best === iLoc) return matrix
		}
	}

	const bStreet = labels.indexOf("B-street")
	const iStreet = labels.indexOf("I-street")

	const wordGroups = groupPiecesIntoWords(pieces)
	// Non-empty groups with their indices into `wordGroups` — span geometry works on these.
	const words: Array<{ group: WordGroup; idx: number }> = []

	for (let i = 0; i < wordGroups.length; i++) {
		const g = wordGroups[i]!

		if (g.fstToken !== "") {
			words.push({ group: g, idx: i })
		}
	}

	if (words.length < 2) return matrix

	// Gate 1 (R1 + R1b) — the LONGEST trailing admin-place match wins; fire only when it carries a
	// locality entry whose presence is REAL: importance > 0, or zero-importance localities with no
	// competing positive-importance region on the same span ("North Dakota" = region 0.69 + two
	// importance-0.00 locality entries → the region reading wins, block; an importance-unknown
	// commune with no region shadow stays fireable — presence over importance).
	let span: { startWord: number; endWord: number } | null = null

	for (let len = Math.min(maxSpanGroups, words.length - 1); len >= 1 && !span; len--) {
		const startWord = words.length - len
		const tokens = words.slice(startWord).map((w) => w.group.fstToken)
		const entries = matchAdminEntries(opts.fst, tokens)

		if (!entries) continue // no admin match at this length — try shorter

		const localityPositive = entries.some((e) => e.placetype === "locality" && e.importance > 0)
		const localityAny = entries.some((e) => e.placetype === "locality")
		const regionPositive = entries.some((e) => e.placetype === "region" && e.importance > 0)

		if (localityPositive || (localityAny && !regionPositive)) {
			span = { startWord, endWord: words.length - 1 }
		}
		// else: a non-locality admin match at this length BLOCKS shorter spans (R1) — stop.
		break
	}

	if (!span) return matrix

	// R4 — comma-separated ⇒ silent. The bug is comma-FREE: a comma at the span's immediate left
	// boundary means the model's home turf (comma'd twins parse correctly at baseline); firing
	// there is pure downside (the golden collateral class: "…Rd, Vermont"). Scans from the previous
	// word's LAST piece (a comma fused into the word-final piece — "▁Street," — is the common
	// SentencePiece shape) through the gap pieces up to the span's first piece.
	const spanFirstPiece = words[span.startWord]!.group.pieceIndices[0]!
	const prevPieces = words[span.startWord - 1]!.group.pieceIndices

	for (let pi = prevPieces.at(-1)!; pi < spanFirstPiece; pi++) {
		if (pieces[pi]!.piece.includes(",")) return matrix
	}

	// Gate 2 — post-street evidence: some word-group strictly before the span is a street affix.
	let affixBefore = -1

	for (let i = 0; i < span.startWord; i++) {
		if (isStreetAffix(opts.streetMorphology, words[i]!.group.fstToken)) {
			affixBefore = i
		}
	}

	if (affixBefore === -1) return matrix

	// Gate 3 (R2) — the span must not BE the street name. Find the effective (particle-transparent)
	// predecessor; if it's an affix, the affix must be in SUFFIX position (a non-affix,
	// non-house-number, non-particle word before it), else the span is the street NAME of a
	// prefix-locale street ("45 Cours Lafayette", "8 Rue de Montfaucon" — don't fire).
	const predWordIdx = effectivePredecessor(words, span.startWord - 1)

	if (predWordIdx >= 0 && isStreetAffix(opts.streetMorphology, words[predWordIdx]!.group.fstToken)) {
		let suffixPosition = false

		for (let i = 0; i < predWordIdx; i++) {
			const token = words[i]!.group.fstToken

			if (
				!isStreetAffix(opts.streetMorphology, token) &&
				!HOUSE_NUMBER_RE.test(token) &&
				!STREET_NAME_PARTICLES.has(token)
			) {
				suffixPosition = true
				break
			}
		}

		if (!suffixPosition) return matrix
	}

	// Fire — positive B/I-locality on the span's pieces, mild street suppression on the same.
	const spanPieces: number[] = []

	for (let w = span.startWord; w <= span.endWord; w++) {
		spanPieces.push(...words[w]!.group.pieceIndices)
	}

	for (let k = 0; k < spanPieces.length; k++) {
		const pi = spanPieces[k]!
		const locCol = k === 0 ? bLoc : iLoc !== -1 ? iLoc : bLoc
		matrix[pi]![locCol] = Math.max(matrix[pi]![locCol]!, bias)

		if (streetPenalty > 0) {
			const stCol = k === 0 ? bStreet : iStreet !== -1 ? iStreet : bStreet

			if (stCol !== -1) {
				matrix[pi]![stCol] = Math.min(matrix[pi]![stCol]!, -streetPenalty)
			}
		}
	}

	return matrix
}
