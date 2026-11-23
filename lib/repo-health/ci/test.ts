// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Runs one of the root Vitest suites with the file list selected by `ci-scope`.
 */

import { liveEnv } from "@mailwoman/core/env"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { runProcess } from "@mailwoman/core/scripting/process"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import { z } from "zod"

const ciEnvironment = liveEnv(
	z.object({
		TEST_FILES: z.string(),
		FULL_SCOPE: z.string().optional(),
		/**
		 * The Vitest worker limit for a runner that shares its host's cores with other runners.
		 *
		 * Vitest otherwise starts one worker per core less one on each runner.
		 */
		CI_TEST_MAX_WORKERS: z.coerce.number().int().positive().optional(),
		/**
		 * `true` on a hosted runner's slow job, where a test that skips would otherwise run on no runner.
		 *
		 * The run then fails when any selected test is skipped.
		 */
		CI_TEST_REFUSE_SKIPS: z.string().optional(),
	})
)

const CI_TEST_COMMANDS = {
	fast: "ci:test:fast",
	slow: "ci:test:slow",
} as const

export type CITestSuite = keyof typeof CI_TEST_COMMANDS

export function isCITestSuite(value: string | undefined): value is CITestSuite {
	return value != null && Object.hasOwn(CI_TEST_COMMANDS, value)
}

/**
 * Validates the scope outputs and returns the Yarn command and its arguments.
 */
export function readCITestArguments(suite: CITestSuite, input: string, fullScope?: string): string[] {
	const files = z.array(z.string()).parse(parseJSONStrict(input))

	if (fullScope !== "true" && !files.length) {
		throw new Error(`A scoped ${suite} job requires selected test files`)
	}

	return [CI_TEST_COMMANDS[suite], ...files]
}

/**
 * Where a run that refuses skips writes Vitest's JSON report, beside the JUnit report.
 */
const RESULTS_FILE = "test-results/results.json"

/**
 * The reporters of a run that refuses skips: the configured console
 * and JUnit reporters, and the JSON report.
 *
 * A reporter passed on the command line replaces the configured list,
 * so the two configured ones are repeated.
 */
const REFUSE_SKIPS_REPORTERS = [
	"--reporter=default",
	"--reporter=junit",
	"--outputFile.junit=test-results/junit.xml",
	"--reporter=json",
	`--outputFile.json=${RESULTS_FILE}`,
]

const vitestAssertion = z.object({ fullName: z.string(), status: z.string() })
const vitestFile = z.object({ name: z.string(), assertionResults: z.array(vitestAssertion) })
const vitestReport = z.object({ testResults: z.array(vitestFile) })

/**
 * Each test in a Vitest JSON report that neither passed nor failed, as `<file> > <test>`.
 *
 * Vitest reports a skipped test as `skipped` or `pending`, and an unwritten one as `todo`.
 */
export function unrunTests(report: unknown): string[] {
	return vitestReport
		.parse(report)
		.testResults.flatMap((file) =>
			file.assertionResults
				.filter((test) => test.status !== "passed" && test.status !== "failed")
				.map((test) => `${file.name} > ${test.fullName}`)
		)
}

export async function runCITests(suite: CITestSuite): Promise<void> {
	const args = readCITestArguments(suite, ciEnvironment.TEST_FILES, ciEnvironment.FULL_SCOPE)
	const maxWorkers = ciEnvironment.CI_TEST_MAX_WORKERS
	const refuseSkips = ciEnvironment.CI_TEST_REFUSE_SKIPS === "true"

	await runProcess(
		"yarn",
		[...args, ...(maxWorkers ? [`--maxWorkers=${maxWorkers}`] : []), ...(refuseSkips ? REFUSE_SKIPS_REPORTERS : [])],
		{ stdin: "inherit", stdout: "inherit", stderr: "inherit" }
	)

	if (!refuseSkips) return

	const unrun = unrunTests(await readLocalJSONFile(RESULTS_FILE))

	if (unrun.length) {
		throw new Error(
			`${unrun.length} test(s) didn't run on this runner. A test that skips without an artifact runs on a ` +
				"`mailwoman-data` runner: `lib/repo-health/ci/data-runner.ts` states how a file is assigned.\n" +
				unrun.map((test) => `  ${test}`).join("\n")
		)
	}
}
