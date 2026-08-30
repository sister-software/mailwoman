/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Host-level pins against a stub child — the seam `WorkerHostOptions.workerPath` exists for. The stub advertises
 *   whatever tool metas its sidecar file holds, so the test can change a SCHEMA between forks without changing a name:
 *   exactly the restart the name-only `tools_changed` compare failed to announce, leaving clients on a stale schema
 *   with no signal to refresh.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { WorkerHost } from "@mailwoman/dev-mcp/worker-host"
import { afterAll, describe, expect, it } from "vitest"

const STUB_DIR = await temporaryDirectory("mwdev-stub-worker-")
const STUB_PATH = STUB_DIR.resolve("stub-worker.mjs")
const TOOLS_PATH = STUB_DIR.resolve("tools.json")

/**
 * A minimal worker speaking the IPC protocol: ready on handshake with the sidecar's tool metas, echo on call.
 */
await writeLocalTextFile(
	`const { readFileSync } = process.getBuiltinModule("node:fs")
const tools = JSON.parse(readFileSync(process.argv[2], "utf8"))
process.on("message", (message) => {
	if (message.type === "handshake") {
		process.send({ type: "ready", pid: process.pid, bootFingerprint: "stub", tools })
	}
	if (message.type === "call") {
		process.send({ type: "result", id: message.id, ok: true, value: message.args })
	}
})
`,
	STUB_PATH
)

async function writeTools(schema: Record<string, unknown>): Promise<void> {
	await writeLocalJSONFile([{ name: "stub_tool", description: "a stub", inputSchema: schema }], TOOLS_PATH)
}

afterAll(() => STUB_DIR[Symbol.asyncDispose]())

describe("WorkerHost restart", () => {
	it("reports tools_changed when a schema changes without a name changing", async () => {
		await writeTools({ type: "object", properties: {} })

		await using host = new WorkerHost({ workerPath: STUB_PATH, workerArgs: [TOOLS_PATH] })

		await host.start()

		// Same list, same fork state — a restart with nothing edited stays quiet.
		const unchanged = await host.restart()

		expect(unchanged.tools_changed).toBe(false)

		// A new parameter, same tool name: the client's copy of the schema is now wrong, so this MUST announce.
		await writeTools({ type: "object", properties: { tally: { type: "array" } } })

		const changed = await host.restart()

		expect(changed.tools_changed).toBe(true)
	}, 30_000)
})
