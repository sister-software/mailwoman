// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The CI reader reports a failed `gh` call as unread rather than as an empty queue.
 */

import { stringifyJSON } from "@mailwoman/core/values/json"
import { describe, expect, it } from "vitest"

import { readActiveCIRuns } from "#check-kit/ci-runs"

describe("readActiveCIRuns", () => {
	it("reports the CI state as unread when gh fails", async () => {
		const reading = await readActiveCIRuns(async () => {
			throw new Error("error connecting to api.github.com")
		})

		expect(reading).toEqual({ read: false, error: "error connecting to api.github.com" })
	})

	it("lists a GitHub-hosted code-scanning run and a run queued past GitHub's limit apart from the runs it counts", async () => {
		const now = Date.parse("2026-11-20T18:00:00Z")

		const queued = [
			{
				databaseId: 3,
				workflowName: "Deploy",
				headBranch: "main",
				status: "queued",
				event: "push",
				createdAt: "2026-11-11T20:42:42Z",
				url: "https://example.invalid/3",
			},
		]

		const reading = await readActiveCIRuns(
			async (args) =>
				stringifyJSON(
					!args.includes("in_progress")
						? queued
						: [
								{
									databaseId: 1,
									workflowName: "Test",
									headBranch: "main",
									status: "in_progress",
									event: "push",
									createdAt: "2026-11-20T17:00:00Z",
									url: "https://example.invalid/1",
								},
								{
									databaseId: 2,
									workflowName: "CodeQL",
									headBranch: "refs/pull/1/head",
									status: "in_progress",
									event: "dynamic",
									createdAt: "2026-11-20T17:00:00Z",
									url: "https://example.invalid/2",
								},
							]
				),
			now
		)

		expect(reading.runs?.map((run) => run.workflow)).toEqual(["Test"])
		expect(reading.excluded?.map((run) => run.workflow)).toEqual(["CodeQL", "Deploy"])
	})
})
