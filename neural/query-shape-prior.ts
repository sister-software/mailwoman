/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Soft-prior emission biases derived from `QueryShape`.
 *
 *   When the QueryShape sub-system has identified a known-format span (US ZIP, UK postcode, PO box,
 *   etc.), this module produces an additive bias matrix that nudges the encoder's per-token
 *   emissions toward the matching BIO label. The biases compose with the structural BIO mask in the
 *   Viterbi decoder — confident encoder predictions still win, but uncertain ones get pulled toward
 *   the format-implied label.
 *
 *   Bitter-lesson-safe boundary: we don't override the encoder, just bias it. The encoder remains the
 *   authority on context-dependent calls (the "Buffalo Wild Wings, Buffalo, NY" disambiguation);
 *   the QueryShape prior helps on the easy cases (a 5-digit token is _probably_ a postcode).
 *
 *   Uses structural typing for the QueryShape input so this module has zero dependencies on
 *   `@mailwoman/query-shape` — consumers compute the shape with that package, pass it in here.
 */

/**
 * Minimal subset of `QueryShape` this module consumes. Compatible with `@mailwoman/query-shape`'s
 * exported `QueryShape` type by shape — no import required.
 */
export interface QueryShapeLike {
	knownFormats: ReadonlyArray<KnownFormatHitLike>
}

export interface KnownFormatHitLike {
	format: string
	span: { start: number; end: number }
	/** 0..1; ambiguous patterns (e.g. 5-digit US/FR/DE overlap) score lower. */
	confidence: number
}

/** Minimal subset of `TokenizedPiece` this module consumes. */
export interface TokenLike {
	start: number
	end: number
}

/**
 * Mapping from `KnownFormat` strings to the BIO label that should be boosted. Multiple formats may
 * map to the same label (all postcode flavors → `B-postcode`).
 */
const FORMAT_TO_LABEL: ReadonlyMap<string, string> = new Map([
	["us_zip", "B-postcode"],
	["us_zip4", "B-postcode"],
	["fr_postcode", "B-postcode"],
	["de_postcode", "B-postcode"],
	["uk_postcode", "B-postcode"],
	["ca_postcode", "B-postcode"],
	["jp_postcode", "B-postcode"],
	["po_box", "B-po_box"],
])

export interface BuildPriorsOpts {
	/**
	 * Maximum bias magnitude (in log-odds units). Default 1.0 — adds up to ~e^1 ≈ 2.7× odds to the
	 * favored label. Confidence-scaled, so a 0.6-confidence format hit gets +0.6 max bias.
	 */
	biasScale?: number
}

/**
 * Build a `[seqLen][numLabels]` matrix of additive log-bias to be added to encoder emissions before
 * Viterbi decoding.
 *
 * For each (token, format-hit) pair where the token's character span overlaps the hit's span, the
 * matrix entry for the format's mapped label receives `hit.confidence × biasScale`. Tokens that
 * don't overlap any hit, or for which no label mapping exists, get 0.
 *
 * Returns the all-zeros matrix if `shape.knownFormats` is empty — composes harmlessly.
 */
export function buildEmissionPriors(
	shape: QueryShapeLike,
	tokens: ReadonlyArray<TokenLike>,
	labels: ReadonlyArray<string>,
	opts: BuildPriorsOpts = {}
): number[][] {
	const T = tokens.length
	const L = labels.length
	const biasScale = opts.biasScale ?? 1.0
	const matrix: number[][] = []
	for (let t = 0; t < T; t++) matrix.push(new Array<number>(L).fill(0))

	if (shape.knownFormats.length === 0) return matrix

	// Index label → column for fast lookup.
	const labelToCol = new Map<string, number>()
	for (let k = 0; k < labels.length; k++) labelToCol.set(labels[k]!, k)

	for (const hit of shape.knownFormats) {
		const targetLabel = FORMAT_TO_LABEL.get(hit.format)
		if (!targetLabel) continue
		const col = labelToCol.get(targetLabel)
		if (col === undefined) continue
		const bias = hit.confidence * biasScale
		for (let t = 0; t < T; t++) {
			const tok = tokens[t]!
			if (overlaps(tok, hit.span)) {
				matrix[t]![col] = Math.max(matrix[t]![col]!, bias)
			}
		}
	}

	return matrix
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
	return a.start < b.end && b.start < a.end
}

/** Element-wise add two matrices of equal shape. Returns a new matrix. */
export function addEmissionMatrix(emissions: number[][], priors: number[][]): number[][] {
	if (priors.length === 0) return emissions.map((row) => row.slice())
	const out: number[][] = []
	for (let t = 0; t < emissions.length; t++) {
		const e = emissions[t]!
		const p = priors[t] ?? new Array<number>(e.length).fill(0)
		const row = new Array<number>(e.length)
		for (let k = 0; k < e.length; k++) row[k] = e[k]! + (p[k] ?? 0)
		out.push(row)
	}
	return out
}
