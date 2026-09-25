/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { attachOpenAPIDocs, engineHeaders, type OpenAPIDocInfo, readServedDocumentInfo } from "@mailwoman/api-kit"
import type { EngineStamp } from "@mailwoman/core/license"
import { cors } from "hono/cors"

import type { PhotonEngine } from "#engine"
import { registerPhotonRoutes } from "#routes"

/**
 * Options for {@link createPhotonApp}.
 */
export interface PhotonAppOptions {
	/**
	 * Whether to send permissive CORS headers and answer preflight `OPTIONS` requests.
	 *
	 * It defaults to true because browser map widgets call Photon from other origins.
	 * Set it to `false` when a reverse proxy already sets the CORS headers.
	 */
	cors?: boolean

	/**
	 * The engine stamp added to every FeatureCollection and sent in the `Server`
	 * and `Link: rel="license"` headers.
	 *
	 * The `photon` command always passes one.
	 * An embedding application may omit it.
	 */
	engine?: EngineStamp
}

/**
 * The OpenAPI document info for the Photon API.
 *
 * The served `/openapi.json` route and the CLI's `openapi` subcommand both use it.
 */
export const PHOTON_DOC_INFO: OpenAPIDocInfo = {
	...(await readServedDocumentInfo(import.meta.url, "@mailwoman/photon")),
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
 * Builds the Photon-compatible app around the given {@link PhotonEngine}.
 */
export function createPhotonApp(engine: PhotonEngine, options: PhotonAppOptions = {}): OpenAPIHono {
	const app = new OpenAPIHono()

	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], allowHeaders: ["*"], maxAge: 86_400 }))
	}

	if (options.engine) {
		app.use(engineHeaders(options.engine))
	}

	app.onError((_error, c) => c.json({ type: "FeatureCollection", features: [], message: "internal error" }, 500))

	registerPhotonRoutes(app, engine, options.engine)
	attachOpenAPIDocs(app, PHOTON_DOC_INFO)

	return app
}
