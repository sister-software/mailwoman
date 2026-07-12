/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Nominatim-compatible Hono app: CORS + error safety net + routes + the emitted OpenAPI
 *   document. Engine-agnostic — the CLI wires the real engine; tests inject fixtures.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { attachOpenAPIDocs } from "@mailwoman/api-kit"
import packageJson from "@mailwoman/nominatim/package.json" with { type: "json" }
import { cors } from "hono/cors"

import type { NominatimEngine } from "./engine.ts"
import { registerNominatimRoutes } from "./routes.ts"

/** Options for {@link createNominatimApp}. */
export interface NominatimAppOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — browser-embedded geocoder clients need it: a cross-origin XHR is blocked without it
	 * (#1017). Set `false` when a reverse proxy already owns the CORS headers.
	 */
	cors?: boolean
}

/** Build the Nominatim-compatible app around an injected {@link NominatimEngine}. */
export function createNominatimApp(engine: NominatimEngine, options: NominatimAppOptions = {}): OpenAPIHono {
	const app = new OpenAPIHono()

	// Browser-embedded geocoder clients need CORS or their cross-origin XHR is blocked before completing (#1017).
	// GET-only — nominatim has no mutating routes, so unlike libpostal's CORS there is no POST in the methods list.
	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], allowHeaders: ["*"], maxAge: 86400 }))
	}

	// Safety net: a malformed query or an engine fault must never crash the process into a stack-trace 500 — the
	// clean legacy JSON error instead (`{error}` — NOT photon's FeatureCollection+message envelope).
	app.onError((_error, c) => c.json({ error: "internal error" }, 500))

	registerNominatimRoutes(app, engine)
	attachOpenAPIDocs(app, {
		title: packageJson.name,
		version: packageJson.version,
		description: packageJson.description,
		license: { name: "AGPL-3.0-only OR LicenseRef-Commercial", identifier: "AGPL-3.0-only" },
		contact: { name: "Sister Software", url: "https://mailwoman.sister.software" },
		externalDocs: {
			description: "Switching from Nominatim",
			url: "https://mailwoman.sister.software/docs/concepts/switching-from-nominatim",
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
	})

	return app
}
