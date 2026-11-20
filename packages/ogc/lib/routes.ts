// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Route definitions and handlers for the OGC API Common Part 1 resources.
 *
 *   The API definition is emitted from these definitions, so no handwritten spec exists.
 *   Every resource validates its query against {@link OGCFormatQuerySchema},
 *   and the app's validation hook answers a failure with a 400.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import { APIErrorSchema, emitOpenAPIDocuments, type OpenAPIDocInfo } from "@mailwoman/api-kit"
import { stringifyJSON } from "@mailwoman/core/json"

import { negotiateFormat } from "#format"
import { apiDefinitionHTML, conformanceHTML, landingPageHTML, type OpenAPI30Document } from "#html"
import {
	type OGCConformance,
	OGCConformanceClass,
	OGCConformanceSchema,
	OGCFormat,
	OGCFormatQuerySchema,
	type OGCLandingPage,
	OGCLandingPageSchema,
	type OGCLink,
	OGCLinkRelation,
	OGCMediaType,
} from "#schema"

/**
 * What the routes need to know about the deployment.
 */
export interface OGCRouteOptions {
	/**
	 * The service's public base URL, such as `https://example.org/ogc/`.
	 *
	 * Link hrefs resolve against it.
	 * Without it they resolve against the request's own origin.
	 *
	 * A reverse proxy that rewrites the host or mounts the service under a path needs it set.
	 */
	baseURL?: string
	/**
	 * The landing page's title and description, and the API definition's `info` block.
	 */
	docInfo: OpenAPIDocInfo
}

/**
 * The conformance classes the routes below implement.
 */
export const OGC_CONFORMANCE: OGCConformance = {
	conformsTo: Object.values(OGCConformanceClass),
}

const errorResponses = {
	400: {
		description: "An unknown query parameter, or an `f` value other than `json` or `html`.",
		content: { [OGCMediaType.JSON]: { schema: APIErrorSchema } },
	},
	500: {
		description: "An unexpected server fault.",
		content: { [OGCMediaType.JSON]: { schema: APIErrorSchema } },
	},
}

const htmlContent = { [OGCMediaType.HTML]: { schema: z.string() } }

const landingRoute = createRoute({
	method: "get",
	path: "/",
	operationId: "getLandingPage",
	summary: "Landing page",
	description: "Links to the API definition and the conformance declaration.",
	tags: ["capabilities"],
	request: { query: OGCFormatQuerySchema },
	responses: {
		200: {
			description: "The landing page.",
			content: { [OGCMediaType.JSON]: { schema: OGCLandingPageSchema }, ...htmlContent },
		},
		...errorResponses,
	},
})

const conformanceRoute = createRoute({
	method: "get",
	path: "/conformance",
	operationId: "getConformanceDeclaration",
	summary: "Conformance declaration",
	description: "The OGC API conformance classes this service implements.",
	tags: ["capabilities"],
	request: { query: OGCFormatQuerySchema },
	responses: {
		200: {
			description: "The conformance declaration.",
			content: { [OGCMediaType.JSON]: { schema: OGCConformanceSchema }, ...htmlContent },
		},
		...errorResponses,
	},
})

const apiRoute = createRoute({
	method: "get",
	path: "/api",
	operationId: "getAPIDefinition",
	summary: "API definition",
	description: "This document, as OpenAPI 3.0 JSON or as HTML.",
	tags: ["capabilities"],
	request: { query: OGCFormatQuerySchema },
	responses: {
		200: {
			description: "The API definition.",
			content: { [OGCMediaType.OpenAPI30]: { schema: z.object({}).loose() }, ...htmlContent },
		},
		...errorResponses,
	},
})

/**
 * Resolve a service path against the deployment's base URL.
 *
 * @param path A path relative to the service root, without a leading slash.
 */
function hrefOf(base: string, path: string, format: OGCFormat): string {
	const url = new URL(path, base.endsWith("/") ? base : `${base}/`)

	url.searchParams.set("f", format)

	return url.href
}

function otherFormat(format: OGCFormat): OGCFormat {
	return format === OGCFormat.HTML ? OGCFormat.JSON : OGCFormat.HTML
}

function mediaTypeOf(format: OGCFormat): OGCMediaType {
	return format === OGCFormat.HTML ? OGCMediaType.HTML : OGCMediaType.JSON
}

/**
 * The `self` and `alternate` links of a resource served in `format`.
 */
function selfLinks(base: string, path: string, format: OGCFormat, title: string): OGCLink[] {
	const alternate = otherFormat(format)

	return [
		{ href: hrefOf(base, path, format), rel: OGCLinkRelation.Self, type: mediaTypeOf(format), title },
		{
			href: hrefOf(base, path, alternate),
			rel: OGCLinkRelation.Alternate,
			type: mediaTypeOf(alternate),
			title: `${title} as ${alternate.toUpperCase()}`,
		},
	]
}

/**
 * The landing page for a request served in `format`.
 */
export function buildLandingPage(base: string, docInfo: OpenAPIDocInfo, format: OGCFormat): OGCLandingPage {
	const conformanceHref = hrefOf(base, "conformance", OGCFormat.JSON)
	const conformanceTitle = "Conformance declaration"

	return {
		title: docInfo.title,
		description: docInfo.description ?? docInfo.title,
		links: [
			...selfLinks(base, "", format, "This document"),
			{
				href: hrefOf(base, "api", OGCFormat.JSON),
				rel: OGCLinkRelation.ServiceDesc,
				type: OGCMediaType.OpenAPI30,
				title: "API definition (OpenAPI 3.0)",
			},
			{
				href: hrefOf(base, "api", OGCFormat.HTML),
				rel: OGCLinkRelation.ServiceDoc,
				type: OGCMediaType.HTML,
				title: "API documentation",
			},
			{ href: conformanceHref, rel: OGCLinkRelation.Conformance, type: OGCMediaType.JSON, title: conformanceTitle },
			{ href: conformanceHref, rel: OGCLinkRelation.OGCConformance, type: OGCMediaType.JSON, title: conformanceTitle },
		],
	}
}

/**
 * Register the OGC API Common Part 1 routes.
 */
export function registerOGCRoutes(app: OpenAPIHono, { baseURL, docInfo }: OGCRouteOptions): void {
	const baseOf = (url: string) => baseURL ?? new URL(url).origin
	// The route table is complete once the app is built, so the document is
	// emitted once, at the first request.
	let document: OpenAPI30Document | undefined

	app.openapi(landingRoute, (c) => {
		const format = negotiateFormat(c, c.req.valid("query").f)
		const landing = buildLandingPage(baseOf(c.req.url), docInfo, format)

		return format === OGCFormat.HTML ? c.html(landingPageHTML(landing), 200) : c.json(landing, 200)
	})

	app.openapi(conformanceRoute, (c) => {
		const format = negotiateFormat(c, c.req.valid("query").f)
		const links = selfLinks(baseOf(c.req.url), "conformance", format, "This document")

		return format === OGCFormat.HTML
			? c.html(conformanceHTML(OGC_CONFORMANCE, links), 200)
			: c.json({ ...OGC_CONFORMANCE, links }, 200)
	})

	app.openapi(apiRoute, (c) => {
		const format = negotiateFormat(c, c.req.valid("query").f)

		document ??= emitOpenAPIDocuments(app, docInfo).v30 as OpenAPI30Document

		if (format === OGCFormat.HTML) {
			const base = baseOf(c.req.url)

			const links: OGCLink[] = [
				{ href: hrefOf(base, "api", OGCFormat.HTML), rel: OGCLinkRelation.Self, type: OGCMediaType.HTML },
				{ href: hrefOf(base, "api", OGCFormat.JSON), rel: OGCLinkRelation.ServiceDesc, type: OGCMediaType.OpenAPI30 },
				{ href: hrefOf(base, "", OGCFormat.HTML), rel: "start", type: OGCMediaType.HTML, title: "Landing page" },
			]

			return c.html(apiDefinitionHTML(document, links), 200)
		}

		return c.body(stringifyJSON(document), 200, { "Content-Type": OGCMediaType.OpenAPI30 })
	})
}
