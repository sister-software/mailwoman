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
import { cors } from "hono/cors"

import type { LibpostalEngine } from "./engine.ts"
import { registerLibpostalRoutes } from "./routes.ts"

/** Options for {@link createLibpostalApp}. */
export interface LibpostalAppOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — browser clients need it (#1017). Set `false` when a reverse proxy already owns the
	 * CORS headers.
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

	registerLibpostalRoutes(app, engine)
	attachOpenAPIDocs(app, { title: packageJson.name, version: packageJson.version })

	return app
}
