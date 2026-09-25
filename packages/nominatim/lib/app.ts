/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { attachOpenAPIDocs, engineHeaders, type OpenAPIDocInfo, readServedDocumentInfo } from "@mailwoman/api-kit"
import type { EngineStamp } from "@mailwoman/core/license"
import { cors } from "hono/cors"

import type { NominatimEngine } from "#engine"
import { registerNominatimRoutes } from "#routes"

/**
 * Options for {@link createNominatimApp}.
 */
export interface NominatimAppOptions {
	/**
	 * Whether every response carries `Access-Control-Allow-Origin: *` and preflight requests
	 * are answered, defaulting to `true` so browser clients can call cross-origin.
	 *
	 * Set it to `false` when a reverse proxy already sets the CORS headers.
	 */
	cors?: boolean

	/**
	 * The engine stamp added to each JSON result and GeoJSON collection,
	 * and to the `Server` and `Link: rel="license"` headers.
	 *
	 * An embedding application may omit it, but the `nominatim` CLI always passes one.
	 */
	engine?: EngineStamp
}

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
export function createNominatimApp(engine: NominatimEngine, options: NominatimAppOptions = {}): OpenAPIHono {
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
