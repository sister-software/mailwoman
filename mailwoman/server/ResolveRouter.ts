/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   POST /api/resolve — runs the neural parser → resolver pipeline against a free-text address and
 *   returns the parsed XML tree + flat list of resolved nodes (coords, place IDs, scores).
 *
 *   Server-side counterpart to the static `resolve.html` page. Caller's perspective: send `{ text:
 *   "Springfield, IL" }`, get back a structured response suitable for both an XML viewer and a
 *   (future) map renderer.
 *
 *   Lazy-loads `@mailwoman/neural` + `@mailwoman/resolver-wof-sqlite` the first time the endpoint is
 *   hit so a server without WOF / weights can still boot and serve the rule-based `/parse`
 *   endpoint; the first `/api/resolve` call surfaces the missing-dep error cleanly to the client.
 */

import { existsSync } from "node:fs"

import { type AddressTree, decodeAsXML } from "@mailwoman/core/decoder"
import { createWOFResolver, type Resolver, type ResolverBackend } from "@mailwoman/resolver"
import { type RequestHandler, Router } from "express"

import { createResolverBackend, dataRootPath, wofShardPaths } from "../resolver-backend.js"

/** One node in the response's flat list — what the UI renders for each resolved component. */
export interface ResolveResponseNode {
	tag: string
	value: string
	start: number
	end: number
	confidence: number
	source?: string
	sourceID?: string
	lat?: number
	lon?: number
	placeID?: string
	depth: number
}

export interface ResolveResponse {
	input: string
	xml: string
	nodes: ResolveResponseNode[]
}

export interface ResolveErrorResponse {
	error: string
}

/**
 * Resolves a WOF DB path the same way the CLI does — explicit env override wins, else the canonical lab path.
 * Multi-shard: comma-separated paths in `MAILWOMAN_WOF_DB` are split and routed through the multi-shard ATTACH
 * machinery.
 */
function resolveWOFPaths(): string[] {
	const env = process.env["MAILWOMAN_WOF_DB"]

	if (env) {
		return env
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean)
	}

	// Canonical gazetteer is our CUSTOM-built unified DBs (from cloned WOF GeoJSON repos via
	// scripts/build-unified-wof.ts) — never the off-the-shelf geocode.earth dumps (different WOF
	// ids; see the feedback-custom-wof-db-only memory + scripts/wof-build-manifest.json). Multi-shard:
	// admin (7 priority countries) + US postcodes; the resolver routes postalcode queries to the
	// postcode shard. Override with MAILWOMAN_WOF_DB.
	return wofShardPaths().filter((p) => existsSync(p))
}

/**
 * One-time lazy initialization of the neural parser + resolver. Returns null when dependencies aren't installed
 * (optional peer deps); the handler converts that into a 503.
 */
let resolverPipeline: Promise<{ parse: (text: string) => Promise<AddressTree>; resolver: Resolver } | null> | null =
	null

async function getResolverPipeline() {
	if (resolverPipeline) return resolverPipeline
	resolverPipeline = (async () => {
		let neuralMod: typeof import("@mailwoman/neural")
		let resolverMod: typeof import("@mailwoman/resolver-wof-sqlite")

		try {
			neuralMod = await import("@mailwoman/neural")
		} catch {
			console.error("ResolveRouter: @mailwoman/neural not installed")

			return null
		}

		try {
			resolverMod = await import("@mailwoman/resolver-wof-sqlite")
		} catch {
			console.error("ResolveRouter: @mailwoman/resolver-wof-sqlite not installed")

			return null
		}

		const wofPaths = resolveWOFPaths()

		if (wofPaths.length === 0) {
			console.error(`ResolveRouter: no WOF DBs found. Set MAILWOMAN_WOF_DB or place shards at ${dataRootPath("wof")}/`)

			return null
		}

		const neural = await neuralMod.NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		const lookup = createResolverBackend(resolverMod, { wofPaths })
		// The lookup is structurally compatible with `ResolverBackend` — same shape.
		const resolver = createWOFResolver(lookup)

		return {
			parse: (text: string) => neural.parse(text),
			resolver,
		}
	})()

	return resolverPipeline
}

/** Flatten the tree to a depth-tagged list — easier to render in a table without recursion. */
function flatten(tree: AddressTree): ResolveResponseNode[] {
	const out: ResolveResponseNode[] = []
	const walk = (node: AddressTree["roots"][number], depth: number): void => {
		out.push({
			tag: node.tag,
			value: node.value,
			start: node.start,
			end: node.end,
			confidence: node.confidence,
			source: node.source,
			sourceID: node.sourceID,
			lat: node.lat,
			lon: node.lon,
			placeID: node.placeID,
			depth,
		})

		for (const child of node.children) walk(child, depth + 1)
	}

	for (const root of tree.roots) walk(root, 0)

	return out
}

const handler: RequestHandler = async (req, res) => {
	const text =
		typeof req.body?.text === "string"
			? req.body.text.trim()
			: typeof req.query?.text === "string"
				? (req.query.text as string).trim()
				: ""

	if (!text) {
		res.status(400).json({ error: "Missing `text` parameter" } satisfies ResolveErrorResponse)

		return
	}

	const pipeline = await getResolverPipeline()

	if (!pipeline) {
		res.status(503).json({
			error:
				"Resolver not available. Install @mailwoman/neural + @mailwoman/resolver-wof-sqlite, " +
				"and set MAILWOMAN_WOF_DB to a WOF SQLite distribution path.",
		} satisfies ResolveErrorResponse)

		return
	}

	try {
		const decoded = await pipeline.parse(text)
		const resolved = await pipeline.resolver.resolveTree(decoded)
		const response: ResolveResponse = {
			input: text,
			xml: decodeAsXML(resolved),
			nodes: flatten(resolved),
		}
		res.status(200).json(response)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error("ResolveRouter: pipeline error:", message)
		res.status(500).json({ error: `Pipeline error: ${message}` } satisfies ResolveErrorResponse)
	}
}

export const ResolveRouter: Router = Router()

ResolveRouter.post("/api/resolve", handler)
ResolveRouter.get("/api/resolve", handler)
