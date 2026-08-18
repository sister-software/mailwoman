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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { WorkerHost } from "./worker-host.ts"

const STUB_DIR = mkdtempSync(join(tmpdir(), "mwdev-stub-worker-"))
const STUB_PATH = join(STUB_DIR, "stub-worker.mjs")
const TOOLS_PATH = join(STUB_DIR, "tools.json")

/**
 * A minimal worker speaking the IPC protocol: ready on handshake with the sidecar's tool metas, echo on call.
 */
writeFileSync(
	STUB_PATH,
	`import { readFileSync } from "node:fs"
const tools = JSON.parse(readFileSync(process.argv[2], "utf8"))
process.on("message", (message) => {
	if (message.type === "handshake") {
		process.send({ type: "ready", pid: process.pid, bootFingerprint: "stub", tools })
	}
	if (message.type === "call") {
		process.send({ type: "result", id: message.id, ok: true, value: message.args })
	}
})
`
)

function writeTools(schema: Record<string, unknown>): void {
	writeFileSync(TOOLS_PATH, JSON.stringify([{ name: "stub_tool", description: "a stub", inputSchema: schema }]))
}

afterAll(() => {
	rmSync(STUB_DIR, { recursive: true, force: true })
})

describe("WorkerHost restart", () => {
	it("reports tools_changed when a schema changes without a name changing", async () => {
		writeTools({ type: "object", properties: {} })

		const host = new WorkerHost({ workerPath: STUB_PATH, workerArgs: [TOOLS_PATH] })

		try {
			await host.start()

			// Same list, same fork state — a restart with nothing edited stays quiet.
			const unchanged = await host.restart()

			expect(unchanged.tools_changed).toBe(false)

			// A new parameter, same tool name: the client's copy of the schema is now wrong, so this MUST announce.
			writeTools({ type: "object", properties: { tally: { type: "array" } } })

			const changed = await host.restart()

			expect(changed.tools_changed).toBe(true)
		} finally {
			await host.shutdown()
		}
	}, 30_000)
})
