// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Fastify plugin for mailwoman's local parsing, geocoding, and POI pipeline.
 *
 * Routes are the shared `@mailwoman/api` operations: `GET`/`POST /v1/parse`,
 * `POST /v1/geocode`, `POST /v1/poi`, and `GET /health`.
 * The `fastify.mailwoman` decorator also exposes parse, geocode, and POI methods.
 *
 * Provide a ready-to-use pipeline with `pipeline`, or let the plugin build its
 * engine lazily on the first request.
 * Lazy setup uses `locale` and the optional database paths.
 *
 * With a gazetteer path the engine is a geocode session, the one the drop-in
 * servers build: `geocode` goes through `session.geocode`, and parse and POI run
 * a pipeline over the session's classifier and gazetteer.
 * Without one the engine is a pipeline over the weights, and a geocode answers
 * the parse without a coordinate.
 *
 * The decorator's parse result extends `@mailwoman/api`'s parse response with the pipeline path.
 * Geocode returns a `GeocodeResult`.
 * Errors use `{ error, detail }`.
 */

import { GeocodeAddressOperation } from "@mailwoman/api/operations/geocode/address"
import { ParseAddressOperation } from "@mailwoman/api/operations/parse/address"
import { ParseAddressQueryOperation } from "@mailwoman/api/operations/parse/address/query"
import { RetrieveHealthOperation } from "@mailwoman/api/operations/retrieve/health"
import { SearchPOIOperation } from "@mailwoman/api/operations/search-poi"
import { reportSupport } from "@mailwoman/api/support"
import { memoizeResettable } from "@mailwoman/core/async/memoize"
import type { AddressTree, decodeAsTuples } from "@mailwoman/core/decoder"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import type { FastifyPluginAsync } from "fastify"
import fp from "fastify-plugin"
import {
	hasZodFastifySchemaValidationErrors,
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod"
import type { extractGeocodeResult } from "mailwoman/geocode"
import type { GeocodeRequestOptions, GeocodeSession } from "mailwoman/geocode/session"

import type { InjectedPipeline, MailwomanDecorator, MailwomanFastifyOptions } from "#shared"
import { POINotConfiguredError } from "#shared"

// #region Pipeline Helpers

interface PipelineHelpers {
	decodeAsTuples: typeof decodeAsTuples
	extractGeocodeResult: typeof extractGeocodeResult
}

/**
 * Load the helpers parse and geocode share.
 */
async function loadHelpers(): Promise<PipelineHelpers> {
	const [{ decodeAsTuples }, { extractGeocodeResult }] = await Promise.all([
		import("@mailwoman/core/decoder"),
		import("mailwoman/geocode"),
	])

	return { decodeAsTuples, extractGeocodeResult }
}

/**
 * What the plugin answers from: a pipeline for parse and POI, and a session
 * for geocode when a gazetteer was given.
 *
 * Its async disposal closes what the plugin built.
 */
interface PluginEngine extends AsyncDisposable {
	pipeline: InjectedPipeline
	/**
	 * The geocode session, or `null` for a parse-only registration and for an injected pipeline.
	 */
	session: GeocodeSession | null
}

/**
 * Builds the engine on first use when no pipeline was provided.
 *
 * With a gazetteer path the plugin builds the session a drop-in server builds:
 * no country scope, over every layer `mailwoman geocode` composes.
 * The pipeline for parse and POI reads that session's classifier and gazetteer, so the weights load once.
 *
 * Without one the plugin loads the weights and never reads a data root.
 */
async function buildEngine(opts: MailwomanFastifyOptions): Promise<PluginEngine> {
	const { createRuntimePipeline } = await import("mailwoman/engine/runtime-pipeline")
	const poiQueryKind = opts.poiDatabasePath ? { poiDatabasePath: opts.poiDatabasePath } : ("extract" as const)

	if (opts.candidateDatabasePath || opts.resolveDatabasePath) {
		const [{ createDropInGeocodeSession }, { NODE_LAYER_CONTRIBUTIONS }, { createWOFResolver }] = await Promise.all([
			import("mailwoman/geocode/session/drop-in"),
			import("mailwoman/services/entry/node"),
			import("@mailwoman/resolver"),
		])

		// A locale the plugin's user states is the caller's.
		// With none, the session is given none and records its locale as the default.
		const session = await createDropInGeocodeSession(NODE_LAYER_CONTRIBUTIONS, {
			...(opts.candidateDatabasePath ? { candidateDB: opts.candidateDatabasePath } : {}),
			...(opts.resolveDatabasePath ? { resolveDB: opts.resolveDatabasePath } : {}),
			...(opts.locale ? { locale: opts.locale } : {}),
		})

		const pipeline = createRuntimePipeline({
			classifier: session.services.routed,
			resolver: createWOFResolver(session.services.lookup),
			poiQueryKind,
		})

		return {
			pipeline,
			session,
			// The pipeline reads the session's gazetteer, so it closes first.
			[Symbol.asyncDispose]: async () => {
				await pipeline[Symbol.asyncDispose]()
				await session[Symbol.asyncDispose]()
			},
		}
	}

	const [{ NeuralAddressClassifier }, { DEFAULT_WEIGHTS_LOCALE }] = await Promise.all([
		import("@mailwoman/neural"),
		import("@mailwoman/neural/weights/families"),
	])

	const classifier = await NeuralAddressClassifier.loadRoutedFromWeights({
		locale: opts.locale ?? DEFAULT_WEIGHTS_LOCALE,
	})

	const pipeline = createRuntimePipeline({ classifier, poiQueryKind })

	return { pipeline, session: null, [Symbol.asyncDispose]: () => pipeline[Symbol.asyncDispose]() }
}

// #endregion

// #region Implementation

/**
 * Read this package's manifest without copying JSON into the compiled output.
 */
const { default: packageJSON } = await import("@mailwoman/fastify/package.json", {
	with: { type: "json" },
})

const pluginImpl: FastifyPluginAsync<MailwomanFastifyOptions> = async (fastify, opts) => {
	// A locale the plugin's user stated goes to every pipeline call.
	// With none, the pipeline detects each input's locale.
	const localeHint = opts.locale ? { locale: opts.locale } : {}
	const prefix = opts.prefix ?? ""

	// POI is available only when a database path was explicitly supplied.
	const poiEnabled = !!opts.poiDatabasePath

	const startedAt = Date.now()
	const { decodeAsTuples, extractGeocodeResult } = await loadHelpers()

	// The engine loads model weights, so it is built on the first request rather than at registration.
	// A failed build is retried by the next request, so installing the data needs no restart.
	// The plugin owns an engine it built, and closes it when the server closes.
	// A pipeline the caller passed in stays the caller's.
	let ownedEngine: PluginEngine | null = null

	const loadEngine = memoizeResettable(async () => {
		const built = await buildEngine(opts)

		ownedEngine = built

		return built
	})

	fastify.addHook("onClose", async () => {
		await ownedEngine?.[Symbol.asyncDispose]()
	})

	const getEngine = (): Promise<Pick<PluginEngine, "pipeline" | "session">> => {
		if (opts.pipeline) return Promise.resolve({ pipeline: opts.pipeline, session: null })

		return loadEngine()
	}

	/**
	 * Geocodes one address through the session, or through the pipeline when the registration has none.
	 *
	 * The pipeline path answers a parse-only registration and an injected pipeline: the request's
	 * options become the pipeline's resolve options, and the result is read off the tree it returns.
	 */
	const runGeocode = async (
		text: string,
		request: GeocodeRequestOptions = {}
	): Promise<{ result: GeocodeResult; tree: AddressTree }> => {
		const { pipeline, session } = await getEngine()

		if (session) return session.geocode(text, request)

		const { tree } = await pipeline(text, {
			...localeHint,
			...(request.inputMode ? { inputMode: request.inputMode } : {}),
			resolveOpts: {
				...(request.bias?.length ? { bias: request.bias } : {}),
				...(request.parentPlace ? { parentPlace: request.parentPlace } : {}),
				...(request.defaultCountry
					? { defaultCountry: { country: request.defaultCountry, source: "caller" as const } }
					: {}),
			},
		})

		return { result: extractGeocodeResult(text, tree), tree }
	}

	const mailwoman: MailwomanDecorator = {
		async parse(text, runOpts) {
			const { pipeline } = await getEngine()
			const result = await pipeline(text, { ...runOpts, ...localeHint })

			return {
				input: text,
				path: result.path,
				components: decodeAsTuples(result.tree).map(([tag, value]) => ({ tag, value })),
				tree: result.tree,
				debug: null,
			}
		},

		async geocode(text, request) {
			return (await runGeocode(text, request)).result
		},

		async poi(text, runOpts) {
			if (!poiEnabled) throw new POINotConfiguredError()

			const { pipeline } = await getEngine()
			const result = await pipeline(text, { ...runOpts, ...localeHint })

			return result.poiIntent ?? { type: "not_poi_query" }
		},
	}

	fastify.decorate("mailwoman", mailwoman)

	// The shared API operations validate and serialize with Zod in their own scope,
	// so the host app's compilers stay untouched.
	fastify.register(
		(operations) => {
			const api = operations.withTypeProvider<ZodTypeProvider>()

			api.setValidatorCompiler(validatorCompiler)
			api.setSerializerCompiler(serializerCompiler)

			api.setErrorHandler((error, _request, reply) => {
				if (hasZodFastifySchemaValidationErrors(error)) {
					return reply.code(400).send({ error: "invalid request", detail: error.message })
				}

				throw error
			})

			api.route({
				method: RetrieveHealthOperation.method,
				url: RetrieveHealthOperation.pathname,
				schema: RetrieveHealthOperation.schema,
				handler: () => ({
					status: "ok" as const,
					uptime_s: Math.round((Date.now() - startedAt) / 1000),
					version: packageJSON.version,
				}),
			})

			api.route({
				method: ParseAddressOperation.method,
				url: ParseAddressOperation.pathname,
				schema: ParseAddressOperation.schema,
				handler: async (request, reply) => {
					const address = request.body.address.trim()

					if (!address) return reply.code(400).send({ error: "address is required", detail: null })

					const { input, components, tree, debug } = await mailwoman.parse(address, {
						inputMode: request.body.input_mode,
					})

					return { input, components, tree, debug }
				},
			})

			api.route({
				method: ParseAddressQueryOperation.method,
				url: ParseAddressQueryOperation.pathname,
				schema: ParseAddressQueryOperation.schema,
				handler: async (request, reply) => {
					const address = request.query.address?.trim()

					if (!address) return reply.code(400).send({ error: "address is required", detail: null })

					const { input, components, tree, debug } = await mailwoman.parse(address, {
						inputMode: request.query.input_mode,
					})

					return { input, components, tree, debug }
				},
			})

			api.route({
				method: GeocodeAddressOperation.method,
				url: GeocodeAddressOperation.pathname,
				schema: GeocodeAddressOperation.schema,
				handler: async (request, reply) => {
					const { input_mode, bias, parent, include_tree } = request.body
					const address = request.body.address.trim()

					if (!address) return reply.code(400).send({ error: "address is required", detail: null })

					const { result: geocoded, tree } = await runGeocode(address, {
						inputMode: input_mode,
						...(bias.length ? { bias: bias.map((point) => ({ ...point })) } : {}),
						...(parent ? { parentPlace: { id: parent.id, source: "caller", strength: parent.scope } } : {}),
					})

					return {
						...geocoded,
						tree: include_tree ? tree : null,
						support: reportSupport(address, geocoded.countryCode),
					}
				},
			})

			api.route({
				method: SearchPOIOperation.method,
				url: SearchPOIOperation.pathname,
				schema: SearchPOIOperation.schema,
				handler: async (request, reply) => {
					if (!poiEnabled) {
						return reply.code(501).send({
							error: "poi search not configured",
							detail: `register @mailwoman/fastify with { poiDatabasePath } to enable POST ${SearchPOIOperation.pathname}`,
						})
					}

					const query = request.body.query.trim()

					if (!query) return reply.code(400).send({ error: "query is required", detail: null })

					return mailwoman.poi(query)
				},
			})
		},
		{ prefix }
	)
}

// #endregion

/**
 * Fastify plugin.
 *
 * Register with `fastify.register(mailwomanFastify, options)`.
 */
export const mailwomanFastify = fp(pluginImpl, { fastify: ">=5", name: "@mailwoman/fastify" })
