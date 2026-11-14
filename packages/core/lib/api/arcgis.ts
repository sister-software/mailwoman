// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   ArcGIS REST services return errors with HTTP 200 as a JSON `error` envelope.
 *
 *   Layer products pass every ArcGIS JSON body through {@link assertNoArcGISError}
 *   before reading fields, so an error isn't read as an empty layer.
 *
 *   {@link pageArcGISLayer} reads every feature of one MapServer layer by `OBJECTID`.
 */

import type { APIClient } from "#api/APIClient"

/**
 * The `error` object in an ArcGIS JSON body.
 */
export interface ArcGISErrorEnvelope {
	code?: number
	message: string
	details?: string[]
}

/**
 * An error thrown for an ArcGIS error envelope.
 */
export class ArcGISServiceError extends Error {
	public readonly code: number | undefined
	public readonly details: readonly string[]

	constructor(context: string, envelope: ArcGISErrorEnvelope) {
		const details = envelope.details?.length ? ` (${envelope.details.join("; ")})` : ""

		super(
			`${context}: the ArcGIS service answered an error${!envelope.code ? "" : ` ${envelope.code}`} — ${envelope.message}${details}`
		)

		this.name = "ArcGISServiceError"
		this.code = envelope.code
		this.details = envelope.details ?? []
	}
}

/**
 * Returns the error envelope in an ArcGIS JSON body, or `null` when the body is a normal response.
 *
 * The body counts as an error only when its `error` object has a string `message`.
 */
export function readArcGISError(payload: unknown): ArcGISErrorEnvelope | null {
	if (typeof payload !== "object" || !payload) return null

	const error = (payload as { error?: unknown }).error

	if (typeof error !== "object" || !error) return null

	const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown }

	if (typeof message !== "string") return null

	return {
		...(typeof code === "number" ? { code } : {}),
		message,
		...(Array.isArray(details) ? { details: details.filter((d): d is string => typeof d === "string") } : {}),
	}
}

/**
 * Throws {@link ArcGISServiceError} when an ArcGIS JSON body is an error envelope.
 */
export function assertNoArcGISError(payload: unknown, context: string): void {
	const error = readArcGISError(payload)

	if (error) {
		throw new ArcGISServiceError(context, error)
	}
}

/**
 * A feature's attributes keyed by the lower-cased field name.
 *
 * Services differ in the case of their field names (`OBJECTID`, `objectid`),
 * so a reader looks names up in lower case.
 */
export function arcGISFields(properties: unknown): Record<string, unknown> {
	if (properties == null || typeof properties !== "object") return {}

	return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key.toLowerCase(), value]))
}

/**
 * A text attribute as written: trimmed, or `null` when the service left it empty.
 */
export function arcGISText(value: unknown): string | null {
	if (value == null) return null
	const text = String(value).trim()

	return text || null
}

/**
 * An integer attribute, or `null` when the service left it empty or it isn't an integer.
 */
export function arcGISInteger(value: unknown): number | null {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN

	return Number.isInteger(number) ? number : null
}

/**
 * One MapServer or FeatureServer layer: the service URL and the layer's numeric id.
 */
export interface ArcGISLayer {
	serviceURL: string
	layerID: number
}

/**
 * A layer's query URL for a feature count, or for one page of the features whose
 * `OBJECTID` exceeds `afterObjectID`, in `OBJECTID` order.
 *
 * `where` narrows both requests with a clause in the service's SQL dialect.
 */
export function arcGISLayerQueryURL(
	layer: ArcGISLayer,
	request:
		| { countOnly: true; where?: string }
		| { afterObjectID: number; outFields: readonly string[]; pageSize: number; where?: string }
): string {
	const params = new URLSearchParams()

	if ("countOnly" in request) {
		params.set("where", request.where ?? "1=1")
		params.set("returnCountOnly", "true")
		params.set("f", "json")
	} else {
		params.set("where", `${request.where ? `${request.where} AND ` : ""}OBJECTID>${request.afterObjectID}`)
		params.set("outFields", request.outFields.join(","))
		params.set("orderByFields", "OBJECTID")
		params.set("outSR", "4326")
		params.set("resultRecordCount", String(request.pageSize))
		params.set("f", "geojson")
	}

	return `${layer.serviceURL}/${layer.layerID}/query?${params}`
}

/**
 * Reads one JSON body from an ArcGIS service.
 *
 * @throws When the body isn't a JSON object, or is an ArcGIS error envelope.
 */
export async function readArcGISJSON<T>(
	client: Pick<APIClient, "fetch">,
	url: string,
	context: string,
	signal?: AbortSignal
): Promise<T> {
	const { data } = await client.fetch<T>({ url, timeout: 120_000, signal })
	const body: unknown = data

	if (body == null || typeof body !== "object") {
		throw new Error(`${context}: ${url} answered a body that is not JSON: ${String(body).slice(0, 200)}`)
	}

	assertNoArcGISError(body, `${context}: ${url}`)

	return data
}

/**
 * Options for {@link pageArcGISLayer}.
 */
export interface ArcGISLayerPagingOptions {
	outFields: readonly string[]
	/**
	 * The most features one query asks for, at most the service's `maxRecordCount`.
	 */
	pageSize: number
	where?: string
	/**
	 * Prefixes every error message, so a failure states which source it belongs to.
	 */
	context: string
	signal?: AbortSignal
	onCount?: (count: number) => void
	onPage?: (written: number, count: number) => void
}

/**
 * The `OBJECTID` of one GeoJSON feature an ArcGIS service answered.
 *
 * Services differ in the case of their field names (`OBJECTID`, `objectid`),
 * so the key is matched without regard to case.
 */
function featureObjectID(feature: unknown): number | null {
	return arcGISInteger(arcGISFields((feature as { properties?: unknown } | null)?.properties)["objectid"])
}

/**
 * Yields every feature of one layer a page at a time, as the GeoJSON features the service answered.
 *
 * The layer's feature count is asked for first.
 * Each page then asks for the features whose `OBJECTID` exceeds the last one read.
 *
 * A `resultOffset` query slows as the offset grows, and an `OBJECTID` page costs the same at any depth.
 *
 * @throws When the service answers an error, a page that isn't a FeatureCollection, a feature with no
 * `OBJECTID`, a page whose `OBJECTID`s don't advance, or a pull whose size differs from the count.
 */
export async function* pageArcGISLayer(
	client: Pick<APIClient, "fetch">,
	layer: ArcGISLayer,
	options: ArcGISLayerPagingOptions
): AsyncGenerator<unknown[]> {
	const { context, signal } = options
	const countURL = arcGISLayerQueryURL(layer, { countOnly: true, where: options.where })
	const { count } = await readArcGISJSON<{ count?: unknown }>(client, countURL, context, signal)

	if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
		throw new Error(`${context}: the count query of layer ${layer.layerID} answered no feature count: ${String(count)}`)
	}

	options.onCount?.(count)

	let written = 0
	let afterObjectID = 0

	while (written < count) {
		const url = arcGISLayerQueryURL(layer, {
			afterObjectID,
			outFields: options.outFields,
			pageSize: options.pageSize,
			where: options.where,
		})

		const page = await readArcGISJSON<{ type?: unknown; features?: unknown }>(client, url, context, signal)

		if (page.type !== "FeatureCollection" || !Array.isArray(page.features)) {
			throw new Error(`${context}: ${url} answered something other than a FeatureCollection`)
		}

		if (!page.features.length) break

		const lastObjectID = featureObjectID(page.features.at(-1))

		if (lastObjectID === null) {
			throw new Error(`${context}: layer ${layer.layerID} answered a feature with no OBJECTID`)
		}

		if (lastObjectID <= afterObjectID) {
			throw new Error(`${context}: ${url} answered a page whose OBJECTIDs don't advance past ${afterObjectID}`)
		}

		yield page.features

		written += page.features.length
		afterObjectID = lastObjectID
		options.onPage?.(written, count)
	}

	if (written !== count) {
		throw new Error(
			`${context}: the service counted ${count} features in layer ${layer.layerID} and the pull returned ${written}`
		)
	}
}
