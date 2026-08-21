/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worktree arm's CONTRACT, exercised against a throwaway git repo rather than this one.
 *
 *   Deliberately not a geocode: building an engine costs minutes and needs the data root, so a test that ran one
 *   would be a slow integration test wearing a unit test's clothes. What is asserted here is the machinery that
 *   was actually hard — that a ref arm runs the REF's source and a `WORKTREE` arm runs the UNCOMMITTED one,
 *   that a dirty tree says so in the commit it reports, and that neither leaves litter behind.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { runWorktreeArm, WORKING_TREE_REF } from "./worktree-arm.ts"

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true })
	}
})

/**
 * A minimal git repo whose "pipeline" is one file, plus a `node_modules` the farm can mirror.
 *
 * `mailwoman/geocode-session` is stubbed as a real package directory so the runner's import resolves without this test
 * needing the monorepo. That is the same resolution path the real arm uses — a stub here proves the farm and the
 * subprocess, and the engine is exercised for real by the tools that call this.
 */
function fakeRepo(marker: string): string {
	const root = mkdtempSync(join(tmpdir(), "mwdev-wt-test-"))

	roots.push(root)

	mkdirSync(join(root, "packages", "mailwoman"), { recursive: true })
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/mailwoman"] }))

	writeFileSync(
		join(root, "packages", "mailwoman", "package.json"),
		JSON.stringify({
			name: "mailwoman",
			exports: { "./geocode-session": { node: "./geocode-session.ts", default: "./geocode-session.ts" } },
		})
	)

	writeFileSync(
		join(root, "packages", "mailwoman", "geocode-session.ts"),
		`export async function createGeocodeSession() {
			return {
				geocode: async (input) => ({ result: { lat: 1, lon: 2, resolution_tier: ${JSON.stringify(marker)}, components: { locality: input } } }),
				close: () => {},
			}
		}\n`
	)

	// The workspace link yarn would have installed. Both arms need it and for different reasons: the WORKTREE arm
	// resolves through it directly, and the ref arm's farm mirrors this directory to build its own — so an empty
	// node_modules here would test neither path.
	mkdirSync(join(root, "node_modules"), { recursive: true })
	symlinkSync(join(root, "packages", "mailwoman"), join(root, "node_modules", "mailwoman"))
	// Untracked and ignored, so the "does not touch the caller's tree" assertion compares a clean status to a clean
	// status rather than to one this helper dirtied.
	writeFileSync(join(root, ".gitignore"), "node_modules\n")

	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root })
	execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root })
	execFileSync("git", ["config", "user.name", "T"], { cwd: root })
	execFileSync("git", ["add", "-A"], { cwd: root })
	execFileSync("git", ["commit", "-qm", "initial"], { cwd: root })

	return root
}

const OPTIONS = {}

describe("runWorktreeArm — a ref arm runs THAT ref's source", () => {
	it("answers from the committed source, not the working tree", async () => {
		const root = fakeRepo("committed")

		// Edit without committing. A ref arm must not see this; that is the whole distinction it sells.
		writeFileSync(
			join(root, "packages", "mailwoman", "geocode-session.ts"),
			`export async function createGeocodeSession() {
				return { geocode: async () => ({ result: { lat: 9, lon: 9, resolution_tier: "uncommitted", components: {} } }), close: () => {} }
			}\n`
		)

		const result = await runWorktreeArm({ repoRoot: root, ref: "HEAD", inputs: ["x"], options: OPTIONS })

		expect(result.answers[0]!.tier).toBe("committed")
		expect(result.commit).not.toContain("+dirty")
	})
})

describe("runWorktreeArm — the WORKTREE arm runs the UNCOMMITTED source", () => {
	it("answers from the working tree and marks the commit dirty", async () => {
		const root = fakeRepo("committed")

		writeFileSync(
			join(root, "packages", "mailwoman", "geocode-session.ts"),
			`export async function createGeocodeSession() {
				return { geocode: async () => ({ result: { lat: 9, lon: 9, resolution_tier: "uncommitted", components: {} } }), close: () => {} }
			}\n`
		)

		const result = await runWorktreeArm({
			repoRoot: root,
			ref: WORKING_TREE_REF,
			inputs: ["x"],
			options: OPTIONS,
		})

		expect(result.answers[0]!.tier).toBe("uncommitted")
		// A dirty tree is not its HEAD. Reporting the bare sha would let a result claim a commit it did not run.
		expect(result.commit).toContain("+dirty")
	})

	it("leaves no runner behind in the operator's own checkout", async () => {
		const root = fakeRepo("committed")

		await runWorktreeArm({ repoRoot: root, ref: WORKING_TREE_REF, inputs: ["x"], options: OPTIONS })

		expect(existsSync(join(root, ".mwdev-arm-runner.ts"))).toBe(false)
	})

	it("removes the runner even when the child throws", async () => {
		const root = fakeRepo("committed")

		writeFileSync(
			join(root, "packages", "mailwoman", "geocode-session.ts"),
			`export async function createGeocodeSession() { throw new Error("boom") }\n`
		)

		await expect(
			runWorktreeArm({ repoRoot: root, ref: WORKING_TREE_REF, inputs: ["x"], options: OPTIONS })
		).rejects.toThrow(/boom|Command failed/)

		expect(existsSync(join(root, ".mwdev-arm-runner.ts"))).toBe(false)
	})
})

describe("runWorktreeArm — cleanup", () => {
	it("registers no worktree after a ref arm completes", async () => {
		const root = fakeRepo("committed")

		await runWorktreeArm({ repoRoot: root, ref: "HEAD", inputs: ["x"], options: OPTIONS })

		const listed = execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" })

		// The main checkout is always listed; a leaked worktree would be a second line.
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- the test creates at most one extra worktree
		expect(listed.trim().split("\n")).toHaveLength(1)
	})

	it("does not touch the caller's HEAD or working tree", async () => {
		const root = fakeRepo("committed")
		const before = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })

		await runWorktreeArm({ repoRoot: root, ref: "HEAD", inputs: ["x"], options: OPTIONS })

		expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(before)
		expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).toBe(head)
		// A stash-based arm would have moved these; a worktree cannot, which is why it is a worktree.
		expect(readdirSync(root)).toContain("packages")
	})
})

describe("runWorktreeArm — per-input failures", () => {
	it("reports a throwing input as an errored answer rather than failing the batch", async () => {
		const root = fakeRepo("committed")

		writeFileSync(
			join(root, "packages", "mailwoman", "geocode-session.ts"),
			`export async function createGeocodeSession() {
				return {
					geocode: async (input) => {
						if (input === "bad") throw new Error("nope")
						return { result: { lat: 1, lon: 2, resolution_tier: "ok", components: {} } }
					},
					close: () => {},
				}
			}\n`
		)

		const result = await runWorktreeArm({
			repoRoot: root,
			ref: WORKING_TREE_REF,
			inputs: ["good", "bad"],
			options: OPTIONS,
		})

		expect(result.answers).toHaveLength(2)
		expect(result.answers[0]!.tier).toBe("ok")
		expect(result.answers[1]!.lat).toBeNull()
		expect(result.answers[1]!.error).toContain("nope")
	})
})
