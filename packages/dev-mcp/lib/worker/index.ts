/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The dev-MCP worker that actually imports mailwoman: the shim speaks MCP stdio and imports no runtime module, so
 * this child holds the whole graph and is the unit of restart, and its stdout is piped to the shim's stderr so
 * library noise cannot corrupt the MCP channel.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { z } from "zod"

import { EngineRegistry } from "#engine/registry"
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

/**
 * Messages the worker accepts: handshake, call and shutdown, mirroring the shim's own shapes structurally.
 */
export type WorkerInbound = HandshakeMessage | CallMessage | ShutdownMessage

/**
 * A tool the worker advertises in the ready message, with its schema already converted to JSON Schema.
 */
export interface WorkerToolMeta {
	name: string
	description: string
	inputSchema: Record<string, unknown>
}

/**
 * Messages the worker sends: a ready signal, and a result carrying either a value or an error string.
 */
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
			send({ type: "result", id: message.id, ok: false, error: `Unknown tool ${stringifyJSON(message.name)}.` })

			return
		}

		// Validate here rather than in the shim: an unvalidated handler turns a
		// stale-schema client's mis-shaped argument into a deep, misattributed TypeError,
		// and parsing also applies the schema's defaults.
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

// The shim restarts by sigterm.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		registry.evictAll()
		jobs.cancelAll()
		process.exit(0)
	})
}
