/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { expect, it } from "vitest"

import { createBrowserMCPServer } from "#mcp"

import { serveBrowserFixture } from "../test/site.ts"

it("serves stealth-enabled browser tools over the configured stdio command", async () => {
	await using scratch = await temporaryDirectory("browser-stdio-")
	await using resources = new AsyncDisposableStack()
	const client = new Client({ name: "browser-stdio", version: "1.0.0" })
	resources.defer(() => client.close())

	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [repoRootPath("lib/browser-mcp/cli.ts").toString(), "--output-dir", scratch.path.toString()],
		stderr: "pipe",
	})

	const errors: string[] = []
	transport.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()))
	await client.connect(transport)
	const navigation = await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } })
	expect(navigation.isError, stringifyJSON(navigation)).not.toBe(true)

	const evaluation = await client.callTool({
		name: "browser_evaluate",
		arguments: { function: "() => navigator.webdriver" },
	})

	expect(evaluation.isError, stringifyJSON(evaluation)).not.toBe(true)

	expect(evaluation.content).toEqual(
		expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("false") })])
	)

	await client.close()
	expect(errors.join("")).toBe("")
})

it("serves navigation, evaluation, images, and browser reopening through Microsoft's MCP tools", async () => {
	await using site = await serveBrowserFixture()
	await using scratch = await temporaryDirectory("browser-mcp-")
	await using connection = await createBrowserMCPServer({ outputDir: scratch.path.toString() })
	await using resources = new AsyncDisposableStack()
	const client = new Client({ name: "browser-integration", version: "1.0.0" })
	resources.defer(() => client.close())
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	await connection.connect(serverTransport)
	await client.connect(clientTransport)

	const { tools } = await client.listTools()

	expect(tools.map((tool) => tool.name)).toEqual(
		expect.arrayContaining(["browser_navigate", "browser_evaluate", "browser_take_screenshot", "browser_close"])
	)

	for (const attempt of [0, 1]) {
		const navigation = await client.callTool({ name: "browser_navigate", arguments: { url: site.url } })
		expect(navigation.isError, stringifyJSON(navigation)).not.toBe(true)

		const evaluation = await client.callTool({
			name: "browser_evaluate",
			arguments: { function: "() => ({ firstScript: globalThis.initialWebdriver, current: navigator.webdriver })" },
		})

		expect(evaluation.isError, stringifyJSON(evaluation)).not.toBe(true)
		expect(stringifyJSON(evaluation)).toContain('\\"firstScript\\": false')
		expect(stringifyJSON(evaluation)).toContain('\\"current\\": false')

		if (attempt === 0) {
			const screenshot = await client.callTool({ name: "browser_take_screenshot", arguments: { type: "png" } })
			expect(screenshot.isError, stringifyJSON(screenshot)).not.toBe(true)
			expect(screenshot.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]))

			const download = await client.callTool({
				name: "browser_click",
				arguments: { element: "Download addresses", target: "text=Download addresses" },
			})

			expect(download.isError, stringifyJSON(download)).not.toBe(true)

			await expect
				.poll(() => readLocalTextFile(scratch.path("addresses.csv")))
				.toBe("address\n10 Downing Street, London SW1A 2AA\n")
		}

		const closed = await client.callTool({ name: "browser_close", arguments: {} })
		expect(closed.isError, stringifyJSON(closed)).not.toBe(true)
	}
})
