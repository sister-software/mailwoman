/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Registry of committed conformance suites. It lives apart from `command.ts` so that importing it does not load an
 *   engine. The `conformance-suites.test.ts` test fails when a suite file in this directory is unregistered.
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
 * Committed law suite with its audit and report functions.
 */
export interface ConformanceSuite {
	law: string
	path: string
	/**
	 * Checks suite rows before the engine loads.
	 * It returns one message per problem.
	 */
	audit: (fixtures: readonly ConformanceFixture[]) => string[]
	/**
	 * Formats the law-specific line shown with each finding.
	 */
	detail: (fixture: ConformanceFixture) => string
	/**
	 * Formats coverage against the corpus inputs that the runner supplies.
	 */
	coverage?: (fixtures: readonly ConformanceFixture[], corpusInputs: readonly string[]) => string
}

/**
 * Committed law suites in the order that a default run reports them.
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
		// The step derives the coarser base from the finer variant.
		detail: (fixture) => `    xform   : variant −${describeRefinementStep(fixture)} → base`,
		coverage: describeRefinementCoverage,
	},
]

const SUITE_BY_LAW = new Map(CONFORMANCE_SUITES.map((suite) => [suite.law, suite]))

/**
 * Returns the registered suite for a law, or `undefined` when no suite is registered for it.
 */
export function suiteForLaw(law: string): ConformanceSuite | undefined {
	return SUITE_BY_LAW.get(law)
}

/**
 * Returns the law-specific detail line for a finding, or `""` for an unregistered law.
 */
export function describeLaw(fixture: ConformanceFixture): string {
	return SUITE_BY_LAW.get(fixture.law)?.detail(fixture) ?? ""
}

/**
 * Directory of the committed suites.
 *
 * It comes from a suite path because `import.meta.url` points at compiled output.
 */
export const CONFORMANCE_SUITE_DIR = dirname(CASE_FOLDING_SUITE_PATH)
