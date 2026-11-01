/**
 * Computes CI scope and writes GitHub Actions outputs without running tests.
 */

import { liveEnv } from "@mailwoman/core/env"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { appendLocalTextFile } from "@mailwoman/core/fs/writers"
import { git, trackedFiles } from "@mailwoman/core/git"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePath } from "path-ts"
import { z } from "zod"

import { readRelatedCITests, selectRelatedCIScope } from "#repo-health/ci/related"
import { readCIWorkspaces, selectCIScope, type CIScope } from "#repo-health/ci/scope"

const ciEnvironment = liveEnv(
	z.object({
		GITHUB_EVENT_NAME: z.string().optional(),
		CI_BASE_SHA: z.string().optional(),
		CI_HEAD_SHA: z.string().optional(),
		GITHUB_OUTPUT: z.string().optional(),
		GITHUB_STEP_SUMMARY: z.string().optional(),
	})
)

const isCommitSHA = (sha: string | undefined): sha is string => typeof sha === "string" && /^[a-f0-9]{40}$/u.test(sha)

/**
 * Whether a run selects its suites from the diff between `base` and `head`,
 * rather than running every suite.
 *
 * A pull request always does.
 * A push does when it passes the branch's previous head and the clone holds that commit.
 *
 * A new branch reports an all-zero previous head, and a force-push passes one the clone lacks.
 * A dispatched run runs every suite.
 *
 * @throws When a pull request does not name both commits.
 */
export async function scopesByDiff(
	event: string | undefined,
	base: string | undefined,
	head: string | undefined,
	hasCommit: (sha: string) => Promise<boolean>
): Promise<boolean> {
	if (event === "pull_request") {
		if (!isCommitSHA(base) || !isCommitSHA(head)) {
			throw new Error("A pull request requires valid CI_BASE_SHA and CI_HEAD_SHA commits")
		}

		return true
	}

	if (event !== "push" || !isCommitSHA(base) || !isCommitSHA(head) || /^0+$/u.test(base)) return false

	return hasCommit(base)
}

/**
 * Writes the selected suites to GitHub Actions outputs and returns the selection.
 */
export async function writeCIScope(root: string): Promise<CIScope> {
	const event = ciEnvironment.GITHUB_EVENT_NAME
	const base = ciEnvironment.CI_BASE_SHA
	const head = ciEnvironment.CI_HEAD_SHA

	const scoped = await scopesByDiff(event, base, head, (sha) =>
		git(["cat-file", "-t", sha], root).then(
			(type) => type.trim() === "commit",
			() => false
		)
	)

	// A diff without rename detection includes both paths of a move, so both workspaces are selected.
	const changed = scoped
		? (await git(["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"], root, 64 * 1024 * 1024))
				.split("\0")
				.filter((path) => path.length > 0)
		: []

	const files = await trackedFiles(root)

	const release = await readLocalJSONFile<{
		plugins: { "@release-it-plugins/workspaces": { workspaces: string[] } }
	}>(resolvePath(root, ".release-it.json"))

	const workspaces = await readCIWorkspaces(root, files)

	const workspaceScope = selectCIScope(
		workspaces,
		files,
		changed,
		release.plugins["@release-it-plugins/workspaces"].workspaces,
		!scoped
	)

	const scope = await selectRelatedCIScope(workspaceScope, workspaces, changed, (inputs, config) =>
		readRelatedCITests(root, inputs, config)
	)

	const outputs = {
		...Object.fromEntries(Object.entries(scope).filter(([, value]) => typeof value === "boolean")),
		fast_files: stringifyJSON(scope.full ? [] : scope.fastFiles),
		slow_files: stringifyJSON(scope.full ? [] : scope.slowFiles),
	}

	if (ciEnvironment.GITHUB_OUTPUT) {
		await appendLocalTextFile(
			Object.entries(outputs)
				.map(([key, value]) => `${key}=${value}`)
				.join("\n") + "\n",
			ciEnvironment.GITHUB_OUTPUT
		)
	}

	if (ciEnvironment.GITHUB_STEP_SUMMARY) {
		await appendLocalTextFile(
			[
				"## Selected CI suites",
				"",
				...scope.reasons,
				"",
				`Affected workspaces: ${scope.affected.length ? scope.affected.map((directory) => `\`${directory}\``).join(", ") : "none"}.`,
				"",
				"| Suite | Selected |",
				"| --- | --- |",
				...Object.entries(outputs)
					.filter(([, value]) => typeof value === "boolean")
					.map(([key, value]) => `| ${key} | ${value} |`),
				"",
				`Selected fast test files: ${scope.fastFiles.length}. Selected slow test files: ${scope.slowFiles.length}.`,
				"Unselected suites did not run. Main and dispatched runs select every suite.",
				"",
			].join("\n"),
			ciEnvironment.GITHUB_STEP_SUMMARY
		)
	}

	return scope
}
