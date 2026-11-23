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
import type { LayerTerms } from "@mailwoman/core/layers/provenance"
import { wofIDFromPlaceID } from "@mailwoman/core/resolver"
import { isoSeconds } from "@mailwoman/core/utils"
import { stringifyJSON } from "@mailwoman/core/values/json"
import type { Context } from "hono"

import { type OGCBBox, parseBBox, searchBoxContains } from "#bbox"
import { OGC_COLLECTION_CATALOG } from "#collections"
import type { OGCEngine, OGCItem, OGCSearchHit, OGCServedCollection } from "#engine"
import { negotiateFormat } from "#format"
import {
	apiDefinitionHTML,
	collectionHTML,
	collectionsHTML,
	conformanceHTML,
	itemHTML,
	itemsHTML,
	landingPageHTML,
	type OpenAPI30Document,
	searchHTML,
} from "#html"
import { itemFeature, itemPlaceID, parseItemsQuery } from "#items"
import { collectionTerms } from "#provenance"
import {
	type OGCExtent,
	type OGCItemFeature,
	OGCItemFeatureSchema,
	OGCItemPathSchema,
	OGCItemsQuerySchema,
	type OGCItemsResponse,
	OGCItemsResponseSchema,
	OGC_CRS84,
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
	/**
	 * Serve `/collections/{collectionId}/items` for the collections whose engine entry has an item source.
	 *
	 * While it's off, the descriptions link items for none of the collections,
	 * and both items routes answer 404.
	 * `/search` features then link no item, and the conformance declaration lists only the Common classes.
	 *
	 * @defaultValue `false`
	 */
	serveItems?: boolean
}

/**
 * The OGC API Features Part 1 classes, declared only when a collection serves items.
 */
const FEATURES_CLASSES: ReadonlySet<string> = new Set([
	OGCConformanceClass.FeaturesCore,
	OGCConformanceClass.FeaturesGeoJSON,
	OGCConformanceClass.FeaturesHTML,
	OGCConformanceClass.FeaturesOAS30,
])

/**
 * The conformance classes the routes implement for a service whose collections are `collections`.
 *
 * The OGC API Features Part 1 classes need a collection with items, so a service with none omits them.
 */
export function conformanceOf(collections: readonly OGCServedCollection[]): OGCConformance {
	const servesItems = collections.some((collection) => collection.items)

	return {
		conformsTo: Object.values(OGCConformanceClass).filter((uri) => servesItems || !FEATURES_CLASSES.has(uri)),
	}
}

/**
 * The spatial extent of every collection that serves items.
 *
 * The box is the whole CRS84 range, so it contains every item.
 * A tighter box would need a scan of the gazetteer at startup, and OGC API Features
 * Part 1 asks only that the box contain the items.
 */
const WORLD_EXTENT: OGCExtent = { spatial: { bbox: [[-180, -90, 180, 90]], crs: OGC_CRS84 } }

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
export function buildCollection(
	base: string,
	served: OGCServedCollection,
	format: OGCFormat,
	knownLayers: readonly LayerTerms[] = served.layers ?? []
): OGCCollection {
	const { title, description } = OGC_COLLECTION_CATALOG[served.id]
	const coverage = served.regions ? ` The engine opened its layers for ${served.regions.join(", ")}.` : ""
	const path = collectionPath(served.id)
	const terms = collectionTerms(served, knownLayers)
	const links = [...selfLinks(base, path, format, title), ...terms.links]

	if (served.items) {
		links.push(
			{
				href: hrefOf(base, `${path}/items`, OGCFormat.JSON),
				rel: OGCLinkRelation.Items,
				type: OGCMediaType.GeoJSON,
				title: `${title} items`,
			},
			{
				href: hrefOf(base, `${path}/items`, OGCFormat.HTML),
				rel: OGCLinkRelation.Items,
				type: OGCMediaType.HTML,
				title: `${title} items as HTML`,
			}
		)
	}

	return {
		id: served.id,
		title,
		description: [`${description}${coverage}`, ...terms.notes].join(" "),
		links,
		...(terms.attribution ? { attribution: terms.attribution } : {}),
		...(served.items ? { itemType: "feature" as const, extent: WORLD_EXTENT } : {}),
		geometryDimension: 0,
		version: OGC_COLLECTION_VERSION,
	}
}

/**
 * Every layer the collections' manifests describe, so one collection's source can resolve to another layer.
 */
function knownLayersOf(collections: readonly OGCServedCollection[]): LayerTerms[] {
	return collections.flatMap((collection) => collection.layers ?? [])
}

/**
 * A collection's path relative to the service root.
 */
function collectionPath(collectionID: string): string {
	return `collections/${encodeURIComponent(collectionID)}`
}

/**
 * The path of one item relative to the service root.
 */
export function itemPath(collectionID: string, item: Pick<OGCItem, "wofID">): string {
	return `${collectionPath(collectionID)}/items/${encodeURIComponent(itemPlaceID(item))}`
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
		collections: collections.map((served) => buildCollection(base, served, format, knownLayersOf(collections))),
	}
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
export function searchFeature(hit: OGCSearchHit, href?: string): OGCSearchFeature {
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
			...(href ? { href } : {}),
		},
	}
}

/**
 * The item URL of a `/search` hit, when its collection serves items and holds the hit's place.
 *
 * The collection is asked for the place, so a link never points at an item that answers 404.
 */
async function searchHitHref(
	base: string,
	hit: OGCSearchHit,
	collections: readonly OGCServedCollection[]
): Promise<string | undefined> {
	const items = collections.find(({ id }) => id === hit.collectionID)?.items
	const wofID = wofIDFromPlaceID(hit.placeID ?? null)

	if (!items || wofID == null) return undefined

	const item = await items.item(wofID)

	return item ? hrefOf(base, itemPath(hit.collectionID, item), OGCFormat.JSON) : undefined
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
export function registerOGCRoutes(
	app: OpenAPIHono,
	engine: OGCEngine,
	{ baseURL, docInfo, serveItems = false }: OGCRouteOptions
): void {
	const baseOf = (url: string) => baseURL ?? new URL(url).origin

	// With items off, every collection is served as if its engine entry had no item source.
	const collections: readonly OGCServedCollection[] = serveItems
		? engine.collections
		: engine.collections.map(({ items: _, ...served }) => served)

	const conformance = conformanceOf(collections)
	// The route table is complete once the app is built, so the document is
	// emitted once, at the first request.
	let document: OpenAPI30Document | undefined

	// A service whose collections serve no items keeps the items routes out of its API
	// definition, and its conformance declaration lists no Features class.
	// The two paths still answer 404 in the native form.
	if (collections.some((collection) => collection.items)) {
		registerItemRoutes(app, collections, baseOf)
	} else {
		registerItemRoutesNotFound(app, collections)
	}

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
			? c.html(conformanceHTML(conformance, links), 200)
			: c.json({ ...conformance, links }, 200)
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

		// The served definition lists the origin the request reached, the base its link hrefs use,
		// so a client resolves each path against a URL rather than the `{host}:{port}` template.
		const served = { ...document, servers: [{ url: baseOf(c.req.url) }] }

		return c.body(stringifyJSON(served), 200, { "Content-Type": OGCMediaType.OpenAPI30 })
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

		const body = buildCollection(baseOf(c.req.url), served, format, knownLayersOf(collections))

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

		const hits = selectHits(await engine.search(request.q), request)

		const features = await Promise.all(
			hits.map(async (hit) => searchFeature(hit, await searchHitHref(base, hit, collections)))
		)

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

const itemsRoute = createRoute({
	method: "get",
	path: "/collections/{collectionId}/items",
	operationId: "getFeatures",
	summary: "Items",
	description:
		"One page of the collection's places in ascending WOF id order, as a GeoJSON FeatureCollection. A `next` link continues after the page's last place while more places remain.",
	tags: ["data"],
	request: { params: OGCCollectionPathSchema, query: OGCItemsQuerySchema },
	responses: {
		200: {
			description: "One page of the collection's items.",
			content: { [OGCMediaType.GeoJSON]: { schema: OGCItemsResponseSchema }, ...htmlContent },
		},
		404: { description: "No collection has this id, or the collection serves no items.", content: errorContent },
		...errorResponses,
	},
})

const itemRoute = createRoute({
	method: "get",
	path: "/collections/{collectionId}/items/{featureId}",
	operationId: "getFeature",
	summary: "Item",
	description: "One place, by the gazetteer place ID `/search` reports as `place_id`.",
	tags: ["data"],
	request: { params: OGCItemPathSchema, query: OGCFormatQuerySchema },
	responses: {
		200: {
			description: "The item, as a GeoJSON Feature.",
			content: { [OGCMediaType.GeoJSON]: { schema: OGCItemFeatureSchema }, ...htmlContent },
		},
		404: {
			description: "No collection has this id, it serves no items, or it holds no such item.",
			content: errorContent,
		},
		...errorResponses,
	},
})

/**
 * The served collection with items for `collectionId`, or the 404 response that states why there's none.
 */
function collectionWithItems(c: Context, collections: readonly OGCServedCollection[], collectionId: string) {
	const served = collections.find(({ id }) => id === collectionId)

	if (!served) return errorResponse(c, 404, "collection not found", `no collection has the id "${collectionId}"`)

	if (!served.items) {
		return errorResponse(c, 404, "collection serves no items", `the collection "${collectionId}" has no items resource`)
	}

	return { served, items: served.items }
}

/**
 * Answer both items paths with the native 404 when no collection serves items.
 *
 * The handlers stay out of the API definition, so it declares no items route.
 */
function registerItemRoutesNotFound(app: OpenAPIHono, collections: readonly OGCServedCollection[]): void {
	const notFound = (c: Context) => {
		const found = collectionWithItems(c, collections, c.req.param("collectionId") ?? "")

		return found instanceof Response ? found : errorResponse(c, 404, "collection serves no items")
	}

	app.get("/collections/:collectionId/items", notFound)
	app.get("/collections/:collectionId/items/:featureId", notFound)
}

/**
 * Register `/collections/{collectionId}/items` and `/collections/{collectionId}/items/{featureId}`.
 */
function registerItemRoutes(
	app: OpenAPIHono,
	collections: readonly OGCServedCollection[],
	baseOf: (url: string) => string
): void {
	app.openapi(itemsRoute, async (c) => {
		const query = c.req.valid("query")
		const format = negotiateFormat(c, query.f)
		const found = collectionWithItems(c, collections, c.req.valid("param").collectionId)

		if (found instanceof Response) return found

		const request = parseItemsQuery(query)

		if (typeof request === "string") return errorResponse(c, 400, "invalid query parameter", request)

		// One row past the page tells whether a next page exists without counting the box.
		const rows = await found.items.page({ ...request, limit: request.limit + 1 })
		const page = rows.slice(0, request.limit)
		const base = baseOf(c.req.url)
		const path = `${collectionPath(found.served.id)}/items`
		const { title } = OGC_COLLECTION_CATALOG[found.served.id]
		const pairs = queryPairsOf(c)

		const links = selfLinks(base, path, format, `${title} items`, { query: pairs, json: OGCMediaType.GeoJSON })
		const last = page.at(-1)

		if (rows.length > request.limit && last) {
			links.push({
				href: hrefOf(base, path, format, [...pairs.filter(([key]) => key !== "after"), ["after", String(last.wofID)]]),
				rel: OGCLinkRelation.Next,
				type: mediaTypeOf(format, OGCMediaType.GeoJSON),
				title: "Next page",
			})
		}

		links.push({
			href: hrefOf(base, collectionPath(found.served.id), OGCFormat.JSON),
			rel: OGCLinkRelation.Collection,
			type: OGCMediaType.JSON,
			title,
		})

		const body: OGCItemsResponse = {
			type: "FeatureCollection",
			timeStamp: isoSeconds(),
			links,
			numberReturned: page.length,
			features: page.map((item) => itemFeature(item)),
		}

		if (format === OGCFormat.HTML) return c.html(itemsHTML(body, title, found.served.id), 200)

		return c.body(stringifyJSON(body), 200, { "Content-Type": OGCMediaType.GeoJSON })
	})

	app.openapi(itemRoute, async (c) => {
		const format = negotiateFormat(c, c.req.valid("query").f)
		const { collectionId, featureId } = c.req.valid("param")
		const found = collectionWithItems(c, collections, collectionId)

		if (found instanceof Response) return found

		const wofID = wofIDFromPlaceID(featureId)
		const item = wofID == null ? null : await found.items.item(wofID)

		if (!item) {
			return errorResponse(c, 404, "feature not found", `the collection "${collectionId}" has no item "${featureId}"`)
		}

		const base = baseOf(c.req.url)
		const { title } = OGC_COLLECTION_CATALOG[found.served.id]

		const links: OGCLink[] = [
			...selfLinks(base, itemPath(found.served.id, item), format, item.name, { json: OGCMediaType.GeoJSON }),
			{
				href: hrefOf(base, collectionPath(found.served.id), OGCFormat.JSON),
				rel: OGCLinkRelation.Collection,
				type: OGCMediaType.JSON,
				title,
			},
		]

		const feature: OGCItemFeature = itemFeature(item, links)

		if (format === OGCFormat.HTML) return c.html(itemHTML(feature, title), 200)

		return c.body(stringifyJSON(feature), 200, { "Content-Type": OGCMediaType.GeoJSON })
	})
}
