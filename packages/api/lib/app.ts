/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The native Mailwoman Hono app: cors + a request-body-size guard + the strict-validation error
 *   envelope + the `/v1` routes + the emitted OpenAPI document. Engine-agnostic — the `mailwoman`
 *   CLI wires the real parse/geocode/resolve stack (phase 4b); tests inject fixtures.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import {
	attachOpenAPIDocs,
	engineHeaders,
	errorResponse,
	type OpenAPIDocInfo,
	readServedDocumentInfo,
} from "@mailwoman/api-kit"
import type { EngineStamp } from "@mailwoman/core/license"
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"

import type { MailwomanAPIEngine } from "#engine"
import { DEFAULT_BATCH_MAX, registerMailwomanAPIRoutes } from "#routes"
import type { GeocodeOutcomeLike } from "#schema"

/**
 * Maximum request body size, matching the former Express server.
 */
const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024

/**
 * Options for {@link createMailwomanAPI}.
 */
export interface MailwomanAPIOptions {
	/**
	 * Emit permissive cors headers (`Access-Control-Allow-Origin: *`) on every response
	 * and answer preflight `options` with `204`.
	 *
	 * Default `true` — browser-embedded clients (the demo, a map widget) need it:
	 * a cross-origin XHR (including the `post` preflight) is blocked without it (#1017).
	 * Set `false` when a reverse proxy already owns the cors headers.
	 */
	cors?: boolean

	/**
	 * Max request body size in bytes, enforced ahead of every `/v1/*` handler.
	 *
	 * Default 2 MiB.
	 */
	bodyLimitBytes?: number

	/**
	 * Max `addresses` rows accepted by `post /v1/batch`.
	 *
	 * Default 500 (see `routes.ts`'s `DEFAULT_BATCH_MAX`).
	 */
	batchMax?: number

	/**
	 * The engine stamp to carry on every response: `engine` in each `/v1` body
	 * and the `Server` + `Link: rel="license"` headers everywhere.
	 *
	 * Absent when an embedding application builds the app without the `mailwoman` package.
	 * The `mailwoman serve` command always passes one.
	 */
	engine?: EngineStamp
}

/**
 * Format validation issues as one concise response detail.
 */
function summarizeValidationError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
	return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
}

/**
 * OpenAPI metadata shared by the mounted endpoint and document generator.
 */
export const MAILWOMAN_API_DOC_INFO: OpenAPIDocInfo = {
	...(await readServedDocumentInfo(import.meta.url, "@mailwoman/api")),
	license: { name: "AGPL-3.0-only OR LicenseRef-Commercial", identifier: "AGPL-3.0-only" },
	contact: { name: "Sister Software", url: "https://mailwoman.ai" },
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
}

/**
 * Build the native Mailwoman app around an injected {@link MailwomanAPIEngine}.
 */
export function createMailwomanAPI<T extends Partial<GeocodeOutcomeLike> = GeocodeOutcomeLike>(
	engine: MailwomanAPIEngine<T>,
	options: MailwomanAPIOptions = {}
): OpenAPIHono {
	const app = new OpenAPIHono({
		// Validate declared schemas and format failures with the shared API envelope.
		// Routes can override this fallback with endpoint-specific messages.
		defaultHook: (result, c) => {
			if (!result.success) {
				return errorResponse(c, 400, "invalid request body", summarizeValidationError(result.error))
			}

			return undefined
		},
	})

	// Browser clients need CORS for cross-origin requests and POST preflights.
	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["*"], maxAge: 86_400 }))
	}

	if (options.engine) {
		app.use(engineHeaders(options.engine))
	}

	// Return engine failures in the API's error envelope, including the message in `detail`.
	app.onError((error, c) => {
		// Hono rejects malformed JSON before route-level validation hooks run.
		// Treat that client syntax error as 400; reserve 500 for engine faults.
		if (error instanceof Error && error.message.includes("Malformed JSON")) {
			return errorResponse(c, 400, "invalid request body", "malformed JSON")
		}

		return errorResponse(c, 500, "internal error", error instanceof Error ? error.message : String(error))
	})

	// Enforce the limit before handlers buffer request bodies.
	app.use(
		"/v1/*",
		bodyLimit({
			maxSize: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
			onError: (c) => errorResponse(c, 413, "request body too large"),
		})
	)

	registerMailwomanAPIRoutes(app, engine, {
		batchMax: options.batchMax ?? DEFAULT_BATCH_MAX,
		engine: options.engine,
	})

	attachOpenAPIDocs(app, MAILWOMAN_API_DOC_INFO)

	return app
}
