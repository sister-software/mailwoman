/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end proof of the shim/worker split: a real MCP client spawns the real bin, calls a real tool through the
 *   forked worker, restarts the worker MID-SESSION, and keeps working — the property the split exists for. No stubs
 *   anywhere: a stubbed worker would prove the test's own idea of the IPC protocol, and protocol drift between shim
 *   and worker is precisely the failure this file must catch.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// The package declares no `./cli` export, so this reads the bin the manifest actually publishes.
const CLI_PATH = String(resolvePackagePath("@mailwoman/dev-mcp", "lib", "cli", "index.ts"))

/**
 * Worker boot imports the whole mailwoman graph; under vitest concurrency that is seconds, not milliseconds.
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

			// The schemas crossed the IPC boundary as plain JSON Schema — spot-check one is an object schema, not a
			// serialization accident.
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
			// A restart is not a source change: the same tree yields the same TOOL SET.
			//
			// Deliberately not `new_boot_fingerprint === previous_boot_fingerprint`. That digest covers the newest
			// source mtime and `git status --porcelain` (`tree-fingerprint.ts`), so it moves whenever anything writes
			// into the checkout — and under `yarn test` 866 other files run alongside this one, at least one of which
			// re-populates the weights overlay by design. The assertion held only while nothing else touched the tree,
			// which is true in isolation and false in the suite it runs in.
			expect(report.tools_changed).toBe(false)

			// The plumbing each fork owns, which IS load-independent: a worker reports the fingerprint it booted
			// against, and the restart report carries each fork's own value rather than re-reading one for both.
			expect(report.previous_boot_fingerprint).toBe(beforeStatus.boot_tree_fingerprint)

			// The fresh worker serves: same client, same session, new module graph.
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
			expect(String((result.content as Array<{ text: string }>)[0]?.text)).toContain("Unknown tool")
		},
		BOOT_TIMEOUT_MS
	)

	it(
		"rejects mis-shaped arguments at the schema, not deep inside the handler",
		async () => {
			// The split moved the SDK's validation out of the call path; the worker must re-impose it. A client holding
			// a pre-restart schema sends exactly this shape — an array parameter as its JSON text — and the failure it
			// gets back must name the arguments, not a TypeError from whatever the handler tried to do with the string.
			const result = await client.callTool({
				name: "mwdev_run",
				arguments: { tally: '["tier"]' },
			})

			expect(result.isError).toBe(true)
			expect(String((result.content as Array<{ text: string }>)[0]?.text)).toContain("invalid arguments")
		},
		BOOT_TIMEOUT_MS
	)
})
