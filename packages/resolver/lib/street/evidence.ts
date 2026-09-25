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
	 * Returns whether the raw street surface exists as a street name, within `scope`
	 * when given; the implementation folds the surface itself.
	 *
	 * It must return `false` on any doubt, such as a missing index or read error,
	 * because absence is never a veto.
	 */
	hasStreetName(streetSurface: string, scope?: StreetEvidenceScope): boolean

	/**
	 * The uppercase ISO 3166-1 alpha-2 countries this instance can answer for.
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
 * Folds a street surface for both index build and lookup by stripping diacritics,
 * lowercasing, turning hyphens and apostrophes into spaces, and collapsing whitespace.
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
 * Describes one candidate parse for {@link pickByStreetEvidence}, whose score is
 * comparable only against other candidates for the same input.
 */
export interface StreetCandidate<T = unknown> {
	/**
	 * The candidate's raw street surface; an empty string means no street was parsed,
	 * so the candidate cannot win on evidence.
	 */
	streetSurface: string

	/**
	 * The parse score, where higher is better.
	 */
	score: number

	/**
	 * An opaque caller value, such as the segmentation or tree, carried through to the result.
	 */
	payload?: T
}

/**
 * Configures {@link pickByStreetEvidence}, where `marginCap` (default 2.5) bounds how far
 * below rank 1 a winner may score and `exclusions` is indexed like the candidates.
 */
export interface PickByStreetEvidenceOpts {
	/**
	 * The locality or postcode scope forwarded to {@link StreetLocalityEvidence.hasStreetName}.
	 */
	scope?: StreetEvidenceScope

	/**
	 * The largest score gap below rank 1 at which evidence may still promote a candidate, defaulting to 2.5.
	 *
	 * Raw score margins differ between models, so the value needs refitting when the span head is retrained.
	 */
	marginCap?: number

	/**
	 * One entry per candidate, in the same order; a non-null entry moves that candidate
	 * behind every non-excluded one without removing it.
	 *
	 * If every candidate is excluded, the fallback pick is still rank 1.
	 */
	exclusions?: ReadonlyArray<Exclusion | null>
}

/**
 * Reports the candidate {@link pickByStreetEvidence} chose, its index, whether it
 * displaced rank 1, and the indexes demoted by exclusions.
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
	 * Whether the pick is not rank 1, either through evidence or because rank 1 was excluded.
	 */
	moved: boolean

	/**
	 * The input indexes that exclusions demoted, in input order, recorded
	 * separately from what the evidence found.
	 */
	demoted: number[]
}

/**
 * Picks the first candidate, in score order, whose street name exists in the evidence index,
 * is not pure type vocabulary, and scores within `marginCap` of rank 1.
 *
 * An excluded candidate is demoted behind every other candidate but never removed,
 * and when nothing qualifies the first non-excluded candidate wins.
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
