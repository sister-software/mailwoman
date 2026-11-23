// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Shared types and interfaces for the @mailwoman/fastify plugin.
 */

import type { ParseResponse } from "@mailwoman/api/operations/parse/address"
import type { POISearchResponse } from "@mailwoman/api/operations/search-poi"
import type { PipelineOpts, PipelineResult } from "@mailwoman/core"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import type { GeocodeRequestOptions } from "mailwoman/geocode/session"

/**
 * A parse function a caller injects in place of the pipeline the plugin builds, such as a test double.
 *
 * It is the call signature of `RuntimePipeline` in `mailwoman/engine/runtime-pipeline` without
 * that type's disposal: the caller owns an injected pipeline, and the plugin never closes it.
 */
export type InjectedPipeline = (raw: string, opts?: PipelineOpts) => Promise<PipelineResult>

/**
 * Options for the Mailwoman Fastify plugin.
 */
export interface MailwomanFastifyOptions {
	/**
	 * Supply a pre-built pipeline to skip model and gazetteer loading.
	 *
	 * Parse, geocode, and POI calls all read this pipeline, and the gazetteer paths below are ignored.
	 */
	pipeline?: InjectedPipeline
	/**
	 * Path to `poi.db`; enables POI search and configures it on a lazy-built pipeline.
	 */
	poiDatabasePath?: string
	/**
	 * Path of a candidate gazetteer, such as `candidate.db`.
	 *
	 * With this path or `resolveDatabasePath`, the plugin geocodes through a geocode session.
	 */
	candidateDatabasePath?: string
	/**
	 * Path of a WOF admin database, read when no candidate gazetteer resolves.
	 *
	 * With this path or `candidateDatabasePath`, the plugin geocodes through a geocode session.
	 * With neither, parsing works from the weights and a geocode answers the parse without a coordinate.
	 */
	resolveDatabasePath?: string
	/**
	 * The locale whose weights the plugin loads, and the locale every parse and geocode runs under.
	 *
	 * Absent, the plugin loads the default weights, the pipeline detects each input's locale,
	 * and the session records its locale as the default.
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
 * The settings one parse or POI call may state.
 *
 * The locale is the plugin's registration option, so a call states none.
 */
export type FastifyPipelineOptions = Omit<PipelineOpts, "locale">

/**
 * Methods exposed on `fastify.mailwoman`.
 */
export interface MailwomanDecorator {
	/**
	 * Parse text into ordered components and a decoded tree.
	 */
	parse(text: string, opts?: FastifyPipelineOptions): Promise<FastifyParseResult>
	/**
	 * Geocode text and return its `GeocodeResult`.
	 *
	 * The options are a geocode session's request options: the input mode, bias points,
	 * a parent place and a country that scopes this one request.
	 */
	geocode(text: string, opts?: GeocodeRequestOptions): Promise<GeocodeResult>
	/**
	 * Run a POI query and return its intent and results, an abstention, or `not_poi_query`.
	 * The method throws when POI isn't configured.
	 */
	poi(text: string, opts?: FastifyPipelineOptions): Promise<POISearchResponse>
}

declare module "fastify" {
	interface FastifyInstance {
		mailwoman: MailwomanDecorator
	}
}

/**
 * Thrown by `mailwoman.poi` when POI search isn't configured.
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
