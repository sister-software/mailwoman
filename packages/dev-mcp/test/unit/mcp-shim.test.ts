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

import { fileURLToPath } from "@mailwoman/platform/url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const CLI_PATH = fileURLToPath(import.meta.resolve("@mailwoman/dev-mcp/cli"))

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
			const before = await client.callTool({ name: "mwdev_daemon", arguments: { action: "status" } })
			const beforePID = (before.structuredContent as { pid: number }).pid

			const restart = await client.callTool({ name: "mwdev_restart", arguments: {} })

			const report = restart.structuredContent as {
				previous_pid: number
				new_pid: number
				previous_boot_fingerprint: string
				new_boot_fingerprint: string
				tools_changed: boolean
			}

			expect(report.previous_pid).toBe(beforePID)
			expect(report.new_pid).not.toBe(beforePID)
			// The tree did not move between forks, so the fingerprints must agree — a restart is not a source change.
			expect(report.new_boot_fingerprint).toBe(report.previous_boot_fingerprint)
			expect(report.tools_changed).toBe(false)

			// The fresh worker serves: same client, same session, new module graph.
			const after = await client.callTool({ name: "mwdev_daemon", arguments: { action: "status" } })
			const afterPID = (after.structuredContent as { pid: number }).pid

			expect(afterPID).toBe(report.new_pid)
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
