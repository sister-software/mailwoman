/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Exclusion } from "@mailwoman/evidence"

/**
 * Answers whether a street name exists, optionally within a locality or postcode,
 * for the countries a backend such as BAN street centroids covers.
 */
export interface StreetLocalityEvidence {
	/**
	 * Returns whether the raw street surface exists as a street name, within `scope` when given.
	 *
	 * The implementation folds the surface itself.
	 * It must return `false` on a missing index or a read error, because a `false`
	 * answer only withholds promotion.
	 */
	hasStreetName(streetSurface: string, scope?: StreetEvidenceScope): boolean

	/**
	 * The upper-case ISO 3166-1 alpha-2 countries this instance covers.
	 */
	readonly countries: ReadonlySet<string>
}

/**
 * Narrows a street-name existence probe to a locality, a postcode, or both.
 */
export interface StreetEvidenceScope {
	locality?: string
	postcode?: string
}

/**
 * Folds a street surface for both index build and lookup.
 *
 * It strips diacritics, lowercases, turns hyphens, dashes and apostrophes into spaces,
 * and collapses whitespace.
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
 * Returns true when a folded street surface is empty or consists only of French
 * street-type words and particles, such as "rue de la".
 */
export function isPureTypeVocabulary(foldedSurface: string): boolean {
	const tokens = foldedSurface.split(" ").filter((value) => value.length)

	if (!tokens.length) return true

	return tokens.every((t) => FR_STREET_TYPE_WORDS.has(t))
}

/**
 * One candidate parse for {@link pickByStreetEvidence}.
 *
 * Scores are comparable only among candidates for the same input.
 */
export interface StreetCandidate<T = unknown> {
	/**
	 * The candidate's raw street surface.
	 *
	 * An empty string means the parse found no street, and evidence then skips the candidate.
	 */
	streetSurface: string

	/**
	 * The parse score, where higher is better.
	 */
	score: number

	/**
	 * An opaque caller value, such as the segmentation or tree, returned unchanged with the pick.
	 */
	payload?: T
}

/**
 * Options for {@link pickByStreetEvidence}.
 */
export interface PickByStreetEvidenceOpts {
	/**
	 * The locality or postcode scope passed to {@link StreetLocalityEvidence.hasStreetName}.
	 */
	scope?: StreetEvidenceScope

	/**
	 * The largest score gap below rank 1 at which evidence may still promote a candidate.
	 * It defaults to 2.5.
	 *
	 * Raw score margins differ between models, so the value needs refitting when the span head is retrained.
	 */
	marginCap?: number

	/**
	 * One entry per candidate, in the same order.
	 *
	 * A non-null entry moves that candidate behind every non-excluded one without removing it.
	 * If every candidate is excluded, the fallback pick is rank 1.
	 */
	exclusions?: ReadonlyArray<Exclusion | null>
}

/**
 * The result of {@link pickByStreetEvidence}.
 */
export interface StreetEvidencePick<T = unknown> {
	/**
	 * The first candidate that passes the evidence checks, or the first non-excluded
	 * candidate when none passes.
	 */
	candidate: StreetCandidate<T>

	/**
	 * The chosen candidate's index in the input array.
	 */
	index: number

	/**
	 * Whether the pick differs from rank 1, through evidence or because rank 1 was excluded.
	 */
	moved: boolean

	/**
	 * The input indexes that exclusions demoted, in input order.
	 */
	demoted: number[]
}

/**
 * Picks the first candidate, in score order, whose street name exists in the evidence index,
 * holds more than street type words, and scores within `marginCap` of rank 1.
 *
 * Excluded candidates are checked after all others.
 * When nothing qualifies, the first non-excluded candidate wins.
 *
 * @param candidates Parse candidates sorted by score, rank 1 first.
 * @throws When `candidates` is empty.
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

	const order = demoted.length ? [...considered, ...demoted] : considered

	for (const i of order) {
		const c = candidates[i]!

		if (!c.streetSurface) continue

		if (topScore - c.score > marginCap) continue

		if (isPureTypeVocabulary(foldStreetSurface(c.streetSurface))) continue

		if (evidence.hasStreetName(c.streetSurface, opts.scope)) {
			return { candidate: c, index: i, moved: i > 0, demoted }
		}
	}

	const fallback = order[0] ?? 0

	return { candidate: candidates[fallback]!, index: fallback, moved: fallback > 0, demoted }
}
