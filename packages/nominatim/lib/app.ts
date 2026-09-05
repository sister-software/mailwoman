/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Nominatim-compatible Hono app: CORS + error safety net + routes + the emitted OpenAPI
 *   document. Engine-agnostic — the CLI wires the real engine; tests inject fixtures.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { attachOpenAPIDocs, engineHeaders, type OpenAPIDocInfo } from "@mailwoman/api-kit"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import type { EngineStamp } from "@mailwoman/core/license"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { cors } from "hono/cors"

import type { NominatimEngine } from "#engine"
import { registerNominatimRoutes } from "#routes"

/**
 * This package's own manifest, read at load rather than imported as a module: a JSON import makes `tsc` copy the file
 * into `out/`, where it becomes the package scope for the compiled tree and breaks every `#` import in it.
 */
const packageJson = await readLocalJSONFile<{ name: string; version: string; description: string }>(
	resolvePackagePath("@mailwoman/nominatim", "package.json")
)

/**
 * Options for {@link createNominatimApp}.
 */
export interface NominatimAppOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — browser-embedded geocoder clients need it: a cross-origin XHR is blocked without it
	 * (#1017). Set `false` when a reverse proxy already owns the CORS headers.
	 */
	cors?: boolean

	/**
	 * The engine stamp to carry on every response: `engine` on each jsonv2 result and geojson collection, and the
	 * `Server` + `Link: rel="license"` headers everywhere. Absent when an embedding application builds the app without
	 * the `mailwoman` package; the `nominatim` bin always passes one.
	 */
	engine?: EngineStamp
}

/**
 * The document info stamped into the emitted OpenAPI document. Exported (not inlined) so the CLI's `openapi` subcommand
 * can call `emitOpenAPIDocuments` with the SAME info the mounted `/openapi.json` route (below, via
 * {@link attachOpenAPIDocs}) uses — one source of truth, no risk of the two drifting.
 */
export const NOMINATIM_DOC_INFO: OpenAPIDocInfo = {
	title: packageJson.name,
	version: packageJson.version,
	description: packageJson.description,
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

	// Browser-embedded geocoder clients need CORS or their cross-origin XHR is blocked before completing (#1017).
	// GET-only — nominatim has no mutating routes, so unlike libpostal's CORS there is no POST in the methods list.
	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], allowHeaders: ["*"], maxAge: 86_400 }))
	}

	if (options.engine) {
		app.use(engineHeaders(options.engine))
	}

	// Safety net: a malformed query or an engine fault must never crash the process into a stack-trace 500 — the
	// clean legacy JSON error instead (`{error}` — NOT photon's FeatureCollection+message envelope).
	app.onError((_error, c) => c.json({ error: "internal error" }, 500))

	registerNominatimRoutes(app, engine, options.engine ? { engine: options.engine } : {})
	attachOpenAPIDocs(app, NOMINATIM_DOC_INFO)

	return app
}
