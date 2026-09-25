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
	 * Whether to send permissive CORS headers and answer preflight `OPTIONS` requests, default true.
	 *
	 * Browser map widgets call Photon cross-origin, as upstream Photon allows; set `false`
	 * when a reverse proxy already sets the CORS headers.
	 */
	cors?: boolean

	/**
	 * The engine stamp added to every FeatureCollection and sent in the `Server`
	 * and `Link: rel="license"` headers.
	 *
	 * The `photon` command always passes one; an embedding application without
	 * the `mailwoman` package may omit it.
	 */
	engine?: EngineStamp
}

/**
 * Describes the Photon API in its OpenAPI document, shared by the served `/openapi.json` route
 * and the CLI's `openapi` subcommand so the two cannot drift.
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
 * Build the Photon-compatible app around an injected {@link PhotonEngine}.
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
