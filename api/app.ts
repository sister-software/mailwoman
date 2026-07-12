/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The native Mailwoman Hono app: CORS + a request-body-size guard + the strict-validation error
 *   envelope + the `/v1` routes + the emitted OpenAPI document. Engine-agnostic — the `mailwoman`
 *   CLI wires the real parse/geocode/resolve stack (phase 4b); tests inject fixtures.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { apiError, attachOpenAPIDocs } from "@mailwoman/api-kit"
import packageJson from "@mailwoman/api/package.json" with { type: "json" }
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"

import type { MailwomanAPIEngine } from "./engine.ts"
import { DEFAULT_BATCH_MAX, registerMailwomanAPIRoutes } from "./routes.ts"

/** 2 MiB — carried from the express server's `express.json({ limit: "2mb" })` (`mailwoman/server/index.ts`). */
const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024

/** Options for {@link createMailwomanAPI}. */
export interface MailwomanAPIOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — browser-embedded clients (the demo, a map widget) need it: a cross-origin XHR
	 * (including the `POST` preflight) is blocked without it (#1017). Set `false` when a reverse proxy already owns the
	 * CORS headers.
	 */
	cors?: boolean

	/** Max request body size in bytes, enforced ahead of every `/v1/*` handler. Default 2 MiB. */
	bodyLimitBytes?: number

	/** Max `addresses` rows accepted by `POST /v1/batch`. Default 500 (see `routes.ts`'s `DEFAULT_BATCH_MAX`). */
	batchMax?: number
}

/**
 * Short, single-line summary of a zod validation failure for the envelope's `detail` field — not the full `ZodError`,
 * which is multi-line and carries internal path/code detail not meant for a wire response.
 */
function summarizeValidationError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
	return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
}

/** Build the native Mailwoman app around an injected {@link MailwomanAPIEngine}. */
export function createMailwomanAPI(engine: MailwomanAPIEngine, options: MailwomanAPIOptions = {}): OpenAPIHono {
	const app = new OpenAPIHono({
		// This surface is ours (no vendor contract to preserve): every declared body/query schema is
		// validator-enforced, and a failure maps through the shared api-kit envelope — never the raw zod
		// `{success, error}` shape. Individual routes (routes.ts) override this per-call to answer their OWN
		// friendly business message (e.g. "address is required"); this is the fallback for the rest (currently
		// just `/v1/format`).
		defaultHook: (result, c) => {
			if (!result.success) {
				return apiError(c, 400, "invalid request body", summarizeValidationError(result.error))
			}

			return undefined
		},
	})

	// Browser-embedded clients need CORS or their cross-origin XHR (including the mutating `/v1/*` preflight) is
	// blocked before it completes (#1017). GET+POST, unlike the read-only drop-ins (photon, nominatim).
	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["*"], maxAge: 86400 }))
	}

	// Safety net: an engine fault answers the native envelope, never a crash. `detail` carries the raw message —
	// this surface is ours to design, so (unlike the vendor-constrained drop-in envelopes) we can be helpful.
	app.onError((error, c) => apiError(c, 500, "internal error", error instanceof Error ? error.message : String(error)))

	// Ahead of the handlers (which buffer the body into memory) so an oversized POST is rejected before that
	// buffering happens, not after — mirrors the libpostal precedent.
	app.use(
		"/v1/*",
		bodyLimit({
			maxSize: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
			onError: (c) => apiError(c, 413, "request body too large"),
		})
	)

	registerMailwomanAPIRoutes(app, engine, { batchMax: options.batchMax ?? DEFAULT_BATCH_MAX })

	attachOpenAPIDocs(app, {
		title: packageJson.name,
		version: packageJson.version,
		description: packageJson.description,
		license: { name: "AGPL-3.0-only OR LicenseRef-Commercial", identifier: "AGPL-3.0-only" },
		contact: { name: "Sister Software", url: "https://mailwoman.sister.software" },
		servers: [
			{
				url: "http://{host}:{port}",
				variables: { host: { default: "127.0.0.1" }, port: { default: "3000" } },
			},
		],
		security: [],
		tags: [
			{ name: "parsing", description: "Free-text address parsing." },
			{ name: "geocoding", description: "Address-to-coordinate resolution." },
			{ name: "resolving", description: "Gazetteer resolution over an already-decoded address tree." },
			{ name: "formatting", description: "Component-dict rendering — the inverse of parsing." },
			{ name: "meta", description: "Health, metrics, and deploy-time operations." },
		],
	})

	return app
}
