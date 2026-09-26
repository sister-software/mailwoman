/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The native error envelope, for surfaces ours to design (the `@mailwoman/api` native `/v1/*`
 *   routes); surfaces carrying a vendor-compat interface (photon, nominatim, libpostal) keep
 *   their own error shapes.
 */

import { z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

/**
 * The native error envelope: a short machine-stable `error` string plus an optional human `detail`.
 */
export const APIErrorSchema = z
	.object({
		error: z.string(),
		detail: z.string().optional(),
	})
	.openapi("APIError")

/**
 * Respond with the native error envelope.
 *
 * `status` stays generic so the returned `TypedResponse` keeps the caller's literal
 * status (e.g. `503`) rather than widening to the `ContentfulStatusCode` union,
 * which `app.openapi(route, handler)` requires to match a route's declared response branch.
 */
export function errorResponse<S extends ContentfulStatusCode>(c: Context, status: S, error: string, detail?: string) {
	return c.json(detail === undefined ? { error } : { error, detail }, status)
}

const GEOCODER_UNAVAILABLE_DETAIL =
	"install @mailwoman/neural + @mailwoman/resolver-wof-sqlite and provide gazetteer data (MAILWOMAN_WOF_DB / MAILWOMAN_CANDIDATE_DB)"

/**
 * The "engine method absent" 503, for the engine method the route actually needed.
 *
 * `<subject> not available` is published verbatim in the http API reference table and the
 * docker deploy guide, so a caller branching on it is doing what the docs told them to;
 * `/v1/resolve` answers `resolver` because the method it found missing is `engine.resolveTree`.
 */
export function geocoderUnavailableError(c: Context, subject: "geocoder" | "resolver" = "geocoder") {
	return errorResponse(c, 503, `${subject} not available`, GEOCODER_UNAVAILABLE_DETAIL)
}
