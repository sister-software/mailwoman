/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the libpostal-compatible Hono app around an injected engine.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { attachOpenAPIDocs, engineHeaders, type OpenAPIDocInfo, readServedDocumentInfo } from "@mailwoman/api-kit"
import type { EngineStamp } from "@mailwoman/core/license"
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"

import type { LibpostalEngine } from "#engine"
import { registerLibpostalRoutes } from "#routes"

/**
 * Request-body limit of 100 KiB, which matches the usual JSON parser default.
 */
const MAX_BODY_BYTES = 102_400

/**
 * Options for {@link createLibpostalApp}.
 */
export interface LibpostalAppOptions {
	/**
	 * Enables permissive CORS.
	 *
	 * It defaults to `true`.
	 * Set it to `false` when a reverse proxy adds the CORS headers.
	 */
	cors?: boolean

	/**
	 * Engine stamp for response headers.
	 * The CLI always provides it.
	 */
	engine?: EngineStamp
}

/**
 * OpenAPI metadata shared by the served document and CLI-generated documents.
 */
export const LIBPOSTAL_DOC_INFO: OpenAPIDocInfo = {
	...(await readServedDocumentInfo(import.meta.url, "@mailwoman/libpostal")),
	license: { name: "AGPL-3.0-only OR LicenseRef-Commercial", identifier: "AGPL-3.0-only" },
	contact: { name: "Sister Software", url: "https://mailwoman.ai" },
	externalDocs: {
		description: "What Mailwoman is",
		url: "https://mailwoman.ai/docs/developers/get-started/what-mailwoman-is",
	},
	servers: [
		{
			url: "http://{host}:{port}",
			variables: { host: { default: "127.0.0.1" }, port: { default: "8081" } },
		},
	],
	security: [],
	tags: [
		{ name: "parsing", description: "Free-text address parsing and component expansion." },
		{ name: "meta", description: "Health and deploy-time operations." },
	],
}

/**
 * Creates the app around an injected {@link LibpostalEngine}.
 */
export function createLibpostalApp(engine: LibpostalEngine, options: LibpostalAppOptions = {}): OpenAPIHono {
	const app = new OpenAPIHono()

	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["*"], maxAge: 86_400 }))
	}

	if (options.engine) {
		app.use(engineHeaders(options.engine))
	}

	// The handler hides engine error details from clients.
	app.onError((_error, c) => c.json({ error: "internal error" }, 500))

	// The limit rejects an oversized body before the route buffers it.
	const guardBodySize = bodyLimit({
		maxSize: MAX_BODY_BYTES,
		onError: (c) => c.json({ error: "request body too large" }, 413),
	})

	app.use("/parse", guardBodySize)
	app.use("/expand", guardBodySize)

	registerLibpostalRoutes(app, engine)
	attachOpenAPIDocs(app, LIBPOSTAL_DOC_INFO)

	return app
}
