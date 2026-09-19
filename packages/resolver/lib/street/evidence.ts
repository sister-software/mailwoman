/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Street-name existence is positive-only evidence for choosing between sibling parses. It never
 *   changes the model score and a missing lookup result leaves the model ranking unchanged.
 */

import type { Exclusion } from "@mailwoman/evidence"

/**
 * A street-name existence probe. Backend-agnostic. the FR instance is BAN street-centroids, a future US instance is
 * tiger, etc. (per the registry-backed-structured-prediction doctrine tiers).
 */
export interface StreetLocalityEvidence {
	/**
	 * True when `streetSurface` exists as a street name — optionally scoped to a locality or postcode when the hypothesis
	 * carries one (fragments usually don't. unscoped is the measured mode). The implementation is responsible for folding
	 * the surface with {@link foldStreetSurface} so the caller passes raw text.
	 *
	 * Positive evidence only: return `false` on any doubt — a missing index, an unsupported country, a read error — so
	 * {@link pickByStreetEvidence} fails open to the model's ranking. Absence is never a veto.
	 */
	hasStreetName(streetSurface: string, scope?: StreetEvidenceScope): boolean
	/**
	 * ISO-2 (upper-case) countries this instance can answer for. Anything else → no evidence, never a veto.
	 */
	readonly countries: ReadonlySet<string>
}

export interface StreetEvidenceScope {
	locality?: string
	postcode?: string
}

/**
 * Shared index-build and lookup fold: strip diacritics, lowercase, replace hyphens and apostrophes, and collapse space.
 */
export function foldStreetSurface(surface: string): string {
	return surface
		.normalize("NFD")
		.replaceAll(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replaceAll(/['’‐-―-]/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim()
}

/**
 * FR street-type + particle vocabulary — the G1 guard. A street surface made only of these words carries no name (bare
 * `rue`/`chemin` is a truncation, and it is in the index), so it warrants no evidence credit. Folded forms (particles
 * are pre-folded: `l'` → `l`). Kept small and lexical — it is a dictionary fact rather than a tuned weight (the
 * anti-Pelias line).
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

/**
 * True when the folded surface contains no token outside {@link FR_STREET_TYPE_WORDS} — i.e. it is pure type/particle.
 */
export function isPureTypeVocabulary(foldedSurface: string): boolean {
	const tokens = foldedSurface.split(" ").filter((value) => value.length)

	if (!tokens.length) return true

	return tokens.every((t) => FR_STREET_TYPE_WORDS.has(t))
}

/**
 * One candidate parse for the street-evidence rerank — its street surface + its (within-input comparable) score.
 */
export interface StreetCandidate<T = unknown> {
	/**
	 * The candidate's street surface (raw. folded internally). Empty string = no street parsed → never the evidence pick.
	 */
	streetSurface: string
	/**
	 * The parse score, comparable to its siblings from the same input. Higher is better.
	 */
	score: number
	/**
	 * Opaque caller payload carried through to the result (the segmentation, the tree, …).
	 */
	payload?: T
}

export interface PickByStreetEvidenceOpts {
	/**
	 * Locality/postcode scope forwarded to {@link StreetLocalityEvidence.hasStreetName} (fragments usually carry none).
	 */
	scope?: StreetEvidenceScope
	/**
	 * G2 — the margin cap. A candidate whose score is more than this far below rank-1 is never promoted by evidence
	 * (without it, evidence reaches deep down the list and moves off correct rank-1 parses). Default 2.5 — the value the
	 * v2 board measured (148 fixes / 3 breaks). uncalibrated across models: re-fit when the span head retrains, since raw
	 * score margins are not comparable across models. (Plan #1134 pre-registers an isotonic ambiguity check to replace
	 * it.)
	 */
	marginCap?: number
	/**
	 * One entry per candidate, positionally aligned. A non-null entry demotes that candidate by one bit — it is
	 * considered only after every un-excluded sibling. It is never removed: with every candidate excluded the pick is
	 * still rank-1, because the worst case this policy accepts is the model's own ranking.
	 *
	 * Omitted or all-null reproduces the measured v2 policy exactly.
	 */
	exclusions?: ReadonlyArray<Exclusion | null>
}

export interface StreetEvidencePick<T = unknown> {
	/**
	 * The chosen candidate — the first evidence-passing sibling, or rank-1 when none passes (fail-open).
	 */
	candidate: StreetCandidate<T>
	/**
	 * Index of the chosen candidate in the input array.
	 */
	index: number
	/**
	 * True when evidence moved the pick off rank-1 (a rank-2-beats-rank-1 correction — loggable training signal).
	 */
	moved: boolean
	/**
	 * Indices an exclusion demoted, in input order. Empty when no exclusion applied — a loggable record of what the
	 * coverage check licensed, distinct from what evidence found.
	 */
	demoted: number[]
}

/**
 * The measured v2 rerank policy. Given candidates in parse-score order (rank-1 first) and an evidence probe, return the
 * first candidate whose street surface passes all of: (1) exists in the index, (2) G1 — not pure type vocabulary, (3)
 * G2 — within `marginCap` of rank-1. If none passes, return rank-1 (fail-open). Positive evidence only. the model's
 * order is preserved among equal-evidence candidates. This is the `resolver/rerank.ts` anti-Pelias discipline applied
 * to the name signal: one bit, no blending. `opts.exclusions` adds one more bit in the same fold: a coverage-licensed
 * absence demotes its candidate behind every un-excluded sibling and never removes it.
 *
 * @param candidates Parse candidates, rank-1 first (the caller sorts by score descending).
 */
export function pickByStreetEvidence<T>(
	candidates: ReadonlyArray<StreetCandidate<T>>,
	evidence: StreetLocalityEvidence,
	opts: PickByStreetEvidenceOpts = {}
): StreetEvidencePick<T> {
	const marginCap = opts.marginCap ?? 2.5

	if (!candidates.length) {
		throw new Error("pickByStreetEvidence: no candidates")
	}

	const rank1 = candidates[0]!
	const topScore = rank1.score
	const demoted: number[] = []
	const considered: number[] = []

	for (let i = 0; i < candidates.length; i++) {
		if (opts.exclusions?.[i]) {
			demoted.push(i)
		} else {
			considered.push(i)
		}
	}

	// An excluded candidate is considered only after every un-excluded sibling. it is never dropped.
	const order = demoted.length ? [...considered, ...demoted] : considered

	for (const i of order) {
		const c = candidates[i]!

		if (!c.streetSurface) continue

		// G2: the margin is measured from rank-1's score, whatever position the candidate is considered at.
		if (topScore - c.score > marginCap) continue

		// G1: a pure street-type/particle surface (bare `rue`) carries no name — no evidence credit.
		if (isPureTypeVocabulary(foldStreetSurface(c.streetSurface))) continue

		if (evidence.hasStreetName(c.streetSurface, opts.scope)) {
			return { candidate: c, index: i, moved: i > 0, demoted }
		}
	}

	// Fail-open: the first un-excluded candidate, which is rank-1 unless an exclusion demoted it, and rank-1 again when
	// every candidate is excluded.
	const fallback = order[0] ?? 0

	return { candidate: candidates[fallback]!, index: fallback, moved: fallback > 0, demoted }
}
