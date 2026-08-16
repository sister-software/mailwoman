#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwdev-mcp` — boot the development MCP server over stdio.
 *
 *   Engines are LAZY: nothing loads weights or opens a gazetteer at startup, matching `packages/mcp/cli.ts`'s contract
 *   and for the same reason — a client may connect, list tools, and never call one. The first call that needs an engine
 *   builds it, and every call after that is warm.
 *
 *   ```sh
 *   mwdev-mcp                     # repo root inferred from this file's location
 *   mwdev-mcp --repo-root /path   # explicit, for a second checkout
 *   ```
 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { EngineRegistry } from "./engine-registry.ts"
import { JobRegistry } from "./jobs.ts"
import { createDevMCPServer } from "./server.ts"

const { values } = parseArgs({
	options: {
		"repo-root": { type: "string" },
		"max-resident": { type: "string" },
	},
})

// This file lives at <repo>/packages/dev-mcp/cli.ts, so the root is two levels up. Derived from `import.meta.url`
// rather than `cwd`, because an MCP client spawns the server from wherever it happens to be.
const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const repoRoot = values["repo-root"] ? resolve(values["repo-root"]) : defaultRepoRoot
const maxResident = values["max-resident"] ? Number.parseInt(values["max-resident"], 10) : 2

const registry = new EngineRegistry(repoRoot, maxResident)
const jobs = new JobRegistry()
const server = createDevMCPServer({ registry, jobs, startedAt: Date.now() })

// Sessions hold SQLite handles for as long as the agent lives; `packages/mcp` has no shutdown handler and that gap is
// not inherited.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		registry.closeAll()
		jobs.cancelAll()
		process.exit(0)
	})
}

await server.connect(new StdioServerTransport())
