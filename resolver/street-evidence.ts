/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #727 stage-2 phase 4c — street-NAME existence as the k-best arbiter signal.
 *
 *   Phase 4a measured the planned arbiter (full-geocode resolution tier) at exactly ZERO collected
 *   headroom: the failing class is context-free fragments, which never reach rooftop layers, so
 *   every hypothesis ties at admin tier. The corrected signal is street-NAME existence — "does this
 *   hypothesis's street surface exist as a street name in the national register?" — which IS
 *   queryable for a bare fragment. Measured on the FR fragment board over the v3.10.1 8k span model:
 *   the rerank collects +6.0pp street@1 (0.791 → 0.851), 96 fixes / 3 breaks (32:1), the value
 *   concentrated on the date-name class (+16.7pp). Receipts:
 *   `docs/articles/evals/2026-07-17-v3101-span-head-8k-result.md`, spec
 *   `docs/superpowers/specs/2026-07-17-727-phase4c-street-name-evidence.md`.
 *
 *   THE ANTI-PELIAS RULE (shared with `rerank.ts`): ONE bit of evidence, not a score. We do NOT
 *   blend the name signal into the parse scores — those already share a partition function and rank
 *   fine within an input. The reranker's only job is to prefer a sibling hypothesis whose street the
 *   world confirms exists, over a rank-1 whose street it does not. Positive evidence only: the
 *   ABSENCE of a name is never evidence against a parse (index incompleteness is the default state
 *   of the world), so the policy always fails open to the model's own ranking.
 *
 *   This module is PURE — the interface + the fold + the measured pick policy, no SQLite. The FR BAN
 *   backend lives in `@mailwoman/resolver-wof-sqlite` (`SQLiteStreetNameLookup`); callers inject it,
 *   mirroring the `PlaceLookup` pattern.
 */

/**
 * A street-name existence probe. Backend-agnostic; the FR instance is BAN street-centroids, a future US instance is
 * TIGER, etc. (per the registry-backed-structured-prediction doctrine tiers).
 */
export interface StreetLocalityEvidence {
	/**
	 * True when `streetSurface` exists as a street name — optionally scoped to a locality or postcode when the hypothesis
	 * carries one (fragments usually don't; unscoped is the measured mode). The implementation is responsible for folding
	 * the surface with {@link foldStreetSurface} so the caller passes raw text.
	 *
	 * POSITIVE EVIDENCE ONLY: return `false` on any doubt — a missing index, an unsupported country, a read error — so
	 * {@link pickByStreetEvidence} fails open to the model's ranking. Absence is never a veto.
	 */
	hasStreetName(streetSurface: string, scope?: StreetEvidenceScope): boolean
	/** ISO-2 (upper-case) countries this instance can answer for. Anything else → no evidence, never a veto. */
	readonly countries: ReadonlySet<string>
}

export interface StreetEvidenceScope {
	locality?: string
	postcode?: string
}

/**
 * The fold CONTRACT — the index builder and every runtime prober MUST share this exact function, or lookups silently
 * miss (the 4 v1-policy breaks were fold mismatches: `pillet-will` stored unhyphenated). NFD strip-diacritics,
 * lowercase, hyphen/apostrophe → space, whitespace-collapse. Import this beside the interface; never re-implement it.
 */
export function foldStreetSurface(surface: string): string {
	return surface
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/['’‐-―-]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
}

/**
 * FR street-type + particle vocabulary — the G1 guard. A street surface made ONLY of these words carries no NAME (bare
 * `rue`/`chemin` is a truncation, and it IS in the index), so it earns no evidence credit. Folded forms (particles are
 * pre-folded: `l'` → `l`). Kept small and lexical — it is a dictionary fact, not a tuned weight (the anti-Pelias
 * line).
 */
const FR_STREET_TYPE_WORDS: ReadonlySet<string> = new Set([
	"rue",
	"avenue",
	"boulevard",
	"chemin",
	"route",
	"allee",
	"impasse",
	"place",
	"quai",
	"passage",
	"sentier",
	"square",
	"cours",
	"voie",
	"chaussee",
	"rond",
	"point",
	"clos",
	"villa",
	"cite",
	"de",
	"du",
	"des",
	"la",
	"le",
	"les",
	"l",
	"d",
	"en",
	"aux",
	"au",
	"sur",
	"sous",
])

/** True when the folded surface contains no token outside {@link FR_STREET_TYPE_WORDS} — i.e. it is pure type/particle. */
export function isPureTypeVocabulary(foldedSurface: string): boolean {
	const tokens = foldedSurface.split(" ").filter(Boolean)

	if (tokens.length === 0) return true

	return tokens.every((t) => FR_STREET_TYPE_WORDS.has(t))
}

/** One candidate parse for the street-evidence rerank — its street surface + its (within-input comparable) score. */
export interface StreetCandidate<T = unknown> {
	/** The candidate's street surface (raw; folded internally). Empty string = no street parsed → never the evidence pick. */
	streetSurface: string
	/** The parse score, comparable to its siblings from the SAME input. Higher is better. */
	score: number
	/** Opaque caller payload carried through to the result (the segmentation, the tree, …). */
	payload?: T
}

export interface PickByStreetEvidenceOpts {
	/** Locality/postcode scope forwarded to {@link StreetLocalityEvidence.hasStreetName} (fragments usually carry none). */
	scope?: StreetEvidenceScope
	/**
	 * G2 — the margin cap. A candidate whose score is more than this far below rank-1 is never promoted by evidence
	 * (without it, evidence reaches deep down the list and moves off correct rank-1 parses). Default 2.5 — the value the
	 * v2 board measured (148 fixes / 3 breaks). UNCALIBRATED across models: re-fit when the span head retrains, since raw
	 * score margins are not comparable across models. (Plan #1134 pre-registers an isotonic ambiguity gate to replace
	 * it.)
	 */
	marginCap?: number
}

export interface StreetEvidencePick<T = unknown> {
	/** The chosen candidate — the first evidence-passing sibling, or rank-1 when none passes (fail-open). */
	candidate: StreetCandidate<T>
	/** Index of the chosen candidate in the input array. */
	index: number
	/** True when evidence MOVED the pick off rank-1 (a rank-2-beats-rank-1 correction — loggable training signal). */
	moved: boolean
}

/**
 * The measured v2 rerank policy. Given candidates in PARSE-SCORE order (rank-1 first) and an evidence probe, return the
 * first candidate whose street surface passes ALL of: (1) exists in the index, (2) G1 — not pure type vocabulary, (3)
 * G2 — within `marginCap` of rank-1. If none passes, return rank-1 (fail-open). Positive evidence only; the model's
 * order is preserved among equal-evidence candidates. This is the `resolver/rerank.ts` anti-Pelias discipline applied
 * to the name signal: one bit, no blending.
 *
 * @param candidates Parse candidates, rank-1 FIRST (the caller sorts by score descending).
 */
export function pickByStreetEvidence<T>(
	candidates: ReadonlyArray<StreetCandidate<T>>,
	evidence: StreetLocalityEvidence,
	opts: PickByStreetEvidenceOpts = {}
): StreetEvidencePick<T> {
	const marginCap = opts.marginCap ?? 2.5

	if (candidates.length === 0) {
		throw new Error("pickByStreetEvidence: no candidates")
	}
	const rank1 = candidates[0]!
	const topScore = rank1.score

	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i]!

		if (!c.streetSurface) continue

		// G2: candidates are score-ordered, so once one falls past the cap nothing deeper qualifies either.
		if (topScore - c.score > marginCap) break

		// G1: a pure street-type/particle surface (bare `rue`) carries no name — no evidence credit.
		if (isPureTypeVocabulary(foldStreetSurface(c.streetSurface))) continue

		if (evidence.hasStreetName(c.streetSurface, opts.scope)) {
			return { candidate: c, index: i, moved: i > 0 }
		}
	}

	return { candidate: rank1, index: 0, moved: false }
}
