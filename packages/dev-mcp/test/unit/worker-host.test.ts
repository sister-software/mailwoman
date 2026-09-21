/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Host-level pins against a stub child — the injection point `WorkerHostOptions.workerPath` exists for. The stub advertises
 *   whatever tool metas its sidecar file holds, so the test can change a schema between forks without changing a name:
 *   exactly the restart the name-only `tools_changed` compare failed to announce, leaving clients on a stale schema
 *   with no signal to refresh.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { WorkerHost } from "@mailwoman/dev-mcp/worker/host"
import { afterAll, describe, expect, it } from "vitest"

const STUB_DIR = await temporaryDirectory("mwdev-stub-worker-")
const STUB_PATH = STUB_DIR.resolve("stub-worker.mjs")
const TOOLS_PATH = STUB_DIR.resolve("tools.json")
const JOBS_PATH = STUB_DIR.resolve("jobs.json")

/**
 * A minimal worker speaking the IPC protocol: ready on handshake with the
 * sidecar's tool metas, echo on call.
 *
 * `mwdev_job` is answered from a sidecar file rather than echoed, because the restart asks the worker
 * for its running jobs before killing it and the test has to be able to say what the worker holds.
 */
await writeLocalTextFile(
	`const { promises: fs } = process.getBuiltinModule("node:fs")
const tools = JSON.parse(await fs.readFile(process.argv[2], "utf8"))
process.on("message", async (message) => {
	if (message.type === "handshake") {
		process.send({ type: "ready", pid: process.pid, bootFingerprint: "stub", tools })
	}
	if (message.type === "call") {
		if (message.name === "mwdev_job") {
			const raw = await fs.readFile(process.argv[3], "utf8").catch(() => null)

			if (raw === null) {
				process.send({ type: "result", id: message.id, ok: false, error: "no job registry" })
				return
			}

			process.send({ type: "result", id: message.id, ok: true, value: { jobs: JSON.parse(raw) } })
			return
		}

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

		// A new parameter, same tool name: the client's copy of the schema is now wrong, so this must announce.
		await writeTools({ type: "object", properties: { tally: { type: "array" } } })

		const changed = await host.restart()

		expect(changed.tools_changed).toBe(true)
	}, 30_000)

	it("names every job it killed, with the command that relaunches it", async () => {
		await writeTools({ type: "object", properties: {} })

		await writeLocalJSONFile(
			[
				{
					job_id: "job-1",
					label: "check:v9.0.0-base",
					state: "running",
					elapsed_s: 41,
					command: "node out/cli/index.js eval promote --check v9.0.0-base",
				},
				// A finished job is not a loss and must not be reported as one — a caller relaunching it would re-run
				// work that already has a verdict on disk.
				{ job_id: "job-0", label: "check:earlier", state: "succeeded", elapsed_s: 400, command: "node earlier" },
			],
			JOBS_PATH
		)

		await using host = new WorkerHost({ workerPath: STUB_PATH, workerArgs: [TOOLS_PATH, JOBS_PATH] })

		await host.start()

		const report = await host.restart()

		expect(report.killed_jobs).toEqual([
			{
				job_id: "job-1",
				label: "check:v9.0.0-base",
				elapsed_s: 41,
				command: "node out/cli/index.js eval promote --check v9.0.0-base",
			},
		])

		expect(report.killed_jobs_note).toBeUndefined()
	}, 30_000)

	it("says the job list could not be read rather than reporting no jobs", async () => {
		await writeTools({ type: "object", properties: {} })

		// The sidecar is absent, so the stub refuses the call the way a worker with no registry would.
		// An empty list here would tell the caller a relaunch is unnecessary, which is the one wrong answer.
		await using host = new WorkerHost({
			workerPath: STUB_PATH,
			workerArgs: [TOOLS_PATH, STUB_DIR.resolve("absent.json").toString()],
		})

		await host.start()

		const report = await host.restart()

		expect(report.killed_jobs).toEqual([])
		expect(report.killed_jobs_note).toMatch(/could not be read/)
	}, 30_000)
})
