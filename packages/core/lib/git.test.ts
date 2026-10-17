/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode GitClient}: progress parsing, initialization, transfers and disposal.
 */

import { construct } from "async-init"
import { describe, expect, it } from "vitest"

import { realPath } from "#fs/readers/stat"
import { temporaryDirectory } from "#fs/temporary"
import { writeLocalTextFile } from "#fs/writers"
import { GitClient, type GitProgress, parseGitProgress } from "#git"

const IDENTITY = ["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture"]

describe("parseGitProgress", () => {
	it("reads a local and a remote progress line", () => {
		expect(parseGitProgress("Receiving objects:  45% (450/1000), 1.20 MiB | 2.40 MiB/s")).toEqual({
			stage: "Receiving objects",
			percent: 45,
			processed: 450,
			total: 1000,
		})

		expect(parseGitProgress("remote: Counting objects: 100% (5/5), done.")).toMatchObject({
			stage: "Counting objects",
			percent: 100,
		})
	})

	it("answers null for a line that carries no meter", () => {
		expect(parseGitProgress("Cloning into 'repo'...")).toBeNull()
		expect(parseGitProgress("remote: Enumerating objects: 5, done.")).toBeNull()
	})
})

describe("GitClient", () => {
	it("resolves the working-tree root on initialization and clones with progress events", async () => {
		await using scratch = await temporaryDirectory("git-client-")

		const origin = scratch.path("origin")
		const originClient = new GitClient({ cwd: scratch.path })

		await originClient.read(["init", "--quiet", "--initial-branch=main", origin.toString()])

		await writeLocalTextFile("fixture\n", origin("README"))

		const originRepo = await construct(GitClient, { cwd: origin })

		await originRepo.read(["add", "README"])
		await originRepo.read([...IDENTITY, "commit", "--quiet", "-m", "fixture"])

		expect(originRepo.root).toBe(await realPath(origin))

		const steps: GitProgress[] = []

		await using cloner = new GitClient({ cwd: scratch.path })

		cloner.on("progress", (step) => steps.push(step))

		const result = await cloner.clone(`file://${origin}`, scratch.path("copy"), { depth: 1 })

		expect(result.exitCode).toBe(0)
		expect(steps.length).toBeGreaterThan(0)
		expect(steps[0]!.command).toContain("clone")
		expect(await new GitClient({ cwd: scratch.path("copy") }).head()).toBe(await originRepo.head())
	})

	it("rejects a read after disposal", async () => {
		const client = new GitClient()

		await client[Symbol.asyncDispose]()

		await expect(client.read(["rev-parse", "HEAD"])).rejects.toThrow("disposed")
	})
})
