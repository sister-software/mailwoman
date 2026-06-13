/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman geocode "<address>" [flags]` — end-to-end street-level geocoder.
 *
 *   Pipeline:
 *     1. Parse the address with the neural classifier (same path as `parse` command).
 *     2. Resolve admin hierarchy via `createWofResolver(WofSqlitePlaceLookup)`.
 *     3. Augment with per-state address-point (situs) + interpolation shards, selected from
 *        the resolved region. Both are optional — absent shards degrade gracefully to admin-only.
 *     4. Extract the best available coordinate + resolution tier from the resolved tree and emit
 *        a flat geocode result object.
 *
 *   Resolution tiers (best → worst):
 *     - `address_point`  — exact situs coordinate from the address-points shard
 *     - `interpolated`   — house-number estimate from the interpolation shard
 *     - `admin`          — admin centroid from the WOF gazetteer
 *
 *   Exit-code contract:
 *     - 0  successful geocode (including admin-only degradation when shards are absent)
 *     - 1  bad arguments, missing required DB, or fatal parse/resolve error
 */

import { Spinner } from "@inkjs/ui"
import { createWofResolver, type ResolveOpts, type ResolverBackend } from "@mailwoman/core/resolver"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { Text } from "ink"
import { existsSync } from "node:fs"
import { setImmediate } from "node:timers/promises"
import { useEffect, useState } from "react"
import zod from "zod"
import { createRuntimePipeline } from "../runtime-pipeline.js"
import type { CommandComponent } from "../sdk/cli.js"
import { resolverDefaultCountry } from "./parse.js"

// ---------------------------------------------------------------------------
// CLI contract — args + options
// ---------------------------------------------------------------------------

const ArgumentsSchema = zod.array(zod.string().describe("A formatted postal address to geocode"))
export { ArgumentsSchema as args, OptionsSchema as options }

const OptionsSchema = zod.object({
	locale: zod
		.string()
		.regex(/^[a-z]{2}(-[A-Z]{2})?$/u, "Expected a BCP-47 tag like en-US or fr-FR")
		.optional()
		.default("en-US")
		.describe("Locale tag matching a weights package (en-US, fr-FR). Default en-US."),
	defaultCountry: zod
		.string()
		.optional()
		.describe(
			"ISO-3166 country to scope the WOF resolver. Defaults from --locale's region subtag (en-US → US). " +
				"Pass 'none' to disable the country filter."
		),
	resolveDb: zod
		.string()
		.optional()
		.describe(
			"Path to a WOF admin SQLite distribution. Defaults to $MAILWOMAN_WOF_DB; errors if neither is set."
		),
	dataRoot: zod
		.string()
		.optional()
		.default("/mnt/playpen/mailwoman-data")
		.describe(
			"Root directory for per-state address-point and interpolation shards. " +
				"Shards are expected at <dataRoot>/address-points/address-points-us-<state>.db " +
				"and <dataRoot>/interpolation/interpolation-us-<state>.db. Default: /mnt/playpen/mailwoman-data."
		),
	addressPointsDb: zod
		.string()
		.optional()
		.describe(
			"Explicit path to an address-points (situs) SQLite shard. Bypasses the per-state shard selection " +
				"from the resolved region. Use when you already know the right shard or are testing a specific file."
		),
	interpolationDb: zod
		.string()
		.optional()
		.describe(
			"Explicit path to an interpolation SQLite shard. Bypasses the per-state shard selection. " +
				"Use when you already know the right shard or are testing a specific file."
		),
	format: zod
		.enum(["json", "text"])
		.optional()
		.default("json")
		.describe('Output format. "json" (default) emits a machine-readable object; "text" prints a human summary.'),
})

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/**
 * The resolution tier that produced the coordinate. `address_point` > `interpolated` > `admin`.
 * Consumers should treat coordinates differently depending on the tier:
 *   - `address_point` — rooftop / parcel centroid; uncertainty_m is a small floor (~1 m)
 *   - `interpolated`  — house-number estimate; uncertainty_m is honest (half the bracket span)
 *   - `admin`         — admin centroid; uncertainty_m is null (no sub-locality estimate available)
 */
type ResolutionTier = "address_point" | "interpolated" | "admin"

interface GeocodeResult {
	input: string
	lat: number | null
	lon: number | null
	resolution_tier: ResolutionTier
	/** Uncertainty radius in meters. null for the admin tier. */
	uncertainty_m: number | null
	locality: string | null
	region: string | null
	postcode: string | null
	/** Admin hierarchy from the resolver, locality → country (most specific first). */
	hierarchy: Array<{ tag: string; value: string; lat?: number; lon?: number; placeId?: string }>
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveWofPath(options: zod.infer<typeof OptionsSchema>): string {
	const path = options.resolveDb ?? process.env["MAILWOMAN_WOF_DB"]
	if (!path) {
		throw new Error(
			"geocode needs a WOF admin SQLite path. Set $MAILWOMAN_WOF_DB or pass --resolve-db <path>. " +
				"Build one with `mailwoman-wof-build-slim` + `mailwoman-wof-build-fts`."
		)
	}
	return path
}

/**
 * Convert a resolved region name or abbreviation to a lowercase 2-letter state slug for shard
 * filenames (e.g. "TX" → "tx", "Texas" → null). Both the raw parsed value (e.g. "TX") and the
 * resolver's canonical name (e.g. "Texas") are checked — the raw abbreviation wins when present
 * because that's what the user typed and what the shard filenames encode.
 */
function regionToStateSlug(regionValue: string | null | undefined, resolverName: string | null | undefined): string | null {
	// Check raw parsed value first — abbreviations ("TX") are 2-letter and match immediately.
	for (const candidate of [regionValue, resolverName]) {
		if (!candidate) continue
		const trimmed = candidate.trim()
		if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toLowerCase()
	}
	return null
}

/**
 * Select the per-state address-points shard path from the data root + state slug.
 * Returns null when no slug is available or the file does not exist.
 */
function selectAddressPointsDb(dataRoot: string, stateSlug: string | null): string | null {
	if (!stateSlug) return null
	const candidate = `${dataRoot}/address-points/address-points-us-${stateSlug}.db`
	return existsSync(candidate) ? candidate : null
}

/**
 * Select the per-state interpolation shard path from the data root + state slug.
 * Returns null when no slug is available or the file does not exist.
 */
function selectInterpolationDb(dataRoot: string, stateSlug: string | null): string | null {
	if (!stateSlug) return null
	const candidate = `${dataRoot}/interpolation/interpolation-us-${stateSlug}.db`
	return existsSync(candidate) ? candidate : null
}

// ---------------------------------------------------------------------------
// Core geocode logic
// ---------------------------------------------------------------------------

async function runGeocode(input: string, options: zod.infer<typeof OptionsSchema>): Promise<string> {
	// --- Step 1: load neural classifier (graceful degradation if weights absent) ---
	let classifier: NeuralAddressClassifier | undefined
	try {
		classifier = await NeuralAddressClassifier.loadFromWeights({ locale: options.locale })
	} catch {
		// Weights not present — pipeline runs rule-only (queryShape / kind only). Acceptable degradation.
	}

	// --- Step 2: open WOF admin resolver ---
	let mod: typeof import("@mailwoman/resolver-wof-sqlite")
	try {
		mod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		throw new Error(
			"geocode requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
				"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
		)
	}

	const wofPath = resolveWofPath(options)
	const lookup = new mod.WofSqlitePlaceLookup({ databasePath: wofPath })

	try {
		// Step 2a: first pass — admin-only resolve so we can read the region to select shards.
		const resolver = createWofResolver(lookup as unknown as ResolverBackend)
		const dc = resolverDefaultCountry(options)
		const baseResolveOpts: ResolveOpts = {}
		if (dc) baseResolveOpts.defaultCountry = dc

		// Build a resolver pipeline for the first (admin-only) pass — no address-point / interpolation
		// yet; those need the region slug we haven't extracted yet.
		const pipeline = createRuntimePipeline({ classifier, resolver })
		const pipelineOpts = { locale: options.locale, resolveOpts: baseResolveOpts }
		const firstResult = await pipeline(input, pipelineOpts)
		const firstTree = firstResult.tree

		// --- Step 3: shard selection from resolved region ---
		// Walk the resolved tree to find the region node's canonical name / value.
		let regionValue: string | null = null
		let regionResolverName: string | null = null
		let localityValue: string | null = null
		let postcodeValue: string | null = null

		const stack = [...firstTree.roots]
		while (stack.length > 0) {
			const node = stack.pop()!
			if (node.tag === "region" && !regionValue) {
				regionValue = node.value.trim() || null
				regionResolverName = (node.metadata?.["resolver_name"] as string | undefined) ?? null
			}
			if (node.tag === "locality" && !localityValue) {
				localityValue = node.value.trim() || null
			}
			if (node.tag === "postcode" && !postcodeValue) {
				postcodeValue = node.value.trim() || null
			}
			stack.push(...node.children)
		}

		// Determine which state shard to open. Explicit flags always win; then fall back to
		// the region-derived slug. Missing shards → admin-only (never an error).
		const stateSlug = regionToStateSlug(regionValue, regionResolverName)
		const dataRoot = options.dataRoot

		const addressPointsPath = options.addressPointsDb ?? selectAddressPointsDb(dataRoot, stateSlug)
		const interpolationPath = options.interpolationDb ?? selectInterpolationDb(dataRoot, stateSlug)

		// --- Step 4: second resolve pass wiring in address-point + interpolation tiers ---
		let addressPointLookup: InstanceType<typeof mod.AddressPointSqliteLookup> | undefined
		let interpolationLookup: InstanceType<typeof mod.StreetInterpolator> | undefined

		try {
			if (addressPointsPath) {
				addressPointLookup = new mod.AddressPointSqliteLookup(addressPointsPath)
			}
			if (interpolationPath) {
				interpolationLookup = new mod.StreetInterpolator({ dbPath: interpolationPath })
			}

			const enrichedResolveOpts: ResolveOpts = { ...baseResolveOpts }
			if (addressPointLookup) enrichedResolveOpts.addressPoints = addressPointLookup
			if (interpolationLookup) enrichedResolveOpts.interpolation = interpolationLookup

			// Re-resolve the tree from the first-pass result with the enriched opts.
			// We re-resolve the already-parsed tree (not re-parse) to avoid a second neural inference.
			let finalTree = firstTree
			if (addressPointLookup || interpolationLookup) {
				finalTree = await resolver.resolveTree(firstTree, enrichedResolveOpts)
			}

			// --- Step 5: extract geocode result from the resolved tree ---
			const result = extractGeocodeResult(input, finalTree)

			// Emit
			if (options.format === "text") {
				return formatText(result)
			}
			return JSON.stringify(result, null, 2)
		} finally {
			addressPointLookup?.close()
			interpolationLookup?.close()
		}
	} finally {
		lookup.close()
	}
}

// ---------------------------------------------------------------------------
// Tree extraction
// ---------------------------------------------------------------------------

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"

/**
 * Walk the resolved `AddressTree` and extract the geocode result. Reads the street node's metadata
 * for the address-point / interpolation coordinate (whichever tier won), falls back to the best
 * admin centroid (locality → region → country) for the `admin` tier.
 */
function extractGeocodeResult(input: string, tree: AddressTree): GeocodeResult {
	// Flatten tree to a depth-first list for scanning.
	const allNodes: AddressNode[] = []
	const flatten = (nodes: readonly AddressNode[]) => {
		for (const n of nodes) {
			allNodes.push(n)
			flatten(n.children)
		}
	}
	flatten(tree.roots)

	// Find street node (carries address_point / interpolated_point metadata).
	const streetNode = allNodes.find((n) => n.tag === "street")

	let lat: number | null = null
	let lon: number | null = null
	let tier: ResolutionTier = "admin"
	let uncertaintyM: number | null = null

	// Address-point tier: the street node's metadata key is `address_point`.
	if (streetNode?.metadata?.["resolution_tier"] === "address_point") {
		const ap = streetNode.metadata["address_point"] as { lat: number; lon: number } | undefined
		if (ap) {
			lat = ap.lat
			lon = ap.lon
			tier = "address_point"
			uncertaintyM = 1 // Floor: situs point is essentially exact.
		}
	}

	// Interpolation tier: metadata key is `interpolated_point`.
	if (tier !== "address_point" && streetNode?.metadata?.["resolution_tier"] === "interpolated") {
		const ip = streetNode.metadata["interpolated_point"] as { lat: number; lon: number } | undefined
		if (ip) {
			lat = ip.lat
			lon = ip.lon
			tier = "interpolated"
			uncertaintyM = (streetNode.metadata["uncertainty_m"] as number | undefined) ?? null
		}
	}

	// Admin tier: best admin centroid from resolved nodes.
	if (tier === "admin") {
		// Prefer locality, then region, then country — most specific first.
		const adminPriority: ReadonlyArray<string> = ["locality", "dependent_locality", "region", "country"]
		for (const tag of adminPriority) {
			const node = allNodes.find((n) => n.tag === tag && n.lat != null && n.lon != null)
			if (node) {
				lat = node.lat!
				lon = node.lon!
				break
			}
		}
	}

	// Extract admin string values for the structured fields.
	const locality =
		allNodes.find((n) => n.tag === "locality" || n.tag === "dependent_locality")?.value?.trim() || null
	const region = allNodes.find((n) => n.tag === "region")?.value?.trim() || null
	const postcode = allNodes.find((n) => n.tag === "postcode")?.value?.trim() || null

	// Build hierarchy: all resolved admin nodes, most specific first.
	const HIERARCHY_TAGS = ["locality", "dependent_locality", "subregion", "region", "country"]
	const hierarchy = allNodes
		.filter((n) => HIERARCHY_TAGS.includes(n.tag) && (n.lat != null || n.placeId))
		.sort((a, b) => HIERARCHY_TAGS.indexOf(a.tag) - HIERARCHY_TAGS.indexOf(b.tag))
		.map((n) => ({
			tag: n.tag,
			value: n.value.trim(),
			...(n.lat != null ? { lat: n.lat, lon: n.lon! } : {}),
			...(n.placeId ? { placeId: n.placeId } : {}),
		}))

	return { input, lat, lon, resolution_tier: tier, uncertainty_m: uncertaintyM, locality, region, postcode, hierarchy }
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

function formatText(result: GeocodeResult): string {
	const lines: string[] = []
	lines.push(`input:            ${result.input}`)
	lines.push(`resolution_tier:  ${result.resolution_tier}`)
	if (result.lat != null && result.lon != null) {
		lines.push(`coordinate:       ${result.lat.toFixed(6)}, ${result.lon.toFixed(6)}`)
	} else {
		lines.push(`coordinate:       (unresolved)`)
	}
	if (result.uncertainty_m != null) {
		lines.push(`uncertainty_m:    ${result.uncertainty_m}`)
	}
	if (result.locality) lines.push(`locality:         ${result.locality}`)
	if (result.region) lines.push(`region:           ${result.region}`)
	if (result.postcode) lines.push(`postcode:         ${result.postcode}`)
	if (result.hierarchy.length > 0) {
		lines.push("hierarchy:")
		for (const h of result.hierarchy) {
			const coord = h.lat != null ? ` (${h.lat.toFixed(4)}, ${h.lon!.toFixed(4)})` : ""
			const id = h.placeId ? ` [${h.placeId}]` : ""
			lines.push(`  ${h.tag.padEnd(20)} ${h.value}${id}${coord}`)
		}
	}
	return lines.join("\n")
}

// ---------------------------------------------------------------------------
// React command component
// ---------------------------------------------------------------------------

const GeocodeCommand: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) => {
	const [output, setOutput] = useState<string>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		if (error) {
			setImmediate().then(() => process.exit(1))
		}
	}, [error])

	useEffect(() => {
		const input = args[0]

		if (!input || input.trim().length === 0) {
			setError("geocode requires a positional address argument  (e.g. mailwoman geocode \"350 5th Ave, New York, NY\")")
			return
		}

		runGeocode(input.trim(), options)
			.then(setOutput)
			.catch((err: unknown) => setError((err as Error).message))
	}, [args, options])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (!output) {
		return <Spinner />
	}

	return <Text>{output}</Text>
}

export default GeocodeCommand
