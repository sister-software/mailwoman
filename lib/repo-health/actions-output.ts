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

import { readCIWorkspaces, selectCIScope, type CIScope } from "#repo-health/ci-scope"

const ciEnvironment = liveEnv(
	z.object({
		GITHUB_EVENT_NAME: z.string().optional(),
		CI_BASE_SHA: z.string().optional(),
		CI_HEAD_SHA: z.string().optional(),
		GITHUB_OUTPUT: z.string().optional(),
		GITHUB_STEP_SUMMARY: z.string().optional(),
	})
)

/**
 * Writes the selected suites to GitHub Actions outputs and returns the selection.
 */
export async function writeCIScope(root: string): Promise<CIScope> {
	const event = ciEnvironment.GITHUB_EVENT_NAME
	const base = ciEnvironment.CI_BASE_SHA
	const head = ciEnvironment.CI_HEAD_SHA

	if (event === "pull_request" && (!base || !head || !/^[a-f0-9]{40}$/u.test(base) || !/^[a-f0-9]{40}$/u.test(head))) {
		throw new Error("A pull request requires valid CI_BASE_SHA and CI_HEAD_SHA commits")
	}

	// Disabling rename detection includes both paths of a move, so both workspaces are selected.
	const changed =
		event === "pull_request"
			? (await git(["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"], root, 64 * 1024 * 1024))
					.split("\0")
					.filter((path) => path.length > 0)
			: []

	const files = await trackedFiles(root)

	const release = await readLocalJSONFile<{
		plugins: { "@release-it-plugins/workspaces": { workspaces: string[] } }
	}>(resolvePath(root, ".release-it.json"))

	const scope = selectCIScope(
		await readCIWorkspaces(root, files),
		files,
		changed,
		release.plugins["@release-it-plugins/workspaces"].workspaces,
		event !== "pull_request"
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
