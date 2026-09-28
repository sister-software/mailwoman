/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module implements numerically stable softmax and log-sum-exp for the coarse-placer's linear model.
 *   Always-resident inference ({@link CoarsePlacer.predict}) uses it.
 *   The SGD trainer uses it. Open-set score comparison uses it too.
 *   The implementation finds maxima with loops. Spreading an array near 65k features risks a stack overflow.
 *   The loop also keeps floating-point evaluation order identical across callers.
 */

/**
 * The numeric containers the coarse-placer moves logits through.
 */
export type LogitVector = Float32Array | Float64Array | number[]

/**
 * Numerically-stable softmax of `logits` written into `out` (same length).
 *
 * The max is subtracted before exponentiation.
 * The sum is accumulated in index order and divided through in a second pass,
 * so a caller replacing an inline softmax sees bit-identical floats.
 */
export function softmaxInto(logits: LogitVector, out: LogitVector): void {
	let max = -Infinity

	for (const logit of logits) {
		if (logit > max) {
			max = logit
		}
	}

	let sum = 0

	for (let i = 0; i < logits.length; i++) {
		const e = Math.exp(logits[i]! - max)
		out[i] = e
		sum += e
	}

	for (let i = 0; i < out.length; i++) {
		out[i] = out[i]! / sum
	}
}

/**
 * Log-sum-exp of `xs` with the max factored out: `max + log(Σ exp(x − max))`.
 */
export function logsumexp(xs: LogitVector): number {
	let max = -Infinity

	for (const x of xs) {
		if (x > max) {
			max = x
		}
	}

	let sum = 0

	for (const x of xs) {
		sum += Math.exp(x - max)
	}

	return max + Math.log(sum)
}
