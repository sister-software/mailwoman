/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Photon-compatible Hono app: CORS + error safety net + routes + the emitted OpenAPI
 *   document. Engine-agnostic — the CLI wires the real engine; tests inject fixtures.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { attachOpenAPIDocs, engineHeaders, type OpenAPIDocInfo } from "@mailwoman/api-kit"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import type { EngineStamp } from "@mailwoman/core/license"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { cors } from "hono/cors"

import type { PhotonEngine } from "#engine"
import { registerPhotonRoutes } from "#routes"

/**
 * This package's own manifest, read at load rather than imported as a module: a JSON import makes `tsc` copy the file
 * into `out/`, where it becomes the package scope for the compiled tree and breaks every `#` import in it.
 */
const packageJson = await readLocalJSONFile<{ name: string; version: string; description: string }>(
	resolvePackagePath("@mailwoman/photon", "package.json")
)

/**
 * Options for {@link createPhotonApp}.
 */
export interface PhotonAppOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — upstream komoot/photon serves permissive CORS, and the map-widget use case
	 * (leaflet-control-geocoder, @openrunner/photon-geocoder, …) needs it: a browser's cross-origin XHR is blocked
	 * without it (#1017). Set `false` when a reverse proxy already owns the CORS headers.
	 */
	cors?: boolean

	/**
	 * The engine stamp to carry on every response: `engine` as a foreign member of each FeatureCollection, and the
	 * `Server` + `Link: rel="license"` headers everywhere. Absent when an embedding application builds the app without
	 * the `mailwoman` package; the `photon` bin always passes one.
	 */
	engine?: EngineStamp
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
	contact: { name: "Sister Software", url: "https://mailwoman.ai" },
	externalDocs: {
		description: "What Mailwoman is",
		url: "https://mailwoman.ai/docs/developers/get-started/what-mailwoman-is",
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

/**
 * Build the Photon-compatible app around an injected {@link PhotonEngine}.
 */
export function createPhotonApp(engine: PhotonEngine, options: PhotonAppOptions = {}): OpenAPIHono {
	const app = new OpenAPIHono()

	// Browser-embedded widgets need CORS or their cross-origin XHR is blocked before the request completes (#1017).
	// GET-only — photon has no mutating routes, so unlike libpostal's CORS there is no POST in the methods list.
	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], allowHeaders: ["*"], maxAge: 86_400 }))
	}

	if (options.engine) {
		app.use(engineHeaders(options.engine))
	}

	// Safety net: malformed input or an engine fault returns an empty FeatureCollection, never a crash (photon's
	// envelope — NOT `{error}`, which is the libpostal/nominatim shape).
	app.onError((_error, c) => c.json({ type: "FeatureCollection", features: [], message: "internal error" }, 500))

	registerPhotonRoutes(app, engine, options.engine ? { engine: options.engine } : {})
	attachOpenAPIDocs(app, PHOTON_DOC_INFO)

	return app
}
