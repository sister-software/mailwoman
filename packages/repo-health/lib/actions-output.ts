/** Computes CI scope and writes GitHub Actions outputs without running tests. */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { appendLocalTextFile } from "@mailwoman/core/fs/writers"
import { git, trackedFiles } from "@mailwoman/core/git"
import { resolvePath } from "path-ts"

import { readCIWorkspaces, selectCIScope, type CIScope } from "#ci-scope"

/** Writes the selected suites to GitHub Actions outputs and returns the selection. */
export async function writeCIScope(root: string): Promise<CIScope> {
	const event = process.env["GITHUB_EVENT_NAME"]
	const base = process.env["CI_BASE_SHA"]
	const head = process.env["CI_HEAD_SHA"]

	if (event === "pull_request" && (!base || !head || !/^[a-f0-9]{40}$/u.test(base) || !/^[a-f0-9]{40}$/u.test(head))) {
		throw new Error("A pull request requires valid CI_BASE_SHA and CI_HEAD_SHA commits")
	}

	// Disabling rename detection includes both paths of a move, so both workspaces are selected.
	const changed =
		event === "pull_request"
			? (await git(["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"], root, 64 * 1024 * 1024))
					.split("\0")
					.filter(Boolean)
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
		fast_files: JSON.stringify(scope.full ? [] : scope.fastFiles),
		slow_files: JSON.stringify(scope.full ? [] : scope.slowFiles),
	}

	if (process.env["GITHUB_OUTPUT"]) {
		await appendLocalTextFile(
			Object.entries(outputs)
				.map(([key, value]) => `${key}=${value}`)
				.join("\n") + "\n",
			process.env["GITHUB_OUTPUT"]
		)
	}
	if (process.env["GITHUB_STEP_SUMMARY"]) {
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
			process.env["GITHUB_STEP_SUMMARY"]
		)
	}

	return scope
}
