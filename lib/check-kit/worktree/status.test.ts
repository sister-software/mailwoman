// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The status readers over scratch trees built here.
 *
 * A tree marked by a `.git` file that points nowhere has the shape of a worktree root whose git reads fail.
 * A tree made with `git init` has tracked files for the weights reader.
 */

import { realPath } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	createSymbolicLink,
	makeDirectories,
	setTimestamps,
	writeLocalFile,
	writeLocalJSONFile,
} from "@mailwoman/core/fs/writers"
import { gitSync } from "@mailwoman/core/git"
import { resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import { PrerequisiteState, readWorktreeStatus, type WorktreeStatusOptions } from "#check-kit/worktree/status"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function scratchTree(): Promise<string> {
	const scratch = fixtures.use(await temporaryDirectory("worktree-status-")).path
	const tree = resolvePath(await realPath(scratch), "tree")

	await writeLocalFile("gitdir: /nowhere/.git/worktrees/scratch\n", resolvePath(tree, ".git"))

	return tree
}

const OPTIONS: WorktreeStatusOptions = { callingCheckout: "/calling/checkout" }

describe("readWorktreeStatus: node_modules and the unread readers", () => {
	it("reports an absent node_modules as missing, and the unreadable git and release config as unread", async () => {
		const tree = await scratchTree()
		const status = await readWorktreeStatus(tree, OPTIONS)

		expect(status.tree).toBe(tree)

		expect(status.prerequisites.install).toMatchObject({
			state: PrerequisiteState.Missing,
			detail: { state: "absent" },
		})

		// The scratch tree has no release.config.json and its `.git` points nowhere, so neither reads.
		expect(status.prerequisites["copy-weights"].state).toBe(PrerequisiteState.Unread)
		expect(status.prerequisites["copy-weights"].evidence).toMatch(/^the weights workspaces is unread: /u)
		expect(status.branch.read).toBe(false)
		expect(status.origin.read).toBe(false)

		expect(status.ready).toBe(false)
		expect(status.missing).toEqual(["install", "compile", "copy-weights"])
	})

	it("reports a linked node_modules as missing with its target, and a directory as satisfied", async () => {
		const linked = await scratchTree()
		const target = resolvePath(linked, "..", "elsewhere")

		await makeDirectories(target)
		await createSymbolicLink(target, resolvePath(linked, "node_modules"))

		await expect(readWorktreeStatus(linked, OPTIONS)).resolves.toMatchObject({
			prerequisites: { install: { state: PrerequisiteState.Missing, detail: { state: "link", target } } },
		})

		const installed = await scratchTree()

		await makeDirectories(resolvePath(installed, "node_modules"))

		const installedStatus = await readWorktreeStatus(installed, { ...OPTIONS, readBuildDryRunOutput: async () => "" })

		expect(installedStatus.prerequisites.install.state).toBe(PrerequisiteState.Satisfied)
		expect(installedStatus.missing).not.toContain("install")
	})

	it("states the calling checkout's .env flag when the tree has none, and none when it has one", async () => {
		const tree = await scratchTree()

		await expect(readWorktreeStatus(tree, OPTIONS)).resolves.toMatchObject({
			environment: { present: { read: true, value: false }, flag: "--env-file=/calling/checkout/.env" },
		})

		await writeLocalFile("", resolvePath(tree, ".env"))

		await expect(readWorktreeStatus(tree, OPTIONS)).resolves.toMatchObject({
			environment: { present: { read: true, value: true }, flag: null },
		})
	})
})

describe("readWorktreeStatus: the compiled tree", () => {
	async function compiledTree(compiled: "absent" | "older" | "current", installed = false): Promise<string> {
		const tree = await scratchTree()
		const source = resolvePath(tree, "packages", "core", "lib", "a.ts")

		await writeLocalFile("export const a = 1\n", source)
		await setTimestamps(source, 2_000_000, 2_000_000)

		if (compiled !== "absent") {
			const emitted = resolvePath(tree, "packages", "core", "out", "a.js")
			const at = compiled === "older" ? 1_000_000 : 3_000_000

			await writeLocalFile("export const a = 1\n", emitted)
			await setTimestamps(emitted, at, at)
		}

		if (installed) {
			await makeDirectories(resolvePath(tree, "node_modules"))
		}

		return tree
	}

	async function compileReading(tree: string, dryRunOutput?: string) {
		const status = await readWorktreeStatus(tree, {
			...OPTIONS,
			readBuildDryRunOutput: async () => {
				if (dryRunOutput == null) throw new Error("the tree has no install, so tsc -b --dry must not run")

				return dryRunOutput
			},
		})

		return status.prerequisites.compile
	}

	it("reports out/ absent, older than the sources, or current by modification time when the tree has no install", async () => {
		await expect(compileReading(await compiledTree("absent"))).resolves.toMatchObject({
			state: PrerequisiteState.Missing,
			evidence: "out/ is absent",
		})

		await expect(compileReading(await compiledTree("older"))).resolves.toMatchObject({
			state: PrerequisiteState.Missing,
			evidence: expect.stringMatching(/^out\/ is older than the sources: .*a\.ts is newer than .*a\.js$/u),
		})

		await expect(compileReading(await compiledTree("current"))).resolves.toMatchObject({
			state: PrerequisiteState.Satisfied,
		})
	})

	it("reports current modification times as older than the sources when tsc -b --dry would build a build project", async () => {
		const output = [
			"09:19:57 PM - Project '/t/packages/codex/tsconfig.json' is up to date because newest input is older than output",
			"09:19:58 PM - A non-dry build would build project '/t/lib/tsconfig.json'",
		].join("\n")

		const reading = await compileReading(await compiledTree("current", true), output)

		expect(reading.state).toBe(PrerequisiteState.Missing)
		expect(reading.evidence).toContain("would build 1 of 2 build projects, first /t/lib/tsconfig.json")
	})

	it("counts a test project apart, because tsc -b --dry reports a noEmit project out of date after a passing build", async () => {
		const output = [
			"09:19:58 PM - A non-dry build would update timestamps for output of project '/t/docs/tsconfig.json'",
			"09:45:01 PM - A non-dry build would build project '/t/packages/tiger/tsconfig.test.json'",
		].join("\n")

		await expect(compileReading(await compiledTree("current", true), output)).resolves.toMatchObject({
			state: PrerequisiteState.Satisfied,
			detail: { dryRun: { wouldBuild: [], projects: 1, testProjects: 1 } },
		})
	})

	it("reports the compiled tree unread when tsc -b --dry prints no line about a project", async () => {
		const reading = await compileReading(await compiledTree("current", true), "error: something else\n")

		expect(reading.state).toBe(PrerequisiteState.Unread)
		expect(reading.evidence).toContain("no line about a build project")
	})
})

describe("readWorktreeStatus: the weights workspaces", () => {
	const WORKSPACE = "packages/neural-weights-en-us"
	const BARE = "packages/neural-weights-base-latn"

	/**
	 * A git repository whose release config lists one locale.
	 *
	 * A second weights workspace sits beside it, and copy-weights doesn't write that one.
	 */
	async function weightsTree(present: readonly string[]): Promise<string> {
		const scratch = fixtures.use(await temporaryDirectory("worktree-status-weights-")).path
		const tree = await realPath(scratch)

		gitSync(["init", "--quiet"], { cwd: tree })

		await writeLocalJSONFile(
			{ locales: ["en-us"], weights: { model: "m.onnx", tokenizer: "t.model" } },
			resolvePath(tree, "release.config.json")
		)

		await writeLocalJSONFile(
			{ files: ["model-card.json", "model.onnx", "tokenizer.model", "*.ts"] },
			resolvePath(tree, WORKSPACE, "package.json")
		)

		await writeLocalJSONFile({ version: "1.0.0" }, resolvePath(tree, WORKSPACE, "model-card.json"))
		await writeLocalJSONFile({ files: ["model.onnx"] }, resolvePath(tree, BARE, "package.json"))

		gitSync(["add", "release.config.json", WORKSPACE, BARE], { cwd: tree })

		for (const file of present) {
			await writeLocalFile("artifact", resolvePath(tree, WORKSPACE, file))
		}

		return tree
	}

	async function weightsReading(present: readonly string[]) {
		return (await readWorktreeStatus(await weightsTree(present), OPTIONS)).prerequisites["copy-weights"]
	}

	it("reports a copy-weights workspace without its untracked files as missing, naming them", async () => {
		const reading = await weightsReading([])

		expect(reading.state).toBe(PrerequisiteState.Missing)
		expect(reading.evidence).toContain("neural-weights-en-us lacks 2 of 2")

		expect(reading.detail?.workspaces.find((row) => row.workspace === WORKSPACE)).toMatchObject({
			writtenByCopyWeights: true,
			missing: ["model.onnx", "tokenizer.model"],
		})
	})

	it("is satisfied when every copy-weights workspace holds its files, whatever a workspace it doesn't write holds", async () => {
		const reading = await weightsReading(["model.onnx", "tokenizer.model"])

		expect(reading.state).toBe(PrerequisiteState.Satisfied)

		expect(reading.detail?.workspaces.find((row) => row.workspace === BARE)).toMatchObject({
			writtenByCopyWeights: false,
			missing: ["model.onnx"],
		})
	})
})
