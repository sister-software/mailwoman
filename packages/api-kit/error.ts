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

export function geocoderUnavailableError(c: Context) {
	return errorResponse(c, 503, "geocoder unavailable", GEOCODER_UNAVAILABLE_DETAIL)
}
