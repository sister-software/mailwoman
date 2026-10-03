import { describe, expect, it, vi } from "vitest"

import { assertCIComplete } from "#hooks/ci-completion"

function reader(checks: { name: string; bucket: string }[], head = "head-a") {
	return vi
		.fn()
		.mockResolvedValueOnce({ stdout: JSON.stringify({ headRefOid: "head-a", state: "OPEN" }), stderr: "" })
		.mockResolvedValueOnce({ stdout: JSON.stringify(checks), stderr: "" })
		.mockResolvedValueOnce({ stdout: JSON.stringify({ headRefOid: head }), stderr: "" })
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
	it("propagates unavailable GitHub verification", async () => {
		await expect(assertCIComplete("owner/repo", 1, vi.fn().mockRejectedValue(new Error("offline")))).rejects.toThrow(
			"offline"
		)
	})
})
