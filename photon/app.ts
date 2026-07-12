/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Photon-compatible Hono app: CORS + error safety net + routes + the emitted OpenAPI
 *   document. Engine-agnostic — the CLI wires the real engine; tests inject fixtures.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { attachOpenAPIDocs, type OpenAPIDocInfo } from "@mailwoman/api-kit"
import packageJson from "@mailwoman/photon/package.json" with { type: "json" }
import { cors } from "hono/cors"

import type { PhotonEngine } from "./engine.ts"
import { registerPhotonRoutes } from "./routes.ts"

/** Options for {@link createPhotonApp}. */
export interface PhotonAppOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — upstream komoot/photon serves permissive CORS, and the map-widget use case
	 * (leaflet-control-geocoder, @openrunner/photon-geocoder, …) needs it: a browser's cross-origin XHR is blocked
	 * without it (#1017). Set `false` when a reverse proxy already owns the CORS headers.
	 */
	cors?: boolean
}

/**
 * The document info stamped into the emitted OpenAPI document. Exported (not inlined) so the CLI's `openapi` subcommand
 * can call `emitOpenAPIDocuments` with the SAME info the mounted `/openapi.json` route (below, via
 * {@link attachOpenAPIDocs}) uses — one source of truth, no risk of the two drifting.
 */
export const PHOTON_DOC_INFO: OpenAPIDocInfo = {
	title: packageJson.name,
	version: packageJson.version,
	description: packageJson.description,
	license: { name: "AGPL-3.0-only OR LicenseRef-Commercial", identifier: "AGPL-3.0-only" },
	contact: { name: "Sister Software", url: "https://mailwoman.sister.software" },
	externalDocs: {
		description: "Switching from Photon",
		url: "https://mailwoman.sister.software/docs/concepts/switching-from-photon",
	},
	servers: [
		{
			url: "http://{host}:{port}",
			variables: { host: { default: "127.0.0.1" }, port: { default: "2322" } },
		},
	],
	security: [],
	tags: [
		{ name: "geocoding", description: "Forward autocomplete and reverse geocoding." },
		{ name: "meta", description: "Health and deploy-time operations." },
	],
}

/** Build the Photon-compatible app around an injected {@link PhotonEngine}. */
export function createPhotonApp(engine: PhotonEngine, options: PhotonAppOptions = {}): OpenAPIHono {
	const app = new OpenAPIHono()

	// Browser-embedded widgets need CORS or their cross-origin XHR is blocked before the request completes (#1017).
	// GET-only — photon has no mutating routes, so unlike libpostal's CORS there is no POST in the methods list.
	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], allowHeaders: ["*"], maxAge: 86400 }))
	}

	// Safety net: malformed input or an engine fault returns an empty FeatureCollection, never a crash (photon's
	// envelope — NOT `{error}`, which is the libpostal/nominatim shape).
	app.onError((_error, c) => c.json({ type: "FeatureCollection", features: [], message: "internal error" }, 500))

	registerPhotonRoutes(app, engine)
	attachOpenAPIDocs(app, PHOTON_DOC_INFO)

	return app
}
