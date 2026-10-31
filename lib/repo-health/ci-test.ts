/**
 * Runs one of the root Vitest suites with the file list selected by `ci-scope`.
 */

import { liveEnv } from "@mailwoman/core/env"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runProcess } from "@mailwoman/core/process"
import { z } from "zod"

const ciEnvironment = liveEnv(
	z.object({
		TEST_FILES: z.string(),
		FULL_SCOPE: z.string().optional(),
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

export async function runCITests(suite: CITestSuite): Promise<void> {
	const args = readCITestArguments(suite, ciEnvironment.TEST_FILES, ciEnvironment.FULL_SCOPE)

	await runProcess("yarn", args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
}
