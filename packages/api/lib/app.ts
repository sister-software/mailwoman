/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The native Mailwoman Hono app with the `/v1` routes and their OpenAPI document.
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
 * Default maximum request body size in bytes.
 */
const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024

/**
 * Options for {@link createMailwomanAPI}.
 */
export interface MailwomanAPIOptions {
	/**
	 * Whether to send `Access-Control-Allow-Origin: *` and answer CORS preflights.
	 *
	 * Defaults to `true` because browser clients such as the demo need it.
	 * Set it to `false` when a reverse proxy sets the CORS headers.
	 */
	cors?: boolean

	/**
	 * Maximum request body size in bytes for every `/v1/*` route.
	 * Defaults to 2 MiB.
	 */
	bodyLimitBytes?: number

	/**
	 * Maximum number of `addresses` rows that `POST /v1/batch` accepts.
	 * Defaults to `DEFAULT_BATCH_MAX`.
	 */
	batchMax?: number

	/**
	 * Engine stamp added to every `/v1` body and to the `Server` and `Link: rel="license"` headers.
	 *
	 * `mailwoman serve` always passes one.
	 * An embedding app may omit it.
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
 *
 * The CLI passes the real parse and geocode stack.
 * Tests pass fixtures.
 */
export function createMailwomanAPI<T extends Partial<GeocodeOutcomeLike> = GeocodeOutcomeLike>(
	engine: MailwomanAPIEngine<T>,
	options: MailwomanAPIOptions = {}
): OpenAPIHono {
	const app = new OpenAPIHono({
		// Routes may override this fallback with their own validation messages.
		defaultHook: (result, c) => {
			if (!result.success) {
				return errorResponse(c, 400, "invalid request body", summarizeValidationError(result.error))
			}

			return undefined
		},
	})

	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["*"], maxAge: 86_400 }))
	}

	if (options.engine) {
		app.use(engineHeaders(options.engine))
	}

	app.onError((error, c) => {
		// Hono rejects malformed JSON before the validation hook runs.
		// That is a client error.
		if (error instanceof Error && error.message.includes("Malformed JSON")) {
			return errorResponse(c, 400, "invalid request body", "malformed JSON")
		}

		return errorResponse(c, 500, "internal error", error instanceof Error ? error.message : String(error))
	})

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
