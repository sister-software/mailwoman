/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI-facing orchestration for `mailwoman eval conformance`: audit the law suites before loading the engine, then run every row through the Gauntlet's own deps.
 */

import { type ConformanceFixture, loadConformanceFixtures } from "#tools/eval-harness/conformance/fixture"
import {
	type ConformanceFinding,
	type ConformanceSummary,
	formatConformanceFinding,
	gauntletObserver,
	runConformanceFixtures,
	summarizeConformanceRun,
	tracedGauntletObserver,
} from "#tools/eval-harness/conformance/run"
import { CONFORMANCE_SUITES, describeLaw, suiteForLaw } from "#tools/eval-harness/conformance/suites"
import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"
import { buildGauntletDeps, type GauntletDepsOptions } from "#tools/eval-harness/gauntlet/harness"

/**
 * Loads every registered suite into one fixture list, refusing an id that two files
 * both claim because ids name rows in failure output.
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
	 * Suite jsonl path.
	 *
	 * Absent runs every suite in {@linkcode CONFORMANCE_SUITES}.
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
	 * The law's breadth line, when its suite registers one, answering how much of the
	 * population the suite could have stated rather than whether the stated rows held.
	 */
	coverage?: string
}

/**
 * What one conformance run measured, with `measured` absent exactly when `problems` is
 * non-empty so a refused run is not read as a suite that passed no case.
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
 * Loads, audits and runs the law suites, returning the counts without printing a verdict
 * so a second consumer reads the same run rather than re-deriving it.
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

	// The corpus is read only when a law registers a coverage reading.
	// It is the population every law draws from.
	const wantsCoverage = laws.some((law) => suiteForLaw(law)?.coverage)
	const corpusInputs = wantsCoverage ? (await loadRegressionCases()).map((seedCase) => seedCase.input) : []

	// The resolver's trace bookkeeping is opt-in, so the observer is chosen from the
	// comparators the loaded rows name rather than enabled for every run.
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
 * Run the conformance-law suites from CLI-shaped options.
 *
 * @returns The process exit code (0 = pass).
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

	// Per law as well as pooled, because a merged verdict reports a failure without
	// identifying which law stopped holding.
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
