/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The native error envelope. Surfaces that carry a vendor-compat contract (photon, nominatim,
 *   libpostal) keep their own error shapes — this envelope is for surfaces OURS to design (the
 *   `@mailwoman/api` native `/v1/*` routes), where nothing constrains the wire shape but us.
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
 * Respond with the native error envelope. `status` is generic (not the flat `ContentfulStatusCode` union) so the
 * returned `TypedResponse`'s status stays the CALLER'S literal (e.g. `503`), not the whole union — required for use
 * inside an `app.openapi(route, handler)` handler body (`@mailwoman/api/routes.ts`), where the framework checks the
 * handler's return type against that specific route's declared per-status `responses` map. A flat-typed `status` param
 * would widen every branch to "any content-carrying status", which no single declared response branch matches.
 */
export function errorResponse<S extends ContentfulStatusCode>(c: Context, status: S, error: string, detail?: string) {
	return c.json(detail === undefined ? { error } : { error, detail }, status)
}

const GEOCODER_UNAVAILABLE_DETAIL =
	"install @mailwoman/neural + @mailwoman/resolver-wof-sqlite and provide gazetteer data (MAILWOMAN_WOF_DB / MAILWOMAN_CANDIDATE_DB)"

/**
 * The "engine method absent" 503, for the engine method the route actually needed.
 *
 * `subject` is a WIRE VALUE, not a label. `<subject> not available` is published verbatim in the HTTP API reference
 * table and in the docker deploy guide, so a caller branching on it is doing what the docs told them to — and
 * `/v1/resolve` answers `resolver`, not `geocoder`, because the method it found missing is `engine.resolveTree`. Rename
 * this function freely; never the string it emits.
 */
export function geocoderUnavailableError(c: Context, subject: "geocoder" | "resolver" = "geocoder") {
	return errorResponse(c, 503, `${subject} not available`, GEOCODER_UNAVAILABLE_DETAIL)
}
