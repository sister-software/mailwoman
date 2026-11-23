// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reads the repository's queued and in-progress GitHub Actions runs through `gh`.
 *
 * The lab host runs the self-hosted runners, so a running workflow competes
 * with a local heavy check for memory.
 * A failed read is reported as unread, never as idle, because an unreadable queue may hold a run.
 */

import { parseJSONStrict } from "@mailwoman/core/values/json"

import { type RunGitHub, runGitHub } from "#dev-mcp/github"

const REPO = "sister-software/mailwoman"

/**
 * The statuses of a run that hasn't finished.
 */
const ACTIVE_STATUSES = ["in_progress", "queued"] as const

/**
 * The event of a run GitHub's default code-scanning setup starts.
 *
 * Such a run executes on GitHub's hosted runners, so it uses none of this host's memory.
 * It's listed under `excluded` with its reason rather than dropped,
 * so a reader sees what the count leaves out.
 */
const HOSTED_EVENT = "dynamic"

/**
 * The longest a self-hosted job waits in the queue before GitHub terminates it: 24 hours.
 *
 * A run still listed as queued after that holds no job a runner will pick up.
 */
const MAX_QUEUE_MS = 24 * 60 * 60_000

/**
 * One queued or in-progress run.
 */
export interface ActiveCIRun {
	id: number
	workflow: string
	branch: string
	status: string
	event: string
	createdAt: string
	url: string
}

/**
 * A listed run that uses none of this host's runners, with the reason.
 */
interface ExcludedCIRun extends ActiveCIRun {
	reason: string
}

/**
 * Why a run doesn't count against this host, or `null` when it does.
 */
function exclusionReason(run: ActiveCIRun, now: number): string | null {
	if (run.event === HOSTED_EVENT) return "GitHub's default code scanning runs on GitHub-hosted runners"

	if (run.status === "queued" && now - Date.parse(run.createdAt) > MAX_QUEUE_MS) {
		return "queued for more than the 24 hours GitHub lets a self-hosted job wait"
	}

	return null
}

/**
 * The repository's active runs, or the reason they couldn't be read.
 */
export type CIRunsReading =
	| { read: true; runs: ActiveCIRun[]; excluded: ExcludedCIRun[]; error?: never }
	| { read: false; runs?: never; excluded?: never; error: string }

interface RawRun {
	databaseId: number
	workflowName: string
	headBranch: string
	status: string
	event: string
	createdAt: string
	url: string
}

/**
 * Read the queued and in-progress runs, one `gh run list` call per status.
 *
 * @param run The `gh` runner, injected by a test.
 * @param now The current time in epoch milliseconds, injected by a test.
 */
export async function readActiveCIRuns(run: RunGitHub = runGitHub, now: number = Date.now()): Promise<CIRunsReading> {
	const active: ActiveCIRun[] = []

	try {
		for (const status of ACTIVE_STATUSES) {
			const rows = parseJSONStrict<RawRun[]>(
				await run([
					"run",
					"list",
					"--repo",
					REPO,
					"--status",
					status,
					"--limit",
					"100",
					"--json",
					"databaseId,workflowName,headBranch,status,event,createdAt,url",
				])
			)

			if (!Array.isArray(rows)) throw new TypeError(`gh run list --status ${status} returned no array`)

			for (const row of rows) {
				active.push({
					id: row.databaseId,
					workflow: row.workflowName,
					branch: row.headBranch,
					status: row.status,
					event: row.event,
					createdAt: row.createdAt,
					url: row.url,
				})
			}
		}
	} catch (error) {
		return { read: false, error: error instanceof Error ? error.message : String(error) }
	}

	const runs: ActiveCIRun[] = []
	const excluded: ExcludedCIRun[] = []

	for (const entry of active) {
		const reason = exclusionReason(entry, now)

		if (reason) {
			excluded.push({ ...entry, reason })
		} else {
			runs.push(entry)
		}
	}

	return { read: true, runs, excluded }
}

/**
 * One line per run, for the human view.
 */
export function describeCIRun(run: ActiveCIRun): string {
	return `${run.workflow} on ${run.branch} (${run.status}, created ${run.createdAt})`
}
