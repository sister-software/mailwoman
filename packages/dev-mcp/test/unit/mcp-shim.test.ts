/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end: no stubs, because protocol drift between shim and worker is the failure this file must catch.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// The package declares no `./cli` export, so this reads the bin the manifest actually publishes.
const CLI_PATH = resolvePackagePath("@mailwoman/dev-mcp", "lib", "cli", "index.ts")

/**
 * Worker boot imports the whole mailwoman graph, which is seconds rather than
 * milliseconds under vitest concurrency.
 */
const BOOT_TIMEOUT_MS = 120_000

let client: Client

beforeAll(async () => {
	client = new Client({ name: "shim-test", version: "0" })

	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [CLI_PATH],
			stderr: "ignore",
		})
	)
}, BOOT_TIMEOUT_MS)

afterAll(async () => {
	await client.close()
})

describe("the never-stale shim", () => {
	it(
		"lists the worker's tools plus its own mwdev_restart",
		async () => {
			const { tools } = await client.listTools()
			const names = tools.map((tool) => tool.name)

			expect(names).toContain("mwdev_daemon")
			expect(names).toContain("mwdev_inputs")
			expect(names).toContain("mwdev_restart")

			const inputsTool = tools.find((tool) => tool.name === "mwdev_inputs")

			expect(inputsTool?.inputSchema).toMatchObject({ type: "object" })
		},
		BOOT_TIMEOUT_MS
	)

	it(
		"forwards a real tool call through the worker",
		async () => {
			const result = await client.callTool({ name: "mwdev_inputs", arguments: {} })
			const structured = result.structuredContent as { n: number; set_id: string }

			expect(structured.set_id).toBe("board")
			expect(structured.n).toBeGreaterThan(500)
		},
		BOOT_TIMEOUT_MS
	)

	it(
		"restarts the worker mid-session and keeps serving — the property the split exists for",
		async () => {
			interface Status {
				pid: number
				boot_tree_fingerprint: string
			}

			const before = await client.callTool({ name: "mwdev_daemon", arguments: { action: "status" } })
			const beforeStatus = before.structuredContent as Status

			const restart = await client.callTool({ name: "mwdev_restart", arguments: {} })

			const report = restart.structuredContent as {
				previous_pid: number
				new_pid: number
				previous_boot_fingerprint: string
				new_boot_fingerprint: string
				tools_changed: boolean
			}

			expect(report.previous_pid).toBe(beforeStatus.pid)
			expect(report.new_pid).not.toBe(beforeStatus.pid)
			// The boot fingerprint covers the newest source mtime and `git status --porcelain`,
			// so it moves whenever anything writes into the checkout; assert the tool SET instead.
			expect(report.tools_changed).toBe(false)

			// Each fork reports the fingerprint it booted against, so this comparison is load-independent.
			expect(report.previous_boot_fingerprint).toBe(beforeStatus.boot_tree_fingerprint)

			const after = await client.callTool({ name: "mwdev_daemon", arguments: { action: "status" } })
			const afterStatus = after.structuredContent as Status

			expect(afterStatus.pid).toBe(report.new_pid)
			expect(afterStatus.boot_tree_fingerprint).toBe(report.new_boot_fingerprint)
		},
		BOOT_TIMEOUT_MS
	)

	it(
		"reports an unknown tool as a tool error, not a transport failure",
		async () => {
			const result = await client.callTool({ name: "mwdev_nonexistent", arguments: {} })

			expect(result.isError).toBe(true)
			expect((result.content as Array<{ text: string }>)[0]?.text).toContain("Unknown tool")
		},
		BOOT_TIMEOUT_MS
	)

	it(
		"rejects mis-shaped arguments at the schema, not deep inside the handler",
		async () => {
			// The split moved the SDK's argument validation off the call path, so the worker must
			// re-impose it: a client holding a pre-restart schema sends an array parameter as
			// JSON text, and the failure must name the arguments rather than surface a TypeError.
			const result = await client.callTool({
				name: "mwdev_run",
				arguments: { tally: '["tier"]' },
			})

			expect(result.isError).toBe(true)
			expect((result.content as Array<{ text: string }>)[0]?.text).toContain("invalid arguments")
		},
		BOOT_TIMEOUT_MS
	)
})
