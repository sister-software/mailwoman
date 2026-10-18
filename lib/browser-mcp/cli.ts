#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * This command serves the shared browser over MCP stdio.
 */

import { createBrowserMCPServer } from "@mailwoman/browser/mcp"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { resolvePath } from "path-ts"

const { values } = parseArguments({
	options: {
		headed: { type: "boolean", default: false },
		"storage-state": { type: "string" },
		"output-dir": { type: "string" },
		"cdp-endpoint": { type: "string" },
	},
})

await using connection = await createBrowserMCPServer({
	browser: {
		launchOptions: { headless: !values.headed, handleSIGINT: false, handleSIGTERM: false },
		contextOptions: values["storage-state"] ? { storageState: resolvePath(values["storage-state"]) } : {},
		...(values["cdp-endpoint"] ? { cdpEndpoint: values["cdp-endpoint"] } : {}),
	},
	...(values["output-dir"] ? { outputDir: resolvePath(values["output-dir"]) } : {}),
})

const closed = new Promise<void>((resolve) => {
	const previous = connection.server.onclose

	connection.server.onclose = () => {
		previous?.()
		resolve()
	}
})

const close = () => {
	void connection.server.close()
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, close)
}

// The SDK's stdio transport does not close itself when its input reaches EOF.
process.stdin.once("end", close)

try {
	await connection.connect(new StdioServerTransport())
	await closed
} finally {
	process.stdin.off("end", close)

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.off(signal, close)
	}
}
