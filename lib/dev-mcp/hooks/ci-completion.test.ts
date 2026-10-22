import { stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it, vi } from "vitest"

import { assertCIComplete } from "#dev-mcp/hooks/ci-completion"

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
