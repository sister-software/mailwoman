#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Waits for GitHub to attach checks to a pull request, then watches them to completion.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import { isProcessError, runFile, type ProcessOutput } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

const CHECK_DISCOVERY_ATTEMPTS = 60
const CHECK_DISCOVERY_INTERVAL_MS = 10_000

type RunChecks = (args: string[]) => Promise<ProcessOutput>

type Wait = (milliseconds: number) => Promise<void>

const wait: Wait = (milliseconds) =>
	new Promise((resolve) => {
		setTimeout(resolve, milliseconds)
	})

function hasChecks(output: string): boolean {
	try {
		return parseJSONStrict<unknown[]>(output).length > 0
	} catch {
		return false
	}
}

/**
 * Waits for GitHub to report at least one check for a pull request.
 */
export async function waitForPullRequestChecks(
	repo: string,
	pullRequestNumber: number,
	run: RunChecks = (args) => runFile("gh", args),
	delay: Wait = wait
): Promise<void> {
	const args = ["pr", "checks", String(pullRequestNumber), "--repo", repo, "--json", "name"]

	for (let attempt = 0; attempt < CHECK_DISCOVERY_ATTEMPTS; attempt++) {
		try {
			if (hasChecks((await run(args)).stdout)) return
		} catch (error) {
			if (!isProcessError(error)) throw error

			if (hasChecks(error.stdout)) return

			if (!error.stderr.includes("no checks reported")) throw error
		}

		await delay(CHECK_DISCOVERY_INTERVAL_MS)
	}

	throw new Error(`GitHub reported no checks for pull request #${pullRequestNumber} after 10 minutes.`)
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

	await waitForPullRequestChecks(repo, pullRequestNumber)

	const result = await runFile("gh", [
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

	process.stdout.write(result.stdout)
	process.stderr.write(result.stderr)
}

// oxlint-disable-next-line sister-software/no-process-globals -- executable-entry detection has no project helper.
const entryPath = process.argv[1]

if (entryPath && import.meta.filename === resolvePath(entryPath)) {
	await main()
}
