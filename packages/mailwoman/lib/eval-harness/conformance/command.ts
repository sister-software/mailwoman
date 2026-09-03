/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI-facing orchestration for `mailwoman eval conformance` — load the law suites, audit them, run every
 *   row through the Gauntlet's own deps, and report. Thin on purpose: it narrates and owns only the exit
 *   code, matching `eval invariance` and `eval promote`.
 *
 *   EVERY COMMITTED SUITE RUNS BY DEFAULT. {@linkcode CONFORMANCE_SUITES} is the register, and a default run
 *   is all of it: a default that named ONE suite would leave every later law executable only by someone who
 *   remembered to point `--suite` at it, and a law nobody runs reports as an absence rather than a failure.
 *   `--suite` narrows to a single file for an author iterating on one.
 *
 *   THE AUDIT RUNS BEFORE THE ENGINE LOADS. A law suite's rows can be wrong in ways no amount of geocoding
 *   reveals — a pair that differs by more than case still runs, still produces a reading, and still reports a
 *   violation, which a reader then attributes to the pipeline. Auditing first means an unrunnable suite costs
 *   a second rather than a model load, and costs nobody a wrong diagnosis.
 *
 *   A TRACKED ROW IS RUN. The verdict splits by status the way the Gauntlet regression layer splits: `pass`
 *   rows check, tracked rows report, and a tracked row that starts holding prints a promotion instruction. A
 *   red row is never removed to make the exit code zero.
 *
 *   THE OBSERVER IS CHOSEN FROM THE ROWS. `candidate_admissibility` reads the resolver's interior, which the
 *   walk records only when a sink asks it to; the other five comparators read the assembled answer and would
 *   pay for bookkeeping nobody reads. So the run picks the traced observer exactly when a loaded row names
 *   that comparator, and says which one it picked.
 *
 *   AN UNMEASURED ROW IS NOT A QUIET PASS. It is printed in its own section with the window that stopped the
 *   reading, and it is removed from the row count the verdict is stated over — so the headline is a ratio of
 *   rows that were actually DECIDED, and a suite that stops being able to decide anything reports FAIL.
 *
 *   A LAW MAY REPORT ITS OWN BREADTH. A hold count answers "did the rows the suite states hold", never "how
 *   much of the population could the suite have stated" — and for a law whose eligibility is a property of the
 *   query text those are different numbers. `ConformanceSuite.coverage` prints the second one beside the
 *   first; the committed corpus is read only for a run that includes such a law.
 */

import { type ConformanceFixture, loadConformanceFixtures } from "#eval-harness/conformance/fixture"
import {
	type ConformanceFinding,
	type ConformanceSummary,
	formatConformanceFinding,
	gauntletObserver,
	runConformanceFixtures,
	summarizeConformanceRun,
	tracedGauntletObserver,
} from "#eval-harness/conformance/run"
import { CONFORMANCE_SUITES, describeLaw, suiteForLaw } from "#eval-harness/conformance/suites"
import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"
import { buildGauntletDeps, type GauntletDepsOptions } from "#eval-harness/gauntlet/harness"

/**
 * Load every named suite into one fixture list, refusing an id that two files both claim.
 *
 * The per-file loader already refuses a duplicate within its own file; ids name rows in failure output, so two suites
 * sharing one would produce a report line a reader cannot trace back to a file.
 */
async function loadSuites(paths: readonly string[]): Promise<ConformanceFixture[]> {
	const fixtures: ConformanceFixture[] = []
	const originByID = new Map<string, string>()

	for (const path of paths) {
		const loaded = await loadConformanceFixtures(path)

		console.error(`[conformance] loaded ${loaded.length} rows from ${path}`)

		for (const fixture of loaded) {
			const origin = originByID.get(fixture.id)

			if (origin) {
				throw new Error(`${path}: fixture id "${fixture.id}" is already used by ${origin} — ids name rows in output`)
			}

			originByID.set(fixture.id, path)
			fixtures.push(fixture)
		}
	}

	return fixtures
}

function report(findings: readonly ConformanceFinding[]): void {
	for (const finding of findings) {
		const detail = describeLaw(finding.fixture)

		console.log(detail ? `${formatConformanceFinding(finding)}\n${detail}` : formatConformanceFinding(finding))
	}
}

export interface ConformanceCommandOptions extends GauntletDepsOptions {
	/**
	 * Suite JSONL path. Absent runs every suite in {@linkcode CONFORMANCE_SUITES}.
	 */
	suite?: string
}

/**
 * One law's own counts, split the way the verdict splits.
 */
export interface ConformanceLawMeasurement {
	law: string
	decided: number
	holds: number
	tracked: number
	unmeasured: number
	/**
	 * The law's breadth line, when its suite registers one. A hold count answers whether the stated rows held, never how
	 * much of the population the suite could have stated.
	 */
	coverage?: string
}

/**
 * What one conformance run measured.
 *
 * `measured` is ABSENT exactly when `problems` is non-empty — a refused run has no findings, and reporting it as zero
 * findings would read as a suite that passed nothing rather than a suite that ran nothing.
 */
export interface ConformanceMeasurement {
	laws: string[]
	problems: string[]
	measured?: {
		findings: ConformanceFinding[]
		summary: ConformanceSummary
		perLaw: ConformanceLawMeasurement[]
		tracedObserver: boolean
	}
}

/**
 * Load, audit and run the law suites, and return the counts without printing a verdict.
 *
 * Extracted so a second consumer — the phase-2 decision ruler (#1967), which reads the laws as an inertness measurement
 * — takes the NUMBERS from the same run this command narrates, rather than re-deriving them from a second orchestration
 * free to load a different suite set or a different observer.
 */
export async function measureConformance(options: ConformanceCommandOptions = {}): Promise<ConformanceMeasurement> {
	const { suite, ...depsOptions } = options
	const paths = suite ? [suite] : CONFORMANCE_SUITES.map((registered) => registered.path)
	const fixtures = await loadSuites(paths)

	const laws = [...new Set(fixtures.map((fixture) => fixture.law))].toSorted()
	const problems: string[] = []

	for (const law of laws) {
		const registered = suiteForLaw(law)

		if (!registered) {
			console.error(`[conformance] law "${law}" declares no suite audit — its rows run as written`)

			continue
		}

		problems.push(...registered.audit(fixtures.filter((fixture) => fixture.law === law)))
	}

	if (problems.length) return { laws, problems }

	console.error(`[conformance] suite audit clean (${laws.join(", ")})`)

	// The corpus is read only when a law in THIS run registers a coverage reading. It is the population every law
	// draws from, so a law whose eligibility is a property of the query text measures its own breadth against it —
	// see `ConformanceSuite.coverage`.
	const wantsCoverage = laws.some((law) => suiteForLaw(law)?.coverage)
	const corpusInputs = wantsCoverage ? (await loadRegressionCases()).map((seedCase) => seedCase.input) : []

	// The resolver's trace bookkeeping is opt-in and the four answer-axis laws have no use for it, so the observer is
	// chosen from the comparators the loaded rows actually name rather than turned on for every run.
	const wantsTrace = fixtures.some((fixture) => fixture.outcomeComparator === "candidate_admissibility")

	if (wantsTrace) {
		console.error("[conformance] resolver trace ON — a loaded row reads the candidate tables")
	}

	const deps = await buildGauntletDeps(depsOptions)

	try {
		const observer = wantsTrace ? tracedGauntletObserver(deps.geocodeTraced) : gauntletObserver(deps.geocode)
		const { findings } = await runConformanceFixtures(fixtures, observer)

		const perLaw = laws.map((law) => {
			const ofLaw = findings.filter((finding) => finding.fixture.law === law)
			const summarized = summarizeConformanceRun(ofLaw)
			const coverage = suiteForLaw(law)?.coverage

			return {
				law,
				decided: summarized.decided,
				holds: summarized.decided - summarized.failures.length,
				tracked: summarized.tracked.length,
				unmeasured: summarized.unmeasured.length,
				...(coverage
					? {
							coverage: coverage(
								ofLaw.map((finding) => finding.fixture),
								corpusInputs
							),
						}
					: {}),
			}
		})

		return {
			laws,
			problems,
			measured: { findings, summary: summarizeConformanceRun(findings), perLaw, tracedObserver: wantsTrace },
		}
	} finally {
		deps[Symbol.dispose]()
	}
}

/**
 * Run the conformance-law suites from CLI-shaped options. Returns the process exit code (0 = PASS).
 */
export async function runConformanceCommand(options: ConformanceCommandOptions = {}): Promise<number> {
	const { problems, measured } = await measureConformance(options)

	if (!measured) {
		console.error(`[conformance] refusing to run — ${problems.length} suite problem(s):`)

		for (const problem of problems) {
			console.error(`  ✗ ${problem}`)
		}

		return 1
	}

	const { findings, summary, perLaw } = measured

	console.log(
		`\n=== conformance (${summary.decided - summary.failures.length}/${summary.decided} decided rows hold, ` +
			`${summary.tracked.length} tracked, ${summary.unmeasured.length} unmeasured) ===`
	)

	// Per law as well as pooled: a run that merges two suites into one verdict says WHETHER something broke and not
	// WHICH law stopped holding, and the pooled count moves whenever either suite grows.
	for (const law of perLaw) {
		console.log(
			`  ${law.law}: ${law.holds}/${law.decided} decided hold, ${law.tracked} tracked, ${law.unmeasured} unmeasured`
		)

		if (law.coverage) {
			console.log(`    ${law.coverage}`)
		}
	}

	report(findings.filter((finding) => finding.held && (finding.fixture.status ?? "pass") === "pass"))

	if (summary.failures.length) {
		console.log(`\nviolations (conditional):`)

		report(summary.failures)
	}

	if (summary.tracked.length) {
		console.log(`\ntracked (known_fail / improvement_target, non-blocking):`)

		report(summary.tracked)
	}

	if (summary.unmeasured.length) {
		console.log(
			`\nunmeasured — the comparator read its axis and the observation could not decide (never blocking, ` +
				`never counted as holding):`
		)

		report(summary.unmeasured)
	}

	if (summary.newlyHolding.length) {
		console.log(`\n⚠ tracked rows whose law now holds — promote to status=pass:`)

		report(summary.newlyHolding)
	}

	console.log(`\nverdict: ${summary.pass ? "PASS" : "FAIL"}`)

	return summary.pass ? 0 : 1
}
