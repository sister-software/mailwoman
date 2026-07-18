/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   MCP server wiring — thin glue that registers `tools.ts`'s tool table on an `McpServer`. The tool table is the
 *   stable, tested contract (`tools.test.ts`); this module only adapts it to the SDK's `registerTool` signature and
 *   `CallToolResult` envelope. `cli.ts` owns building the real `MCPToolDeps` and connecting a transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { buildToolTable, type MCPToolDeps } from "./tools.ts"

/**
 * The advertised server version — keep in lockstep with `package.json`'s `version` (not read from it dynamically: a
 * static string avoids `resolveJsonModule`/`composite` friction for one cosmetic field, the same tradeoff
 * `nominatim`/`photon`'s OpenAPI `info.version` DON'T make since theirs is a documented public contract; an MCP client
 * only ever logs this).
 */
const MCP_SERVER_VERSION = "7.1.0"

/**
 * Build an `McpServer` with every `tools.ts` tool registered. A handler's returned value is JSON-stringified into a
 * single `text` content block — every tool here answers with structured data (parse trees, geocode results, search
 * hits), so a plain JSON text block is the simplest faithful rendering; none of the five tools need images, resource
 * links, or other MCP content kinds. A thrown error becomes an `isError` tool result instead of a protocol-level
 * failure, so a bad address / missing db surfaces to the agent as a normal (if unsuccessful) tool call.
 */
export function createMCPServer(deps: MCPToolDeps): McpServer {
	const server = new McpServer({ name: "mailwoman", version: MCP_SERVER_VERSION })

	for (const tool of buildToolTable(deps)) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: tool.inputSchema.shape },
			async (args): Promise<CallToolResult> => {
				try {
					const result = await tool.handler(args)

					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)

					return { content: [{ type: "text", text: message }], isError: true }
				}
			}
		)
	}

	return server
}
