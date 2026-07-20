/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/fastify` — a Fastify plugin that mounts mailwoman's local pipeline as HTTP routes.
 *
 *   Install this package to get geocoding, address parsing, and POI search in a Fastify app without
 *   standing up a separate geocoding service. Register the plugin and you have `POST /parse`,
 *   `POST /geocode`, `POST /poi`, and `GET /health`, plus a `fastify.mailwoman` decorator that
 *   exposes the same three operations programmatically.
 *
 *   The plugin runs ONE runtime pipeline (`createRuntimePipeline` from `mailwoman`). Inject a
 *   pre-built pipeline via the `pipeline` option (the DI / testing seam — no model weights required)
 *   or let the plugin build one lazily on first use from `resolveDatabasePath` / `poiDatabasePath` /
 *   `locale`. The lazy build resolves weights + gazetteer data through `@mailwoman/neural`'s standard
 *   resolution, exactly like the CLI and the drop-in servers.
 *
 *   The response envelopes mirror `@mailwoman/api`'s native `/v1` surface (parse → ordered components
 *   + tree, geocode → the `GeocodeResult` passthrough, errors → `{ error, detail? }`). This plugin is
 *   Fastify-native, so it reuses those SHAPES rather than `@mailwoman/api-kit`'s Hono plumbing.
 */

import type { decodeAsTuples } from "@mailwoman/core/decoder"
import packageJson from "@mailwoman/fastify/package.json" with { type: "json" }
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify"
import fp from "fastify-plugin"
import type { AddressTree, PipelineOpts, PipelineResult, POIIntentOutcome } from "mailwoman"
import type { extractGeocodeResult, GeocodeResult } from "mailwoman/geocode-core"

/**
 * Structural shape of the runtime pipeline (`createRuntimePipeline`'s return value): a function from raw input +
 * per-call opts to a {@link PipelineResult}. Kept structural so a caller can inject a fake in tests without importing
 * the concrete factory.
 */
export type RuntimePipeline = (raw: string, opts?: PipelineOpts) => Promise<PipelineResult>

/** Options for the `@mailwoman/fastify` plugin. */
export interface MailwomanFastifyOptions {
	/**
	 * A pre-built runtime pipeline (`createRuntimePipeline(...)`). The dependency-injection / testing path — supply this
	 * and the plugin makes NO attempt to load model weights or open a gazetteer. When omitted, the plugin builds one
	 * lazily on first use from the paths + locale below.
	 */
	pipeline?: RuntimePipeline
	/**
	 * Path to a `poi.db` layer. Enables `POST /poi` (without it the route answers a clean 501) and, on the lazy-built
	 * pipeline, wires POI execution via `createRuntimePipeline({ poiQueryKind: { poiDatabasePath } })`.
	 */
	poiDatabasePath?: string
	/**
	 * Path to a WOF gazetteer database (a `candidate.db` or an admin `wof.db`) for the lazy-built pipeline's resolver.
	 * Omitted → the lazy pipeline parses without a resolver (parse works; geocode returns no coordinates). Ignored when a
	 * pre-built `pipeline` is injected.
	 */
	resolveDatabasePath?: string
	/** Locale for the lazily-loaded model weights + the default per-call locale hint. Defaults to `"en-US"`. */
	locale?: string
	/** Path prefix for every registered route (e.g. `"/geo"` → `POST /geo/parse`). Defaults to `""` (no prefix). */
	routePrefix?: string
}

/** One parsed component in reading order — a `ComponentTag` + the covered text. Mirrors `@mailwoman/api`'s shape. */
export interface ParseComponent {
	tag: string
	value: string
}

/** The `POST /parse` (and `mailwoman.parse`) outcome: ordered components + the full decoded tree. */
export interface ParseOutcome {
	input: string
	/** Which path the coordinator took (`"fast-path"` | `"full"` | `"poi"`). */
	path: PipelineResult["path"]
	components: ParseComponent[]
	tree: AddressTree
}

/** The POI outcome when the query was not POI-shaped (the pipeline produced no intent). */
export interface NotPOIQuery {
	type: "not_poi_query"
}

/** The programmatic surface exposed on `fastify.mailwoman`. Every method runs the same underlying pipeline. */
export interface MailwomanDecorator {
	/** Parse an address into ordered components + the decoded tree. */
	parse(text: string, opts?: PipelineOpts): Promise<ParseOutcome>
	/** Geocode an address to a coordinate (the `GeocodeResult` extracted from the resolved tree). */
	geocode(text: string, opts?: PipelineOpts): Promise<GeocodeResult>
	/**
	 * Run the POI-query path. Returns the pipeline's `POIIntentOutcome` (intent / abstain, with results when a poi.db is
	 * wired) or {@link NotPOIQuery} when the input wasn't POI-shaped. Throws {@link POINotConfiguredError} when the plugin
	 * was registered without `poiDatabasePath`.
	 */
	poi(text: string, opts?: PipelineOpts): Promise<POIIntentOutcome | NotPOIQuery>
}

declare module "fastify" {
	interface FastifyInstance {
		mailwoman: MailwomanDecorator
	}
}

/** Thrown by `mailwoman.poi` when the plugin was registered without a `poiDatabasePath`. */
export class POINotConfiguredError extends Error {
	constructor() {
		super("POI search is not configured — register @mailwoman/fastify with { poiDatabasePath } to enable it")
		this.name = "POINotConfiguredError"
	}
}

interface PipelineHelpers {
	decodeAsTuples: typeof decodeAsTuples
	extractGeocodeResult: typeof extractGeocodeResult
}

/**
 * Lazily load the two pure decode helpers from `mailwoman`. Both are needed on every parse / geocode call regardless of
 * whether the pipeline was injected, so they load once (on the first request) and cache — keeping plugin registration
 * itself free of any `@mailwoman/*` runtime import. Reached via subpaths (`@mailwoman/core/decoder`,
 * `mailwoman/geocode-core`) rather than the bare `mailwoman` barrel to sidestep the documented bare+subpath import
 * cycle (see AGENTS.md § the bare-import + subpath-import cycle).
 */
async function loadHelpers(): Promise<PipelineHelpers> {
	const [decoder, geo] = await Promise.all([import("@mailwoman/core/decoder"), import("mailwoman/geocode-core")])

	return { decodeAsTuples: decoder.decodeAsTuples, extractGeocodeResult: geo.extractGeocodeResult }
}

/**
 * Build the runtime pipeline lazily from the plugin options — the path taken when no `pipeline` was injected. Loads the
 * neural classifier via `@mailwoman/neural`'s standard weight resolution, opens a WOF resolver when
 * `resolveDatabasePath` is set, and wires POI execution when `poiDatabasePath` is set. All imports are dynamic so a
 * consumer who injects their own pipeline never pulls this closure.
 */
async function buildPipeline(opts: MailwomanFastifyOptions, locale: string): Promise<RuntimePipeline> {
	const [{ createRuntimePipeline }, { NeuralAddressClassifier }] = await Promise.all([
		import("mailwoman"),
		import("@mailwoman/neural"),
	])

	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale })

	let resolver: ReturnType<(typeof import("@mailwoman/resolver"))["createWOFResolver"]> | undefined

	if (opts.resolveDatabasePath) {
		const [resolverMod, { createWOFResolver }, { createResolverBackend }] = await Promise.all([
			import("@mailwoman/resolver-wof-sqlite"),
			import("@mailwoman/resolver"),
			import("mailwoman/resolver-backend"),
		])
		const backend = createResolverBackend(resolverMod, { wofPaths: opts.resolveDatabasePath })
		resolver = createWOFResolver(backend)
	}

	return createRuntimePipeline({
		classifier,
		resolver,
		poiQueryKind: opts.poiDatabasePath ? { poiDatabasePath: opts.poiDatabasePath } : undefined,
	})
}

/** Merge the plugin's default locale into per-call pipeline opts (a caller-supplied `locale` wins). */
function withLocale(opts: PipelineOpts | undefined, locale: string): PipelineOpts {
	if (opts?.locale) return opts

	return { ...opts, locale }
}

/**
 * Read + validate the `{ text }` body. On a missing / blank / non-string `text`, sends a `400` through the native `{
 * error }` envelope and returns `null` so the handler bails.
 */
function readText(request: FastifyRequest, reply: FastifyReply): string | null {
	const body = request.body as { text?: unknown } | undefined
	const text = typeof body?.text === "string" ? body.text.trim() : ""

	if (!text) {
		reply.code(400).send({ error: "text is required" })

		return null
	}

	return text
}

const pluginImpl: FastifyPluginAsync<MailwomanFastifyOptions> = async (fastify, opts) => {
	const locale = opts.locale ?? "en-US"
	const prefix = opts.routePrefix ?? ""
	// POI route availability is an explicit config decision: it's on iff `poiDatabasePath` was supplied. A pipeline
	// injected without it still parses/geocodes, but `POST /poi` answers a clean 501 (and `mailwoman.poi` throws) — so the
	// route's availability is deterministic regardless of how the injected pipeline was wired.
	const poiEnabled = opts.poiDatabasePath !== undefined

	// The pipeline + helpers resolve once, lazily. An injected pipeline is used as-is; otherwise it's built on the first
	// request (never at registration) so `fastify.register` stays cheap and side-effect-free.
	let pipelinePromise: Promise<RuntimePipeline> | undefined
	const getPipeline = (): Promise<RuntimePipeline> => {
		if (opts.pipeline) return Promise.resolve(opts.pipeline)

		return (pipelinePromise ??= buildPipeline(opts, locale))
	}

	let helpersPromise: Promise<PipelineHelpers> | undefined
	const getHelpers = (): Promise<PipelineHelpers> => (helpersPromise ??= loadHelpers())

	const mailwoman: MailwomanDecorator = {
		async parse(text, runOpts) {
			const [pipeline, { decodeAsTuples }] = await Promise.all([getPipeline(), getHelpers()])
			const result = await pipeline(text, withLocale(runOpts, locale))

			return {
				input: text,
				path: result.path,
				components: decodeAsTuples(result.tree).map(([tag, value]) => ({ tag, value })),
				tree: result.tree,
			}
		},

		async geocode(text, runOpts) {
			const [pipeline, { extractGeocodeResult }] = await Promise.all([getPipeline(), getHelpers()])
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

	fastify.post(`${prefix}/parse`, async (request, reply) => {
		const text = readText(request, reply)

		if (text === null) return reply

		return reply.send(await mailwoman.parse(text))
	})

	fastify.post(`${prefix}/geocode`, async (request, reply) => {
		const text = readText(request, reply)

		if (text === null) return reply

		return reply.send(await mailwoman.geocode(text))
	})

	fastify.post(`${prefix}/poi`, async (request, reply) => {
		if (!poiEnabled) {
			return reply.code(501).send({
				error: "poi search not configured",
				detail: "register @mailwoman/fastify with { poiDatabasePath } to enable POST /poi",
			})
		}
		const text = readText(request, reply)

		if (text === null) return reply

		return reply.send(await mailwoman.poi(text))
	})

	fastify.get(`${prefix}/health`, async (_request, reply) => reply.send({ ok: true, version: packageJson.version }))
}

/**
 * The `@mailwoman/fastify` plugin, wrapped with `fastify-plugin` so the `fastify.mailwoman` decorator + the routes land
 * on the instance the caller registered against (encapsulation is broken deliberately — the decorator is meant to be
 * shared). Register with `fastify.register(mailwomanFastify, options)`.
 */
export const mailwomanFastify = fp(pluginImpl, { fastify: ">=5", name: "@mailwoman/fastify" })

export default mailwomanFastify
