/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Distribution functions the release evaluator's confidence bounds need: the regularized incomplete beta
 *   function, its inverse, the Clopper–Pearson interval on a possibly fractional effective count, and the
 *   Student t quantile.
 */

/**
 * Term cap for the incomplete-beta continued fraction; it converges in well under 100 terms for
 * the parameters a release check produces, so the cap only guards against a non-converging input.
 */
const FRACTION_MAX_TERMS = 500

/**
 * Relative change at which the continued fraction stops: double-precision resolution.
 */
const FRACTION_TOLERANCE = 1e-15

/**
 * Bisection step cap for the beta quantile; 2^-200 is far below the tolerance, so the cap is never reached.
 */
const BISECTION_MAX_STEPS = 200

/**
 * Width at which the beta-quantile bisection stops, far finer than any reported bound.
 */
const BISECTION_TOLERANCE = 1e-12

const LANCZOS = [
	676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905,
	-0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
]

/**
 * Natural logarithm of the gamma function for `x > 0` (Lanczos, g = 7).
 */
export function logGamma(x: number): number {
	if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)

	const z = x - 1
	let sum = 0.9999999999998099

	for (const [i, c] of LANCZOS.entries()) {
		sum += c / (z + i + 1)
	}

	const t = z + LANCZOS.length - 0.5

	return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum)
}

/**
 * Continued fraction for the incomplete beta function (modified Lentz).
 */
function betaContinuedFraction(x: number, a: number, b: number): number {
	const tiny = 1e-300
	let c = 1
	let d = 1 - ((a + b) * x) / (a + 1)

	d = 1 / (Math.abs(d) < tiny ? tiny : d)

	let h = d

	for (let m = 1; m <= FRACTION_MAX_TERMS; m++) {
		const m2 = 2 * m
		let step = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))

		d = 1 + step * d
		d = 1 / (Math.abs(d) < tiny ? tiny : d)
		c = 1 + step / c
		c = Math.abs(c) < tiny ? tiny : c
		h *= d * c

		step = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
		d = 1 + step * d
		d = 1 / (Math.abs(d) < tiny ? tiny : d)
		c = 1 + step / c
		c = Math.abs(c) < tiny ? tiny : c

		const delta = d * c

		h *= delta

		if (Math.abs(delta - 1) < FRACTION_TOLERANCE) break
	}

	return h
}

/**
 * The regularized incomplete beta function `I_x(a, b)` for `a, b > 0`.
 */
export function regularizedBeta(x: number, a: number, b: number): number {
	if (!(a > 0 && b > 0)) throw new RangeError(`beta parameters must be positive, not ${a} and ${b}`)

	if (x <= 0) return 0

	if (x >= 1) return 1

	const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x))

	return x < (a + 1) / (a + b + 2)
		? (front * betaContinuedFraction(x, a, b)) / a
		: 1 - (front * betaContinuedFraction(1 - x, b, a)) / b
}

/**
 * The `p` quantile of a Beta(a, b) distribution, by bisection to 1e-12.
 */
export function betaQuantile(p: number, a: number, b: number): number {
	if (p <= 0) return 0

	if (p >= 1) return 1

	let lo = 0
	let hi = 1

	for (let i = 0; i < BISECTION_MAX_STEPS && hi - lo > BISECTION_TOLERANCE; i++) {
		const mid = (lo + hi) / 2

		if (regularizedBeta(mid, a, b) < p) {
			lo = mid
		} else {
			hi = mid
		}
	}

	return (lo + hi) / 2
}

/**
 * The Clopper–Pearson interval for `successes` of `n` trials, each side with tail probability `tail`.
 *
 * `successes` and `n` may be fractional, as an effective count under a design effect is;
 * the beta-quantile form extends the exact interval continuously.
 * Zero successes give a lower bound of 0 and `n` successes an upper bound of 1,
 * but the other bound never collapses onto the estimate.
 */
export function clopperPearson(successes: number, n: number, tail: number): { lower: number; upper: number } {
	if (!(n > 0)) throw new RangeError(`a Clopper–Pearson interval needs a positive count, not ${n}`)

	const x = Math.min(n, Math.max(0, successes))

	return {
		lower: x <= 0 ? 0 : betaQuantile(tail, x, n - x + 1),
		upper: x >= n ? 1 : betaQuantile(1 - tail, x + 1, n - x),
	}
}

/**
 * The upper `tail` quantile of Student's t with `df` degrees of freedom (`df` may be fractional).
 */
export function studentTUpperQuantile(tail: number, df: number): number {
	if (!(tail > 0 && tail < 0.5)) throw new RangeError(`a t tail must lie in (0, 0.5), not ${tail}`)

	if (!(df > 0)) throw new RangeError(`t degrees of freedom must be positive, not ${df}`)

	// P(|T| > t) = I_{df / (df + t^2)}(df / 2, 1 / 2).
	const x = betaQuantile(2 * tail, df / 2, 0.5)

	return Math.sqrt((df * (1 - x)) / x)
}
