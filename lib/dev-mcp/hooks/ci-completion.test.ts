import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it, vi } from "vitest"

import {
	assertCIComplete,
	assertSessionCIComplete,
	claimTrackedCI,
	trackedCIMarkerPath,
	trackedCIMarkerPaths,
	type TrackedCI,
} from "#dev-mcp/hooks/ci-completion"

const SESSION_A = "session-a"
const SESSION_B = "session-b"

/**
 * A `gh` stub for an open PR on `feat/mine` whose `test` check fails.
 */
function failingPullRequest() {
	return vi
		.fn()
		.mockResolvedValueOnce({
			stdout: stringifyJSON({ headRefOid: "head-a", headRefName: "feat/mine", state: "OPEN" }),
			stderr: "",
		})
		.mockResolvedValueOnce({ stdout: stringifyJSON([{ name: "test", bucket: "fail" }]), stderr: "" })
		.mockResolvedValueOnce({ stdout: stringifyJSON({ headRefOid: "head-a" }), stderr: "" })
}

describe("session-owned CI marker", () => {
	const onMine = () => "feat/mine"

	async function checkoutWith(marker: Partial<TrackedCI>) {
		const directory = await temporaryDirectory("mw-ci-marker-")
		await writeLocalJSONFile(marker, trackedCIMarkerPath(directory.path.toString()))

		return directory
	}

	it("blocks the owning session while CI is unresolved", async () => {
		await using checkout = await checkoutWith({ repo: "owner/repo", pullRequestNumber: 1, sessionID: SESSION_A })

		await expect(
			assertSessionCIComplete({ cwd: checkout.path.toString(), session_id: SESSION_A }, failingPullRequest(), onMine)
		).rejects.toThrow("unresolved")
	})

	it("passes another session in the same checkout without reading GitHub", async () => {
		await using checkout = await checkoutWith({ repo: "owner/repo", pullRequestNumber: 1, sessionID: SESSION_A })
		const run = failingPullRequest()

		await expect(
			assertSessionCIComplete({ cwd: checkout.path.toString(), session_id: SESSION_B }, run, onMine)
		).resolves.toBeUndefined()

		expect(run).not.toHaveBeenCalled()
	})

	it.each([
		["an unowned marker", { repo: "owner/repo", pullRequestNumber: 1, sessionID: null }],
		["a marker written before ownership", { repo: "owner/repo", pullRequestNumber: 1 }],
	])("passes every session for %s", async (_label, marker) => {
		await using checkout = await checkoutWith(marker)
		const run = failingPullRequest()

		for (const session_id of [SESSION_A, SESSION_B]) {
			await expect(
				assertSessionCIComplete({ cwd: checkout.path.toString(), session_id }, run, onMine)
			).resolves.toBeUndefined()
		}

		expect(run).not.toHaveBeenCalled()
	})

	it("passes the owning session when its checkout is on another branch", async () => {
		await using checkout = await checkoutWith({ repo: "owner/repo", pullRequestNumber: 1, sessionID: SESSION_A })

		await expect(
			assertSessionCIComplete(
				{ cwd: checkout.path.toString(), session_id: SESSION_A },
				failingPullRequest(),
				() => "main"
			)
		).resolves.toBeUndefined()
	})

	it.each(["CLOSED", "MERGED"])("passes the owning session once the PR is %s", async (state) => {
		await using checkout = await checkoutWith({ repo: "owner/repo", pullRequestNumber: 1, sessionID: SESSION_A })

		const run = vi.fn().mockResolvedValueOnce({
			stdout: stringifyJSON({ headRefOid: "head-a", headRefName: "feat/mine", state }),
			stderr: "",
		})

		await expect(
			assertSessionCIComplete({ cwd: checkout.path.toString(), session_id: SESSION_A }, run, onMine)
		).resolves.toBeUndefined()

		expect(run).toHaveBeenCalledTimes(1)
	})

	it("passes a checkout with no marker", async () => {
		await using checkout = await temporaryDirectory("mw-ci-marker-")

		await expect(
			assertSessionCIComplete({ cwd: checkout.path.toString(), session_id: SESSION_A }, failingPullRequest(), onMine)
		).resolves.toBeUndefined()
	})

	it("records the creating session on the worktree and main-checkout markers, and keeps another owner", async () => {
		await using main = await checkoutWith({ repo: "owner/repo", pullRequestNumber: 2, sessionID: null })
		await using worktree = await checkoutWith({ repo: "owner/repo", pullRequestNumber: 2, sessionID: null })
		await using other = await checkoutWith({ repo: "owner/repo", pullRequestNumber: 3, sessionID: SESSION_B })

		const paths = trackedCIMarkerPaths(main.path.toString(), worktree.path.toString())

		expect(paths).toEqual([trackedCIMarkerPath(worktree.path.toString()), trackedCIMarkerPath(main.path.toString())])

		await expect(claimTrackedCI([...paths, trackedCIMarkerPath(other.path.toString())], SESSION_A)).resolves.toEqual(
			paths
		)

		for (const path of paths) {
			await expect(readLocalJSONFile(path)).resolves.toEqual({
				repo: "owner/repo",
				pullRequestNumber: 2,
				sessionID: SESSION_A,
			})
		}

		await expect(readLocalJSONFile(trackedCIMarkerPath(other.path.toString()))).resolves.toMatchObject({
			sessionID: SESSION_B,
		})
	})
})

function reader(checks: { name: string; bucket: string }[], head = "head-a") {
	return vi
		.fn()
		.mockResolvedValueOnce({ stdout: stringifyJSON({ headRefOid: "head-a", state: "OPEN" }), stderr: "" })
		.mockResolvedValueOnce({ stdout: stringifyJSON(checks), stderr: "" })
		.mockResolvedValueOnce({ stdout: stringifyJSON({ headRefOid: head }), stderr: "" })
}

describe("CI completion", () => {
	it.each(["pending", "fail", "cancel"])("blocks %s checks", async (bucket) => {
		await expect(assertCIComplete("owner/repo", 1, reader([{ name: "test", bucket }]))).rejects.toThrow("unresolved")
	})

	it("blocks a head change during verification", async () => {
		await expect(
			assertCIComplete("owner/repo", 1, reader([{ name: "test", bucket: "pass" }], "head-b"))
		).rejects.toThrow("unresolved")
	})

	it("blocks absent checks", async () => {
		await expect(assertCIComplete("owner/repo", 1, reader([]))).rejects.toThrow("unresolved")
	})

	it("requires the aggregate test check to pass", async () => {
		await expect(assertCIComplete("owner/repo", 1, reader([{ name: "CodeQL", bucket: "pass" }]))).rejects.toThrow(
			"unresolved"
		)

		await expect(assertCIComplete("owner/repo", 1, reader([{ name: "test", bucket: "skipping" }]))).rejects.toThrow(
			"unresolved"
		)
	})

	it("accepts successful and conditionally skipped checks on the same head", async () => {
		await expect(
			assertCIComplete(
				"owner/repo",
				1,
				reader([
					{ name: "test", bucket: "pass" },
					{ name: "docs", bucket: "skipping" },
				])
			)
		).resolves.toBeUndefined()
	})

	it("passes a PR whose head branch is not the session's checked-out branch, without reading its checks", async () => {
		const run = vi.fn().mockResolvedValueOnce({
			stdout: stringifyJSON({ headRefOid: "head-a", headRefName: "feat/other-session", state: "OPEN" }),
			stderr: "",
		})

		await expect(assertCIComplete("owner/repo", 1, run, true, "main")).resolves.toBeUndefined()
		expect(run).toHaveBeenCalledTimes(1)
	})

	it("still blocks the session whose checked-out branch is the PR's head", async () => {
		const run = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: stringifyJSON({ headRefOid: "head-a", headRefName: "feat/mine", state: "OPEN" }),
				stderr: "",
			})
			.mockResolvedValueOnce({ stdout: stringifyJSON([{ name: "test", bucket: "fail" }]), stderr: "" })
			.mockResolvedValueOnce({ stdout: stringifyJSON({ headRefOid: "head-a" }), stderr: "" })

		await expect(assertCIComplete("owner/repo", 1, run, true, "feat/mine")).rejects.toThrow("unresolved")
	})

	it("propagates unavailable GitHub verification", async () => {
		await expect(assertCIComplete("owner/repo", 1, vi.fn().mockRejectedValue(new Error("offline")))).rejects.toThrow(
			"offline"
		)
	})
})
