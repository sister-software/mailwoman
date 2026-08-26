/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The register of committed conformance-law suites. Pure — the law modules and the fixture contract, no
 *   engine, so a test can assert the register without a model or a gazetteer.
 *
 *   A SUITE OUTSIDE THIS REGISTER NEVER RUNS. `mailwoman eval conformance` reads it to decide what a default
 *   run covers and which audit each law gets, so a committed `.jsonl` nobody registered is not a suite that
 *   runs unaudited — it is a suite that runs never, and reports as an absence. `conformance-suites.test.ts`
 *   walks the directory and refuses a file no entry names, which is the only check that can see that gap.
 *
 *   It lives apart from `command.ts` because that module imports the Gauntlet harness, and the harness pulls
 *   the neural runtime and the resolver behind it. The register itself needs neither.
 */

import { dirname } from "node:path"

import {
	auditCaseFoldingSuite,
	CASE_FOLDING_LAW,
	CASE_FOLDING_SUITE_PATH,
	describeCaseTransformation,
} from "./case-folding.ts"
import type { ConformanceFixture } from "./fixture.ts"
import {
	auditWhitespaceSuite,
	describeWhitespaceTransformation,
	WHITESPACE_LAW,
	WHITESPACE_SUITE_PATH,
} from "./whitespace.ts"

/**
 * One committed law suite: where its rows live, what refuses a row that does not state its law, and the law-specific
 * detail its findings carry.
 */
export interface ConformanceSuite {
	law: string
	path: string
	/**
	 * Suite-wide checks, run BEFORE the engine loads. One message per problem, empty when the suite is runnable.
	 */
	audit: (fixtures: readonly ConformanceFixture[]) => string[]
	/**
	 * The extra line a finding prints under its head. Both shipped laws name the TRANSFORMATION, without which a
	 * violation reads as "these two strings disagreed" rather than "uppercasing broke it".
	 */
	detail: (fixture: ConformanceFixture) => string
}

/**
 * The committed law suites, in the order a default run reports them.
 */
export const CONFORMANCE_SUITES: readonly ConformanceSuite[] = [
	{
		law: CASE_FOLDING_LAW,
		path: CASE_FOLDING_SUITE_PATH,
		audit: auditCaseFoldingSuite,
		detail: (fixture) => `    xform   : ${describeCaseTransformation(fixture)}`,
	},
	{
		law: WHITESPACE_LAW,
		path: WHITESPACE_SUITE_PATH,
		audit: auditWhitespaceSuite,
		detail: (fixture) => `    xform   : ${describeWhitespaceTransformation(fixture)}`,
	},
]

const SUITE_BY_LAW = new Map(CONFORMANCE_SUITES.map((suite) => [suite.law, suite]))

/**
 * The registered suite for a law, or `undefined` when the law declares none — a fixture file passed to `--suite` may
 * state a law nobody has registered, and the runner says so rather than defaulting it to another law's audit.
 */
export function suiteForLaw(law: string): ConformanceSuite | undefined {
	return SUITE_BY_LAW.get(law)
}

/**
 * Law-specific detail appended to a finding's head line, or `""` for an unregistered law.
 */
export function describeLaw(fixture: ConformanceFixture): string {
	return SUITE_BY_LAW.get(fixture.law)?.detail(fixture) ?? ""
}

/**
 * The directory the committed suites live in — what `conformance-suites.test.ts` walks to find a suite file the
 * register does not name.
 *
 * Derived from a suite path rather than from `import.meta.url`, which under a compiled tree names `out/` — where no
 * `.jsonl` is emitted, so a walk would find nothing and report a clean register.
 */
export const CONFORMANCE_SUITE_DIR = dirname(CASE_FOLDING_SUITE_PATH)
