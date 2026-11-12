// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The stub advertises tool metas from a sidecar, so a schema can change
 *   between forks without a name changing.
 *
 *   That's the restart a name-only `tools_changed` compare would leave clients stale on.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it, vi } from "vitest"

import { WorkerHost } from "#dev-mcp/worker/host"

const STUB_DIR = await temporaryDirectory("mwdev-stub-worker-")
const STUB_PATH = STUB_DIR.path("stub-worker.mjs")
const TOOLS_PATH = STUB_DIR.path("tools.json")
const JOBS_PATH = STUB_DIR.path("jobs.json")

/**
 * `mwdev_job` is answered from a sidecar file rather than echoed, because the restart
 * asks the worker for its running jobs before killing it.
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

const LIFECYCLE_STUB_PATH = STUB_DIR.path("lifecycle-worker.mjs")

/**
 * A worker that counts its spawns in a sidecar file.
 *
 * Its handshake fails on the spawn `--die-on-spawn` names, a `crash` call exits it,
 * `--ready-after` delays its ready message, and a call before ready is refused.
 */
await writeLocalTextFile(
	`const { promises: fs } = process.getBuiltinModule("node:fs")
const { parseArgs } = process.getBuiltinModule("node:util")
const { values } = parseArgs({ options: { counter: { type: "string" }, "die-on-spawn": { type: "string" }, "ready-after": { type: "string" } } })
const spawn = Number((await fs.readFile(values.counter, "utf8").catch(() => "0")) || "0") + 1
await fs.writeFile(values.counter, String(spawn))
let ready = false
process.on("message", (message) => {
	if (message.type === "handshake") {
		if (String(spawn) === values["die-on-spawn"]) process.exit(1)
		setTimeout(() => {
			ready = true
			process.send({ type: "ready", pid: process.pid, bootFingerprint: "stub", tools: [] })
		}, Number(values["ready-after"] ?? "0"))
	}
	if (message.type === "call") {
		if (!ready) return process.send({ type: "result", id: message.id, ok: false, error: "called before ready" })
		if (message.name === "crash") process.exit(1)
		process.send({ type: "result", id: message.id, ok: true, value: spawn })
	}
})
`,
	LIFECYCLE_STUB_PATH
)

async function spawnCount(counter: string): Promise<number> {
	return Number((await readLocalTextFile(counter).catch(() => "0")) || "0")
}

async function writeTools(schema: Record<string, unknown>): Promise<void> {
	await writeLocalJSONFile([{ name: "stub_tool", description: "a stub", inputSchema: schema }], TOOLS_PATH)
}

afterAll(() => STUB_DIR[Symbol.asyncDispose]())

describe("WorkerHost restart", () => {
	it("reports tools_changed when a schema changes without a name changing", async () => {
		await writeTools({ type: "object", properties: {} })

		await using host = new WorkerHost({ workerPath: STUB_PATH, workerArgs: [TOOLS_PATH] })

		await host.start()

		const unchanged = await host.restart()

		expect(unchanged.tools_changed).toBe(false)

		// A new parameter with the same tool name leaves the client's schema copy wrong, so this must announce.
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
					command: "node out/cli.js eval promote --check v9.0.0-base",
				},
				// The job finished successfully and has a verdict on disk.
				// A relaunch would repeat completed work.
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
				command: "node out/cli.js eval promote --check v9.0.0-base",
			},
		])

		expect(report.killed_jobs_note).toBeNull()
	}, 30_000)

	it("says the job list could not be read rather than reporting no jobs", async () => {
		await writeTools({ type: "object", properties: {} })

		// The sidecar is absent, so the stub refuses the call as a worker with no registry would.
		// An empty list would incorrectly tell the caller that no relaunch is needed.
		await using host = new WorkerHost({
			workerPath: STUB_PATH,
			workerArgs: [TOOLS_PATH, STUB_DIR.path("absent.json")],
		})

		await host.start()

		const report = await host.restart()

		expect(report.killed_jobs).toEqual([])
		expect(report.killed_jobs_note).toMatch(/could not be read/)
	}, 30_000)
})

describe("WorkerHost lifecycle", () => {
	it("leaves a respawn that dies in its handshake to that handshake, and forks no third worker", async () => {
		const counter = STUB_DIR.path("respawn-counter.txt").toString()

		await using host = new WorkerHost({
			workerPath: LIFECYCLE_STUB_PATH,
			workerArgs: ["--counter", counter, "--die-on-spawn", "2"],
		})

		await host.start()
		await expect(host.call("crash", {})).rejects.toThrow(/died mid-call/)

		await vi.waitFor(() => expect(host.degradedReason).toMatch(/respawn failed/), { timeout: 10_000 })

		// The first respawn died in its handshake.
		// No other respawn is running, so the host holds no worker.
		await expect(spawnCount(counter)).resolves.toBe(2)
		expect(host.pid).toBeNull()
	}, 30_000)

	it("holds a call made during the handshake until the worker reports ready", async () => {
		const counter = STUB_DIR.path("handshake-counter.txt").toString()

		await using host = new WorkerHost({
			workerPath: LIFECYCLE_STUB_PATH,
			workerArgs: ["--counter", counter, "--ready-after", "300"],
		})

		const starting = host.start()

		await vi.waitFor(async () => expect(await spawnCount(counter)).toBe(1))
		await expect(host.call("echo", {})).resolves.toBe(1)
		await starting
	}, 30_000)
})
