#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs the MCP stdio server that forwards tool calls to a restartable worker process.
 */

import { prettyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { resolvePath } from "path-ts"

import { WorkerHost } from "#worker/host"

const { values } = parseArguments({
	options: {
		"repo-root": { type: "string" },
		"max-resident": { type: "string" },
	},
})

// The repository root does not depend on the MCP client's working directory.
const repoRoot = values["repo-root"] ? resolvePath(values["repo-root"]) : repoRootPath()

const host = new WorkerHost({
	workerPath: resolvePackagePath("@mailwoman/dev-mcp", "lib", "worker", "index.ts"),
	workerArgs: ["--repo-root", repoRoot, ...(values["max-resident"] ? ["--max-resident", values["max-resident"]] : [])],
})

/**
 * The restart tool.
 *
 * The shim handles it directly, so it works even when the worker cannot start.
 */
const RESTART_TOOL = {
	name: "mwdev_restart",
	description:
		"Kill and re-fork the worker process that holds the mailwoman module graph — a fresh import of the source on " +
		"disk, so edited code goes live WITHOUT restarting the MCP client. Run it after any merge or source edit the " +
		"daemon's staleness guard complains about. Costs: in-flight tool calls are rejected (they ran against the old " +
		"graph), background jobs die with the worker, and engines rebuild lazily on the next call. The result names " +
		"both boot fingerprints, whether the tool list changed, and `killed_jobs` — every job that was still running, " +
		"with the command to relaunch it, read before the kill because afterwards its id resolves to nothing. A " +
		"`killed_jobs_note` means the list could not be read, which is not the same as nothing having been running. " +
		"Check `mwdev_job list` first when a long check is in flight. Also the deliberate recovery path when the " +
		"worker is degraded after repeated crashes.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false } as Record<string, unknown>,
}

function asResult(value: unknown): CallToolResult {
	const record = value as Record<string, unknown>

	return { content: [{ type: "text", text: prettyJSON(record) }], structuredContent: record }
}

function asError(error: unknown): CallToolResult {
	const message = error instanceof Error ? error.message : String(error)

	return { content: [{ type: "text", text: message }], isError: true }
}

const server = new Server(
	{ name: "mailwoman-dev", version: "9.1.0" },
	{ capabilities: { tools: { listChanged: true } } }
)

server.setRequestHandler(ListToolsRequestSchema, () => ({
	tools: [...host.tools, RESTART_TOOL],
}))

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
	const name = request.params.name
	const args = (request.params.arguments as Record<string, unknown> | undefined) ?? {}

	if (name === RESTART_TOOL.name) {
		try {
			const report = await host.restart()

			if (report.tools_changed) {
				await server.sendToolListChanged()
			}

			return asResult({
				...report,
				summary:
					`Worker restarted: pid ${report.previous_pid ?? "none"} → ${report.new_pid}, boot tree ` +
					`${report.previous_boot_fingerprint?.slice(0, 12) ?? "none"} → ${report.new_boot_fingerprint.slice(0, 12)}. ` +
					`${report.aborted_calls} in-flight call(s) rejected; background jobs died with the worker; engines ` +
					`rebuild lazily on the next call.${report.tools_changed ? " The tool list CHANGED — re-list tools." : ""}`,
			})
		} catch (error) {
			return asError(error)
		}
	}

	try {
		return asResult(await host.call(name, args))
	} catch (error) {
		return asError(error)
	}
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void host[Symbol.asyncDispose]().finally(() => process.exit(0))
	})
}

await host.start()
await server.connect(new StdioServerTransport())
