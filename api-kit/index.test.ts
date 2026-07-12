/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { expect, test } from "vitest"

import { attachOpenAPIDocs, emitOpenAPIDocuments, serveNode } from "./index.ts"

/** A minimal one-route app shared by the doc + serve tests. */
function createPingApp(): OpenAPIHono {
	const app = new OpenAPIHono()

	app.openapi(
		createRoute({
			method: "get",
			path: "/ping",
			responses: {
				200: {
					description: "pong",
					content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
				},
			},
		}),
		(c) => c.json({ ok: true }, 200)
	)

	return app
}

const info = { title: "@mailwoman/api-kit test", version: "0.0.0" }

test("attachOpenAPIDocs: mounts a 3.1 document at /openapi.json", async () => {
	const app = createPingApp()
	attachOpenAPIDocs(app, info)

	const res = await app.request("/openapi.json")
	expect(res.status).toBe(200)
	const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
	expect(doc.openapi).toBe("3.1.0")
	expect(Object.keys(doc.paths)).toContain("/ping")
})

test("emitOpenAPIDocuments: returns both 3.1 and 3.0 flavors from the same route table", () => {
	const app = createPingApp()
	const { v31, v30 } = emitOpenAPIDocuments(app, info)

	expect((v31 as { openapi: string }).openapi).toBe("3.1.0")
	expect((v30 as { openapi: string }).openapi).toBe("3.0.3")
	expect(Object.keys((v31 as { paths: object }).paths)).toContain("/ping")
	expect(Object.keys((v30 as { paths: object }).paths)).toContain("/ping")
})

test("serveNode: binds, answers over real HTTP, closes cleanly", async () => {
	const app = createPingApp()
	let bound = 0
	const server = serveNode({
		fetch: app.fetch,
		port: 0, // ephemeral
		hostname: "127.0.0.1",
		onListen: (i) => {
			bound = i.port
		},
	})

	try {
		expect(bound).toBeGreaterThan(0)
		const res = await fetch(`http://127.0.0.1:${bound}/ping`)
		expect(await res.json()).toEqual({ ok: true })
	} finally {
		await server.close()
	}
})
