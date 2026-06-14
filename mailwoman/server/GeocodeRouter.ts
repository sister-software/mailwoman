/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Street-level geocoding endpoints (#485, piece 1):
 *     - `POST /api/geocode` — `{ address }` → one {@link GeocodeResult} (parse → situs → interp → admin).
 *     - `POST /api/batch`   — `{ addresses: string[] }` → results in input order, BOUNDED concurrency,
 *       PER-ROW error isolation (one bad address never fails the batch — it gets an `{ error }` slot).
 *
 *   Runs the SAME cascade as the `geocode` CLI (`mailwoman/geocode-core.ts`), so the service and the
 *   CLI never drift. Deps (classifier + resolver + a cached {@link ShardProvider}) are lazy-loaded
 *   ONCE on first hit and reused; the per-state shard cache means a batch hitting many CA addresses
 *   opens CA's situs shard once, not per row.
 */

import { createWofResolver, type Resolver, type ResolverBackend } from "@mailwoman/core/resolver"
import { type RequestHandler, Router } from "express"
import { existsSync } from "node:fs"

import type { AddressTree } from "@mailwoman/core/decoder"
import type { ResolveOpts } from "@mailwoman/core/resolver"

import {
	geocodeAddress,
	type GeocodeClassifier,
	type GeocodeResult,
	regionSlugFromTree,
	ShardProvider,
} from "../geocode-core.js"
import { recordGeocode } from "./metrics.js"

/** Default per-state shard root + interp calibration — mirror the CLI defaults. */
const DATA_ROOT = process.env["MAILWOMAN_DATA_ROOT"] ?? "/mnt/playpen/mailwoman-data"
const INTERP_CALIBRATION = 1.7
/** Bounded concurrency for `/api/batch`. Override with MAILWOMAN_BATCH_CONCURRENCY. */
const BATCH_CONCURRENCY = Math.max(1, Number(process.env["MAILWOMAN_BATCH_CONCURRENCY"] ?? "8"))
/** Hard cap on batch size — a guardrail against unbounded request bodies. */
const BATCH_MAX = Math.max(1, Number(process.env["MAILWOMAN_BATCH_MAX"] ?? "1000"))

interface GeocodeDepsBundle {
	classifier: GeocodeClassifier
	resolver: Resolver
	shards: ShardProvider
	defaultCountry?: string
}

function wofPaths(): string[] {
	const env = process.env["MAILWOMAN_WOF_DB"]
	if (env) return env.split(",").map((p) => p.trim()).filter(Boolean)
	return ["/mnt/playpen/mailwoman-data/wof/admin-global-priority.db", "/mnt/playpen/mailwoman-data/wof/postalcode-us.db"].filter(
		(p) => existsSync(p)
	)
}

let depsPromise: Promise<GeocodeDepsBundle | null> | null = null

async function getDeps(): Promise<GeocodeDepsBundle | null> {
	if (depsPromise) return depsPromise
	depsPromise = (async () => {
		let neuralMod: typeof import("@mailwoman/neural")
		let resolverMod: typeof import("@mailwoman/resolver-wof-sqlite")
		try {
			neuralMod = await import("@mailwoman/neural")
			resolverMod = await import("@mailwoman/resolver-wof-sqlite")
		} catch {
			console.error("GeocodeRouter: @mailwoman/neural + @mailwoman/resolver-wof-sqlite are required")
			return null
		}
		const paths = wofPaths()
		if (paths.length === 0) {
			console.error("GeocodeRouter: no WOF DBs found — set MAILWOMAN_WOF_DB")
			return null
		}
		const classifier = await neuralMod.NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		const backend = new resolverMod.WofSqlitePlaceLookup({ databasePath: paths.length === 1 ? paths[0]! : paths })
		const resolver = createWofResolver(backend as unknown as ResolverBackend)
		const shards = new ShardProvider(resolverMod, DATA_ROOT)
		return { classifier, resolver, shards, defaultCountry: "US" }
	})()
	return depsPromise
}

function oneGeocode(deps: GeocodeDepsBundle, address: string): Promise<GeocodeResult> {
	return geocodeAddress(address, {
		classifier: deps.classifier,
		resolver: deps.resolver,
		shards: deps.shards.for,
		defaultCountry: deps.defaultCountry,
		interpCalibration: INTERP_CALIBRATION,
	})
}

const DEPS_UNAVAILABLE = {
	error: "Geocoder not available. Install @mailwoman/neural + @mailwoman/resolver-wof-sqlite and set MAILWOMAN_WOF_DB.",
}

const singleHandler: RequestHandler = async (req, res) => {
	const address = typeof req.body?.address === "string" ? req.body.address.trim() : ""
	if (!address) {
		res.status(400).json({ error: "Missing `address` (string)" })
		return
	}
	const deps = await getDeps()
	if (!deps) {
		res.status(503).json(DEPS_UNAVAILABLE)
		return
	}
	const t0 = performance.now()
	try {
		const result = await oneGeocode(deps, address)
		recordGeocode(performance.now() - t0, result.resolution_tier)
		res.status(200).json(result)
	} catch (err) {
		recordGeocode(performance.now() - t0, "error")
		res.status(500).json({ error: `geocode error: ${err instanceof Error ? err.message : String(err)}` })
	}
}

/** Per-row result: the GeocodeResult, OR an `{ input, error }` slot so one bad row never fails the batch. */
type BatchRow = GeocodeResult | { input: string; error: string }

const batchHandler: RequestHandler = async (req, res) => {
	const addresses = req.body?.addresses
	if (!Array.isArray(addresses) || addresses.some((a) => typeof a !== "string")) {
		res.status(400).json({ error: "Body must be `{ addresses: string[] }`" })
		return
	}
	if (addresses.length === 0) {
		res.status(200).json({ results: [] })
		return
	}
	if (addresses.length > BATCH_MAX) {
		res.status(413).json({ error: `Batch too large: ${addresses.length} > ${BATCH_MAX} (MAILWOMAN_BATCH_MAX)` })
		return
	}
	const deps = await getDeps()
	if (!deps) {
		res.status(503).json(DEPS_UNAVAILABLE)
		return
	}

	const inputs: string[] = addresses.map((a) => (a as string).trim())
	const results: BatchRow[] = new Array<BatchRow>(inputs.length)

	// Bounded-concurrency worker pool over a shared cursor — results land in input order; a thrown
	// row is isolated to its own slot. The shard cache makes same-state rows cheap after the first.
	let cursor = 0
	const worker = async (): Promise<void> => {
		for (let i = cursor++; i < inputs.length; i = cursor++) {
			const input = inputs[i]!
			const t0 = performance.now()
			try {
				const result = await oneGeocode(deps, input)
				recordGeocode(performance.now() - t0, result.resolution_tier)
				results[i] = result
			} catch (err) {
				recordGeocode(performance.now() - t0, "error")
				results[i] = { input, error: err instanceof Error ? err.message : String(err) }
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, inputs.length) }, worker))

	res.status(200).json({ results })
}

/**
 * `POST /api/resolve-tree` — the resolver-service endpoint that `RemoteResolver` (core) calls. Accepts
 * an already-parsed `{ tree, opts? }`, selects this region's situs/interpolation shards (the data lives
 * here, not on the caller), runs the FULL cascade, and returns `{ tree }`. This is what lets a
 * stateless parser node geocode at street level against a shared resolver service.
 */
const resolveTreeHandler: RequestHandler = async (req, res) => {
	const tree = req.body?.tree as AddressTree | undefined
	if (!tree || !Array.isArray(tree.roots)) {
		res.status(400).json({ error: "Body must be `{ tree: AddressTree, opts?: ResolveOpts }`" })
		return
	}
	const incomingOpts = (req.body?.opts ?? {}) as ResolveOpts
	const deps = await getDeps()
	if (!deps) {
		res.status(503).json(DEPS_UNAVAILABLE)
		return
	}
	const t0 = performance.now()
	try {
		const { addressPoints, interpolation } = deps.shards.for(regionSlugFromTree(tree))
		const opts: ResolveOpts = {
			...incomingOpts,
			defaultCountry: incomingOpts.defaultCountry ?? deps.defaultCountry,
			...(addressPoints ? { addressPoints } : {}),
			...(interpolation
				? { interpolation, interpolationRadiusCalibration: incomingOpts.interpolationRadiusCalibration ?? INTERP_CALIBRATION }
				: {}),
		}
		const resolved = await deps.resolver.resolveTree(tree, opts)
		// Best-effort tier metric: read the street node's stamped tier (matches the geocode path).
		const street = resolved.roots.flatMap((r) => collectStreetTier(r)).find(Boolean)
		recordGeocode(performance.now() - t0, street ?? "admin")
		res.status(200).json({ tree: resolved })
	} catch (err) {
		recordGeocode(performance.now() - t0, "error")
		res.status(500).json({ error: `resolve-tree error: ${err instanceof Error ? err.message : String(err)}` })
	}
}

/** Pull the street node's resolution tier (if any) for the metric — mirrors extractGeocodeResult. */
function collectStreetTier(node: AddressTree["roots"][number]): Array<"address_point" | "interpolated" | "admin"> {
	const out: Array<"address_point" | "interpolated" | "admin"> = []
	if (node.tag === "street") {
		const tier = node.metadata?.["resolution_tier"]
		if (tier === "address_point" || tier === "interpolated") out.push(tier)
	}
	for (const child of node.children) out.push(...collectStreetTier(child))
	return out
}

export const GeocodeRouter: Router = Router()
GeocodeRouter.post("/api/geocode", singleHandler)
GeocodeRouter.post("/api/batch", batchHandler)
GeocodeRouter.post("/api/resolve-tree", resolveTreeHandler)
