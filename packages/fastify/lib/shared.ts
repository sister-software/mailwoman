/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * Shared types and interfaces for the @mailwoman/fastify plugin.
 */

import type { ParseResponse } from "@mailwoman/api/operations/parse/address"
import type { POISearchResponse } from "@mailwoman/api/operations/search-poi"
import type { PipelineOpts, PipelineResult } from "@mailwoman/core"
import type { GeocodeResult } from "@mailwoman/core/geocode"

/**
 * Describes the pipeline function and lets callers inject test doubles.
 */
export type RuntimePipeline = (raw: string, opts?: PipelineOpts) => Promise<PipelineResult>

/**
 * Options for the Mailwoman Fastify plugin.
 */
export interface MailwomanFastifyOptions {
	/**
	 * Supply a pre-built pipeline to skip model and gazetteer loading.
	 */
	pipeline?: RuntimePipeline
	/**
	 * Path to `poi.db`; enables POI search and configures it on a lazy-built pipeline.
	 */
	poiDatabasePath?: string
	/**
	 * Optional WOF database path for the lazy-built resolver.
	 *
	 * Without it, parsing works but geocoding has no coordinates.
	 * Ignored with an injected pipeline.
	 */
	resolveDatabasePath?: string
	/**
	 * Locale for model weights and default per-call options.
	 * Defaults to `"en-US"`.
	 */
	locale?: Intl.UnicodeBCP47LocaleIdentifier
	/**
	 * Fastify's `register` prefix for the route group.
	 */
	prefix?: string
}

/**
 * Result returned by `mailwoman.parse`: the API parse response plus the pipeline path.
 */
export type FastifyParseResult = ParseResponse & { path: PipelineResult["path"] }

/**
 * Methods exposed on `fastify.mailwoman`; all use the same pipeline.
 */
export interface MailwomanDecorator {
	/**
	 * Parse text into ordered components and a decoded tree.
	 */
	parse(text: string, opts?: PipelineOpts): Promise<FastifyParseResult>
	/**
	 * Geocode text and return its `GeocodeResult`.
	 */
	geocode(text: string, opts?: PipelineOpts): Promise<GeocodeResult>
	/**
	 * Run a POI query and return its intent and results, an abstention, or `not_poi_query`.
	 * The method throws when POI is not configured.
	 */
	poi(text: string, opts?: PipelineOpts): Promise<POISearchResponse>
}

declare module "fastify" {
	interface FastifyInstance {
		mailwoman: MailwomanDecorator
	}
}

/**
 * Thrown by `mailwoman.poi` when POI search is not configured.
 */
export class POINotConfiguredError extends Error {
	public override name = "POINotConfiguredError"

	constructor(
		message = "POI search is not configured — register @mailwoman/fastify with { poiDatabasePath } to enable it",
		options?: ErrorOptions
	) {
		super(message, options)
	}
}
