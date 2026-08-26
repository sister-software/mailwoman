/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI-facing orchestration for `mailwoman eval conformance` — load the law suites, audit them, run every
 *   row through the Gauntlet's own deps, and report. Thin on purpose: it narrates and owns only the exit
 *   code, matching `eval invariance` and `eval gate`.
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
 *   rows gate, tracked rows report, and a tracked row that starts holding prints a promotion instruction. A
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

import { loadRegressionCases } from "../gauntlet/cases/load.ts"
import { buildGauntletDeps, type GauntletDepsOptions } from "../gauntlet/harness.ts"
import { type ConformanceFixture, loadConformanceFixtures } from "./fixture.ts"
import {
	type ConformanceFinding,
	formatConformanceFinding,
	gauntletObserver,
	runConformanceFixtures,
	summarizeConformanceRun,
	tracedGauntletObserver,
} from "./run.ts"
import { CONFORMANCE_SUITES, describeLaw, suiteForLaw } from "./suites.ts"

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
 * Run the conformance-law suites from CLI-shaped options. Returns the process exit code (0 = PASS).
 */
export async function runConformanceCommand(options: ConformanceCommandOptions = {}): Promise<number> {
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

	if (problems.length) {
		console.error(`[conformance] refusing to run — ${problems.length} suite problem(s):`)

		for (const problem of problems) {
			console.error(`  ✗ ${problem}`)
		}

		return 1
	}

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
		const summary = summarizeConformanceRun(findings)

		console.log(
			`\n=== conformance (${summary.gated - summary.failures.length}/${summary.gated} decided rows hold, ` +
				`${summary.tracked.length} tracked, ${summary.unmeasured.length} unmeasured) ===`
		)

		// Per law as well as pooled: a run that merges two suites into one verdict says WHETHER something broke and not
		// WHICH law stopped holding, and the pooled count moves whenever either suite grows.
		for (const law of laws) {
			const ofLaw = findings.filter((finding) => finding.fixture.law === law)
			const perLaw = summarizeConformanceRun(ofLaw)

			console.log(
				`  ${law}: ${perLaw.gated - perLaw.failures.length}/${perLaw.gated} decided hold, ` +
					`${perLaw.tracked.length} tracked, ${perLaw.unmeasured.length} unmeasured`
			)

			const coverage = suiteForLaw(law)?.coverage

			if (coverage) {
				const stated = ofLaw.map((finding) => finding.fixture)

				console.log(`    ${coverage(stated, corpusInputs)}`)
			}
		}

		report(findings.filter((finding) => finding.held && (finding.fixture.status ?? "pass") === "pass"))

		if (summary.failures.length) {
			console.log(`\nviolations (gated):`)

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
	} finally {
		deps.close()
	}
}
