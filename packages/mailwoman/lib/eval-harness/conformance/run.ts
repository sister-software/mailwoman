/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Running a conformance-law suite through the same pipeline the Gauntlet runs, with both sides observed every time and `undecidable` counted as a violation.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import { type ComparatorReading, compareOutcomes, type ConformanceOutcome } from "#eval-harness/conformance/comparators"
import type { ConformanceContext, ConformanceFixture } from "#eval-harness/conformance/fixture"
import type { GauntletDeps } from "#eval-harness/gauntlet/harness"
import { toGauntletResult } from "#eval-harness/gauntlet/harness"

/**
 * Produces one side of a law, letting a caller attach trace and mechanism-account detail
 * rather than this module reaching for a private workspace.
 */
export type ConformanceObserver = (
	query: string,
	context: ConformanceContext | undefined
) => Promise<ConformanceOutcome>

/**
 * One fixture's result.
 */
export interface ConformanceFinding {
	fixture: ConformanceFixture
	reading: ComparatorReading
	/**
	 * Whether the observed relation matched the expected one; `undecidable` never holds.
	 */
	held: boolean
}

/**
 * Wraps a Gauntlet `geocode` as an observer projecting through `toGauntletResult`,
 * with no mechanism account attached.
 */
export function gauntletObserver(geocode: GauntletDeps["geocode"]): ConformanceObserver {
	return async (query, context) => ({ result: toGauntletResult(await geocode(query, context)) })
}

/**
 * The same observer with one trace record per backend lookup attached, a second function
 * rather than a flag because the bookkeeping is a real cost.
 */
export function tracedGauntletObserver(geocodeTraced: GauntletDeps["geocodeTraced"]): ConformanceObserver {
	return async (query, context) => {
		const { result, resolver } = await geocodeTraced(query, context)

		return { result: toGauntletResult(result), candidates: resolver }
	}
}

/**
 * Runs every fixture and reports which laws held, with an empty suite returning `pass: false`
 * because reporting an empty run as passing is how a mis-pointed fixture path becomes a green check.
 */
export async function runConformanceFixtures(
	fixtures: readonly ConformanceFixture[],
	observe: ConformanceObserver
): Promise<{ pass: boolean; findings: ConformanceFinding[] }> {
	const findings: ConformanceFinding[] = []

	for (const fixture of fixtures) {
		const base = await observe(fixture.base, fixture.context)
		const variant = await observe(fixture.variant, fixture.context)
		const reading = compareOutcomes(fixture, base, variant)

		findings.push({ fixture, reading, held: reading.observed === fixture.expect })
	}

	return { pass: fixtures.length > 0 && findings.every((finding) => finding.held), findings }
}

/**
 * A run split by what each finding means for the verdict.
 */
export interface ConformanceSummary {
	/**
	 * Findings from `status: pass` rows that were violated.
	 * These, and only these, decide {@linkcode pass}.
	 */
	failures: ConformanceFinding[]
	/**
	 * Findings from tracked rows still violated — reported, never blocking.
	 */
	tracked: ConformanceFinding[]
	/**
	 * Tracked rows whose law now holds, printed as a promotion instruction because a tracked
	 * list that retains resolved defects stops describing the current known set.
	 */
	newlyHolding: ConformanceFinding[]
	/**
	 * Rows whose comparator read its axis but could not decide, left out of the hold ratio
	 * because the run has no evidence the law broke or held.
	 */
	unmeasured: ConformanceFinding[]
	/**
	 * How many rows were admitted and decided, the denominator the pass count needs before it means anything.
	 */
	decided: number
	pass: boolean
}

/**
 * Splits a run by row status, mirroring the Gauntlet regression layer,
 * and reports `pass: false` when no enforcing row was decided.
 */
export function summarizeConformanceRun(findings: readonly ConformanceFinding[]): ConformanceSummary {
	const failures: ConformanceFinding[] = []
	const tracked: ConformanceFinding[] = []
	const newlyHolding: ConformanceFinding[] = []
	const unmeasured: ConformanceFinding[] = []
	let decided = 0

	for (const finding of findings) {
		const blocking = (finding.fixture.status ?? "pass") === "pass"

		// Read before the status split and on tracked rows too, since an unmeasured tracked row has not started holding.
		if (finding.reading.observed === "unmeasured") {
			unmeasured.push(finding)

			continue
		}

		if (blocking) {
			decided += 1

			if (!finding.held) {
				failures.push(finding)
			}
		} else if (finding.held) {
			newlyHolding.push(finding)
		} else {
			tracked.push(finding)
		}
	}

	return { failures, tracked, newlyHolding, unmeasured, decided, pass: decided > 0 && failures.length === 0 }
}

/**
 * Renders one finding as the line a law suite prints, naming the row it came from
 * so a violation is not a claim about a synthetic pair.
 */
export function formatConformanceFinding(finding: ConformanceFinding): string {
	const { fixture, reading, held } = finding
	const rowRef = fixture.rowRef ? ` (row ${fixture.rowRef})` : ""
	const tracked = fixture.status && fixture.status !== "pass"
	const status = tracked ? ` [${fixture.status}${fixture.bugRef ? ` ${fixture.bugRef}` : ""}]` : ""
	const mark = reading.observed === "unmeasured" ? "?" : held ? "✓" : tracked ? "~" : "✗"

	const head =
		`${mark} [${fixture.law}] ${fixture.id}${status}${rowRef} · ${fixture.outcomeComparator} ` +
		`expected ${fixture.expect}, observed ${reading.observed}`

	const lines = [
		head,
		`    base    : ${stringifyJSON(fixture.base)}`,
		`    variant : ${stringifyJSON(fixture.variant)}`,
		`    basis   : ${reading.basis}`,
	]

	if (fixture.context) {
		lines.push(`    context : ${stringifyJSON(fixture.context)}`)
	}

	for (const difference of reading.differences) {
		lines.push(`    - ${difference}`)
	}

	return lines.join("\n")
}
