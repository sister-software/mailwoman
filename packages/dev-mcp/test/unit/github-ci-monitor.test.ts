/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { monitorPullRequestChecks, waitForPullRequestChecks } from "@mailwoman/dev-mcp/github/ci-monitor"
import { describe, expect, it, vi } from "vitest"

describe("GitHub CI monitor", () => {
	it("waits until GitHub attaches a check", async () => {
		const run = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "0\n", stderr: "" })
			.mockResolvedValueOnce({ stdout: "1\n", stderr: "" })

		const delay = vi.fn(async () => undefined)

		await waitForPullRequestChecks("sister-software/mailwoman", "head-a", run, delay)

		expect(run).toHaveBeenCalledTimes(2)
		expect(delay).toHaveBeenCalledOnce()
	})

	it("follows a new head after the first head fails", async () => {
		const failed = Object.assign(new Error("checks failed"), { code: 1, stdout: "failed head-a\n", stderr: "" })

		const run = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "head-a\n", stderr: "" })
			.mockResolvedValueOnce({ stdout: "1\n", stderr: "" })
			.mockRejectedValueOnce(failed)
			.mockResolvedValueOnce({ stdout: "head-b\n", stderr: "" })
			.mockResolvedValueOnce({ stdout: "1\n", stderr: "" })
			.mockResolvedValueOnce({ stdout: "head-b passed\n", stderr: "" })
			.mockResolvedValueOnce({ stdout: "head-b\n", stderr: "" })

		const writes: string[] = []

		await monitorPullRequestChecks("sister-software/mailwoman", 2366, {
			run,
			delay: async () => undefined,
			followAttempts: 1,
			write: (output) => writes.push(output.stdout),
		})

		expect(writes).toEqual(["failed head-a\n", "head-b passed\n"])
		expect(run).toHaveBeenCalledTimes(7)
	})
})
