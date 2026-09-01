/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What an OGR-readable source declares about itself, read before any feature is — the identity check every
 *   polygon-layer ingest opens with.
 *
 *   OGR IS BUILD TOOLING, NEVER A SERVE DEPENDENCY (SCOPE invariant 6). The check refuses a source whose
 *   declared authority code is not the one the ingest was written for, because reading one projection's
 *   coordinates as another's is silent — and it runs the datum-transformation guard even where no shift is
 *   needed, because skipping it on the reasoning that a source needs no shift makes the guard fire on the day
 *   a source arrives that does.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { runFile } from "@mailwoman/core/process"

import { assertDatumTransformationAvailable } from "#projection-transform"

/**
 * What one layer declares about itself.
 */
export interface OGRLayerIdentity {
	epsg: number
	featureCount: number
	layer: string
	/**
	 * The layer's own attribute field names — empty when the source reports none.
	 */
	fields: ReadonlySet<string>
	/**
	 * The layer's own declared extent, `[minLon, minLat, maxLon, maxLat]`, where the source declares one.
	 */
	extent?: readonly [number, number, number, number]
}

export interface ReadOGRLayerIdentityOptions {
	/**
	 * The dataset `ogrinfo` opens — a geodatabase directory, a shapefile, a GeoJSON export.
	 */
	path: string
	/**
	 * Layer inside it, asserted against what the source answers. Omitted, the source's first layer answers and only its
	 * presence is checked.
	 */
	layer?: string
	/**
	 * The EPSG code the source must declare. A source declaring anything else is a product change, not a variation to
	 * absorb.
	 */
	expectEPSG: number
	/**
	 * Names the calling ingest in every refusal, e.g. `flood ingest`.
	 */
	context: string
	/**
	 * Forwarded to the datum-transformation guard.
	 */
	areaOfUse?: string
	/**
	 * Refuse a layer that declares no extent.
	 */
	requireExtent?: boolean
	/**
	 * Refuse a layer that reports no attribute fields.
	 */
	requireFields?: boolean
	/**
	 * A product's own message tails, where they diverge from the defaults.
	 */
	messages?: {
		/**
		 * After `declares no EPSG authority code — `.
		 */
		noAuthorityCode?: string
		/**
		 * After `expected EPSG:<code> — `.
		 */
		epsgMismatch?: string
		/**
		 * After `reports no attribute fields — `.
		 */
		emptyFields?: string
	}
}

/**
 * A summary is small; the ceiling only guards against a pathological driver.
 */
const OGRINFO_MAX_BUFFER = 32 * 1024 * 1024

/**
 * Ordinates in a 2D extent: `minLon, minLat, maxLon, maxLat`. A shorter array is a 3D or degenerate extent this reader
 * does not understand, not a 2D one with something missing.
 */
const EXTENT_ORDINATES = 4

/**
 * Read what the source declares about itself, and refuse a projection the calling ingest was not written for.
 *
 * @throws {Error} When the layer is missing, declares no EPSG authority code, declares one other than `expectEPSG`,
 *   reports no feature count, or fails a `requireExtent`/`requireFields` condition.
 */
export async function readOGRLayerIdentity(options: ReadOGRLayerIdentityOptions): Promise<OGRLayerIdentity> {
	const { stdout } = await runFile(
		"ogrinfo",
		["-json", "-so", options.path, ...(options.layer === undefined ? [] : [options.layer])],
		{ maxBuffer: OGRINFO_MAX_BUFFER }
	)

	const info = parseJSONStrict<{
		layers?: Array<{
			name?: string
			featureCount?: number
			fields?: Array<{ name?: string }>
			geometryFields?: Array<{
				extent?: number[]
				coordinateSystem?: { projjson?: { id?: { code?: number } } }
			}>
		}>
	}>(stdout)

	const described = info.layers?.[0]

	if (!described?.name) {
		throw new Error(
			options.layer === undefined
				? `${options.context}: ${options.path} carries no readable layer`
				: `${options.context}: ${options.path} does not carry a layer named ${JSON.stringify(options.layer)}`
		)
	}

	if (options.layer !== undefined && described.name !== options.layer) {
		throw new Error(`${options.context}: ${options.path} does not carry a layer named ${JSON.stringify(options.layer)}`)
	}

	// The subject a refusal names: the layer where one was asked for, the dataset itself where the source's own first
	// layer answered.
	const subject = options.layer ?? options.path

	const geometry = described.geometryFields?.[0]
	const code = geometry?.coordinateSystem?.projjson?.id?.code

	if (typeof code !== "number") {
		throw new TypeError(
			`${options.context}: ${subject} declares no EPSG authority code — ${
				options.messages?.noAuthorityCode ??
				"the projection cannot be checked, and reading its metres as degrees is silent"
			}`
		)
	}

	if (code !== options.expectEPSG) {
		throw new Error(
			`${options.context}: ${subject} declares EPSG:${code}, expected EPSG:${options.expectEPSG} — ${
				options.messages?.epsgMismatch ??
				"the source's projection changed, which is a product change rather than a variation to absorb"
			}`
		)
	}

	if (typeof described.featureCount !== "number") {
		throw new TypeError(`${options.context}: ${subject} reports no feature count`)
	}

	let extent: readonly [number, number, number, number] | undefined

	if (geometry?.extent && geometry.extent.length >= EXTENT_ORDINATES) {
		extent = [geometry.extent[0]!, geometry.extent[1]!, geometry.extent[2]!, geometry.extent[3]!]
	}

	if (options.requireExtent && !extent) {
		throw new TypeError(
			`${options.context}: ${subject} declares no extent, so a reprojected vertex could not be checked`
		)
	}

	await assertDatumTransformationAvailable(code, {
		context: options.context,
		...(options.areaOfUse === undefined ? {} : { areaOfUse: options.areaOfUse }),
	})

	const fields = new Set((described.fields ?? []).map((field) => field.name).filter((name) => name !== undefined))

	if (options.requireFields && !fields.size) {
		throw new TypeError(
			`${options.context}: ${subject} reports no attribute fields — ${
				options.messages?.emptyFields ?? "an empty field list would make every optional column read as absent"
			}`
		)
	}

	return {
		epsg: code,
		featureCount: described.featureCount,
		layer: described.name,
		fields,
		...(extent === undefined ? {} : { extent }),
	}
}
