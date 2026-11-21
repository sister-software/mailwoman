// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The failed-job reader over a real CI slow-suite log excerpt, and over a
 * summary job's log that holds no test.
 *
 * That second log must come back unparsed rather than as zero failures.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { type DownloadJobLog, readFailedCheckLogs } from "#check-kit/pull-request/failed-logs"

async function fixture(name: string): Promise<string> {
	const { lines } = await readLocalJSONFile<{ lines: string[] }>(
		repoRootPath("test", "fixtures", "check-kit", `${name}.json`)
	)

	return lines.join("\n")
}

/**
 * The failed step of run 44804747811's `test` job, as `gh run view --log-failed` printed it.
 *
 * That job reports the other jobs' results and runs no test.
 */
const SUMMARY_JOB_LOG = [
	"test\tCheck selected jobs\t2026-11-20T20:11:54.8833210Z Selected CI jobs didn't succeed: [ [ 'unit-fast', 'failure' ], [ 'unit-slow', 'failure' ] ]",
	"test\tCheck selected jobs\t2026-11-20T20:11:54.8865153Z ##[error]Process completed with exit code 1.",
].join("\n")

async function readOne(name: string, download: DownloadJobLog, directory?: string) {
	const [log] = await readFailedCheckLogs([{ name, bucket: "fail", runID: 1, jobID: 2, checkRunID: null }], {
		download,
		directory,
	})

	return log!
}

describe("readFailedCheckLogs", () => {
	it("writes the log and returns the failing tests the Vitest parser reads from it", async () => {
		await using scratch = await temporaryDirectory("failed-log-test-")
		const text = await fixture("vitest-ci-slow-timeouts")
		const log = await readOne("unit-slow", async () => text, scratch.path().toString())

		expect(log.parsed).toBe(true)
		expect(log.failingTests.map((test) => test.file)).toContain("packages/corpus/lib/build.integration.test.ts")
		expect(await readLocalTextFile(log.logPath!)).toBe(text)
	})

	it("returns a job log with no test failure as unparsed, with the reason, the log path and its error annotation", async () => {
		await using scratch = await temporaryDirectory("failed-log-test-")
		const log = await readOne("test", async () => SUMMARY_JOB_LOG, scratch.path().toString())

		expect(log).toMatchObject({ parsed: false, failingTests: [], errorLines: ["Process completed with exit code 1."] })
		expect(log.reason).toContain("no Vitest summary")
		expect(log.logPath).toContain("run-1-job-2-failed.log")
	})

	it("reports a failed download as unparsed with no log path", async () => {
		const log = await readOne("test", async () => {
			throw new Error("HTTP 410: the log has expired")
		})

		expect(log).toMatchObject({ parsed: false, logPath: null })
		expect(log.reason).toContain("HTTP 410")
	})
})
