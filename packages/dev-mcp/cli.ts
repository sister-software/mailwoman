#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwdev-mcp` — the never-stale shim. Speaks MCP stdio to the client; every tool call is forwarded over IPC to a
 *   forked worker (`worker.ts`) that holds the actual mailwoman module graph.
 *
 *   THE SPLIT IS THE FEATURE. Node cannot evict an imported ES module, so the old single-process server had to refuse
 *   after any source edit until the OPERATOR restarted the client — which locked the person developing the measurement
 *   tools out of them precisely while the tree was moving (measured cost: most of two working days routed through
 *   scratch scripts, 2026-08-16..18). This file therefore imports NOTHING from the repo's runtime — Node builtins and
 *   the MCP SDK only — and `mwdev_restart` kills and re-forks the worker: a fresh module graph, new source live, no
 *   client restart. A change to the shim itself (rare by design) still needs the client restart; keep it boring.
 *
 *   Tools are registered from the worker's handshake as plain JSON Schema — the low-level `Server` API, deliberately,
 *   because the high-level one wants zod shapes and zod schemas live on the stale side of the boundary. After a
 *   restart the shim diffs the tool list and emits `notifications/tools/list_changed`, so a client that honors the
 *   capability re-lists.
 *
 *   Engines stay LAZY end to end: forking the worker imports modules but builds nothing; the first call that needs an
 *   engine builds it, per the registry's own contract.
 *
 *   PRIOR ART + THE REJECTED ALTERNATIVE (verified 2026-08-18): the MCP ecosystem converged on exactly this
 *   proxy+restartable-child shape — mizchi/mcp-reloader and cameroncooke/reloaderoo wrap a child MCP process and
 *   restart it; mcp-hmr (Python) reloads modules in place; all emit `tools/list_changed` after a swap. The genuinely
 *   newer primitive, `process.execve` (re-exec preserving only stdio), was considered and rejected: it discards the
 *   initialized MCP SESSION along with the module graph, so the fresh image receives post-`initialize` traffic cold —
 *   and no surviving code exists to bridge the boundary or emit list_changed. The shim keeps the session in a process
 *   that cannot go stale, and a child PROCESS (not a worker thread) is what guarantees the sqlite mmaps and ORT
 *   native sessions are actually released on restart.
 */

import { dirname, resolve } from "@mailwoman/platform/path"
import { fileURLToPath } from "@mailwoman/platform/url"
import { parseArgs } from "@mailwoman/platform/util"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { WorkerHost } from "./worker-host.ts"

const { values } = parseArgs({
	options: {
		"repo-root": { type: "string" },
		"max-resident": { type: "string" },
	},
})

// This file lives at <repo>/packages/dev-mcp/cli.ts, so the root is two levels up. Derived from `import.meta.url`
// rather than `cwd`, because an MCP client spawns the server from wherever it happens to be.
const shimDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = values["repo-root"] ? resolve(values["repo-root"]) : resolve(shimDir, "..", "..")

const host = new WorkerHost({
	workerPath: resolve(shimDir, "worker.ts"),
	workerArgs: ["--repo-root", repoRoot, ...(values["max-resident"] ? ["--max-resident", values["max-resident"]] : [])],
})

/**
 * The one tool the SHIM owns, so it exists whatever state the worker is in — including crashed, degraded, or holding a
 * tree so broken the worker cannot boot (start() failures surface here as the restart error, stderr tail included).
 */
const RESTART_TOOL = {
	name: "mwdev_restart",
	description:
		"Kill and re-fork the worker process that holds the mailwoman module graph — a fresh import of the source on " +
		"disk, so edited code goes live WITHOUT restarting the MCP client. Run it after any merge or source edit the " +
		"daemon's staleness guard complains about. Costs: in-flight tool calls are rejected (they ran against the old " +
		"graph), background jobs die with the worker, and engines rebuild lazily on the next call. The result names " +
		"both boot fingerprints and whether the tool list changed. Also the deliberate recovery path when the worker " +
		"is degraded after repeated crashes.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false } as Record<string, unknown>,
}

function asResult(value: unknown): CallToolResult {
	const record = value as Record<string, unknown>

	return { content: [{ type: "text", text: JSON.stringify(record, null, 2) }], structuredContent: record }
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
		void host.shutdown().finally(() => process.exit(0))
	})
}

await host.start()
await server.connect(new StdioServerTransport())
