#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Waits for GitHub to attach checks to a pull request, then watches them to completion.
 */

import { isProcessError, runFile, type ProcessOutput } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

const CHECK_DISCOVERY_ATTEMPTS = 60
const CHECK_DISCOVERY_INTERVAL_MS = 10_000
const PUSH_FOLLOW_ATTEMPTS = 180

type RunChecks = (args: string[]) => Promise<ProcessOutput>

type Wait = (milliseconds: number) => Promise<void>

const wait: Wait = (milliseconds) =>
	new Promise((resolve) => {
		setTimeout(resolve, milliseconds)
	})

function hasChecks(output: string): boolean {
	return Number.parseInt(output.trim(), 10) > 0
}

/**
 * Waits for GitHub to report at least one check for a commit.
 */
export async function waitForPullRequestChecks(
	repo: string,
	head: string,
	run: RunChecks = (args) => runFile("gh", args),
	delay: Wait = wait
): Promise<void> {
	const args = ["api", `repos/${repo}/commits/${head}/check-runs`, "--jq", ".total_count"]

	for (let attempt = 0; attempt < CHECK_DISCOVERY_ATTEMPTS; attempt++) {
		if (hasChecks((await run(args)).stdout)) return

		await delay(CHECK_DISCOVERY_INTERVAL_MS)
	}

	throw new Error(`GitHub reported no checks for commit ${head} after 10 minutes.`)
}

async function readHead(repo: string, pullRequestNumber: number, run: RunChecks): Promise<string> {
	return (
		await run(["pr", "view", String(pullRequestNumber), "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"])
	).stdout.trim()
}

async function waitForNewHead(
	repo: string,
	pullRequestNumber: number,
	previousHead: string,
	run: RunChecks,
	delay: Wait,
	attempts: number
): Promise<string | null> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const head = await readHead(repo, pullRequestNumber, run)

		if (head !== previousHead) return head

		await delay(CHECK_DISCOVERY_INTERVAL_MS)
	}

	return null
}

export interface MonitorOptions {
	run?: RunChecks
	delay?: Wait
	followAttempts?: number
	write?: (output: ProcessOutput) => void
}

/**
 * Watches the current PR head and follows a new head pushed after a failed check run.
 */
export async function monitorPullRequestChecks(
	repo: string,
	pullRequestNumber: number,
	options: MonitorOptions = {}
): Promise<void> {
	const run = options.run ?? ((args) => runFile("gh", args))
	const delay = options.delay ?? wait
	const followAttempts = options.followAttempts ?? PUSH_FOLLOW_ATTEMPTS

	const write =
		options.write ??
		((output: ProcessOutput) => {
			process.stdout.write(output.stdout)
			process.stderr.write(output.stderr)
		})

	let head = await readHead(repo, pullRequestNumber, run)

	while (true) {
		await waitForPullRequestChecks(repo, head, run, delay)

		try {
			const result = await run([
				"pr",
				"checks",
				String(pullRequestNumber),
				"--repo",
				repo,
				"--watch",
				"--fail-fast",
				"--interval",
				"10",
			])

			const currentHead = await readHead(repo, pullRequestNumber, run)

			write(result)

			if (currentHead === head) return

			head = currentHead
		} catch (error) {
			if (!isProcessError(error)) throw error

			write(error)

			const nextHead = await waitForNewHead(repo, pullRequestNumber, head, run, delay, followAttempts)

			if (!nextHead) throw error

			head = nextHead
		}
	}
}

async function main(): Promise<void> {
	const { values } = parseArguments({
		options: {
			repo: { type: "string" },
			"pull-request": { type: "string" },
		},
	})

	const repo = values.repo
	const pullRequestNumber = Number.parseInt(values["pull-request"] ?? "", 10)

	if (!repo || !Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
		throw new TypeError("The CI monitor requires `--repo` and a positive `--pull-request` number.")
	}

	await monitorPullRequestChecks(repo, pullRequestNumber)
}

// oxlint-disable-next-line sister-software/no-process-globals -- executable-entry detection has no project helper.
const entryPath = process.argv[1]

if (entryPath && import.meta.filename === resolvePath(entryPath)) {
	await main()
}
