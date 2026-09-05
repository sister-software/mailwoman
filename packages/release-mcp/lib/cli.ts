#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `mwrelease-mcp` — the release registry over stdio. Start it from an MCP client's config with no flags for the
 *   read and local-write operations; add `--allow-external-write` to also expose `release_publish_workspace` and
 *   `release_bless_package`, which then still demand a plan file from `release_plan` whose digest matches on an
 *   unmoved, clean HEAD. `--repo-root` names the checkout when the server is not started inside one.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { resolvePath } from "path-ts"

import { createReleaseMCPServer } from "#server"

const { values } = parseArguments({
	options: {
		"repo-root": { type: "string" },
		"allow-external-write": { type: "boolean", default: false },
	},
})

const server = createReleaseMCPServer({
	repoRoot: values["repo-root"] ? String(resolvePath(values["repo-root"])) : String(repoRootPath()),
	allowExternalWrite: values["allow-external-write"] === true,
})

await server.connect(new StdioServerTransport())
