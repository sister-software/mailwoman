// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Whether a test file has to run on a `mailwoman-data` runner, read from the file's own text.
 *
 *   Only those runners hold the data root, and the model weights are served from it.
 *   A hosted runner has a checkout, an install and a compile.
 *
 *   A test that needs an artifact a hosted runner lacks declares it in one of two ways.
 *   It skips when the artifact is absent, through `skipIf`, `runIf` or a `skip()` call.
 *
 *   Or it fails when the artifact is absent, and declares the runner in a
 *   comment: `// ci-runner: mailwoman-data`.
 *
 *   A file with neither runs on a hosted runner, where a skipped test fails the job.
 *   A file that gains a skip therefore moves to the data runner on its own,
 *   and a skip can't leave a test unrun on every runner.
 */

/**
 * A conditional skip on a suite or a test, or a skip called on the test context.
 */
const SKIP_GUARD =
	/\b(?:describe|suite|test|it)(?:\.\w+)*\.(?:skipIf|runIf|skip)\s*\(|\b(?:ctx|context)\.skip\s*\(|\bskip\s*\(\s*\)/u

/**
 * The comment that declares a test file's runner.
 */
const DATA_RUNNER_COMMENT = /\/\/\s*ci-runner:\s*mailwoman-data\b/u

/**
 * Whether the test file with this text runs on a `mailwoman-data` runner.
 */
export function declaresDataRunner(text: string): boolean {
	return DATA_RUNNER_COMMENT.test(text) || SKIP_GUARD.test(text)
}
