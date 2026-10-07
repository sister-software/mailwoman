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

import type { PhotonEngine } from "#engine"
import { registerPhotonRoutes } from "#routes"

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
export function createPhotonApp(engine: PhotonEngine, options: CompatibilityAppOptions = {}): OpenAPIHono {
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
