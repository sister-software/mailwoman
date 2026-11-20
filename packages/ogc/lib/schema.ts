// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Zod schemas, media types and conformance class URIs for the OGC API surface.
 *
 *   The shapes follow the `landingPage`, `confClasses` and `link` schemas of
 *   OGC API Common Part 1 (OGC 19-072).
 *   Each schema is registered as a component, so the API definition references it by name.
 */

import { z } from "@hono/zod-openapi"

/**
 * The media types this surface serves, keyed by their role.
 */
export const OGCMediaType = {
	JSON: "application/json",
	HTML: "text/html",
	OpenAPI30: "application/vnd.oai.openapi+json;version=3.0",
} as const

export type OGCMediaType = (typeof OGCMediaType)[keyof typeof OGCMediaType]

/**
 * The values the `f` query parameter accepts on every resource.
 */
export const OGCFormat = {
	JSON: "json",
	HTML: "html",
} as const

export type OGCFormat = (typeof OGCFormat)[keyof typeof OGCFormat]

/**
 * The link relations the landing page emits.
 *
 * OGC API Common identifies the conformance relation by URI.
 * PDOK's Location API emits both the URI and the short name, and the landing page does the same.
 */
export const OGCLinkRelation = {
	Self: "self",
	Alternate: "alternate",
	ServiceDesc: "service-desc",
	ServiceDoc: "service-doc",
	Conformance: "conformance",
	OGCConformance: "http://www.opengis.net/def/rel/ogc/1.0/conformance",
} as const

export type OGCLinkRelation = (typeof OGCLinkRelation)[keyof typeof OGCLinkRelation]

const COMMON_PART_1 = "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf"

/**
 * The OGC API Common Part 1 conformance classes this surface implements.
 *
 * Each one is declared only because a route serves what its requirements ask for:
 *
 * - `core`: HTTP 1.1, and a 400 for an unknown query parameter or an invalid `f` value.
 * - `landing-page`: `GET /` with API definition and conformance links, `GET /conformance`, `GET /api`.
 * - `json`: the landing page and conformance declaration as `application/json`.
 * - `html`: the landing page and conformance declaration as HTML5 carrying every link as an `<a>`.
 * - `oas30`: an OpenAPI 3.0 document as `service-desc` and its HTML form as `service-doc`.
 */
export const OGCConformanceClass = {
	Core: `${COMMON_PART_1}/core`,
	LandingPage: `${COMMON_PART_1}/landing-page`,
	JSON: `${COMMON_PART_1}/json`,
	HTML: `${COMMON_PART_1}/html`,
	OAS30: `${COMMON_PART_1}/oas30`,
} as const

export type OGCConformanceClass = (typeof OGCConformanceClass)[keyof typeof OGCConformanceClass]

/**
 * A link object from OGC API Common's `link.yaml`.
 */
export const OGCLinkSchema = z
	.object({
		href: z.string(),
		rel: z.string(),
		type: z.string().optional(),
		title: z.string().optional(),
	})
	.openapi("OGCLink")

export type OGCLink = z.infer<typeof OGCLinkSchema>

/**
 * The landing page from OGC API Common's `landingPage.yaml`.
 */
export const OGCLandingPageSchema = z
	.object({
		title: z.string(),
		description: z.string(),
		links: z.array(OGCLinkSchema),
	})
	.openapi("OGCLandingPage")

export type OGCLandingPage = z.infer<typeof OGCLandingPageSchema>

/**
 * The conformance declaration from OGC API Common's `confClasses.yaml`.
 */
export const OGCConformanceSchema = z
	.object({
		conformsTo: z.array(z.string()),
		links: z.array(OGCLinkSchema).optional(),
	})
	.openapi("OGCConformance")

export type OGCConformance = z.infer<typeof OGCConformanceSchema>

/**
 * The query every resource accepts.
 *
 * The object is strict because OGC API Common's core class answers 400 to a query
 * parameter the API definition doesn't name.
 */
export const OGCFormatQuerySchema = z
	.object({
		f: z.enum([OGCFormat.JSON, OGCFormat.HTML]).optional().openapi({
			description: "The response encoding. Without it the `Accept` header decides, and JSON is the default.",
		}),
	})
	.strict()
