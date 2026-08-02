/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Python-parity numeric helpers — the third member of the `python-*` family in this directory,
 *   beside `python-json.ts` (CPython `json.dumps` spacing) and `python-random.ts` (`random.Random`).
 *
 *   These exist because the gazetteer pipeline was ported from Python and its outputs have to match
 *   the originals bit for bit: a postcode centroid that rounds differently is a different centroid,
 *   and the shard it lands in is a different shard. Four files each carried byte-identical copies
 *   before the 2026-08-02 dedupe — four chances for one of them to drift from the reference, and
 *   the drift would only surface as a shard that quietly disagrees.
 */

/**
 * Digit at which a fractional remainder is exactly half. Above it the value rounds up; at it the tie is broken toward
 * even, which is what keeps repeated centroid rounding unbiased.
 */
const ROUND_HALF_DIGIT = 5

/**
 * Increment a non-negative decimal-digit string, propagating the carry (e.g. "999" → "1000").
 */
export function incDecimalString(s: string): string {
	const a = s.split("")
	let i = a.length - 1

	for (; i >= 0; i--) {
		if (a[i] === "9") {
			a[i] = "0"
		} else {
			a[i] = String(Number(a[i]) + 1)

			break
		}
	}

	if (i < 0) {
		a.unshift("1")
	}

	return a.join("")
}

/**
 * Python `round()` — correctly-rounded, round-half-to-EVEN. Works off the double's EXACT (terminating) decimal
 * expansion via `toFixed(80)`, so it matches Python both on ordinary values (where a naïve `x * 10**nd` would diverge
 * by a ULP) and on exact half-way ties like `40.890625` → `40.89062` (where `toFixed(nd)` rounds half-UP and would
 * diverge). `nd === 0` keeps a fast half-even path on the double.
 */
export function pyRound(x: number, nd = 0): number {
	if (!Number.isFinite(x)) return x

	if (nd === 0) {
		const floor = Math.floor(x)
		const diff = x - floor

		if (diff < 0.5) return floor

		if (diff > 0.5) return floor + 1

		return floor % 2 === 0 ? floor : floor + 1
	}

	const neg = x < 0
	const digits = Math.abs(x).toFixed(20) // exact expansion for any coord/distance-range double
	const dot = digits.indexOf(".")
	const intPart = digits.slice(0, dot)
	const frac = digits.slice(dot + 1)
	const keep = frac.slice(0, nd)
	const rest = frac.slice(nd)
	let roundUp = false
	const first = rest.charCodeAt(0) - 48

	if (first > ROUND_HALF_DIGIT) {
		roundUp = true
	} else if (first === ROUND_HALF_DIGIT) {
		if (/[1-9]/.test(rest.slice(1))) {
			roundUp = true
		} else {
			// exact half → round to even
			const lastKept = keep.length ? keep.charCodeAt(keep.length - 1) - 48 : Number(intPart) % 10
			roundUp = lastKept % 2 === 1
		}
	}

	let combined = intPart + keep

	if (roundUp) {
		combined = incDecimalString(combined)
	}

	const num = Number(combined) / 10 ** nd

	return neg ? -num : num
}

/**
 * Python `float()`: trimmed-empty / non-numeric → null (the build's try/except skip).
 */
export function pyFloat(s: string | undefined): number | null {
	if (s === undefined) return null
	const t = s.trim()

	if (t === "") return null
	const n = Number(t)

	return Number.isNaN(n) ? null : n
}
