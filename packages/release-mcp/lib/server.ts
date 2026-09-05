/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file MCP wiring for the release tool table — `registerTool` per tool, results as `structuredContent` beside the text
 *   block, an operation's thrown error as an `isError` result rather than a dropped connection.
 */

import { operations, type ReleaseOperation } from "@mailwoman/release-kit"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { buildReleaseToolTable, registryTool, type ReleaseToolTableOptions } from "#tool-table"

export interface ReleaseMCPServerOptions extends ReleaseToolTableOptions {
	/**
	 * The registry to serve. Defaults to `@mailwoman/release-kit`'s; a test hands in its own.
	 */
	registry?: ReadonlyArray<ReleaseOperation<unknown, unknown>>
}

export function createReleaseMCPServer(options: ReleaseMCPServerOptions): McpServer {
	const registry = options.registry ?? operations
	const server = new McpServer({ name: "mailwoman-release", version: "9.2.0" })

	for (const tool of [registryTool(registry, options), ...buildReleaseToolTable(registry, options)]) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: tool.inputSchema.shape },
			async (args): Promise<CallToolResult> => {
				try {
					const structured: Record<string, unknown> = { ...(await tool.handler(args as Record<string, unknown>)) }

					return {
						content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
						structuredContent: structured,
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
