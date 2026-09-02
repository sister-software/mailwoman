/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Soft-prior emission biases derived from the FST gazetteer. When the FST finds that a token
 *   sequence matches a known place name (e.g., "New York" → locality + region), this module
 *   produces additive biases that nudge the Viterbi decoder toward the matching BIO labels.
 *
 *   Composes with the QueryShape prior via addEmissionMatrix — same integration point, same additive
 *   semantics.
 *
 *   SentencePiece ↔ FST bridge: SentencePiece pieces are grouped into whitespace words (by the ▁
 *   sentinel), normalized through the same pipeline as FST edges (NFKC, lowercase, strip
 *   non-alnum), and walked through the FST as contiguous subpaths.
 *
 *   Uses structural typing for the FST input so this module has zero dependencies on
 *   `@mailwoman/resolver-wof-sqlite` — consumers pass an FSTMatcher instance, but this file only
 *   consumes the shape.
 */

import { emptyPriorMatrix, labelColumnIndex } from "#prior-matrix"
import type { TokenLike } from "#query-shape-prior"

/**
 * Confidence scaling by matched-token count. A one- or two-token FST hit is far likelier to be coincidental than a
 * three-token one, so short matches are discounted rather than trusted.
 */
const FST_MATCH_LENGTH_SCALE: ReadonlyMap<number, number> = new Map([
	[1, 0.25],
	[2, 0.7],
])

/**
 * Scale applied once a match is long enough to stand on its own.
 */
const FULL_FST_MATCH_SCALE = 1

const SPACE_SENTINEL = "▁"

/**
 * A SentencePiece byte-fallback piece (`<0xHH>`) — the vocab's override for a character with no direct token (curly
 * quotes “”‘’, guillemets «», braces {} all hit this even on an otherwise-Latin-script vocab; see `tokenizer.ts`'s doc
 * comment). The placeholder TEXT itself ("<0x7B>") contains hex digits and letters that `/[\p{L}\p{N}]/u` would misread
 * as real alnum content — without this guard, a byte-fallback piece's placeholder text leaks into `fstToken` as garbage
 * ("0x7bblock" instead of "block"), silently corrupting the FST/pair-index probe key for any place name written with
 * one of these characters (paired-punctuation audit, `.superpowers/sdd/task-9-audit-report.md`). Matched against the
 * piece with any leading `▁` stripped, mirroring how `hasAlnum`/`literal` are computed below.
 */
const BYTE_FALLBACK_RE = /^<0x[0-9A-Fa-f]{2}>$/

/**
 * Is `piece` real word content, ignoring a leading `▁` sentinel? False for a byte-fallback placeholder — see above.
 */
function hasWordContent(piece: string): boolean {
	const literal = piece.startsWith(SPACE_SENTINEL) ? piece.slice(SPACE_SENTINEL.length) : piece

	if (BYTE_FALLBACK_RE.test(literal)) return false

	return /[\p{L}\p{N}]/u.test(piece)
}

//#region Structural types

export interface FSTMatchLike {
	stateID: number
	accepted: boolean
	depth: number
}

export interface FSTPlaceEntryLike {
	wofID: number
	placetype: string
	/**
	 * REFERENTIAL likelihood in [0, 1] — population-anchored. The ONLY score the decoder bias reads (ROAD_TO_V9 §2,
	 * ratified 2026-08-06: "the importance of a knowledge-base article is not the probability that this is the place the
	 * user means").
	 *
	 * The structural type deliberately does NOT name `encyclopedic`. The FST entries the matcher hands over carry it, and
	 * a bias that could see it would eventually use it — so the type boundary is where the policy is enforced, not a
	 * comment.
	 */
	referential: number
}

export interface FSTMatcherLike {
	walk(tokens: string[]): FSTMatchLike | null
	walkFrom(prev: FSTMatchLike, token: string): FSTMatchLike | null
	accepting(stateID: number): FSTPlaceEntryLike[]
}

//#endregion

//#region Placetype → BIO label mapping

/**
 * The only placetypes that reach a BIO tag.
 *
 * Exported because a probe that reports "what bias would the decoder get for this surface" has to collapse the FST's
 * accepting entries the SAME way {@link applyBias} does, and a second copy of this map makes the probe answer a
 * question about a decoder that does not exist. A `county` or `borough` entry is walked, deduped, and dropped without
 * ever touching the emission matrix — no attested board row licenses a tag for those tiers, and `region` would be a
 * guess.
 *
 * `localadmin` and `neighbourhood` map to `locality` (the C4 census's one attested covering-surface class, #1747):
 * `Biggin Hill, United Kingdom` is accepted by the GB FST as a NEIGHBOURHOOD entry, and dropping it left the covering
 * surface with zero bias while the sub-span reading fragmented the parse (`locality: Biggin` + a stranded
 * `street_suffix: Hill`). `localadmin` is WOF's administrative twin of a locality — the resolver's placetype filter
 * groups already treat the pair as one contest class. The bias stays soft (referential-scaled), so a dependent-locality
 * reading can still win where the model's own emissions say so.
 *
 * The two mapped tiers carry ONE surface-conditional exception (#1903): a street-shaped surface — see
 * {@link isStreetShapedSurface} — draws no locality bias from a neighbourhood/localadmin entry. Direct `locality`
 * entries are never suppressed; a real locality named after a street keeps its bias.
 */
export const PLACETYPE_TO_BIO: ReadonlyMap<string, string> = new Map([
	["country", "country"],
	["region", "region"],
	["locality", "locality"],
	["localadmin", "locality"],
	["neighbourhood", "locality"],
	["postalcode", "postcode"],
])

/**
 * The placetypes whose BIO mapping is borrowed (`→ locality`) rather than their own tier — the C4 pair, and the only
 * entries {@link isStreetShapedSurface} can suppress.
 */
const MAPPED_TIER_PLACETYPES: ReadonlySet<string> = new Set(["localadmin", "neighbourhood"])

/**
 * A surface whose final tokens read as a street name: a hard street generic (`street`, `road`, `avenue`, `boulevard`,
 * `square`), optionally followed by one directional (`east`/`west`/`north`/`south`/`upper`/`lower`).
 *
 * Restricts the C4 mapped tiers only. Census over the 2026-08-25 candidate gazetteer (279,513 distinct
 * neighbourhood/localadmin surfaces): this predicate covers the three classes that collide with bare street names — 79
 * generic+directional ("King Street East" is a Hamilton, Ontario neighbourhood), 442 hard-generic-final, 235
 * square-final ("Madison Square") — 756 surfaces, 0.27% of the mapped class. The covering-surface classes the mapping
 * exists for are untouched: `hill`-final alone is 866 surfaces ("Biggin Hill") and no other generic (`green`, `park`,
 * `common`, …) is in the list. Tokens arrive FST-normalized (lowercase), so the match is exact, not case-folded here.
 */
export function isStreetShapedSurface(tokens: readonly string[]): boolean {
	if (!tokens.length) return false

	let last = tokens.length - 1

	if (STREET_SHAPE_DIRECTIONALS.has(tokens[last]!)) {
		if (last === 0) return false
		last -= 1
	}

	// The generic must not be the whole surface: a bare "square" or "street" token is not a street NAME.
	return last > 0 && STREET_SHAPE_GENERICS.has(tokens[last]!)
}

const STREET_SHAPE_GENERICS: ReadonlySet<string> = new Set(["street", "road", "avenue", "boulevard", "square"])
const STREET_SHAPE_DIRECTIONALS: ReadonlySet<string> = new Set(["east", "west", "north", "south", "upper", "lower"])

/**
 * An FST entry as both the decoder and the probes read it.
 */
export interface FSTEntryLike {
	placetype: string
	/**
	 * The referential/importance score. Named loosely because the two probes and the prior reach it under different field
	 * names on their own record types.
	 */
	importance: number
}

/**
 * Collapse accepting entries to `max(importance)` PER BIO TAG — the only shape {@link applyBias} acts on.
 *
 * The per-place ranking INSIDE a name is invisible to the decoder; only the per-tag max is not. A caller reporting
 * anything finer would overstate what an importance change can do.
 *
 * `surfaceTokens` is the FST-normalized matched surface, and it is REQUIRED because the collapse is
 * surface-conditional: a street-shaped surface draws nothing from the mapped tiers ({@link isStreetShapedSurface},
 * #1903). A probe that omitted it would answer for a decoder that does not exist — the same hazard this function's
 * export guards against for the placetype map.
 *
 * An EMPTY result is not a zero bias: it means the surface was accepted but carries no BIO-mapped placetype, so the
 * decoder sees nothing. A caller must keep that apart from "the FST does not accept this surface at all", which is
 * absence, and from a tag present with value `0`, which is a measured zero.
 */
export function collapseFSTBias(
	entries: ReadonlyArray<FSTEntryLike>,
	surfaceTokens: readonly string[]
): Map<string, number> {
	const byTag = new Map<string, number>()
	const streetShaped = isStreetShapedSurface(surfaceTokens)

	for (const entry of entries) {
		const tag = PLACETYPE_TO_BIO.get(entry.placetype)

		if (!tag) continue

		if (streetShaped && MAPPED_TIER_PLACETYPES.has(entry.placetype)) continue

		byTag.set(tag, Math.max(byTag.get(tag) ?? 0, entry.importance))
	}

	return byTag
}

//#endregion

//#region Internals

export interface WordGroup {
	fstToken: string
	pieceIndices: number[]
}

/**
 * One accepting contiguous FST path, before any emission-bias policy is applied.
 *
 * This is an observability shape: it reports every accepted surface, including nested matches. It does not deduplicate
 * WOF ids, rank matches, or mutate decoder emissions.
 */
export interface FSTAcceptedMatch {
	startPiece: number
	endPiece: number
	startWord: number
	endWord: number
	entries: FSTPlaceEntryLike[]
}

/**
 * Enumerate every accepting contiguous FST path over the same reconstructed words used by
 * {@link buildFSTEmissionPriors}.
 *
 * `endPiece` and `endWord` are exclusive. Empty normalized word groups remain transparent while walking, matching the
 * prior's treatment of punctuation-only SentencePiece groups. The returned list preserves walk order: start word first,
 * then increasing end word.
 */
export function findFSTAcceptedMatches(
	fst: FSTMatcherLike,
	pieces: ReadonlyArray<{ piece: string }>
): FSTAcceptedMatch[] {
	const groups = groupPiecesIntoWords(pieces)
	const matches: FSTAcceptedMatch[] = []

	for (let startWord = 0; startWord < groups.length; startWord++) {
		const first = groups[startWord]!

		if (first.fstToken === "") continue
		const firstMatch = fst.walk([first.fstToken])

		if (!firstMatch) continue

		if (firstMatch.accepted) {
			matches.push(acceptedMatch(startWord, startWord, [first], fst.accepting(firstMatch.stateID)))
		}

		let current = firstMatch

		for (let endWord = startWord + 1; endWord < groups.length; endWord++) {
			const nextGroup = groups[endWord]!

			if (nextGroup.fstToken === "") continue
			const next = fst.walkFrom(current, nextGroup.fstToken)

			if (!next) break

			if (next.accepted) {
				const matchedGroups = groups.slice(startWord, endWord + 1).filter((group) => group.fstToken !== "")
				matches.push(acceptedMatch(startWord, endWord, matchedGroups, fst.accepting(next.stateID)))
			}

			current = next
		}
	}

	return matches
}

function acceptedMatch(
	startWord: number,
	endWord: number,
	groups: ReadonlyArray<WordGroup>,
	entries: FSTPlaceEntryLike[]
): FSTAcceptedMatch {
	const pieceIndices = groups.flatMap((group) => group.pieceIndices)

	return {
		startPiece: pieceIndices[0]!,
		endPiece: pieceIndices.at(-1)! + 1,
		startWord,
		endWord: endWord + 1,
		entries,
	}
}

const SUPPRESS_WHEN_PLACE: readonly string[] = ["B-street", "I-street", "B-house_number", "I-house_number", "B-venue"]

/**
 * Match-length scaling mode for the importance bias (#1142). A single-token place match is weak evidence (a place name
 * that is also a surname / street head / common word); a multi-token match is reliable. `both` scales the positive
 * locality bias AND the street suppression by match length; `suppression` scales only the suppression (leaving the
 * positive bias intact — safe for the bare-fragment regime where the positive gazetteer bias earns its keep); `off`
 * disables it.
 */
export type ImportanceLengthScaleMode = "off" | "suppression" | "both"

/**
 * Street-context check for the positive FST bias (#1142, street-context check — the FR-fragment complement to #1173's
 * suppression length-scaling).
 *
 * Washington/Madison/Jackson are simultaneously the highest-importance US place names AND the commonest US street
 * names, so a positive locality/region bias must be withheld when the matched span sits in a syntactically
 * street-headed position — conditioned on SYNTAX (street-type adjacency, house-number-left), NEVER on the importance
 * value (`importance²` magnitude sharpening was measured and REJECTED: it re-imports exactly this collision).
 * Positive-evidence-only: the check can only scale the positive bias DOWN when street context is present; its absence
 * never penalizes, and a parse with no street context is byte-identical to the unrestricted path.
 *
 * The street-type signal source is the street-morphology FST (`fst-street-morphology.bin`, locale-general — catches
 * prefix locales like "Rue de Rivoli", the FR −3), NOT codex `us/street-suffix.ts` (US-only — using it re-introduces an
 * FR regression).
 */
export interface StreetContextGateOpts {
	/**
	 * The street-morphology FST matcher (same instance the street-morphology prior consumes).
	 */
	fst: FSTMatcherLike
	/**
	 * Multiplier applied to the positive `impBias` when the check fires. Default 0.25 (tune 0.15–0.4). Deliberately NOT
	 * zero — "New York Ave" still deserves some admin mass for the semi-markov decoder.
	 */
	positiveScale?: number
}

export interface FSTPriorOpts {
	biasScale?: number
	/**
	 * Maximum bias magnitude (logits). Prevents large-population places from overriding the model. Default 3.0.
	 */
	maxBias?: number
	suppressionScale?: number
	/**
	 * See {@link ImportanceLengthScaleMode}. Default `suppression` (measured best; see the caller).
	 */
	importanceLengthScaleMode?: ImportanceLengthScaleMode
	/**
	 * See {@link StreetContextGateOpts}. Absent → current behavior (default-safe no-op).
	 */
	streetContext?: StreetContextGateOpts
}

/**
 * House-number shape for the street-context check (#1143: "the house number is the license").
 */
const HOUSE_NUMBER_RE = /^\d{1,6}[a-z]?$/

/**
 * Build a `[seqLen][numLabels]` bias matrix from FST gazetteer matches.
 *
 * Walks all contiguous subpaths of the reconstructed whitespace-token sequence through the FST. For each accepting
 * state, biases the corresponding BIO labels on the matched pieces.
 */
export function buildFSTEmissionPriors(
	fst: FSTMatcherLike,
	pieces: ReadonlyArray<TokenLike & { piece: string }>,
	labels: ReadonlyArray<string>,
	opts: FSTPriorOpts = {}
): number[][] {
	const T = pieces.length
	const L = labels.length
	const biasScale = opts.biasScale ?? 1
	const seenWOFIDs = new Set<number>()
	const maxBias = opts.maxBias ?? 3
	const suppressionScale = opts.suppressionScale ?? 1.5
	// Default `suppression` (#1142, measured 2026-07-18): scaling ONLY the street-suppression term by
	// match length is a broad win (US golden +35, admin-street-homonym fragments +50, bare-locality −2),
	// and it leaves the positive locality bias untouched so the bare-fragment regime is safe. Scaling the
	// positive term too (`both`) measured strictly worse (US +26, FR −9). See docs/…/the-meaning-of-zero.
	const lengthMode: ImportanceLengthScaleMode = opts.importanceLengthScaleMode ?? "suppression"
	const tuning: BiasTuning = { biasScale, maxBias, suppressionScale, seenWOFIDs, lengthMode }
	const matrix = emptyPriorMatrix(T, L)
	const labelToCol = labelColumnIndex(labels)

	const wordGroups = groupPiecesIntoWords(pieces)

	if (!wordGroups.length) return matrix

	// Street-context check precompute (#1142) — O(words), only when the morphology FST was passed in.
	// `streetTypeFlags[i]` = word-group i is a street-type token per the morphology FST;
	// `houseNumberFlags[i]` = word-group i is house-number-shaped.
	const streetContext = opts.streetContext

	const streetTypeFlags: boolean[] | null = streetContext
		? wordGroups.map((g) => g.fstToken !== "" && isStreetAffix(streetContext.fst, g.fstToken))
		: null

	const houseNumberFlags: boolean[] | null = streetContext
		? wordGroups.map((g) => HOUSE_NUMBER_RE.test(g.fstToken))
		: null

	for (let start = 0; start < wordGroups.length; start++) {
		const group = wordGroups[start]!

		if (group.fstToken === "") continue

		const match = fst.walk([group.fstToken])

		if (!match) continue

		if (match.accepted) {
			applyBias(
				matrix,
				labelToCol,
				fst.accepting(match.stateID),
				[group],
				tuning,
				streetContextScale(wordGroups, start, start, streetContext, streetTypeFlags, houseNumberFlags)
			)
		}

		let current = match

		for (let end = start + 1; end < wordGroups.length; end++) {
			const nextGroup = wordGroups[end]!

			if (nextGroup.fstToken === "") continue

			const next = fst.walkFrom(current, nextGroup.fstToken)

			if (!next) break

			if (next.accepted) {
				const matchedGroups = wordGroups.slice(start, end + 1).filter((g) => g.fstToken !== "")

				applyBias(
					matrix,
					labelToCol,
					fst.accepting(next.stateID),
					matchedGroups,
					tuning,
					streetContextScale(wordGroups, start, end, streetContext, streetTypeFlags, houseNumberFlags)
				)
			}

			current = next
		}
	}

	return matrix
}

/**
 * Group SentencePiece pieces into whitespace-delimited words. Each word's literal text is reconstructed by
 * concatenating pieces (minus leading ▁), then normalized through the same pipeline the FST builder uses.
 *
 * **The word boundary is `▁` (the SentencePiece space sentinel) — and ONLY `▁`.** The loop carries one piece of state,
 * `current: WordGroup | null` — the word presently being assembled, or `null` when a word is PENDING (nothing is open,
 * and the next real content should start one fresh, whatever piece it arrives on). Three kinds of piece, crossed with
 * that state, is the whole state machine:
 *
 * 1. **`▁`-prefixed, with alnum content** (a genuine new word, e.g. `"▁Stock"`, `"▁Tyne"`): always closes whatever
 *    `current` holds (pushing it to `groups`) and opens a fresh one. This is the only case that unconditionally starts
 *    a word — every other case below is conditioned on whether one is already open or pending.
 * 2. **`▁`-prefixed, NO alnum content** (a bare `"▁"` — a lone space tokenized as its own piece with nothing attached — or
 *    a punctuation piece the tokenizer fused with its own leading space): closes whatever `current` holds, same as case
 *    1, but does NOT open a new word — it also gets its own empty placeholder group (`{ fstToken: "", pieceIndices: [i]
 *    }`, preserving index alignment) and leaves the state PENDING (`current = null`) for whatever piece comes next.
 * 3. **Not `▁`-prefixed** (interior to whatever's already true — nothing here is itself a boundary):
 *
 *    - **Alnum** (a SentencePiece subword split, e.g. `"ton"` after `"▁Stock"`): if a word is open (`current` is non-null),
 *      this is an ordinary continuation — appended onto it. If a word is PENDING (`current` is `null` — because the last
 *      piece was case 2's bare `▁`, or a run of case-3-punctuation with nothing to attach to, or this is the very first
 *      piece), this piece is the actual start of the pending word: nothing else marks the boundary, so it opens `current`
 *      fresh here instead of being dropped. **Opening on a non-`▁` piece is required, not a nicety**: restrict
 *      word-opening to `▁`-prefixed pieces (or `i === 0`) and a pending word whose first piece happens to lack its own `▁`
 *      vanishes silently — that is the exact shape a SentencePiece vocab produces for a short/common word never learned as
 *      a merged `"▁word"` token (`"on"`, `"upon"`, `"super"`, bare `"IL"` after a lone `"▁"` before it — all observed on
 *      the production `v0.9.0-multisplice` tokenizer, so not a fixture-vocab quirk).
 *    - **Punctuation-only** (`"-"`, `"'"`, a bare `","`): if a word is open, it's interior punctuation — absorbed into
 *      `current.pieceIndices` (contributing nothing to `fstToken`; `normalizeFSTToken` strips punctuation anyway) but
 *      never resetting it, so the pieces that follow still have a `current` to land on ("Stockton-on-Tees", "Bishop's
 *      Stortford"). If a word is PENDING, this punctuation piece has nothing to attach to either — same empty-placeholder
 *      treatment as case 2 — and the state stays PENDING; the punctuation doesn't consume or clear the pending word, it
 *      just has nothing of its own to open.
 *
 * The pending state is what keeps `"Stockton , Lancashire"` from fusing "Stockton" and "Lancashire" into one group:
 * however many raw empty-placeholder groups the comma/space sequence produces (one from the bare `▁`, one from the
 * comma itself if it too has no leading `▁`), they never carry real content, so non-empty-filtering callers
 * (`placetype-pair-prior.ts`'s window builder) still see "stockton" and "lancashire" as two separate,
 * non-adjacent-fused entries.
 *
 * Exported (alongside {@linkcode normalizeFSTToken} and the {@linkcode WordGroup} type) so consumers like the
 * street-morphology prior can reuse the same piece-grouping/normalization pipeline without duplication. Internal helper
 * signature; not part of the public neural API.
 */
export function groupPiecesIntoWords(pieces: ReadonlyArray<{ piece: string }>): WordGroup[] {
	const groups: WordGroup[] = []
	let current: WordGroup | null = null

	for (let i = 0; i < pieces.length; i++) {
		const p = pieces[i]!
		const hasAlnum = hasWordContent(p.piece)
		const startsNewWord = p.piece.startsWith(SPACE_SENTINEL) || i === 0

		if (startsNewWord) {
			if (current) {
				groups.push(current)
			}

			if (!hasAlnum) {
				// Case 2: a bare ▁ (or a ▁-fused punctuation piece) — close current, emit its own placeholder, and
				// leave `current === null` as the PENDING signal for whatever piece follows.
				groups.push({ fstToken: "", pieceIndices: [i] })
				current = null

				continue
			}

			const literal = p.piece.startsWith(SPACE_SENTINEL) ? p.piece.slice(SPACE_SENTINEL.length) : p.piece
			current = { fstToken: literal, pieceIndices: [i] }
		} else if (!hasAlnum) {
			// Case 3, punctuation: interior (absorbed) if a word is open; otherwise it has nothing to attach to and
			// stands alone — the pending state (if any) is left untouched for the next piece.
			if (current) {
				current.pieceIndices.push(i)
			} else {
				groups.push({ fstToken: "", pieceIndices: [i] })
			}
		} else if (current) {
			// Case 3, alnum, word already open: ordinary SentencePiece subword continuation.
			current.pieceIndices.push(i)
			current.fstToken += p.piece
		} else {
			// Case 3, alnum, PENDING (current === null): this piece is the pending word's actual start — it has no
			// leading ▁ of its own, but nothing else could possibly claim it, so it opens `current` fresh rather than
			// being dropped. See the docstring's numbered case 3 for the production-tokenizer motivation.
			current = { fstToken: p.piece, pieceIndices: [i] }
		}
	}

	if (current) {
		groups.push(current)
	}

	for (const g of groups) {
		if (g.fstToken !== "") {
			g.fstToken = normalizeFSTToken(g.fstToken)
		}
	}

	return groups
}

/**
 * Normalize a whitespace word to FST-index form: NFKC → lowercase → strip punctuation and symbols.
 *
 * NFKC (compatibility decomposition + canonical composition) unifies ligatures, superscripts, and other decomposable
 * forms; it does NOT strip diacritics ("Álava" stays "álava", not "alava"). Both the FST builder and this runtime fold
 * use the same pipeline, so any index built from either is consistent — that consistency is the guarantee, not the
 * specific form (indexed and query surfaces agree on diacritics).
 *
 * The regex `\p{P}\p{S}` strips all Unicode punctuation and symbols (categories P and S), leaving spaces intact — space
 * (U+0020) is Unicode category Zs (separator), NOT matched by `\p{P}` or `\p{S}`. So this function preserves spaces
 * within the token string ("Stockton on Tees" → "stockton on tees"). The hyphen/space EQUIVALENCE that produces
 * "stocktonontees" is a property of the caller's split-then-join pipeline in `groupPiecesIntoWords` — each word is
 * normalized separately, then words are joined with no separator.
 */
export function normalizeFSTToken(s: string): string {
	const cleaned = s
		.normalize("NFKC")
		.toLowerCase()
		.replaceAll(/[\p{P}\p{S}]/gu, "")

	return cleaned.length ? cleaned : ""
}

/**
 * Is `token` a street-type affix per the street-morphology FST? The morphology FST's accepting entries carry the
 * synthetic `street_affix` placetype (see `street-morphology-prior.ts` / the builder).
 */
function isStreetAffix(fst: FSTMatcherLike, token: string): boolean {
	const match = fst.walk([token])

	if (!match?.accepted) return false

	return fst.accepting(match.stateID).some((e) => e.placetype === "street_affix")
}

/**
 * Nearest non-empty word-group index adjacent to a matched span, or -1 when none exists in that direction.
 */
function adjacentNonEmptyIndex(groups: WordGroup[], from: number, direction: 1 | -1): number {
	for (let i = from + direction; i >= 0 && i < groups.length; i += direction) {
		if (groups[i]!.fstToken !== "") return i
	}

	return -1
}

/**
 * Street-context check (#1142): returns the positive-bias multiplier for a matched span at word-groups
 * `[startIdx..endIdx]` — `streetContext.positiveScale` (default 0.25) when EITHER syntactic condition holds, else 1.0
 * (byte-identical to the unrestricted path):
 *
 * 1. **Street-type adjacency** — the word-group immediately after (suffix locales: "Washington Blvd") or before (prefix
 *    locales: "Rue de Rivoli") the matched span is a street-type token per the morphology FST.
 * 2. **House-number left** — the word-group immediately before the match is house-number-shaped (`/^\d{1,6}[a-z]?$/` —
 *    "500 Washington" is street-headed, #1143). A house number before a street-type prefix ("500 rue …") needs no extra
 *    case: the prefix itself already satisfies condition 1.
 *
 * Composes with #1173's length-scaling inside {@linkcode applyBias} (length = weak lone match; context = strong match
 * in a street position); the suppression path is untouched.
 */
function streetContextScale(
	groups: WordGroup[],
	startIdx: number,
	endIdx: number,
	streetContext: StreetContextGateOpts | undefined,
	streetTypeFlags: boolean[] | null,
	houseNumberFlags: boolean[] | null
): number {
	if (!streetContext || !streetTypeFlags || !houseNumberFlags) return 1

	const prev = adjacentNonEmptyIndex(groups, startIdx, -1)

	if (prev >= 0 && (streetTypeFlags[prev] || houseNumberFlags[prev])) {
		return streetContext.positiveScale ?? 0.25
	}

	const next = adjacentNonEmptyIndex(groups, endIdx, 1)

	if (next >= 0 && streetTypeFlags[next]) {
		return streetContext.positiveScale ?? 0.25
	}

	return 1
}

/**
 * The per-run bias knobs — fixed for the whole of one `buildFSTEmissionPriors` call, so they travel as one bundle
 * rather than five positional arguments. `seenWOFIDs` is deliberately shared, not copied: it is the run-wide dedupe set
 * that keeps one WOF place from biasing the matrix twice.
 */
interface BiasTuning {
	biasScale: number
	maxBias: number
	suppressionScale: number
	seenWOFIDs: Set<number>
	lengthMode: ImportanceLengthScaleMode
}

function applyBias(
	matrix: number[][],
	labelToCol: Map<string, number>,
	entries: ReadonlyArray<FSTPlaceEntryLike>,
	groups: WordGroup[],
	tuning: BiasTuning,
	contextScale: number
): void {
	const { biasScale, maxBias, suppressionScale, seenWOFIDs, lengthMode } = tuning
	const seenTags = new Map<string, number>()

	// Surface-conditional restriction on the C4 mapped tiers (#1903): a street-shaped surface draws no locality
	// bias from a neighbourhood/localadmin entry. Computed once — the groups are this call's matched surface.
	const streetShaped = isStreetShapedSurface(groups.map((group) => group.fstToken))

	// Match-length scaling (#1142). A single-token place match ("Sweeney", "Tower", "Rome") is weak
	// evidence — surnames, street heads, and everyday words are place names *somewhere*; a multi-token
	// match ("New York", "Saint Louis") is far more reliable. Without this, real gazetteer importance
	// pulls the leading token of a bare/comma-free street into locality ("Sweeney Ranch Road" → loc
	// "Sweeney"; measured US golden −22, the no-anchor comma-free class). `suppression` scales only the
	// street-suppression term (safe for the bare-fragment regime where the positive bias earns its keep);
	// `both` also scales the positive locality bias; `off` disables. Locale-general — no word list.
	const matchLen = groups.length
	const lengthScale = FST_MATCH_LENGTH_SCALE.get(matchLen) ?? FULL_FST_MATCH_SCALE
	const posScale = lengthMode === "both" ? lengthScale : 1
	const supScale = lengthMode === "off" ? 1 : lengthScale

	for (const entry of entries) {
		if (seenWOFIDs.has(entry.wofID)) continue
		seenWOFIDs.add(entry.wofID)
		const bioTag = PLACETYPE_TO_BIO.get(entry.placetype)

		if (!bioTag) continue

		if (streetShaped && MAPPED_TIER_PLACETYPES.has(entry.placetype)) continue

		// The referential bias. Named `impBias` since #1142 and left alone: renaming it would churn every
		// tuning comment that cites it, and the field it reads is now unambiguous.
		const impBias = entry.referential * biasScale * maxBias * posScale * contextScale
		const existing = seenTags.get(bioTag) ?? 0

		if (impBias > existing) {
			seenTags.set(bioTag, impBias)
		}
	}

	if (!seenTags.size) return

	const allPieceIndices: number[] = []

	for (const group of groups) {
		for (const pi of group.pieceIndices) {
			allPieceIndices.push(pi)
		}
	}

	for (const [bioTag, bias] of seenTags) {
		const bCol = labelToCol.get(`B-${bioTag}`)
		const iCol = labelToCol.get(`I-${bioTag}`)

		if (bCol === undefined) continue

		for (let k = 0; k < allPieceIndices.length; k++) {
			const pi = allPieceIndices[k]!
			const col = k === 0 ? bCol : (iCol ?? bCol)
			matrix[pi]![col] = Math.max(matrix[pi]![col]!, bias)
		}
	}

	if (suppressionScale > 0) {
		// Scale the street/house-number suppression by the same match length — a lone place-name token
		// must not strongly suppress the street reading of the token it heads (#1142).
		const scaledSuppression = suppressionScale * supScale

		for (const pi of allPieceIndices) {
			for (const label of SUPPRESS_WHEN_PLACE) {
				const col = labelToCol.get(label)

				if (col !== undefined) {
					matrix[pi]![col] = Math.min(matrix[pi]![col]!, -scaledSuppression)
				}
			}
		}
	}
}

//#endregion
