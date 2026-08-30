/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, setTimestamps, makeDirectories } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/utils"
import {
	computeTreeFingerprint,
	FINGERPRINTED_WORKSPACES,
	staleEngineMessage,
} from "@mailwoman/dev-mcp/tree-fingerprint"
import { execFileSync } from "@mailwoman/platform/child_process"
import { join } from "@mailwoman/platform/path"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * A fake checkout carrying one source file in the first fingerprinted workspace — enough to exercise the walk without
 * touching the real tree.
 */
async function fakeCheckout(): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("mwdev-fingerprint-")).path

	const workspace = join(root, FINGERPRINTED_WORKSPACES[0])

	await makeDirectories(workspace)
	await writeLocalTextFile("export const x = 1\n", join(workspace, "thing.ts"))

	return root
}

describe("computeTreeFingerprint", () => {
	it("is stable when nothing changes", async () => {
		const root = await fakeCheckout()

		expect((await computeTreeFingerprint(root)).digest).toBe((await computeTreeFingerprint(root)).digest)
	})

	it("moves when a source file is touched", async () => {
		const root = await fakeCheckout()
		const before = await computeTreeFingerprint(root)
		const file = join(root, FINGERPRINTED_WORKSPACES[0], "thing.ts")
		const future = new Date(Date.now() + 60_000)

		await setTimestamps(file, future, future)

		expect((await computeTreeFingerprint(root)).digest).not.toBe(before.digest)
	})

	it("ignores out/, so a recompile does not read as a source edit", async () => {
		const root = await fakeCheckout()
		const before = await computeTreeFingerprint(root)
		const compiled = join(root, FINGERPRINTED_WORKSPACES[0], "out")

		await makeDirectories(compiled)
		await writeLocalTextFile("export const x = 1\n", join(compiled, "thing.js"))
		// A .ts inside out/ must be ignored too — declaration output lands there.
		await writeLocalTextFile("export declare const x: number\n", join(compiled, "thing.d.ts"))

		expect((await computeTreeFingerprint(root)).digest).toBe(before.digest)
	})

	it("throws rather than fingerprinting nothing", async () => {
		// A walk that finds no files produces a digest that matches every other empty walk, which would disable the
		// staleness guard silently. `corpus-stamp.ts` names the same shape: an empty loader on BOTH sides agrees.
		await using emptyDirectory = await temporaryDirectory("mwdev-empty-")
		const empty = emptyDirectory.path

		await expect(computeTreeFingerprint(empty)).rejects.toThrow(/walked 0 source files/)
	})

	it("walks the real repository and finds source", async () => {
		const fingerprint = await computeTreeFingerprint(String(repoRootPath()))

		expect(fingerprint.filesWalked).toBeGreaterThan(100)
		expect(fingerprint.digest).toMatch(/^[0-9a-f]{16}$/)
	})
})

describe("staleEngineMessage", () => {
	it("names both fingerprints and prescribes a restart, not a reload", async () => {
		const root = await fakeCheckout()
		const before = await computeTreeFingerprint(root)
		const file = join(root, FINGERPRINTED_WORKSPACES[0], "thing.ts")
		const future = new Date(Date.now() + 120_000)

		await setTimestamps(file, future, future)

		const after = await computeTreeFingerprint(root)
		const message = staleEngineMessage(before, after)

		expect(message).toContain(before.digest)
		expect(message).toContain(after.digest)
		expect(message.toLowerCase()).toContain("restart")
		expect(message).toContain("cannot evict an imported module")
		// The assertion this test's name always claimed and never made. The message used to end
		// `Restart the MCP server (or call mwdev_daemon with action "reload")`, so it prescribed BOTH — and the
		// reload half is the one that rebuilds sessions around the same module graph and reports a clean
		// fingerprint over stale code. A "not a reload" guard has to check for the absence.
		expect(message).not.toMatch(/action "reload"|call mwdev_daemon/)
		expect(message.toLowerCase()).toContain("separate process")
	})
})

describe("computeTreeFingerprint — dirty files", () => {
	it("reports a modified path whole, including the first one", async () => {
		// `git status --porcelain` writes an unstaged modification as " M path". Trimming the whole output before
		// splitting eats column one of the FIRST line only, and a fixed-width slice then takes the leading character of
		// the path with it — so the field reports a file that does not exist, and only ever the first one.
		const root = await fakeCheckout()
		const relative = join(FINGERPRINTED_WORKSPACES[0]!, "thing.ts")

		execFileSync("git", ["init", "--quiet"], { cwd: root })
		execFileSync("git", ["add", "."], { cwd: root })

		execFileSync("git", ["-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "--quiet", "-m", "seed"], {
			cwd: root,
		})

		await writeLocalTextFile("export const x = 2\n", join(root, relative))

		expect((await computeTreeFingerprint(root)).dirtyFiles).toEqual([relative])
	})
})
