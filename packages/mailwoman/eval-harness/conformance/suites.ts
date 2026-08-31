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

import { dirname } from "path-ts"

import {
	auditCaseFoldingSuite,
	CASE_FOLDING_LAW,
	CASE_FOLDING_SUITE_PATH,
	describeCaseTransformation,
} from "#eval-harness/conformance/case-folding"
import type { ConformanceFixture } from "#eval-harness/conformance/fixture"
import {
	auditCanonicalFormSuite,
	CANONICAL_FORM_LAW,
	describeCanonicalFormCoverage,
	describeCanonicalTransformation,
	NFC_NFD_SUITE_PATH,
} from "#eval-harness/conformance/nfc-nfd"
import {
	auditPunctuationSuite,
	describePunctuationTransformation,
	PUNCTUATION_LAW,
	PUNCTUATION_SUITE_PATH,
} from "#eval-harness/conformance/punctuation"
import {
	auditRefinementSuite,
	describeRefinementCoverage,
	describeRefinementStep,
	REFINEMENT_MONOTONICITY_LAW,
	REFINEMENT_MONOTONICITY_SUITE_PATH,
} from "#eval-harness/conformance/refinement-monotonicity"
import {
	auditWhitespaceSuite,
	describeWhitespaceTransformation,
	WHITESPACE_LAW,
	WHITESPACE_SUITE_PATH,
} from "#eval-harness/conformance/whitespace"

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
	 * The extra line a finding prints under its head. Every shipped law names the TRANSFORMATION, without which a
	 * violation reads as "these two strings disagreed" rather than "uppercasing broke it".
	 */
	detail: (fixture: ConformanceFixture) => string
	/**
	 * How much of the population the suite reached, printed beside the law's own hold count.
	 *
	 * Optional because most laws can be stated over any row: the arms a query refuses are reported per row by the
	 * applicability rules, and the verdict already names the denominator that decides it. A law whose ELIGIBILITY is a
	 * property of the text — canonical form is the one shipped example, where 83 of 651 committed rows carry a character
	 * either form can act on — needs the second denominator as well, or its hold count implies a breadth it never
	 * exercised. `corpusInputs` is every committed board row's query text, supplied by the runner.
	 */
	coverage?: (fixtures: readonly ConformanceFixture[], corpusInputs: readonly string[]) => string
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
	{
		law: PUNCTUATION_LAW,
		path: PUNCTUATION_SUITE_PATH,
		audit: auditPunctuationSuite,
		detail: (fixture) => `    xform   : ${describePunctuationTransformation(fixture)}`,
	},
	{
		law: CANONICAL_FORM_LAW,
		path: NFC_NFD_SUITE_PATH,
		audit: auditCanonicalFormSuite,
		detail: (fixture) => `    xform   : ${describeCanonicalTransformation(fixture)}`,
		coverage: describeCanonicalFormCoverage,
	},
	{
		law: REFINEMENT_MONOTONICITY_LAW,
		path: REFINEMENT_MONOTONICITY_SUITE_PATH,
		audit: auditRefinementSuite,
		// The step is named from the FULLER query to the coarser one, because that is the direction the derivation runs;
		// the law itself is stated the other way, which the head line already prints as base → variant.
		detail: (fixture) => `    xform   : variant −${describeRefinementStep(fixture)} → base`,
		coverage: describeRefinementCoverage,
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
