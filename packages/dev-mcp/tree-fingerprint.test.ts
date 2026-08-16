/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import { afterAll, describe, expect, it } from "vitest"

import { computeTreeFingerprint, FINGERPRINTED_WORKSPACES, staleEngineMessage } from "./tree-fingerprint.ts"

const scratchRoots: string[] = []

/**
 * A fake checkout carrying one source file in the first fingerprinted workspace — enough to exercise the walk without
 * touching the real tree.
 */
function fakeCheckout(): string {
	const root = mkdtempSync(join(tmpdir(), "mwdev-fingerprint-"))

	scratchRoots.push(root)

	const workspace = join(root, FINGERPRINTED_WORKSPACES[0])

	mkdirSync(workspace, { recursive: true })
	writeFileSync(join(workspace, "thing.ts"), "export const x = 1\n")

	return root
}

afterAll(() => {
	for (const root of scratchRoots) {
		rmSync(root, { recursive: true, force: true })
	}
})

describe("computeTreeFingerprint", () => {
	it("is stable when nothing changes", () => {
		const root = fakeCheckout()

		expect(computeTreeFingerprint(root).digest).toBe(computeTreeFingerprint(root).digest)
	})

	it("moves when a source file is touched", () => {
		const root = fakeCheckout()
		const before = computeTreeFingerprint(root)
		const file = join(root, FINGERPRINTED_WORKSPACES[0], "thing.ts")
		const future = new Date(Date.now() + 60_000)

		utimesSync(file, future, future)

		expect(computeTreeFingerprint(root).digest).not.toBe(before.digest)
	})

	it("ignores out/, so a recompile does not read as a source edit", () => {
		const root = fakeCheckout()
		const before = computeTreeFingerprint(root)
		const compiled = join(root, FINGERPRINTED_WORKSPACES[0], "out")

		mkdirSync(compiled, { recursive: true })
		writeFileSync(join(compiled, "thing.js"), "export const x = 1\n")
		// A .ts inside out/ must be ignored too — declaration output lands there.
		writeFileSync(join(compiled, "thing.d.ts"), "export declare const x: number\n")

		expect(computeTreeFingerprint(root).digest).toBe(before.digest)
	})

	it("throws rather than fingerprinting nothing", () => {
		// A walk that finds no files produces a digest that matches every other empty walk, which would disable the
		// staleness guard silently. `corpus-stamp.ts` names the same shape: an empty loader on BOTH sides agrees.
		const empty = mkdtempSync(join(tmpdir(), "mwdev-empty-"))

		scratchRoots.push(empty)

		expect(() => computeTreeFingerprint(empty)).toThrow(/walked 0 source files/)
	})

	it("walks the real repository and finds source", () => {
		const fingerprint = computeTreeFingerprint(String(repoRootPath()))

		expect(fingerprint.filesWalked).toBeGreaterThan(100)
		expect(fingerprint.digest).toMatch(/^[0-9a-f]{16}$/)
	})
})

describe("staleEngineMessage", () => {
	it("names both fingerprints and prescribes a restart, not a reload", () => {
		const root = fakeCheckout()
		const before = computeTreeFingerprint(root)
		const file = join(root, FINGERPRINTED_WORKSPACES[0], "thing.ts")
		const future = new Date(Date.now() + 120_000)

		utimesSync(file, future, future)

		const after = computeTreeFingerprint(root)
		const message = staleEngineMessage(before, after)

		expect(message).toContain(before.digest)
		expect(message).toContain(after.digest)
		// The remedy must not claim a reload that Node cannot perform.
		expect(message).toContain("Restart")
		expect(message).toContain("cannot evict an imported module")
	})
})

describe("computeTreeFingerprint — dirty files", () => {
	it("reports a modified path whole, including the first one", () => {
		// `git status --porcelain` writes an unstaged modification as " M path". Trimming the whole output before
		// splitting eats column one of the FIRST line only, and a fixed-width slice then takes the leading character of
		// the path with it — so the field reports a file that does not exist, and only ever the first one.
		const root = fakeCheckout()
		const relative = join(FINGERPRINTED_WORKSPACES[0]!, "thing.ts")

		execFileSync("git", ["init", "--quiet"], { cwd: root })
		execFileSync("git", ["add", "."], { cwd: root })

		execFileSync("git", ["-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "--quiet", "-m", "seed"], {
			cwd: root,
		})

		writeFileSync(join(root, relative), "export const x = 2\n")

		expect(computeTreeFingerprint(root).dirtyFiles).toEqual([relative])
	})
})
