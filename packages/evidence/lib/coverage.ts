/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The exclusion check. An {@link Exclusion} is the only evidence kind that can act on an absence, so it is the only
 * one with no public constructor: {@link requireExclusionBasis} is the sole way to make one and refuses far more often
 * than it admits.
 *
 * Fold parity is a precondition rather than a detail: a key that "exists nowhere" may exist under a surface we did
 * not probe, so the probe must name the fold it used and the layer must name the fold its builder wrote, and a
 * mismatch is a refusal rather than an exclusion.
 */

/**
 * What a `completeness` value rests on; only {@link CoverageBasis.Designated} and
 * {@link CoverageBasis.Surveyed} can support an exclusion, since {@link CoverageBasis.SourcePresent}
 * records that the source looked, which is not the same as the source having found everything.
 */
export const CoverageBasis = {
	/**
	 * An authority declares the set complete for this cell, so a miss inside it is evidence of absence.
	 */
	Designated: "designated",
	/**
	 * We measured completeness ourselves against an independent reference,
	 * so a miss is evidence of absence in proportion to the value.
	 */
	Surveyed: "surveyed",
	/**
	 * The source returned rows in this cell, which makes no statement about what it missed,
	 * so a miss here is unknown and never absence.
	 */
	SourcePresent: "source_present",
} as const

export type CoverageBasis = (typeof CoverageBasis)[keyof typeof CoverageBasis]

/**
 * Whether a coverage reading can support an exclusion; absence is only supportable
 * from a designated or surveyed basis (presence is supportable from any),
 * so callers building negative evidence must check this rather than `completeness` alone
 * or an exclusion fires identically on a genuinely empty cell and on one we never surveyed.
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
	 * The fold both the layer's builder and this probe used; their agreement is what licensed the exclusion.
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
	 * The layer's coverage row for this cell; `undefined` means the cell is absent from
	 * `layer_coverage`, which is unknown and never a zero-completeness record.
	 */
	cell: { basis?: CoverageBasis | null } | undefined
	/**
	 * Identity of the fold this probe folded its key with, derived with {@link foldIdentity} rather than
	 * a hand-written label, because three packages export a `foldName` that computes different answers.
	 */
	probeFold: string
	/**
	 * Identity of the fold the layer's builder wrote its keys with, derived the same way.
	 */
	layerFold: string
	country?: string
	/**
	 * ISO-2 upper-case countries this probe can answer for; omit for an unscoped probe.
	 */
	countries?: ReadonlySet<string>
}

/**
 * The only constructor for an {@link Exclusion}; returns `null` — never throws — on every refusal,
 * because a refusal is the ordinary case and a caller must fail open to whatever ranking it already had.
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
 * Inputs a fold identity is computed over, each exercising an axis folds can
 * differ on (word-internal diacritics, hyphens, periods, apostrophes, case,
 * whitespace collapsing, non-Latin scripts); adding an input changes every identity,
 * and the order is load-bearing because identity is order-dependent.
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
 * The separator between probe outputs in a fold identity: a control character no fold emits,
 * so two outputs cannot run together and read as one.
 */
const IDENTITY_SEPARATOR = "\u0001"

/**
 * Identify a fold by its behavior over {@link FOLD_PROBE_CORPUS}: two folds that compute the same
 * answers share an identity, which is the property the exclusion check needs, and the string is
 * deliberately readable rather than a cryptographic hash so a reviewer can see which probe moved.
 */
export function foldIdentity(fold: (s: string) => string): string {
	return FOLD_PROBE_CORPUS.map((probe) => fold(probe)).join(IDENTITY_SEPARATOR)
}
