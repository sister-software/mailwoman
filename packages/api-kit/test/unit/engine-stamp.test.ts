/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { engineHeaders, EngineStampSchema, withEngineStamp } from "@mailwoman/api-kit"
import type { EngineStamp } from "@mailwoman/core/license"
import { expect, test } from "vitest"

const stamp: EngineStamp = {
	name: "mailwoman",
	version: "9.2.0",
	license: "AGPL-3.0-only",
	license_url: "https://mailwoman.ai/license",
	notice: "n",
}

function createPingApp(): OpenAPIHono {
	const app = new OpenAPIHono()

	app.use(engineHeaders(stamp))
	app.onError((_error, c) => c.json({ error: "internal error" }, 500))

	app.openapi(
		createRoute({
			method: "get",
			path: "/ping",
			responses: {
				200: { description: "pong", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
			},
		}),
		(c) => c.json({ ok: true }, 200)
	)

	app.get("/boom", () => {
		throw new Error("boom")
	})

	return app
}

test("engineHeaders: Server and Link ride on a 200", async () => {
	const res = await createPingApp().request("/ping")

	expect(res.status).toBe(200)
	expect(res.headers.get("server")).toBe("mailwoman/9.2.0 (AGPL-3.0-only)")
	expect(res.headers.get("link")).toBe('<https://mailwoman.ai/license>; rel="license"')
})

test("engineHeaders: the headers ride on the error net's 500 too", async () => {
	const res = await createPingApp().request("/boom")

	expect(res.status).toBe(500)
	expect(res.headers.get("server")).toBe("mailwoman/9.2.0 (AGPL-3.0-only)")
})

test("withEngineStamp: attaches the field when given a stamp and leaves the body alone otherwise", () => {
	expect(withEngineStamp({ a: 1 }, stamp)).toEqual({ a: 1, engine: stamp })
	expect(withEngineStamp({ a: 1 }, undefined)).toEqual({ a: 1 })
})

test("EngineStampSchema: accepts the stamp and refuses a licensee", () => {
	expect(EngineStampSchema.parse(stamp)).toEqual(stamp)
	expect(EngineStampSchema.safeParse({ ...stamp, licensee: "x" }).success).toBe(false)
})
