/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared street-level geocode cascade — the reusable core behind the `geocode` CLI command AND the
 *   server's `/api/geocode` + `/api/batch` endpoints (#485). One implementation of the cascade, so the
 *   CLI and the service never drift.
 *
 *   Cascade (the eval-validated path — 98.8% within 100m on the non-circular Travis holdout):
 *     1. RAW neural parse (`classifier.parse`, postcodeRepair). NOT the runtime pipeline — its
 *        reconcile stage merges street INTO house_number, dropping the street node the coordinate
 *        tiers need (#566).
 *     2. Read the parsed region → pick the per-state situs + interpolation shards.
 *     3. `resolveTree` with the coordinate tiers wired (additive; admin-only when shards absent).
 *     4. Extract the best coordinate + resolution tier (address_point > interpolated > admin).
 *
 *   The cascade depends on a {@link ShardResolver} — a `(stateSlug) => { addressPoints?, interpolation? }`
 *   function — so the CLI (honoring its explicit `--address-points-db` flags) and the server (a cached
 *   {@link ShardProvider}) supply shards their own way without the core knowing how.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { AddressPointLookup, InterpolationLookup, ResolveOpts, Resolver } from "@mailwoman/core/resolver"
import { existsSync } from "node:fs"

/**
 * The resolution tier that produced the coordinate. `address_point` > `interpolated` > `admin`.
 *   - `address_point` — rooftop / parcel centroid; uncertainty_m is a small floor (~1 m)
 *   - `interpolated`  — house-number estimate; uncertainty_m is honest (calibrated bracket span)
 *   - `admin`         — admin centroid; uncertainty_m is null (no sub-locality estimate available)
 */
export type ResolutionTier = "address_point" | "interpolated" | "admin"

export interface GeocodeResult {
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

/** The per-state shards to wire into a single geocode resolve. Either/both may be absent (admin-only). */
export interface StateShards {
	addressPoints?: AddressPointLookup
	interpolation?: InterpolationLookup
}

/** Resolve the situs/interpolation shards for a state slug (e.g. `"tx"`). `null` slug → no shards. */
export type ShardResolver = (stateSlug: string | null) => StateShards

/** The minimal classifier surface the cascade needs (a `NeuralAddressClassifier` satisfies it). */
export interface GeocodeClassifier {
	parse(text: string, opts?: { postcodeRepair?: boolean }): Promise<AddressTree>
}

export interface GeocodeDeps {
	classifier: GeocodeClassifier
	resolver: Resolver
	/** Per-state shard resolver. Omit for admin-only geocoding. */
	shards?: ShardResolver
	/** Country constraint passed to the resolver (e.g. `"US"`). */
	defaultCountry?: string
	/**
	 * Interpolation-radius conformal calibration multiplier (#374). The geocode surfaces pass 1.7 (the
	 * Travis calibration) so reported radii are an honest ~90% bound; 1 or undefined keeps the raw
	 * half-segment heuristic. See `docs/articles/evals/2026-06-14-interp-radius-calibration.md`.
	 */
	interpCalibration?: number
}

/** Lowercase 2-letter state slug from a parsed region value / resolver name, else null. */
export function regionToStateSlug(
	regionValue: string | null | undefined,
	resolverName: string | null | undefined
): string | null {
	for (const candidate of [regionValue, resolverName]) {
		if (!candidate) continue
		const trimmed = candidate.trim()
		if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toLowerCase()
	}
	return null
}

/** Per-state situs shard path under `<dataRoot>/address-points/`, or null if the slug/file is absent. */
export function selectAddressPointsDb(dataRoot: string, stateSlug: string | null): string | null {
	if (!stateSlug) return null
	const candidate = `${dataRoot}/address-points/address-points-us-${stateSlug}.db`
	return existsSync(candidate) ? candidate : null
}

/** Per-state interpolation shard path under `<dataRoot>/interpolation/`, or null if absent. */
export function selectInterpolationDb(dataRoot: string, stateSlug: string | null): string | null {
	if (!stateSlug) return null
	const candidate = `${dataRoot}/interpolation/interpolation-us-${stateSlug}.db`
	return existsSync(candidate) ? candidate : null
}

/** The lookup-class surface a {@link ShardProvider} needs from `@mailwoman/resolver-wof-sqlite`. */
export interface ShardLookupFactory {
	AddressPointSqliteLookup: new (dbPath: string) => AddressPointLookup & { close(): void }
	StreetInterpolator: new (opts: { dbPath: string }) => InterpolationLookup & { close(): void }
}

/**
 * Opens + CACHES per-state situs/interpolation lookups so a batch geocoding many addresses in one
 * state opens that state's (possibly multi-GB) shards once, not once per row. Call {@link close} when
 * done to release every cached handle.
 */
export class ShardProvider {
	readonly #factory: ShardLookupFactory
	readonly #dataRoot: string
	readonly #cache = new Map<string, StateShards & { _ap?: { close(): void }; _ip?: { close(): void } }>()

	constructor(factory: ShardLookupFactory, dataRoot: string) {
		this.#factory = factory
		this.#dataRoot = dataRoot
	}

	readonly for: ShardResolver = (stateSlug) => {
		if (!stateSlug) return {}
		const cached = this.#cache.get(stateSlug)
		if (cached) return { addressPoints: cached.addressPoints, interpolation: cached.interpolation }

		const apPath = selectAddressPointsDb(this.#dataRoot, stateSlug)
		const ipPath = selectInterpolationDb(this.#dataRoot, stateSlug)
		const ap = apPath ? new this.#factory.AddressPointSqliteLookup(apPath) : undefined
		const ip = ipPath ? new this.#factory.StreetInterpolator({ dbPath: ipPath }) : undefined
		const entry = { addressPoints: ap, interpolation: ip, _ap: ap, _ip: ip }
		this.#cache.set(stateSlug, entry)
		return { addressPoints: ap, interpolation: ip }
	}

	close(): void {
		for (const e of this.#cache.values()) {
			e._ap?.close()
			e._ip?.close()
		}
		this.#cache.clear()
	}
}

/**
 * Run the full street-level cascade on one address and return the structured geocode result. Always
 * returns a result (admin tier even with no coordinate shards). Throws only on a fatal parse/resolve
 * error — callers doing batch work should catch per-row.
 */
export async function geocodeAddress(input: string, deps: GeocodeDeps): Promise<GeocodeResult> {
	const tree = await deps.classifier.parse(input, { postcodeRepair: true })

	// Read the parsed region (raw value + resolver canonical name) for shard selection.
	let regionValue: string | null = null
	let regionResolverName: string | null = null
	const stack = [...tree.roots]
	while (stack.length > 0) {
		const node = stack.pop()!
		if (node.tag === "region" && !regionValue) {
			regionValue = node.value.trim() || null
			regionResolverName = (node.metadata?.["resolver_name"] as string | undefined) ?? null
		}
		stack.push(...node.children)
	}

	const stateSlug = regionToStateSlug(regionValue, regionResolverName)
	const { addressPoints, interpolation } = deps.shards?.(stateSlug) ?? {}

	const opts: ResolveOpts = {}
	if (deps.defaultCountry) opts.defaultCountry = deps.defaultCountry
	if (addressPoints) opts.addressPoints = addressPoints
	if (interpolation) {
		opts.interpolation = interpolation
		if (deps.interpCalibration && deps.interpCalibration !== 1) {
			opts.interpolationRadiusCalibration = deps.interpCalibration
		}
	}

	const resolved = await deps.resolver.resolveTree(tree, opts)
	return extractGeocodeResult(input, resolved)
}

/**
 * Walk the resolved tree and extract the geocode result: the street node's address-point /
 * interpolation coordinate (whichever tier won), else the best admin centroid (locality → region →
 * country).
 */
export function extractGeocodeResult(input: string, tree: AddressTree): GeocodeResult {
	const allNodes: AddressNode[] = []
	const flatten = (nodes: readonly AddressNode[]) => {
		for (const n of nodes) {
			allNodes.push(n)
			flatten(n.children)
		}
	}
	flatten(tree.roots)

	const streetNode = allNodes.find((n) => n.tag === "street")

	let lat: number | null = null
	let lon: number | null = null
	let tier: ResolutionTier = "admin"
	let uncertaintyM: number | null = null

	if (streetNode?.metadata?.["resolution_tier"] === "address_point") {
		const ap = streetNode.metadata["address_point"] as { lat: number; lon: number } | undefined
		if (ap) {
			lat = ap.lat
			lon = ap.lon
			tier = "address_point"
			uncertaintyM = 1 // Floor: situs point is essentially exact.
		}
	}

	if (tier !== "address_point" && streetNode?.metadata?.["resolution_tier"] === "interpolated") {
		const ip = streetNode.metadata["interpolated_point"] as { lat: number; lon: number } | undefined
		if (ip) {
			lat = ip.lat
			lon = ip.lon
			tier = "interpolated"
			uncertaintyM = (streetNode.metadata["uncertainty_m"] as number | undefined) ?? null
		}
	}

	if (tier === "admin") {
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

	const locality =
		allNodes.find((n) => n.tag === "locality" || n.tag === "dependent_locality")?.value?.trim() || null
	const region = allNodes.find((n) => n.tag === "region")?.value?.trim() || null
	const postcode = allNodes.find((n) => n.tag === "postcode")?.value?.trim() || null

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
