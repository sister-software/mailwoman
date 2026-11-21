// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `mwdev_http_get` against a local server bound to 127.0.0.1, and the address-range
 * refusal through a stubbed resolver.
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { stringifyJSON } from "@mailwoman/core/json"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { HTTPGetServices } from "#check-kit/http-get"
import type { DevToolDeps } from "#dev-mcp/tool-kit"
import { httpGetTool } from "#dev-mcp/tools/http-get"

/**
 * The fields of a reply these tests read.
 */
interface HTTPReply {
	status: number | null
	finalURL: string
	redirects: Array<{ url: string; status: number }>
	binary: boolean
	body: string | null
	bytesRead: number
	truncated: boolean
	fullLength: number | null
	contentType: string | null
	json: unknown
}

async function getThroughTool(args: Record<string, unknown>, services: HTTPGetServices = {}): Promise<HTTPReply> {
	return (await httpGetTool({} as DevToolDeps, services).handler(args)) as HTTPReply
}

/**
 * A resolver that answers every host name with one address.
 */
function resolvesTo(address: string): HTTPGetServices {
	return { resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }] }
}

let server: Server
let origin: string
const received: Array<Record<string, string | string[] | undefined>> = []

beforeAll(async () => {
	server = createServer((request, response) => {
		received.push(request.headers)

		const path = request.url ?? "/"

		if (path === "/json") {
			response.writeHead(200, { "content-type": "application/json" })
			response.end(stringifyJSON({ meta: { count: 2 }, items: ["a", "b"] }))
		} else if (path === "/large") {
			response.writeHead(200, { "content-type": "text/plain", "content-length": "5000" })
			response.end("x".repeat(5000))
		} else if (path.startsWith("/hop/")) {
			const remaining = Number(path.slice("/hop/".length))

			response.writeHead(302, { location: remaining ? `/hop/${remaining - 1}` : "/json" })
			response.end()
		} else if (path === "/binary") {
			response.writeHead(200, { "content-type": "image/png", "content-length": "1024" })
			response.end(Buffer.alloc(1024))
		} else {
			response.writeHead(404, { "content-type": "text/plain" })
			response.end("not found")
		}
	})

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})

	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
	server.close()
})

describe("httpGet", () => {
	it("projects a JSON body by a dotted path, and sends no cookie, credential or project name", async () => {
		const result = await getThroughTool({ url: `${origin}/json`, json_path: "meta.count" })

		expect(result).toMatchObject({ status: 200, json: { present: true, value: 2 }, truncated: false })

		const headers = received.at(-1)!

		expect(headers["cookie"]).toBeUndefined()
		expect(headers["authorization"]).toBeUndefined()
		expect(headers["user-agent"]).toBe("dev-http-get/1.0")
	})

	it("reports an absent path as absent rather than as null", async () => {
		const result = await getThroughTool({ url: `${origin}/json`, json_path: "meta.total" })

		expect(result.json).toEqual({
			path: "meta.total",
			present: false,
			error: 'the path "meta.total" is absent from the JSON body',
		})
	})

	it("states that a body which isn't JSON was not projected", async () => {
		const result = await getThroughTool({ url: `${origin}/missing`, json_path: "meta" })

		expect(result.status).toBe(404)
		expect(result.json).toMatchObject({ present: false, error: expect.stringContaining("not JSON") })
	})

	it("truncates the body at max_bytes and reports the full length the server declared", async () => {
		const result = await getThroughTool({ url: `${origin}/large`, max_bytes: 100 })

		expect(result).toMatchObject({ truncated: true, bytesRead: 100, fullLength: 5000 })
		expect(result.body).toHaveLength(100)
	})

	it("follows a redirect chain and reports each hop", async () => {
		const result = await getThroughTool({ url: `${origin}/hop/2` })

		expect(result.finalURL).toBe(`${origin}/json`)

		expect(result.redirects.map((hop) => [new URL(hop.url).pathname, hop.status])).toEqual([
			["/hop/2", 302],
			["/hop/1", 302],
			["/hop/0", 302],
		])
	})

	it("refuses a chain longer than five redirects", async () => {
		await expect(getThroughTool({ url: `${origin}/hop/9` })).rejects.toThrow(/at most 5 redirects/)
	})

	it("returns a binary type's length and type without the body", async () => {
		const result = await getThroughTool({ url: `${origin}/binary` })

		expect(result).toMatchObject({ binary: true, body: null, contentType: "image/png", fullLength: 1024 })
	})

	it("connects a host name to the address the check admitted", async () => {
		const port = new URL(origin).port

		const result = await getThroughTool(
			{ url: `http://service.example:${port}/json`, json_path: "meta.count" },
			resolvesTo("127.0.0.1")
		)

		expect(result).toMatchObject({ status: 200, json: { present: true, value: 2 } })
	})

	it.each([
		"192.168.1.20",
		"10.0.0.1",
		"172.20.0.5",
		"169.254.169.254",
		"fd12:3456::1",
		"fe80::1",
		"::ffff:192.168.0.1",
	])("refuses a host that resolves to %s", async (address) => {
		await expect(getThroughTool({ url: "http://intranet.example/" }, resolvesTo(address))).rejects.toThrow(
			`resolves to ${address}, in a private`
		)
	})

	it("refuses a private address written as the host", async () => {
		await expect(getThroughTool({ url: "http://10.0.0.1/" })).rejects.toThrow("resolves to 10.0.0.1, in a private")
	})

	it("refuses a scheme other than http and https", async () => {
		await expect(getThroughTool({ url: "file:///etc/hostname" })).rejects.toThrow(/http and https URLs only/)
	})
})
