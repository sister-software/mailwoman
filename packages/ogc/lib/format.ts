// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Response encoding negotiation for the OGC API surface.
 *
 *   OGC API Common negotiates the encoding through HTTP content negotiation
 *   and admits a query parameter that overrides it.
 *   The `f` parameter decides when present.
 *
 *   Otherwise the `Accept` header decides, and JSON answers a request that names neither encoding.
 */

import type { Context } from "hono"
import { accepts } from "hono/accepts"

import { OGCFormat, OGCMediaType } from "#schema"

/**
 * The JSON media types a request may name in `Accept`, beside `text/html`.
 *
 * `/api` serves the OpenAPI media type and answers a request for plain JSON with it too,
 * and `/search` serves GeoJSON the same way.
 */
const JSON_MEDIA_TYPES: readonly string[] = [
	OGCMediaType.JSON,
	OGCMediaType.GeoJSON,
	"application/vnd.oai.openapi+json",
]

/**
 * The encoding a request asks for.
 *
 * @param f The validated `f` query parameter, absent when the request didn't send one.
 */
export function negotiateFormat(c: Context, f: OGCFormat | undefined): OGCFormat {
	if (f) return f

	const matched = accepts(c, {
		header: "Accept",
		supports: [...JSON_MEDIA_TYPES, OGCMediaType.HTML],
		default: OGCMediaType.JSON,
	})

	return matched === OGCMediaType.HTML ? OGCFormat.HTML : OGCFormat.JSON
}
