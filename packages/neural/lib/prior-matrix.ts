/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared construction for the additive emission-prior builders (`query-shape-prior.ts`,
 *   `fst-prior.ts`, `street-morphology-prior.ts`, `span-proposal-prior.ts`,
 *   `placetype-pair-prior.ts`). Every builder starts from the same all-zeros `[seqLen][numLabels]`
 *   matrix and the same label→column index; what each writes into the matrix is its own contract and
 *   stays in place.
 */

/**
 * The all-zeros `[seqLen][numLabels]` additive bias matrix — composes harmlessly via `addEmissionMatrix`.
 */
export function emptyPriorMatrix(seqLen: number, numLabels: number): number[][] {
	const matrix: number[][] = []

	for (let t = 0; t < seqLen; t++) {
		matrix.push(new Array<number>(numLabels).fill(0))
	}

	return matrix
}

/**
 * Index label → column for fast bias writes.
 */
export function labelColumnIndex(labels: ReadonlyArray<string>): Map<string, number> {
	const labelToCol = new Map<string, number>()

	for (let k = 0; k < labels.length; k++) {
		labelToCol.set(labels[k]!, k)
	}

	return labelToCol
}
