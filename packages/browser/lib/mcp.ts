/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { RequestId } from "@modelcontextprotocol/sdk/types.js"
import { createConnection } from "@playwright/mcp"

import { createBrowserSession, type BrowserSession, type BrowserSessionOptions } from "#session"

/**
 * These options configure the browser and the directory for MCP artifacts.
 */
export interface BrowserMCPOptions {
	browser?: BrowserSessionOptions
	outputDir?: string
}

/**
 * Creates Microsoft's browser MCP tools using the shared stealth-enabled context.
 *
 * The browser starts on the first browser tool call.
 * A later call starts a new session with the same settings after the context closes.
 */
export async function createBrowserMCPServer(options: BrowserMCPOptions = {}) {
	let current: BrowserSession | null = null
	let pending: Promise<BrowserSession> | null = null
	let contextClosed = false

	const server = await createConnection(
		{
			// An injected context is already isolated.
			// The MCP's isolated mode would ask its supplied-context adapter to create another context.
			// That adapter only supports the context the caller supplied.
			browser: { isolated: false },
			...(options.outputDir ? { outputDir: options.outputDir } : {}),
		},
		async () => {
			if (pending) return (await pending).context

			if (current && !contextClosed && current.browser.isConnected()) return current.context

			pending = (async () => {
				if (current) {
					await current[Symbol.asyncDispose]()
				}

				const session = await createBrowserSession(options.browser)
				current = session
				contextClosed = false

				session.context.once("close", () => {
					contextClosed = true
				})

				return session
			})()

			try {
				return (await pending).context
			} finally {
				pending = null
			}
		}
	)

	return {
		server,
		async connect(transport: Transport) {
			const closingRequests = new Set<RequestId>()

			const bridge: Transport = {
				async start() {
					transport.onclose = () => bridge.onclose?.()
					transport.onerror = (error) => bridge.onerror?.(error)

					transport.onmessage = (message, extra) => {
						if (
							"method" in message &&
							message.method === "tools/call" &&
							message.params?.["name"] === "browser_close" &&
							"id" in message
						) {
							closingRequests.add(message.id)
						}

						bridge.onmessage?.(message, extra)
					}

					await transport.start()
				},
				async send(message, sendOptions) {
					// The supplied-context adapter disposes its tabs on browser_close but leaves the context open.
					// Our session disposal also disconnects that disposed backend.
					if ("result" in message && closingRequests.delete(message.id) && !message.result["isError"]) {
						await current?.[Symbol.asyncDispose]()
					}

					await transport.send(message, sendOptions)
				},
				close: () => transport.close(),
			}

			await server.connect(bridge)
		},
		async [Symbol.asyncDispose]() {
			try {
				await server.close()
			} finally {
				try {
					await pending
				} finally {
					await current?.[Symbol.asyncDispose]()
				}
			}
		},
	}
}
