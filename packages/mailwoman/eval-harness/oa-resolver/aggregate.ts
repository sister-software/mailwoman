/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Per-arm tallies for the OpenAddresses resolver eval, and the JSON shape a run dumps them in.
 */

import { percentile } from "@mailwoman/core/utils"

/**
 * What one arm reports for a single row: the admin-match flags plus the coordinate error the arm's own tier produced.
 * Every `neural+<tier>` arm reuses the neural arm's flags and substitutes only `err`, so an arm-to-arm delta isolates
 * exactly what the tier sharpens.
 */
export interface ArmOutcome {
	locMatch: boolean
	regMatch: boolean
	resolved: boolean
	err: number | null
}

/**
 * One arm's counters. `errs` is the raw per-row coordinate error list (km) the percentiles are taken over — kept whole
 * rather than streamed, because the report needs p50/p90/p99 from the same sample.
 */
export interface Agg {
	n: number
	localityMatch: number
	regionMatch: number
	resolved: number
	errs: number[]
}

/**
 * An arm's headline plus its per-state breakdown. Per-state aggregation keeps a single dense state (Cook County /
 * Chicago) from dominating the headline.
 */
export interface AggPair {
	overall: Agg
	byState: Map<string, Agg>
}

/**
 * A zeroed counter set.
 */
export function newAgg(): Agg {
	return { n: 0, localityMatch: 0, regionMatch: 0, resolved: 0, errs: [] }
}

/**
 * Fold one row's outcome into a single counter set.
 */
export function bump(a: Agg, locMatch: boolean, regMatch: boolean, resolved: boolean, err: number | null): void {
	a.n++

	if (locMatch) {
		a.localityMatch++
	}

	if (regMatch) {
		a.regionMatch++
	}

	if (resolved) {
		a.resolved++
	}

	if (err !== null) {
		a.errs.push(err)
	}
}

/**
 * Fold one row's outcome into an arm's per-state bucket AND its headline. A row with no state lands in `??` rather than
 * being dropped, so the per-state buckets always sum to the headline.
 */
export function recordInto(pair: AggPair, state: string | undefined, outcome: ArmOutcome): void {
	const st = state || "??"

	if (!pair.byState.has(st)) {
		pair.byState.set(st, newAgg())
	}

	bump(pair.byState.get(st)!, outcome.locMatch, outcome.regMatch, outcome.resolved, outcome.err)
	bump(pair.overall, outcome.locMatch, outcome.regMatch, outcome.resolved, outcome.err)
}

/**
 * The `--out-json` shape for one arm. `errs` is replaced by its length: the raw list is the eval's working set, not a
 * figure anyone reads, and a full run's would dwarf the rest of the dump.
 */
export function dumpAggPair(g: AggPair): Record<string, unknown> {
	return {
		overall: { ...g.overall, errs: undefined, errN: g.overall.errs.length },
		coord: {
			p50: percentile(g.overall.errs, 50),
			p90: percentile(g.overall.errs, 90),
			p99: percentile(g.overall.errs, 99),
		},
		byState: Object.fromEntries([...g.byState].map(([k, v]) => [k, { ...v, errs: undefined }])),
	}
}

/**
 * A fresh arm — headline plus an empty per-state map.
 */
export function newAggPair(): AggPair {
	return { overall: newAgg(), byState: new Map<string, Agg>() }
}
