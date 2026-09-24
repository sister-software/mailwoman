/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Register committed conformance suites without importing an engine.
 *   Unregistered suite files never run; `conformance-suites.test.ts` checks the directory.
 *   This module stays separate from `command.ts` to avoid loading its runtime dependencies.
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
 * A committed law suite and its audit and reporting functions.
 */
export interface ConformanceSuite {
	law: string
	path: string
	/**
	 * Check suite rows before loading the engine; return one message per problem.
	 */
	audit: (fixtures: readonly ConformanceFixture[]) => string[]
	/**
	 * Format the law-specific detail shown with each finding.
	 */
	detail: (fixture: ConformanceFixture) => string
	/**
	 * Optionally report coverage against the corpus inputs supplied by the runner.
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
		// Derivation runs from the fuller query to the coarser one.
		detail: (fixture) => `    xform   : variant −${describeRefinementStep(fixture)} → base`,
		coverage: describeRefinementCoverage,
	},
]

const SUITE_BY_LAW = new Map(CONFORMANCE_SUITES.map((suite) => [suite.law, suite]))

/**
 * The registered suite for a law, or `undefined` when the law declares none.
 *
 * A fixture file passed to `--suite` may state a law nobody has registered,
 * and the runner says so rather than defaulting it to another law's audit.
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
 * Directory of committed suites, derived from a suite path rather than compiled `import.meta.url`.
 */
export const CONFORMANCE_SUITE_DIR = dirname(CASE_FOLDING_SUITE_PATH)
