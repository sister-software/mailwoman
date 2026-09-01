/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The dev-MCP worker — the process that actually imports mailwoman.
 *
 *   The shim (`cli.ts`) speaks MCP stdio to the client and imports NOTHING from this repo's runtime, so it never goes
 *   stale; this child holds the whole module graph — engines, gazetteers, ONNX sessions — and is the unit of restart.
 *   Killing and re-forking it is the ONLY way a running server picks up edited source: Node cannot evict an imported
 *   ES module, and a fresh process is also the only guarantee that the multi-gigabyte SQLite mmaps and ORT sessions
 *   are actually released.
 *
 *   Protocol (over the fork IPC channel; every message is one JSON-structured object):
 *
 *   in:  { type: "handshake" }
 *        { type: "call", id, name, args }
 *        { type: "shutdown" }
 *   out: { type: "ready", pid, bootFingerprint, tools: [{ name, description, inputSchema }] }
 *        { type: "result", id, ok: true, value } | { type: "result", id, ok: false, error }
 *
 *   `inputSchema` crosses the boundary as plain JSON Schema (draft-7, what MCP clients expect) because the shim must
 *   register tools WITHOUT importing zod schemas from this side — that import is exactly the staleness it exists to
 *   avoid. Tool handlers run here verbatim; the shim adds no behavior beyond transport and restart.
 *
 *   STDOUT DISCIPLINE: this process's stdout is piped to the shim's STDERR, so library noise can never corrupt the
 *   MCP channel. All protocol traffic rides the IPC channel via `process.send`.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { z } from "zod"

import { EngineRegistry } from "#engine-registry"
import { JobRegistry } from "#jobs"
import { buildToolTable, type DevTool } from "#tools/index"

interface HandshakeMessage {
	type: "handshake"
}

interface CallMessage {
	type: "call"
	id: number
	name: string
	args: Record<string, unknown>
}

interface ShutdownMessage {
	type: "shutdown"
}

export type WorkerInbound = HandshakeMessage | CallMessage | ShutdownMessage

export interface WorkerToolMeta {
	name: string
	description: string
	inputSchema: Record<string, unknown>
}

export type WorkerOutbound =
	| { type: "ready"; pid: number; bootFingerprint: string; tools: WorkerToolMeta[] }
	| { type: "result"; id: number; ok: true; value: unknown }
	| { type: "result"; id: number; ok: false; error: string }

const { values } = parseArguments({
	options: {
		"repo-root": { type: "string" },
		"max-resident": { type: "string" },
	},
})

if (!values["repo-root"]) {
	throw new Error("worker: --repo-root is required (the shim always passes it)")
}

const registry = await EngineRegistry.create(
	values["repo-root"],
	values["max-resident"] ? Number.parseInt(values["max-resident"], 10) : 2
)

const jobs = new JobRegistry()
const table = await buildToolTable({ registry, jobs, startedAt: Date.now() })
const byName = new Map<string, DevTool>(table.map((tool) => [tool.name, tool]))

function send(message: WorkerOutbound): void {
	process.send?.(message)
}

function toolMetas(): WorkerToolMeta[] {
	return table.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: z.toJSONSchema(tool.inputSchema, { target: "draft-7" }) as Record<string, unknown>,
	}))
}

process.on("message", (message: WorkerInbound) => {
	if (message.type === "handshake") {
		send({ type: "ready", pid: process.pid, bootFingerprint: registry.bootFingerprint.digest, tools: toolMetas() })

		return
	}

	if (message.type === "shutdown") {
		registry.evictAll()
		jobs.cancelAll()
		process.exit(0)
	}

	if (message.type === "call") {
		const tool = byName.get(message.name)

		if (!tool) {
			send({ type: "result", id: message.id, ok: false, error: `Unknown tool ${JSON.stringify(message.name)}.` })

			return
		}

		// Validate HERE, not in the shim: the split moved the SDK's schema enforcement out of the call path, and an
		// unvalidated handler turns a stale-schema client's mis-shaped argument into a deep, misattributed TypeError
		// (a tally array arriving as its JSON text reached `paths.map`). Parsing also applies the schema's defaults.
		const parsed = tool.inputSchema.safeParse(message.args)

		if (!parsed.success) {
			send({
				type: "result",
				id: message.id,
				ok: false,
				error:
					`${message.name}: invalid arguments — ${z.prettifyError(parsed.error)}. If your client's schema for ` +
					"this tool predates a worker restart, refresh the tool list (the server announces schema changes " +
					"via tools/list_changed).",
			})

			return
		}

		void tool
			.handler(parsed.data as Record<string, unknown>)
			.then((value) => send({ type: "result", id: message.id, ok: true, value }))
			.catch((error: unknown) =>
				send({
					type: "result",
					id: message.id,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				})
			)
	}
})

// The shim restarts by SIGTERM; the same cleanup the old single-process server ran on its signals.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		registry.evictAll()
		jobs.cancelAll()
		process.exit(0)
	})
}
