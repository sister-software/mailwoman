/**
 * Prevents task handoff while a tracked pull request has unresolved CI.
 */

import { readLocalJSONFile, readStandardInputJSON } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { isProcessError, runFile, type ProcessOutput } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"

/**
 * Requires successful checks for the same open PR head before and after reading GitHub.
 */
export async function assertCIComplete(
	repo: string,
	pullRequestNumber: number,
	run: (args: string[]) => Promise<ProcessOutput> = (args) => runFile("gh", args),
	allowClosed = false
): Promise<void> {
	const args = ["pr", "view", String(pullRequestNumber), "--repo", repo, "--json", "headRefOid,state"]
	const before = parseJSONStrict<{ headRefOid: string; state: string }>((await run(args)).stdout)

	if (allowClosed && ["CLOSED", "MERGED"].includes(before.state)) return

	if (before.state !== "OPEN" || !before.headRefOid) throw new Error("GitHub omitted the open PR state or head.")

	const output = await run(["pr", "checks", String(pullRequestNumber), "--repo", repo, "--json", "name,bucket"]).catch(
		(error: unknown) => {
			if (isProcessError(error) && [1, 8].includes(Number(error.code)) && error.stdout) return error
			throw error
		}
	)

	const checks = parseJSONStrict<{ name: string; bucket: string }[]>(output.stdout)
	const after = parseJSONStrict<{ headRefOid: string }>((await run(args)).stdout)
	const unresolved = checks.filter((check) => !["pass", "skipping"].includes(check.bucket))

	if (
		before.headRefOid !== after.headRefOid ||
		!checks.some((check) => check.name === "test" && check.bucket === "pass") ||
		unresolved.length
	) {
		throw new Error(
			`PR #${pullRequestNumber} CI is unresolved for ${after.headRefOid}. Review the current checks, fix failures, and continue monitoring. ` +
				unresolved.map((check) => `${check.name}: ${check.bucket}`).join(", ")
		)
	}
}

async function main(): Promise<void> {
	const payload = await readStandardInputJSON<{ cwd?: string }>()
	const marker = resolvePath(payload.cwd ?? process.cwd(), ".claude", "state", "tracked-ci.json")

	if (!(await pathExists(marker))) return

	const { repo, pullRequestNumber } = await readLocalJSONFile<{ repo: string; pullRequestNumber: number }>(marker)
	await assertCIComplete(repo, pullRequestNumber, undefined, true)
}

// oxlint-disable-next-line sister-software/no-process-globals -- executable-entry detection has no project helper.
const entryPath = process.argv[1]

if (entryPath && import.meta.filename === resolvePath(entryPath)) {
	await main().catch((error: unknown) => {
		process.stdout.write(stringifyJSON({ decision: "block", reason: `CI completion check: ${String(error)}` }))
	})
}
