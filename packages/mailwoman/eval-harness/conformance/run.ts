/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Running a conformance-law suite, and saying what a violation was.
 *
 *   NO SECOND HARNESS. A fixture is graded by running the SAME pipeline the Gauntlet runs, through an
 *   observer the caller supplies — `gauntletObserver` wraps `buildGauntletDeps`'s own `geocode` and projects
 *   it with `toGauntletResult`, the projection the board's grader and the warm-engine tools already share. A
 *   law suite is therefore a Gauntlet layer's worth of machinery plus a fixture file, not a parallel runner
 *   with its own model loading, its own weights ladder and its own idea of what a result is.
 *
 *   BOTH SIDES ARE OBSERVED, EVERY TIME. Nothing here caches by query, because a fixture whose base and
 *   variant are the same string is the identity law — two independent runs that must agree — and answering
 *   the second one from a cache would turn the strongest available nondeterminism check into a tautology.
 *
 *   `undecidable` IS A VIOLATION. A comparator that could not read its axis has not found a law holding; it
 *   has found nothing, and a suite that counted it as a pass would report the same total as a suite that
 *   genuinely held.
 */

import type { GauntletDeps } from "../gauntlet/harness.ts"
import { toGauntletResult } from "../gauntlet/harness.ts"
import { type ComparatorReading, compareOutcomes, type ConformanceOutcome } from "./comparators.ts"
import type { ConformanceContext, ConformanceFixture } from "./fixture.ts"

/**
 * Produce one side of a law: run `query` under `context` and return what the comparators read.
 *
 * The seam exists so a caller that can say MORE about a run than the assembled result — `@mailwoman/dev-mcp`, which
 * holds the trace and the mechanism-account predicates — attaches its shapes here rather than this module reaching for
 * a private workspace it must not depend on.
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
	 * Did the observed relation match the expected one? `undecidable` never holds.
	 */
	held: boolean
}

/**
 * Wrap a Gauntlet `geocode` as an observer, projecting through `toGauntletResult`.
 *
 * Takes the function rather than the whole {@linkcode GauntletDeps} so a law suite can hand over a warm session's
 * geocode without this module acquiring an opinion about how the engine was built. No mechanism account is attached —
 * the shape vocabulary lives in the private dev-mcp workspace, and an observer that wants shapes supplies its own.
 */
export function gauntletObserver(geocode: GauntletDeps["geocode"]): ConformanceObserver {
	return async (query, context) => ({ result: toGauntletResult(await geocode(query, context)) })
}

/**
 * Run every fixture and report which laws held.
 *
 * `pass` is true only when every fixture held. A suite with no fixtures returns `pass: false`: an empty run is not a
 * clean run, and reporting one as passing is how a mis-pointed fixture path becomes a green gate.
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
	 * Findings from `status: pass` rows that were violated. These, and only these, decide {@linkcode pass}.
	 */
	failures: ConformanceFinding[]
	/**
	 * Findings from tracked rows still violated — reported, never blocking.
	 */
	tracked: ConformanceFinding[]
	/**
	 * Tracked rows whose law now holds. Printed as a promotion instruction: a tracked list nobody prunes stops being a
	 * record of known defects and becomes a place rows go to be forgotten.
	 */
	newlyHolding: ConformanceFinding[]
	/**
	 * How many rows GATED — the denominator a reader needs before the pass count means anything.
	 */
	gated: number
	pass: boolean
}

/**
 * Split a run by row status, mirroring the Gauntlet regression layer's own three-way reading.
 *
 * `pass` is false on an EMPTY findings list for the same reason {@linkcode runConformanceFixtures} refuses an empty
 * suite, and false on a suite with no gating rows at all: a run whose every row is tracked has measured nothing that
 * could fail, and reporting it as a pass is how a suite quietly stops holding anything.
 */
export function summarizeConformanceRun(findings: readonly ConformanceFinding[]): ConformanceSummary {
	const failures: ConformanceFinding[] = []
	const tracked: ConformanceFinding[] = []
	const newlyHolding: ConformanceFinding[] = []
	let gated = 0

	for (const finding of findings) {
		const gates = (finding.fixture.status ?? "pass") === "pass"

		if (gates) {
			gated += 1

			if (!finding.held) {
				failures.push(finding)
			}
		} else if (finding.held) {
			newlyHolding.push(finding)
		} else {
			tracked.push(finding)
		}
	}

	return { failures, tracked, newlyHolding, gated, pass: gated > 0 && failures.length === 0 }
}

/**
 * Render one finding as the line a law suite prints.
 *
 * Names, in this order: the law, the fixture id, the committed row it was drawn from when it has one, the comparator,
 * the expected and observed relations, both queries, what the comparator read, and every difference it found. A
 * violation reported without the row it came from is a claim about a synthetic pair; with it, a reader can go back to
 * the population and ask how common the shape is.
 */
export function formatConformanceFinding(finding: ConformanceFinding): string {
	const { fixture, reading, held } = finding
	const rowRef = fixture.rowRef ? ` (row ${fixture.rowRef})` : ""
	const tracked = fixture.status && fixture.status !== "pass"
	const status = tracked ? ` [${fixture.status}${fixture.bugRef ? ` ${fixture.bugRef}` : ""}]` : ""
	const mark = held ? "✓" : tracked ? "~" : "✗"

	const head =
		`${mark} [${fixture.law}] ${fixture.id}${status}${rowRef} · ${fixture.outcomeComparator} ` +
		`expected ${fixture.expect}, observed ${reading.observed}`

	const lines = [
		head,
		`    base    : ${JSON.stringify(fixture.base)}`,
		`    variant : ${JSON.stringify(fixture.variant)}`,
		`    basis   : ${reading.basis}`,
	]

	if (fixture.context) {
		lines.push(`    context : ${JSON.stringify(fixture.context)}`)
	}

	for (const difference of reading.differences) {
		lines.push(`    - ${difference}`)
	}

	return lines.join("\n")
}
