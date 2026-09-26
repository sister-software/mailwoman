/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Every measuring tool puts {@link describeObservedRate}'s prose in `summary`, because a bound in a separate
 * `power` field can be dropped on the way to the operator.
 */

/**
 * Exact one-sided Clopper–Pearson upper bound for zero observed events: `1 − α^(1/n)`.
 *
 * Exact rather than the rule-of-three approximation, which diverges most at the small n where this is read.
 */
export function zeroEventUpperBound(n: number, alpha = 0.05): number {
	if (n <= 0) return 1

	return 1 - Math.pow(alpha, 1 / n)
}

/**
 * Wilson score interval — the non-zero counterpart, and the same interval the
 * eval specs derive their floors from.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } {
	if (n <= 0) return { low: 0, high: 1 }

	const p = successes / n
	const z2 = z * z
	const denominator = 1 + z2 / n
	const centre = p + z2 / (2 * n)
	const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)

	return {
		low: Math.max(0, (centre - spread) / denominator),
		high: Math.min(1, (centre + spread) / denominator),
	}
}

/**
 * How tight the upper bound must be before a zero may be read as a real absence.
 *
 * A judgement, not a measurement: 1% is roughly the `n = 300` mark (`1 − 0.05^(1/300) = 0.99%`),
 * where a zero rests on a set larger than any panel assembled by hand here.
 */
const ABSENCE_CLAIM_MAX_UPPER_BOUND = 0.01

/**
 * How an input set was chosen; `random-draw` stays separate from `subset` because a declared subset
 * generalizes to no rows beyond its predicate, while a random draw's rate estimates the population's.
 */
export type Selection = "full" | "subset" | "hand-picked" | "random-draw"

/**
 * How each selection reads inside the observed-rate sentence; a full board adds no qualifier
 * because its denominator already is the population.
 */
const SELECTION_ADJECTIVE: Record<Selection, string> = {
	full: "",
	subset: "declared-subset ",
	"hand-picked": "hand-picked ",
	"random-draw": "randomly-drawn ",
}

/**
 * A rate measured over a sample, with the sample it was measured over.
 */
export interface ObservedRate {
	events: number
	n: number
	selection: Selection
	/**
	 * What one event is, in the caller's own words, e.g. "differed" or "regressed".
	 */
	eventLabel: string
	/**
	 * The size of the set this sample was drawn from, when the caller took a subset of something larger.
	 */
	populationN?: number
}

/**
 * What {@link describeObservedRate} returns: the sentence plus the machine-readable reading behind it.
 */
export interface PowerReading {
	events: number
	n: number
	selection: Selection
	upperBound95: number | null
	interval95: { low: number; high: number } | null
	/**
	 * The sentence callers put in `summary` verbatim.
	 */
	sentence: string
	/**
	 * True when the sample cannot support a claim of absence; the sentence does the work,
	 * this only lets a wrapper branch on it.
	 */
	supportsAbsenceClaim: boolean
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`
}

/**
 * Turn a count into a reading that states its own limits; a zero is not a measurement
 * of absence unless the denominator is large enough to have detected the thing.
 */
export function describeObservedRate(observed: ObservedRate): PowerReading {
	const { events, n, selection, eventLabel, populationN } = observed
	const outOf = populationN && populationN > n ? `, out of ${populationN} available` : ""
	const picked = SELECTION_ADJECTIVE[selection]

	if (n === 0) {
		return {
			events: 0,
			n: 0,
			selection,
			upperBound95: null,
			interval95: null,
			sentence: `No inputs were evaluated, so nothing was measured. This is not a zero rate; it is the absence of a measurement.`,
			supportsAbsenceClaim: false,
		}
	}

	if (events === 0) {
		const bound = zeroEventUpperBound(n)
		const strong = bound < ABSENCE_CLAIM_MAX_UPPER_BOUND

		return {
			events: 0,
			n,
			selection,
			upperBound95: bound,
			interval95: null,
			sentence: strong
				? `0 of ${n} ${picked}inputs ${eventLabel}${outOf} — consistent with any true rate below ${percent(bound)}, which is tight enough to read as a real absence.`
				: `0 of ${n} ${picked}inputs ${eventLabel}${outOf} — consistent with any true rate below ${percent(bound)}, so this CANNOT support a claim of no effect.`,
			supportsAbsenceClaim: strong,
		}
	}

	const interval = wilsonInterval(events, n)
	const rate = events / n

	return {
		events,
		n,
		selection,
		upperBound95: null,
		interval95: interval,
		sentence: `${events} of ${n} ${picked}inputs ${eventLabel}${outOf} — ${percent(rate)}, 95% CI ${percent(interval.low)}–${percent(interval.high)}.`,
		supportsAbsenceClaim: false,
	}
}
