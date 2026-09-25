/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { waitForPullRequestChecks } from "@mailwoman/dev-mcp/github/ci-monitor"
import { describe, expect, it, vi } from "vitest"

describe("GitHub CI monitor", () => {
	it("waits until GitHub attaches a check", async () => {
		const run = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "[]", stderr: "" })
			.mockResolvedValueOnce({ stdout: '[{"name":"test"}]', stderr: "" })

		const delay = vi.fn(async () => undefined)

		await waitForPullRequestChecks("sister-software/mailwoman", 2366, run, delay)

		expect(run).toHaveBeenCalledTimes(2)
		expect(delay).toHaveBeenCalledOnce()
	})
})
