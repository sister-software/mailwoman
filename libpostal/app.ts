/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The libpostal-compatible Hono app: CORS + error safety net + routes + the emitted OpenAPI
 *   document. Engine-agnostic — the CLI wires the real parser; tests inject fixtures.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { attachOpenAPIDocs } from "@mailwoman/api-kit"
import packageJson from "@mailwoman/libpostal/package.json" with { type: "json" }
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"

import type { LibpostalEngine } from "./engine.ts"
import { registerLibpostalRoutes } from "./routes.ts"

/**
 * 100 KiB — express.json's default cap, the closest thing to a legacy precedent for this endpoint. There is no legacy
 * 413 contract to match; the `{ error: "request body too large" }` envelope below is a recorded free choice, shaped
 * like the rest of this API's error responses.
 */
const MAX_BODY_BYTES = 102_400

/** Options for {@link createLibpostalApp}. */
export interface LibpostalAppOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — without it, a cross-origin XHR (including the `POST /parse` preflight) is blocked
	 * outright, and browser clients need this to work at all (#1017). Set `false` for deployments where a reverse proxy
	 * already owns the CORS headers.
	 */
	cors?: boolean
}

/** Build the libpostal-compatible app around an injected {@link LibpostalEngine}. */
export function createLibpostalApp(engine: LibpostalEngine, options: LibpostalAppOptions = {}): OpenAPIHono {
	const app = new OpenAPIHono()

	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["*"], maxAge: 86400 }))
	}

	// Safety net: an engine fault returns the clean legacy JSON error, never a crash (wire contract).
	app.onError((_error, c) => c.json({ error: "internal error" }, 500))

	// Ahead of the canonicalizers (which buffer the full body into memory) so an oversized POST is rejected
	// before that buffering happens, not after.
	const guardBodySize = bodyLimit({
		maxSize: MAX_BODY_BYTES,
		onError: (c) => c.json({ error: "request body too large" }, 413),
	})
	app.use("/parse", guardBodySize)
	app.use("/expand", guardBodySize)

	registerLibpostalRoutes(app, engine)
	attachOpenAPIDocs(app, {
		title: packageJson.name,
		version: packageJson.version,
		description: packageJson.description,
		license: { name: "AGPL-3.0-only OR LicenseRef-Commercial", identifier: "AGPL-3.0-only" },
		contact: { name: "Sister Software", url: "https://mailwoman.sister.software" },
		externalDocs: {
			description: "Switching from libpostal",
			url: "https://mailwoman.sister.software/docs/concepts/switching-from-libpostal",
		},
		servers: [
			{
				url: "http://{host}:{port}",
				variables: { host: { default: "127.0.0.1" }, port: { default: "8081" } },
			},
		],
		security: [],
		tags: [
			{ name: "parsing", description: "Free-text address parsing and component expansion." },
			{ name: "meta", description: "Health and deploy-time operations." },
		],
	})

	return app
}
