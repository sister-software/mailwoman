/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   MCP wiring — adapts `tools.ts`'s table to the SDK's `registerTool` signature.
 *
 *   One departure from `@mailwoman/mcp`'s envelope and the reason this file exists separately rather than
 *   reusing that one. Results here are returned as `structuredContent` as well as text. A denominator that only exists
 *   inside a stringified blob is a denominator a wrapper cannot enforce and an agent can paraphrase away. The text
 *   block stays for clients that cannot read structured output.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { buildToolTable, type DevToolDeps } from "#tools/index"

export async function createDevMCPServer(deps: DevToolDeps): Promise<McpServer> {
	const server = new McpServer({ name: "mailwoman-dev", version: "9.1.0" })

	for (const tool of await buildToolTable(deps)) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: tool.inputSchema.shape },
			async (args): Promise<CallToolResult> => {
				try {
					const result = (await tool.handler(args as Record<string, unknown>)) as Record<string, unknown>

					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
						structuredContent: result,
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)

					return { content: [{ type: "text", text: message }], isError: true }
				}
			}
		)
	}

	return server
}
