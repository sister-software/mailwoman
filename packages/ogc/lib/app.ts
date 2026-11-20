// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { OpenAPIHono } from "@hono/zod-openapi"
import {
	attachOpenAPIDocs,
	type CompatibilityAppOptions,
	engineHeaders,
	errorResponse,
	type OpenAPIDocInfo,
	readServedDocumentInfo,
} from "@mailwoman/api-kit"
import { cors } from "hono/cors"

import type { OGCEngine } from "#engine"
import { registerOGCRoutes } from "#routes"

/**
 * The port `mailwoman-ogc serve` listens on unless told otherwise.
 */
export const OGC_DEFAULT_PORT = 8090

/**
 * The document info for the OGC API surface.
 *
 * The landing page reads its title and description from it, and both API definitions include it.
 */
export const OGC_DOC_INFO: OpenAPIDocInfo = {
	...(await readServedDocumentInfo(import.meta.url, "@mailwoman/ogc")),
	license: { name: "AGPL-3.0-only OR LicenseRef-Commercial", identifier: "AGPL-3.0-only" },
	contact: { name: "Sister Software", url: "https://mailwoman.post" },
	externalDocs: {
		description: "What Mailwoman is",
		url: "https://mailwoman.post/product",
	},
	servers: [
		{
			url: "http://{host}:{port}",
			variables: { host: { default: "127.0.0.1" }, port: { default: String(OGC_DEFAULT_PORT) } },
		},
	],
	security: [],
	tags: [
		{ name: "capabilities", description: "The OGC API Common landing page, conformance and API definition." },
		{ name: "data", description: "The collections and the forward geocoding search." },
	],
}

/**
 * Options for {@link createOGCApp}.
 */
export interface OGCAppOptions extends CompatibilityAppOptions {
	/**
	 * The service's public base URL.
	 * Link hrefs and the API definition's `servers` entry use it.
	 *
	 * @defaultValue The request's own origin.
	 */
	baseURL?: string
	/**
	 * Serve the items routes for the collections whose engine entry has an item source.
	 *
	 * Bulk browsing is opt-in, so the default leaves every collection without items.
	 *
	 * @defaultValue `false`
	 */
	serveItems?: boolean
}

/**
 * Builds the OGC API app around the given {@link OGCEngine}: the landing page at `/`,
 * the conformance declaration at `/conformance`, the OpenAPI 3.0 definition at `/api`,
 * the collections at `/collections`, forward geocoding at `/search`, and the OpenAPI
 * 3.1 document at `/openapi.json` that every Mailwoman surface serves.
 */
export function createOGCApp(engine: OGCEngine, options: OGCAppOptions = {}): OpenAPIHono {
	const app = new OpenAPIHono({
		defaultHook: (result, c) => {
			if (result.success) return

			const detail = result.error.issues
				.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
				.join("; ")

			return errorResponse(c, 400, "invalid query parameter", detail)
		},
	})

	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], allowHeaders: ["*"], maxAge: 86_400 }))
	}

	if (options.engine) {
		app.use(engineHeaders(options.engine))
	}

	app.onError((_error, c) => errorResponse(c, 500, "internal error"))

	const docInfo: OpenAPIDocInfo = options.baseURL
		? { ...OGC_DOC_INFO, servers: [{ url: options.baseURL }] }
		: OGC_DOC_INFO

	registerOGCRoutes(app, engine, { baseURL: options.baseURL, docInfo, serveItems: options.serveItems === true })
	attachOpenAPIDocs(app, docInfo)

	return app
}
