/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Label-bigram transition potentials counted over encoded training rows, in the `crf-transitions.json` shape the
 *   classifier adds to its BIO masks.
 */

/**
 * The counts one fit accumulates: `transitions[a][b]` is the number of times label
 * `b` follows label `a` on adjacent labeled positions of one row.
 */
export interface TransitionCounts {
	labels: readonly string[]
	rows: number
	transitions: number[][]
	starts: number[]
	ends: number[]
}

export function emptyTransitionCounts(labels: readonly string[]): TransitionCounts {
	const n = labels.length

	return {
		labels,
		rows: 0,
		transitions: Array.from({ length: n }, () => new Array<number>(n).fill(0)),
		starts: new Array<number>(n).fill(0),
		ends: new Array<number>(n).fill(0),
	}
}

/**
 * Adds one encoded batch's labels, `[rows, width]` in row-major order.
 *
 * A position labeled `ignoreIndex` (padding, special pieces and inactive tags) is skipped,
 * so the labeled positions on either side of it count as adjacent.
 *
 * @throws When a label id is outside the label list.
 */
export function countBatchTransitions(
	counts: TransitionCounts,
	labels: BigInt64Array,
	rows: number,
	width: number,
	ignoreIndex: number
): void {
	const n = counts.labels.length

	for (let row = 0; row < rows; row++) {
		let previous = -1

		for (let position = 0; position < width; position++) {
			const id = Number(labels[row * width + position])

			if (id === ignoreIndex) continue

			if (id < 0 || id >= n) throw new Error(`label id ${id} at row ${row} is outside the ${n} labels`)

			if (previous === -1) {
				counts.starts[id]!++
			} else {
				counts.transitions[previous]![id]!++
			}

			previous = id
		}

		if (previous !== -1) {
			counts.ends[previous]!++

			counts.rows++
		}
	}
}

/**
 * The fitted potentials: each row of counts gets add-one smoothing, becomes log-probabilities,
 * and is shifted so its most frequent successor scores 0.
 *
 * The shift keeps the potentials a penalty relative to the BIO mask's 0 for a permitted move,
 * instead of adding a large negative constant to every step.
 */
export interface FittedTransitions {
	labels: readonly string[]
	rows_counted: number
	transitions: number[][]
	start_transitions: number[]
	end_transitions: number[]
}

function centeredLogProbabilities(counts: readonly number[]): number[] {
	const total = counts.reduce((sum, count) => sum + count + 1, 0)
	const logs = counts.map((count) => Math.log((count + 1) / total))
	const peak = Math.max(...logs)

	return logs.map((value) => value - peak)
}

export function fitTransitions(counts: TransitionCounts): FittedTransitions {
	return {
		labels: counts.labels,
		rows_counted: counts.rows,
		transitions: counts.transitions.map(centeredLogProbabilities),
		start_transitions: centeredLogProbabilities(counts.starts),
		end_transitions: centeredLogProbabilities(counts.ends),
	}
}

/**
 * Multiplies every potential by `temperature`.
 *
 * The emissions were not trained against these potentials, so their relative weight is a free parameter.
 */
export function scaleTransitions(fitted: FittedTransitions, temperature: number): FittedTransitions {
	const scale = (row: number[]) => row.map((value) => value * temperature)

	return {
		...fitted,
		transitions: fitted.transitions.map(scale),
		start_transitions: scale(fitted.start_transitions),
		end_transitions: scale(fitted.end_transitions),
	}
}
