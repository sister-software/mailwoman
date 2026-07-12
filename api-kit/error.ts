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

/** The native error envelope: a short machine-stable `error` string plus an optional human `detail`. */
export const APIErrorSchema = z
	.object({
		error: z.string(),
		detail: z.string().optional(),
	})
	.openapi("APIError")

/** Respond with the native error envelope. */
export function apiError(c: Context, status: ContentfulStatusCode, error: string, detail?: string) {
	return c.json(detail === undefined ? { error } : { error, detail }, status)
}
