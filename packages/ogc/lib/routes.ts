// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Route definitions and handlers for the OGC API resources.
 *
 *   The API definition is emitted from these definitions, so no handwritten spec exists.
 *   Every resource validates its query against a strict schema, and the app's
 *   validation hook answers a failure with a 400.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import { APIErrorSchema, emitOpenAPIDocuments, errorResponse, type OpenAPIDocInfo } from "@mailwoman/api-kit"
import { MAX_ADDRESS_LENGTH } from "@mailwoman/api/input-limits"
import { stringifyJSON } from "@mailwoman/core/json"
import { isoSeconds } from "@mailwoman/core/utils"
import { isValidLatitude, isValidLongitude } from "@mailwoman/spatial/coordinate/bounds"
import type { Context } from "hono"

import { OGC_COLLECTION_CATALOG } from "#collections"
import type { OGCEngine, OGCSearchHit, OGCServedCollection } from "#engine"
import { negotiateFormat } from "#format"
import {
	apiDefinitionHTML,
	collectionHTML,
	collectionsHTML,
	conformanceHTML,
	landingPageHTML,
	type OpenAPI30Document,
	searchHTML,
} from "#html"
import {
	collectionRelevanceParameter,
	collectionVersionParameter,
	type OGCCollection,
	OGCCollectionPathSchema,
	type OGCCollections,
	OGCCollectionSchema,
	OGCCollectionsSchema,
	OGC_COLLECTION_VERSION,
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
	type OGCSearchFeature,
	type OGCSearchResponse,
	OGCSearchResponseSchema,
	OGC_SEARCH_DEFAULT_LIMIT,
	OGC_SEARCH_MAX_LIMIT,
	searchQuerySchema,
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

const errorContent = { [OGCMediaType.JSON]: { schema: APIErrorSchema } }

const errorResponses = {
	400: {
		description: "An unknown query parameter, or an invalid parameter value.",
		content: errorContent,
	},
	500: {
		description: "An unexpected server fault.",
		content: errorContent,
	},
}

const htmlContent = { [OGCMediaType.HTML]: { schema: z.string() } }

const landingRoute = createRoute({
	method: "get",
	path: "/",
	operationId: "getLandingPage",
	summary: "Landing page",
	description: "Links to the API definition, the conformance declaration, the collections and the search.",
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

const collectionsRoute = createRoute({
	method: "get",
	path: "/collections",
	operationId: "getCollections",
	summary: "Collections",
	description: "The collections the running engine serves, one for each kind of layer it opened.",
	tags: ["data"],
	request: { query: OGCFormatQuerySchema },
	responses: {
		200: {
			description: "The collections.",
			content: { [OGCMediaType.JSON]: { schema: OGCCollectionsSchema }, ...htmlContent },
		},
		...errorResponses,
	},
})

const collectionRoute = createRoute({
	method: "get",
	path: "/collections/{collectionId}",
	operationId: "describeCollection",
	summary: "Collection description",
	description: "One collection, as `/collections` lists it.",
	tags: ["data"],
	request: { params: OGCCollectionPathSchema, query: OGCFormatQuerySchema },
	responses: {
		200: {
			description: "The collection description.",
			content: { [OGCMediaType.JSON]: { schema: OGCCollectionSchema }, ...htmlContent },
		},
		404: { description: "No collection has this id.", content: errorContent },
		...errorResponses,
	},
})

/**
 * Resolve a service path against the deployment's base URL.
 *
 * @param path A path relative to the service root, without a leading slash.
 */
function hrefOf(base: string, path: string, format: OGCFormat, query: Iterable<[string, string]> = []): string {
	const url = new URL(path, base.endsWith("/") ? base : `${base}/`)

	for (const [key, value] of query) {
		url.searchParams.append(key, value)
	}

	url.searchParams.set("f", format)

	return url.href
}

function otherFormat(format: OGCFormat): OGCFormat {
	return format === OGCFormat.HTML ? OGCFormat.JSON : OGCFormat.HTML
}

function mediaTypeOf(format: OGCFormat, json: OGCMediaType = OGCMediaType.JSON): OGCMediaType {
	return format === OGCFormat.HTML ? OGCMediaType.HTML : json
}

/**
 * The `self` and `alternate` links of a resource served in `format`.
 *
 * @param json The media type the resource's JSON form is served as.
 */
function selfLinks(
	base: string,
	path: string,
	format: OGCFormat,
	title: string,
	options: { query?: ReadonlyArray<[string, string]>; json?: OGCMediaType } = {}
): OGCLink[] {
	const alternate = otherFormat(format)

	return [
		{
			href: hrefOf(base, path, format, options.query),
			rel: OGCLinkRelation.Self,
			type: mediaTypeOf(format, options.json),
			title,
		},
		{
			href: hrefOf(base, path, alternate, options.query),
			rel: OGCLinkRelation.Alternate,
			type: mediaTypeOf(alternate, options.json),
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
	const collectionsHref = hrefOf(base, "collections", OGCFormat.JSON)
	const collectionsTitle = "Collections"

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
			{ href: collectionsHref, rel: OGCLinkRelation.Data, type: OGCMediaType.JSON, title: collectionsTitle },
			{ href: collectionsHref, rel: OGCLinkRelation.OGCData, type: OGCMediaType.JSON, title: collectionsTitle },
			{
				href: hrefOf(base, "search", OGCFormat.HTML),
				rel: OGCLinkRelation.Search,
				type: OGCMediaType.HTML,
				title: "Search form (forward geocoding)",
			},
		],
	}
}

/**
 * The description of one collection the engine serves, in the form `/collections`
 * and `/collections/{collectionId}` both serve, so the two can't disagree.
 */
export function buildCollection(base: string, served: OGCServedCollection, format: OGCFormat): OGCCollection {
	const { title, description } = OGC_COLLECTION_CATALOG[served.id]
	const coverage = served.regions ? ` The engine opened its layers for ${served.regions.join(", ")}.` : ""

	return {
		id: served.id,
		title,
		description: `${description}${coverage}`,
		links: selfLinks(base, `collections/${encodeURIComponent(served.id)}`, format, title),
		geometryDimension: 0,
		version: OGC_COLLECTION_VERSION,
	}
}

/**
 * The collections list for a request served in `format`.
 */
export function buildCollections(
	base: string,
	collections: readonly OGCServedCollection[],
	format: OGCFormat
): OGCCollections {
	return {
		links: selfLinks(base, "collections", format, "Collections"),
		collections: collections.map((served) => buildCollection(base, served, format)),
	}
}

/**
 * A `[minLon, minLat, maxLon, maxLat]` box in WGS 84 degrees.
 */
export type OGCBBox = readonly [number, number, number, number]

/**
 * The count of numbers in a two-dimensional `bbox`: two longitudes and two latitudes.
 */
const BBOX_CORNERS = 4

/**
 * Parse a `bbox` value.
 *
 * @returns The box, or a message that states the problem with the value.
 */
export function parseBBox(raw: string): OGCBBox | string {
	const parts = raw.split(",").map((part) => part.trim())
	const numbers = parts.map((part) => (part === "" ? Number.NaN : Number(part)))

	if (numbers.length !== BBOX_CORNERS || !numbers.every(Number.isFinite)) {
		return "bbox: four comma-separated numbers are required, minLon,minLat,maxLon,maxLat"
	}

	const [minLon, minLat, maxLon, maxLat] = numbers as [number, number, number, number]

	if (!isValidLongitude(minLon) || !isValidLongitude(maxLon)) return "bbox: longitudes must lie in [-180, 180]"

	if (!isValidLatitude(minLat) || !isValidLatitude(maxLat)) return "bbox: latitudes must lie in [-90, 90]"

	if (minLat > maxLat) return "bbox: the minimum latitude exceeds the maximum"

	return [minLon, minLat, maxLon, maxLat]
}

/**
 * Whether a point lies inside the box, edges included.
 *
 * A box whose minimum longitude exceeds its maximum crosses the antimeridian, as OGC API boxes may.
 */
export function searchBoxContains([minLon, minLat, maxLon, maxLat]: OGCBBox, lon: number, lat: number): boolean {
	if (lat < minLat || lat > maxLat) return false

	return minLon <= maxLon ? lon >= minLon && lon <= maxLon : lon >= minLon || lon <= maxLon
}

/**
 * A validated `/search` request.
 */
export interface OGCSearchRequest {
	q: string
	limit: number
	bbox: OGCBBox | null
	/**
	 * The collections the request names, or null when it names none and every collection is searched.
	 */
	collections: ReadonlySet<string> | null
}

/**
 * Validate a `/search` query the schema admitted.
 *
 * @returns The request, or a message that identifies the invalid parameter.
 */
export function parseSearchQuery(
	query: Readonly<Record<string, string | undefined>>,
	collections: readonly OGCServedCollection[]
): OGCSearchRequest | string {
	const q = query["q"]?.trim()

	if (!q) return "q: a non-empty query is required"

	if (q.length > MAX_ADDRESS_LENGTH) return `q: the query exceeds ${MAX_ADDRESS_LENGTH} characters`

	let limit = OGC_SEARCH_DEFAULT_LIMIT
	const rawLimit = query["limit"]

	if (rawLimit != null) {
		limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN

		if (!(limit >= 1 && limit <= OGC_SEARCH_MAX_LIMIT)) {
			return `limit: an integer from 1 to ${OGC_SEARCH_MAX_LIMIT} is required`
		}
	}

	let bbox: OGCBBox | null = null
	const rawBBox = query["bbox"]

	if (rawBBox != null) {
		const parsed = parseBBox(rawBBox)

		if (typeof parsed === "string") return parsed

		bbox = parsed
	}

	const named = new Set<string>()

	for (const { id } of collections) {
		const version = query[collectionVersionParameter(id)]
		const relevance = query[collectionRelevanceParameter(id)]

		if (version != null) {
			if (version !== String(OGC_COLLECTION_VERSION)) {
				return `${collectionVersionParameter(id)}: the collection's version is ${OGC_COLLECTION_VERSION}`
			}

			named.add(id)
		}

		if (relevance != null) {
			const weight = relevance.trim() === "" ? Number.NaN : Number(relevance)

			if (!(weight >= 0 && weight <= 1)) {
				return `${collectionRelevanceParameter(id)}: a number from 0 to 1 is required`
			}

			named.add(id)
		}
	}

	return { q, limit, bbox, collections: named.size ? named : null }
}

/**
 * Keep the hits the request's collections and box admit, up to its limit.
 */
export function selectHits(hits: readonly OGCSearchHit[], request: OGCSearchRequest): OGCSearchHit[] {
	return hits
		.filter((hit) => !request.collections || request.collections.has(hit.collectionID))
		.filter((hit) => !request.bbox || searchBoxContains(request.bbox, hit.lon, hit.lat))
		.slice(0, request.limit)
}

/**
 * One hit as a GeoJSON feature.
 */
export function searchFeature(hit: OGCSearchHit): OGCSearchFeature {
	return {
		type: "Feature",
		geometry: { type: "Point", coordinates: [hit.lon, hit.lat] },
		properties: {
			display_name: hit.displayName,
			score: hit.score,
			...(hit.score == null && hit.scoreUnmeasured ? { score_unmeasured: hit.scoreUnmeasured } : {}),
			collection_id: hit.collectionID,
			...(hit.placeID ? { place_id: hit.placeID } : {}),
			...(hit.placetype ? { placetype: hit.placetype } : {}),
		},
	}
}

/**
 * The query pairs of a request except `f`, which each link sets for itself.
 */
function queryPairsOf(c: Context): Array<[string, string]> {
	return [...new URL(c.req.url).searchParams].filter(([key]) => key !== "f")
}

/**
 * Register the OGC API routes against an engine.
 */
export function registerOGCRoutes(app: OpenAPIHono, engine: OGCEngine, { baseURL, docInfo }: OGCRouteOptions): void {
	const baseOf = (url: string) => baseURL ?? new URL(url).origin
	const collections = engine.collections
	// The route table is complete once the app is built, so the document is
	// emitted once, at the first request.
	let document: OpenAPI30Document | undefined

	const searchRoute = createRoute({
		method: "get",
		path: "/search",
		operationId: "search",
		summary: "Search",
		description:
			"Forward geocoding in the form of PDOK's Location API. A query without a collection parameter searches every collection.",
		tags: ["data"],
		request: { query: searchQuerySchema(collections.map(({ id }) => id)) },
		responses: {
			200: {
				description: "The matches, best first, as a GeoJSON FeatureCollection.",
				content: { [OGCMediaType.GeoJSON]: { schema: OGCSearchResponseSchema }, ...htmlContent },
			},
			...errorResponses,
		},
	})

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

	app.openapi(collectionsRoute, (c) => {
		const format = negotiateFormat(c, c.req.valid("query").f)
		const body = buildCollections(baseOf(c.req.url), collections, format)

		return format === OGCFormat.HTML ? c.html(collectionsHTML(body), 200) : c.json(body, 200)
	})

	app.openapi(collectionRoute, (c) => {
		const format = negotiateFormat(c, c.req.valid("query").f)
		const { collectionId } = c.req.valid("param")
		const served = collections.find(({ id }) => id === collectionId)

		if (!served) {
			return errorResponse(c, 404, "collection not found", `no collection has the id "${collectionId}"`)
		}

		const body = buildCollection(baseOf(c.req.url), served, format)

		return format === OGCFormat.HTML ? c.html(collectionHTML(body), 200) : c.json(body, 200)
	})

	app.openapi(searchRoute, async (c) => {
		const query = c.req.valid("query") as Record<string, string | undefined>
		const format = negotiateFormat(c, query["f"] as OGCFormat | undefined)
		const base = baseOf(c.req.url)

		// Without a query the HTML form is the page a browser following the landing page's `search` link expects.
		if (format === OGCFormat.HTML && !query["q"]?.trim()) {
			return c.html(searchHTML(null, selfLinks(base, "search", format, "Search"), collections), 200)
		}

		const request = parseSearchQuery(query, collections)

		if (typeof request === "string") return errorResponse(c, 400, "invalid query parameter", request)

		const features = selectHits(await engine.search(request.q), request).map(searchFeature)

		const body: OGCSearchResponse = {
			type: "FeatureCollection",
			timeStamp: isoSeconds(),
			links: selfLinks(base, "search", format, "Search results", {
				query: queryPairsOf(c),
				json: OGCMediaType.GeoJSON,
			}),
			numberReturned: features.length,
			features,
		}

		if (format === OGCFormat.HTML) return c.html(searchHTML(body, body.links, collections, request.q), 200)

		return c.body(stringifyJSON(body), 200, { "Content-Type": OGCMediaType.GeoJSON })
	})
}
