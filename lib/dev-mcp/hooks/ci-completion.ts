/**
 * Prevents task handoff while a tracked pull request has unresolved CI.
 *
 * The tracked-PR marker is one file per checkout.
 * `mwdev_pull_request` also writes it into the main checkout when it creates a PR from a worktree.
 *
 * A marker belongs to the Claude Code session that created its PR.
 * The MCP server cannot see the session's id, so the tool writes the marker unowned.
 *
 * This module's PostToolUse handler runs in the creating session right after the tool returns.
 * It records the payload's `session_id` in every marker the tool wrote.
 *
 * The `Stop` handler blocks only the owning session, and only while its checkout
 * has the PR's head branch checked out.
 * An unowned marker blocks no session: either its owner was never recorded, or it predates ownership.
 */

import { readLocalJSONFile, readStandardInputJSON } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { gitSync } from "@mailwoman/core/git"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { isProcessError, runFile, type ProcessOutput } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"

import { resolveCheckout } from "#dev-mcp/github"

/**
 * The tool name Claude Code gives `mwdev_pull_request` in hook payloads.
 */
const PULL_REQUEST_TOOL_NAME = "mcp__mailwoman-dev__mwdev_pull_request"

/**
 * The tracked pull request a checkout's session must see through CI.
 */
export interface TrackedCI {
	repo: string
	pullRequestNumber: number
	/**
	 * The Claude Code session that created the PR, or `null` until its PostToolUse hook records it.
	 */
	sessionID: string | null
}

/**
 * The fields this module reads from a Claude Code hook payload.
 */
export interface CIHookPayload {
	hook_event_name?: string
	session_id?: string
	cwd?: string
	tool_name?: string
	tool_input?: { action?: string; checkout?: string }
}

/**
 * The marker path inside one checkout.
 */
export function trackedCIMarkerPath(checkout: string): string {
	return resolvePath(checkout, ".claude", "state", "tracked-ci.json")
}

/**
 * Every marker path `mwdev_pull_request` writes for a PR created from `checkout`:
 * that checkout's, and the server checkout's when they differ.
 */
export function trackedCIMarkerPaths(repoRoot: string, checkout: string): string[] {
	return checkout === repoRoot
		? [trackedCIMarkerPath(checkout)]
		: [trackedCIMarkerPath(checkout), trackedCIMarkerPath(repoRoot)]
}

/**
 * Records `sessionID` as the owner of each unowned marker among `paths`.
 * A marker another session owns is left as it is.
 *
 * @returns The paths whose owner was recorded.
 */
export async function claimTrackedCI(paths: readonly string[], sessionID: string): Promise<string[]> {
	const claimed: string[] = []

	for (const path of paths) {
		if (!(await pathExists(path))) continue

		const marker = await readLocalJSONFile<Partial<TrackedCI>>(path)

		if (typeof marker.sessionID === "string") continue

		await writeLocalJSONFile({ ...marker, sessionID }, path)
		claimed.push(path)
	}

	return claimed
}

/**
 * Requires successful checks for the same open PR head before and after reading GitHub.
 *
 * When `branch` is given, a PR on a different head branch passes.
 * That PR belongs to another checkout's work.
 */
export async function assertCIComplete(
	repo: string,
	pullRequestNumber: number,
	run: (args: string[]) => Promise<ProcessOutput> = (args) => runFile("gh", args),
	allowClosed = false,
	branch?: string
): Promise<void> {
	const args = ["pr", "view", String(pullRequestNumber), "--repo", repo, "--json", "headRefOid,headRefName,state"]
	const before = parseJSONStrict<{ headRefOid: string; headRefName?: string; state: string }>((await run(args)).stdout)

	if (allowClosed && ["CLOSED", "MERGED"].includes(before.state)) return

	if (branch != null && before.headRefName != null && before.headRefName !== branch) return

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

/**
 * The `Stop` check: throws while the session that owns `cwd`'s marker has
 * unresolved CI on the checked-out PR branch.
 *
 * A missing marker, an unowned marker, or a marker another session owns passes without reading GitHub.
 */
export async function assertSessionCIComplete(
	payload: CIHookPayload,
	run?: (args: string[]) => Promise<ProcessOutput>,
	branchOf: (cwd: string) => string = (cwd) => gitSync(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })
): Promise<void> {
	const cwd = payload.cwd ?? process.cwd()
	const path = trackedCIMarkerPath(cwd)

	if (!(await pathExists(path))) return

	const marker = await readLocalJSONFile<Partial<TrackedCI>>(path)

	if (typeof marker.sessionID !== "string" || marker.sessionID !== payload.session_id) return

	if (typeof marker.repo !== "string" || typeof marker.pullRequestNumber !== "number") {
		throw new TypeError(`${path} omits the tracked repo or pull request number.`)
	}

	await assertCIComplete(marker.repo, marker.pullRequestNumber, run, true, branchOf(cwd))
}

/**
 * The PostToolUse handler: records the session as owner of the markers a
 * `mwdev_pull_request` create wrote.
 */
async function claimAfterCreate(payload: CIHookPayload): Promise<void> {
	if (payload.tool_name !== PULL_REQUEST_TOOL_NAME || payload.tool_input?.action !== "create") return

	if (typeof payload.session_id !== "string" || !payload.session_id) {
		throw new TypeError("The PostToolUse payload omits `session_id`, so the tracked PR has no owning session.")
	}

	const repoRoot = repoRootPath()
	const checkout = await resolveCheckout(repoRoot, payload.tool_input.checkout)

	await claimTrackedCI(trackedCIMarkerPaths(repoRoot, checkout), payload.session_id)
}

// oxlint-disable-next-line sister-software/no-process-globals -- executable-entry detection has no project helper.
const entryPath = process.argv[1]

if (entryPath && import.meta.filename === resolvePath(entryPath)) {
	const payload = await readStandardInputJSON<CIHookPayload>()

	const [label, handle] =
		payload.hook_event_name === "PostToolUse"
			? ["CI ownership record", claimAfterCreate]
			: ["CI completion check", assertSessionCIComplete]

	await handle(payload).catch((error: unknown) => {
		process.stdout.write(stringifyJSON({ decision: "block", reason: `${label}: ${String(error)}` }))
	})
}
