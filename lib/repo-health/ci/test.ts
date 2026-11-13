// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

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
		/**
		 * The Vitest worker limit for a runner that shares its host's cores with other runners.
		 *
		 * Vitest otherwise starts one worker per core less one on each runner.
		 */
		CI_TEST_MAX_WORKERS: z.coerce.number().int().positive().optional(),
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
	const maxWorkers = ciEnvironment.CI_TEST_MAX_WORKERS

	await runProcess("yarn", maxWorkers ? [...args, `--maxWorkers=${maxWorkers}`] : args, {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	})
}
