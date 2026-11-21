// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reads the failing tests out of a failed GitHub Actions job's log.
 *
 * The log comes from `gh run view --job <id> --log-failed`, which prints only the failed steps,
 * or from the jobs API when that command refuses a job whose run is still in progress.
 * It is written under the cache root's `checks/ci-logs` directory, outside every
 * checkout, and read by the Vitest text parser.
 *
 * A failed job whose log holds no failing test, such as a lint, build or summary job,
 * is first read by the script parser, and otherwise reported as `parsed: false` with
 * the reason and the log path, never as a job with zero failures.
 */

import { cacheRootPath } from "@mailwoman/core/data-root"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { runFile } from "@mailwoman/core/process"

import { checkOutputLines } from "#check-kit/output-lines"
import { type FailingTest, MAX_ERROR_LINES, type ParsedSource } from "#check-kit/parsed"
import { parseScriptOutput } from "#check-kit/parsers/scripts"
import { parseVitestText } from "#check-kit/parsers/vitest"
import {
	type CheckAnnotationsReading,
	readCheckRunAnnotations,
	type ReadCheckAnnotations,
} from "#check-kit/pull-request/annotations"
import { type CheckBucket, PULL_REQUEST_REPO } from "#check-kit/pull-request/checks"

/**
 * What one failed job's log held.
 */
export interface FailedJobLog {
	/**
	 * The job's name, as the check and the log prefix print it.
	 */
	job: string
	runID: number | null
	jobID: number | null
	/**
	 * Where the log was written, or `null` when it couldn't be downloaded.
	 */
	logPath: string | null
	/**
	 * Whether a parser found the failure in the log.
	 *
	 * When `false`, `reason` states why, and `errorLines` repeats the log's `##[error]` lines.
	 */
	parsed: boolean
	reason: string | null
	source: ParsedSource | null
	failingTests: FailingTest[]
	/**
	 * The scripts or repository checks the script parser names as failing.
	 */
	failingChecks: string[]
	errorLines: string[]
	/**
	 * The check run's annotations, for a failed check without an Actions job
	 * and with a link that ends in `/runs/<id>`.
	 *
	 * It is `null` for an Actions job and for a check whose link holds neither id.
	 */
	annotations: CheckAnnotationsReading | null
}

/**
 * Downloads a failed job's log, injected by a test.
 */
export type DownloadJobLog = (runID: number | null, jobID: number) => Promise<string>

/**
 * The longest a log download may take: a failed slow-suite job's log is over a megabyte.
 */
const LOG_DOWNLOAD_TIMEOUT_MS = 180_000

const LOG_DOWNLOAD_OPTIONS = { timeout: LOG_DOWNLOAD_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 }

/**
 * Download one job's log.
 *
 * `gh run view --log-failed` prints only the failed steps.
 * It refuses a job whose run still has other jobs in progress.
 *
 * The jobs API returns a concluded job's whole log while its run continues.
 * A refusal from the first command is answered by the second.
 *
 * @throws The second command's error when both fail, with the first command's error appended.
 */
const downloadJobLog: DownloadJobLog = async (_runID, jobID) => {
	try {
		const failedSteps = await runFile(
			"gh",
			["run", "view", "--job", String(jobID), "--log-failed", "--repo", PULL_REQUEST_REPO],
			LOG_DOWNLOAD_OPTIONS
		)

		return failedSteps.stdout
	} catch (failedStepsError) {
		try {
			const wholeJob = await runFile(
				"gh",
				["api", "--allow-escape-sequences", `repos/${PULL_REQUEST_REPO}/actions/jobs/${jobID}/logs`],
				LOG_DOWNLOAD_OPTIONS
			)

			return wholeJob.stdout
		} catch (wholeJobError) {
			const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

			throw new Error(`${describe(wholeJobError)} (after \`gh run view --log-failed\`: ${describe(failedStepsError)})`)
		}
	}
}

/**
 * The directory failed-job logs are written to.
 */
function failedLogDirectory(): string {
	return cacheRootPath("checks", "ci-logs")
}

/**
 * The text of the log's `##[error]` annotations.
 *
 * For an unparsed job they state why it failed.
 */
function annotationLines(text: string): string[] {
	return checkOutputLines(text)
		.map((line) => line.text.trim())
		.filter((line) => line.startsWith("##[error]"))
		.map((line) => line.slice("##[error]".length))
		.slice(0, MAX_ERROR_LINES)
}

/**
 * Read one job's log text.
 *
 * The Vitest parser reads it first.
 * A log with no Vitest summary, or a summary with no failing test, is read by the script
 * parser, and a log neither parser explains is returned as `parsed: false`.
 */
function parseFailedJobLog(
	text: string,
	job: { job: string; runID: number | null; jobID: number | null; logPath: string | null }
): FailedJobLog {
	const vitest = parseVitestText(text)

	if (vitest.parsed && vitest.failingTests.length) {
		return {
			...job,
			parsed: true,
			reason: null,
			source: vitest.source,
			failingTests: vitest.failingTests,
			failingChecks: [],
			errorLines: vitest.errorLines,
			annotations: null,
		}
	}

	// A failed job's log is the failure, so the script parser reads it with a non-zero status.
	const script = parseScriptOutput(text, 1)

	if (script.parsed) {
		return {
			...job,
			parsed: true,
			reason: null,
			source: script.source,
			failingTests: [],
			failingChecks: script.failingChecks,
			errorLines: script.errorLines,
			annotations: null,
		}
	}

	const reason = vitest.parsed
		? "the log's Vitest summary names no failing test, and no line matched a script's error format"
		: `the log holds no Vitest summary (${vitest.reason}), and the script parser read none: ${script.reason}`

	return {
		...job,
		parsed: false,
		reason,
		source: null,
		failingTests: [],
		failingChecks: [],
		errorLines: annotationLines(text),
		annotations: null,
	}
}

/**
 * Download one failed job's log, write it under {@link failedLogDirectory}, and read it.
 *
 * A failed download is returned as `parsed: false` with the error, and no log path.
 */
async function readFailedJobLog(
	job: { job: string; runID: number | null; jobID: number },
	options: { download?: DownloadJobLog; directory?: string } = {}
): Promise<FailedJobLog> {
	const download = options.download ?? downloadJobLog
	const directory = options.directory ?? failedLogDirectory()
	let text: string

	try {
		text = await download(job.runID, job.jobID)
	} catch (error) {
		return {
			...job,
			logPath: null,
			parsed: false,
			reason: `the log download failed: ${error instanceof Error ? error.message : String(error)}`,
			source: null,
			failingTests: [],
			failingChecks: [],
			errorLines: [],
			annotations: null,
		}
	}

	const logPath = `${directory}/run-${job.runID ?? "unknown"}-job-${job.jobID}-failed.log`

	await writeLocalTextFile(text, logPath)

	return parseFailedJobLog(text, { ...job, logPath })
}

/**
 * One check whose failed log is read: the check's name and its Actions ids.
 */
export interface FailedCheckRef {
	name: string
	bucket: CheckBucket
	runID: number | null
	jobID: number | null
	checkRunID: number | null
}

/**
 * Read the log of every failed check whose link holds an Actions job id.
 *
 * A failed check without a job id has no job log.
 * When its link ends in `/runs/<id>`, as CodeQL's does, that check run's annotations are read instead.
 *
 * The check stays unparsed either way, with the reason stating which of the two happened.
 */
export async function readFailedCheckLogs(
	checks: readonly FailedCheckRef[],
	options: { download?: DownloadJobLog; directory?: string; readAnnotations?: ReadCheckAnnotations } = {}
): Promise<FailedJobLog[]> {
	const results: FailedJobLog[] = []
	const readAnnotations = options.readAnnotations ?? ((id: number) => readCheckRunAnnotations(id))

	for (const check of checks) {
		if (check.bucket !== "fail") continue

		if (check.jobID == null) {
			const annotations = check.checkRunID == null ? null : await readAnnotations(check.checkRunID)

			const reason = !annotations
				? "the check's link names no GitHub Actions job and no check run, so it has no job log or annotations to read"
				: !annotations.read
					? `the check has no GitHub Actions job log, and its check run ${annotations.checkRunID}'s annotations are unread: ${annotations.error}`
					: annotations.annotations.length
						? `the check has no GitHub Actions job log; its check run ${annotations.checkRunID} holds ${annotations.annotations.length} annotation(s)`
						: `the check has no GitHub Actions job log, and its check run ${annotations.checkRunID} holds zero annotations`

			results.push({
				job: check.name,
				runID: check.runID,
				jobID: null,
				logPath: null,
				parsed: false,
				reason,
				source: null,
				failingTests: [],
				failingChecks: [],
				errorLines: [],
				annotations,
			})

			continue
		}

		results.push(await readFailedJobLog({ job: check.name, runID: check.runID, jobID: check.jobID }, options))
	}

	return results
}
