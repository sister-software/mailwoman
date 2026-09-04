/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The exclusion check. An {@link Exclusion} is the only evidence kind that can act on an ABSENCE, so it is the only
 *   one with no public constructor: {@link requireExclusionBasis} is the sole way to make one, and it refuses far more
 *   often than it admits.
 *
 *   FOLD PARITY IS A PRECONDITION, not a detail. A key that "exists nowhere" may exist under a surface we did not
 *   probe. The board's coverage-miss decomposition found this class directly — `Tel Aviv-Yafo`, `São Paulo - SP`,
 *   `Co. Westmeath` are real places reported as coverage misses — and it is indistinguishable from a true absence at
 *   the decision point. So the probe must name the fold it used and the layer must name the fold its builder wrote,
 *   and a mismatch is a refusal rather than an exclusion.
 */

/**
 * What a `completeness` value RESTS ON. The magnitude alone cannot be acted on: a cell recorded at `1.0` because an
 * authority designates the set complete, and a cell recorded at `1.0` because the source happened to return rows there,
 * license entirely different conclusions.
 *
 * Only {@link CoverageBasis.Designated} and {@link CoverageBasis.Surveyed} can support an EXCLUSION — "the thing you
 * asked for is not here". {@link CoverageBasis.SourcePresent} supports presence and nothing else: the source looked,
 * which is not the same as the source found everything.
 */
export const CoverageBasis = {
	/**
	 * An authority declares the set complete for this cell — BAN holding every address in a commune, OS declaring OS Open
	 * UPRN complete for GB. A miss inside a designated cell IS evidence of absence.
	 */
	Designated: "designated",
	/**
	 * We measured completeness ourselves against an independent reference, and `completeness` carries that measurement. A
	 * miss is evidence of absence in proportion to the value.
	 */
	Surveyed: "surveyed",
	/**
	 * The source returned rows in this cell and we recorded that. Says nothing about what the source missed. A miss here
	 * is UNKNOWN, never absence.
	 */
	SourcePresent: "source_present",
} as const

export type CoverageBasis = (typeof CoverageBasis)[keyof typeof CoverageBasis]

/**
 * Whether a coverage reading can support an EXCLUSION — a claim that the thing asked for is not there.
 *
 * Presence is supportable from any basis. Absence is not: `source_present` records that the source returned rows, which
 * says nothing about what it missed. Callers building negative evidence must check on this rather than on
 * `completeness` alone, or an exclusion fires identically on a genuinely empty cell and on one we never surveyed.
 */
export function supportsExclusion(cell: { basis?: CoverageBasis | null }): boolean {
	return cell.basis === CoverageBasis.Designated || cell.basis === CoverageBasis.Surveyed
}

/**
 * What an exclusion rests on, carried into the derivation so a reader can audit the refusal.
 */
export interface CoverageScope {
	layer: string
	h3Cell: number
	basis: CoverageBasis
	/**
	 * The fold both the layer's builder and this probe used. Their agreement is what licensed the exclusion.
	 */
	fold: string
}

export interface Exclusion {
	kind: "exclusion"
	source: string
	vintage: string
	scope: CoverageScope
}

export interface RequireExclusionInput {
	layer: string
	source: string
	vintage: string
	h3Cell: number
	/**
	 * The layer's coverage row for this cell. `undefined` means the cell is ABSENT from `layer_coverage`, which is
	 * unknown — never a zero-completeness record (the meaning-of-zero rule).
	 */
	cell: { basis?: CoverageBasis | null } | undefined
	/**
	 * Identity of the fold this probe folded its key with. NOT a hand-written label: three packages export a function
	 * named `foldName` and all three compute different answers (`Ångström` → `a ngstro m` / `angstrom` / `angstrom`), so
	 * a name is not an identity. Derive it with {@link foldIdentity}.
	 */
	probeFold: string
	/**
	 * Identity of the fold the layer's builder wrote its keys with, derived the same way.
	 */
	layerFold: string
	/**
	 * The country of the thing being excluded, when the probe is country-scoped.
	 */
	country?: string
	/**
	 * ISO-2 upper-case countries this probe can answer for. Omit for an unscoped probe.
	 */
	countries?: ReadonlySet<string>
}

/**
 * The ONLY constructor for an {@link Exclusion}. Returns `null` — never throws — on every refusal, because a refusal is
 * the ordinary case and a caller must fail open to whatever ranking it already had.
 */
export function requireExclusionBasis(input: RequireExclusionInput): Exclusion | null {
	if (!input.cell) return null

	if (!supportsExclusion(input.cell)) return null

	if (input.probeFold !== input.layerFold) return null

	if (input.countries && input.country && !input.countries.has(input.country.toUpperCase())) return null

	const basis = input.cell.basis

	if (!basis) return null

	return {
		kind: "exclusion",
		source: input.source,
		vintage: input.vintage,
		scope: { layer: input.layer, h3Cell: input.h3Cell, basis, fold: input.probeFold },
	}
}

/**
 * Inputs a fold identity is computed over. Each exercises one axis a fold can differ on: a WORD-INTERNAL diacritic (the
 * axis `resolver/fold-name.ts` gets wrong — it maps the combining mark to a space, splitting the word), a diacritic
 * ADJACENT to punctuation (which hides that bug), hyphens, periods, apostrophes, case, collapsing whitespace, and a
 * non-Latin script. Adding an input changes every identity, which is correct: it is a new distinction two folds may
 * differ on. Never reorder — identity is order-dependent.
 */
export const FOLD_PROBE_CORPUS: readonly string[] = [
	"Besançon",
	"Le Pré-Saint-Gervais",
	"Ångström",
	"São Paulo - SP",
	"Tel Aviv-Yafo",
	"Co. Westmeath",
	"L'Haÿ-les-Roses",
	"  MIXED   Case  ",
	"ХУД - 15 хороо",
	"Đường Trần Hưng Đạo",
]

/**
 * The separator between probe outputs in a fold identity: a control character no fold emits, so two outputs cannot run
 * together and read as one.
 */
const IDENTITY_SEPARATOR = "\u0001"

/**
 * Identify a fold by its BEHAVIOR over {@link FOLD_PROBE_CORPUS} — a name cannot do this job.
 *
 * Two folds that compute the same answers are interchangeable and share an identity, which is the property the
 * exclusion check needs: it is asking "was this key built by a fold equivalent to mine", not "were these two functions
 * written in the same file".
 *
 * Deliberately NOT a cryptographic hash: the string is meant to be readable in a derivation and a diff, so a reviewer
 * can see WHICH probe moved when an identity changes.
 */
export function foldIdentity(fold: (s: string) => string): string {
	return FOLD_PROBE_CORPUS.map((probe) => fold(probe)).join(IDENTITY_SEPARATOR)
}
