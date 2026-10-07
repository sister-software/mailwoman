/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import {
	attachOpenAPIDocs,
	type CompatibilityAppOptions,
	engineHeaders,
	type OpenAPIDocInfo,
	readServedDocumentInfo,
} from "@mailwoman/api-kit"
import { cors } from "hono/cors"

import type { NominatimEngine } from "#engine"
import { registerNominatimRoutes } from "#routes"

/**
 * Supplies the OpenAPI document info shared by the served `/openapi.json` route
 * and the CLI's `openapi` subcommand, so the two documents cannot drift apart.
 */
export const NOMINATIM_DOC_INFO: OpenAPIDocInfo = {
	...(await readServedDocumentInfo(import.meta.url, "@mailwoman/nominatim")),
	license: { name: "AGPL-3.0-only OR LicenseRef-Commercial", identifier: "AGPL-3.0-only" },
	contact: { name: "Sister Software", url: "https://mailwoman.ai" },
	externalDocs: {
		description: "What Mailwoman is",
		url: "https://mailwoman.ai/docs/developers/get-started/what-mailwoman-is",
	},
	servers: [
		{
			url: "http://{host}:{port}",
			variables: { host: { default: "127.0.0.1" }, port: { default: "8080" } },
		},
	],
	security: [],
	tags: [
		{ name: "geocoding", description: "Forward geocoding, reverse geocoding, and OSM id lookup." },
		{ name: "meta", description: "Health and deploy-time operations." },
	],
}

/**
 * Build the Nominatim-compatible app around an injected {@link NominatimEngine}.
 */
export function createNominatimApp(engine: NominatimEngine, options: CompatibilityAppOptions = {}): OpenAPIHono {
	const app = new OpenAPIHono()

	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], allowHeaders: ["*"], maxAge: 86_400 }))
	}

	if (options.engine) {
		app.use(engineHeaders(options.engine))
	}

	app.onError((_error, c) => c.json({ error: "internal error" }, 500))

	registerNominatimRoutes(app, engine, options.engine)
	attachOpenAPIDocs(app, NOMINATIM_DOC_INFO)

	return app
}
