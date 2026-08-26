/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI-facing orchestration for `mailwoman eval conformance` — load a law suite, audit it, run every row
 *   through the Gauntlet's own deps, and report. Thin on purpose: it narrates and owns only the exit code,
 *   matching `eval invariance` and `eval gate`.
 *
 *   THE AUDIT RUNS BEFORE THE ENGINE LOADS. A law suite's rows can be wrong in ways no amount of geocoding
 *   reveals — a pair that differs by more than case still runs, still produces a reading, and still reports a
 *   violation, which a reader then attributes to the pipeline. Auditing first means an unrunnable suite costs
 *   a second rather than a model load, and costs nobody a wrong diagnosis.
 *
 *   A TRACKED ROW IS RUN. The verdict splits by status the way the Gauntlet regression layer splits: `pass`
 *   rows gate, tracked rows report, and a tracked row that starts holding prints a promotion instruction. A
 *   red row is never removed to make the exit code zero.
 */

import { buildGauntletDeps, type GauntletDepsOptions } from "../gauntlet/harness.ts"
import {
	auditCaseFoldingSuite,
	CASE_FOLDING_LAW,
	CASE_FOLDING_SUITE_PATH,
	describeCaseTransformation,
} from "./case-folding.ts"
import { type ConformanceFixture, loadConformanceFixtures } from "./fixture.ts"
import {
	type ConformanceFinding,
	formatConformanceFinding,
	gauntletObserver,
	runConformanceFixtures,
	summarizeConformanceRun,
} from "./run.ts"

/**
 * Per-law suite audits, keyed by the `law` a row carries.
 *
 * A law that declares one has its rows checked for free wherever a suite is run; a law that declares none is run as
 * written. Each law suite registers here rather than owning a runner of its own — the alternative is four commands that
 * load the same engine four ways.
 */
const LAW_AUDITS: Record<string, (fixtures: readonly ConformanceFixture[]) => string[]> = {
	[CASE_FOLDING_LAW]: auditCaseFoldingSuite,
}

/**
 * Law-specific detail appended to a finding's head line. Case folding names the TRANSFORMATION, without which a
 * violation reads as "these two strings disagreed" rather than "uppercasing broke it".
 */
function describeLaw(fixture: ConformanceFixture): string {
	return fixture.law === CASE_FOLDING_LAW ? `    xform   : ${describeCaseTransformation(fixture)}` : ""
}

function report(findings: readonly ConformanceFinding[]): void {
	for (const finding of findings) {
		const detail = describeLaw(finding.fixture)

		console.log(detail ? `${formatConformanceFinding(finding)}\n${detail}` : formatConformanceFinding(finding))
	}
}

export interface ConformanceCommandOptions extends GauntletDepsOptions {
	/**
	 * Suite JSONL path. Default the shipped case-folding suite.
	 */
	suite?: string
}

/**
 * Run a conformance-law suite from CLI-shaped options. Returns the process exit code (0 = PASS).
 */
export async function runConformanceCommand(options: ConformanceCommandOptions = {}): Promise<number> {
	const { suite, ...depsOptions } = options
	const path = suite ?? CASE_FOLDING_SUITE_PATH
	const fixtures = await loadConformanceFixtures(path)

	console.error(`[conformance] loaded ${fixtures.length} rows from ${path}`)

	const laws = [...new Set(fixtures.map((fixture) => fixture.law))].toSorted()
	const problems: string[] = []

	for (const law of laws) {
		const audit = LAW_AUDITS[law]

		if (!audit) {
			console.error(`[conformance] law "${law}" declares no suite audit — its rows run as written`)

			continue
		}

		problems.push(...audit(fixtures.filter((fixture) => fixture.law === law)))
	}

	if (problems.length) {
		console.error(`[conformance] refusing to run — ${problems.length} suite problem(s):`)

		for (const problem of problems) {
			console.error(`  ✗ ${problem}`)
		}

		return 1
	}

	console.error(`[conformance] suite audit clean (${laws.join(", ")})`)

	const deps = await buildGauntletDeps(depsOptions)

	try {
		const { findings } = await runConformanceFixtures(fixtures, gauntletObserver(deps.geocode))
		const summary = summarizeConformanceRun(findings)

		console.log(
			`\n=== conformance (${summary.gated - summary.failures.length}/${summary.gated} gated rows hold, ` +
				`${summary.tracked.length} tracked) ===`
		)

		report(findings.filter((finding) => finding.held && (finding.fixture.status ?? "pass") === "pass"))

		if (summary.failures.length) {
			console.log(`\nviolations (gated):`)

			report(summary.failures)
		}

		if (summary.tracked.length) {
			console.log(`\ntracked (known_fail / improvement_target, non-blocking):`)

			report(summary.tracked)
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
