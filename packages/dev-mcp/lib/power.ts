/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What a sample can and cannot support, expressed as a SENTENCE rather than a field.
 *
 *   The measured failure this exists for: on 2026-08-15 a probe fed 10 self-chosen addresses through a mechanism, saw
 *   no differences, and published "zero effect". Re-run over all 837 board inputs, the mechanism moved 24. Zero events
 *   in 10 trials rules out only rates above 25.9%; the true rate was 2.9%, so that panel had roughly a three-in-four
 *   chance of showing exactly what it showed and licensing the opposite of the truth.
 *
 *   The repair is placement. A bound in a `power` field is a bound that can be dropped on the way to the operator; a
 *   clause inside the sentence being quoted cannot be, without the quoter noticing they are editing it. So
 *   {@link describeObservedRate} returns prose that carries its own limits, and every measuring tool puts it in
 *   `summary`.
 */

/**
 * Exact one-sided Clopper–Pearson upper bound for ZERO observed events: `1 − α^(1/n)`.
 *
 * Exact rather than the rule-of-three approximation (`3/n`) because the two disagree most at small n, which is the only
 * place this is ever read: at n = 10 the exact bound is 0.259 and the approximation 0.300.
 */
export function zeroEventUpperBound(n: number, alpha = 0.05): number {
	if (n <= 0) return 1

	return 1 - Math.pow(alpha, 1 / n)
}

/**
 * Wilson score interval — the non-zero counterpart, and the same interval the gate specs already cut their floors from
 * (`gates/v9.0.0-base.json`'s `$margin_rationale`: "2 × the downward Wilson 95% half-width at the metric's own
 * support").
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
 * A JUDGEMENT, not a measurement — there is no experiment that fixes it. It is set at 1% because that is roughly the `n
 * = 300` mark (`1 − 0.05^(1/300) = 0.99%`), i.e. the point where a zero rests on a set larger than any panel anyone has
 * assembled by hand here. The 2026-08-15 probe used 10, whose bound is 25.9%.
 */
const ABSENCE_CLAIM_MAX_UPPER_BOUND = 0.01

/**
 * How an input set was chosen. `hand-picked` is the one that earns the extra sentence — a full board carries its own
 * denominator, and a declared slice carries the slice.
 *
 * `random-draw` is separate from `slice` because the two subsets support opposite claims. A declared slice is chosen by
 * a predicate and generalizes to nothing beyond it; a random draw from a 26-million-row register is the one subset here
 * whose rate estimates the population's. Collapsing them would print "declared-slice" over the only sample in this file
 * that is not one.
 */
export type Selection = "full" | "slice" | "hand-picked" | "random-draw"

/**
 * How each selection reads inside the observed-rate sentence. A full board says nothing — its denominator already is
 * the population — so it contributes an empty string; every other kind names itself where a reader will trip over it.
 */
const SELECTION_ADJECTIVE: Record<Selection, string> = {
	full: "",
	slice: "declared-slice ",
	"hand-picked": "hand-picked ",
	"random-draw": "randomly-drawn ",
}

export interface ObservedRate {
	events: number
	n: number
	selection: Selection
	/**
	 * What one event IS, in the caller's own words, e.g. "differed" or "regressed". Used to build the sentence.
	 */
	eventLabel: string
	/**
	 * The size of the set this sample was drawn from, when the caller took a subset of something larger. Naming it turns
	 * "0 of 10" into "0 of 10, out of 837 available", which is the comparison that makes a panel look small.
	 */
	populationN?: number
}

export interface PowerReading {
	events: number
	n: number
	selection: Selection
	upperBound95: number | null
	interval95: { low: number; high: number } | null
	/**
	 * The sentence. Callers put this in `summary` verbatim — see the module docstring for why it is prose.
	 */
	sentence: string
	/**
	 * True when the sample cannot support a claim of absence. Machine-readable so a wrapper can act on it, but it is the
	 * sentence that does the work.
	 */
	supportsAbsenceClaim: boolean
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`
}

/**
 * Turn a count into a reading that states its own limits.
 *
 * The zero case is the one that matters and gets the strongest wording: a zero is not a measurement of absence unless
 * the denominator is large enough to have detected the thing. This is the repo's standing meaning-of-zero rule aimed at
 * the agent's own probes rather than at a coverage cell.
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
