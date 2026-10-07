/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Fastify plugin for mailwoman's local parsing, geocoding, and POI pipeline.
 *
 * Routes are the shared `@mailwoman/api` operations: `GET`/`POST /v1/parse`, `POST /v1/geocode`, `POST /v1/poi`, and `GET /health`.
 * The `fastify.mailwoman` decorator also exposes parse, geocode, and POI methods.
 *
 * Provide a ready-to-use pipeline with `pipeline`, or let the plugin build one
 * lazily on the first request. Lazy setup uses `locale` and the optional database
 * paths. The plugin resolves model weights and gazetteer data as the CLI does.
 *
 * The decorator's parse result extends `@mailwoman/api`'s parse response with the pipeline path.
 * Geocode returns a `GeocodeResult`. Errors use `{ error, detail }`.
 */

import { GeocodeAddressOperation } from "@mailwoman/api/operations/geocode/address"
import type { RequestInputMode } from "@mailwoman/api/operations/input-mode"
import { ParseAddressOperation } from "@mailwoman/api/operations/parse/address"
import { ParseAddressQueryOperation } from "@mailwoman/api/operations/parse/address/query"
import { RetrieveHealthOperation } from "@mailwoman/api/operations/retrieve/health"
import { SearchPOIOperation } from "@mailwoman/api/operations/search-poi"
import type { PipelineOpts } from "@mailwoman/core"
import type { decodeAsTuples } from "@mailwoman/core/decoder"
import type { Resolver } from "@mailwoman/core/resolver/types"
import type { FastifyPluginAsync } from "fastify"
import fp from "fastify-plugin"
import {
	hasZodFastifySchemaValidationErrors,
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod"
import type { extractGeocodeResult } from "mailwoman/geocode"

import type { MailwomanFastifyOptions, RuntimePipeline, MailwomanDecorator } from "#shared"
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

const loadPipelineModules = () => Promise.all([import("mailwoman"), import("@mailwoman/neural")])

const loadResolverModules = () =>
	Promise.all([
		import("@mailwoman/resolver-wof-sqlite"),
		import("@mailwoman/resolver"),
		import("mailwoman/resolver-backend"),
	])

/**
 * Build the pipeline on first use when no pipeline was provided.
 */
async function buildPipeline(opts: MailwomanFastifyOptions, locale: string): Promise<RuntimePipeline> {
	const [{ createRuntimePipeline }, { NeuralAddressClassifier }] = await loadPipelineModules()

	const classifier = await NeuralAddressClassifier.loadRoutedFromWeights({ locale })

	let resolver: Resolver | null = null

	if (opts.resolveDatabasePath) {
		const [resolverMod, { createWOFResolver }, { createResolverBackend }] = await loadResolverModules()

		const backend = await createResolverBackend(resolverMod, { wofPaths: opts.resolveDatabasePath })
		resolver = createWOFResolver(backend)
	}

	return createRuntimePipeline({
		classifier,
		resolver,
		poiQueryKind: opts.poiDatabasePath ? { poiDatabasePath: opts.poiDatabasePath } : null,
	})
}

/**
 * Add the default locale unless the caller supplied one.
 */
function withLocale(opts: PipelineOpts | null | undefined, locale: string): PipelineOpts {
	if (opts?.locale) return opts

	return { ...opts, locale }
}

/**
 * The pipeline's input mode for a request's: `"auto"` leaves the pipeline to derive it.
 */
function pipelineInputMode(mode: RequestInputMode): PipelineOpts["inputMode"] {
	return mode === "auto" ? undefined : mode
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
	const locale = opts.locale ?? "en-US"
	const prefix = opts.prefix ?? ""

	// POI is available only when a database path was explicitly supplied.
	const poiEnabled = !!opts.poiDatabasePath

	const startedAt = Date.now()
	const { decodeAsTuples, extractGeocodeResult } = await loadHelpers()

	// The pipeline loads model weights, so it is built on the first request rather than at registration.
	let pipelinePromise: Promise<RuntimePipeline> | null = null

	const getPipeline = (): Promise<RuntimePipeline> => {
		if (opts.pipeline) return Promise.resolve(opts.pipeline)

		return (pipelinePromise ??= buildPipeline(opts, locale))
	}

	const mailwoman: MailwomanDecorator = {
		async parse(text, runOpts) {
			const pipeline = await getPipeline()
			const result = await pipeline(text, withLocale(runOpts, locale))

			return {
				input: text,
				path: result.path,
				components: decodeAsTuples(result.tree).map(([tag, value]) => ({ tag, value })),
				tree: result.tree,
				debug: null,
			}
		},

		async geocode(text, runOpts) {
			const pipeline = await getPipeline()
			const result = await pipeline(text, withLocale(runOpts, locale))

			return extractGeocodeResult(text, result.tree)
		},

		async poi(text, runOpts) {
			if (!poiEnabled) throw new POINotConfiguredError()

			const pipeline = await getPipeline()
			const result = await pipeline(text, withLocale(runOpts, locale))

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
						inputMode: pipelineInputMode(request.body.input_mode),
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
						inputMode: pipelineInputMode(request.query.input_mode),
					})

					return { input, components, tree, debug }
				},
			})

			api.route({
				method: GeocodeAddressOperation.method,
				url: GeocodeAddressOperation.pathname,
				schema: GeocodeAddressOperation.schema,
				handler: async (request, reply) => {
					const address = request.body.address.trim()

					if (!address) return reply.code(400).send({ error: "address is required", detail: null })

					return mailwoman.geocode(address, { inputMode: pipelineInputMode(request.body.input_mode) })
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
