/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared street-level geocode cascade — the reusable core behind the `geocode` CLI command AND the
 *   server's `/api/geocode` + `/api/batch` endpoints (#485). One implementation of the cascade, so
 *   the CLI and the service never drift.
 *
 *   Cascade (the eval-validated path — 98.8% within 100m on the non-circular Travis holdout):
 *
 *   1. RAW neural parse (`classifier.parse`, postcodeRepair). NOT the runtime pipeline — its reconcile
 *        stage merges street INTO house_number, dropping the street node the coordinate tiers need
 *        (#566).
 *   2. Read the parsed region → pick the per-state situs + interpolation shards.
 *   3. `resolveTree` with the coordinate tiers wired (additive; admin-only when shards absent).
 *   4. Extract the best coordinate + resolution tier (address_point > interpolated > admin).
 *
 *   The cascade depends on a {@link ShardResolver} — a `(stateSlug) => { addressPoints?,
 *   interpolation? }` function — so the CLI (honoring its explicit `--address-points-db` flags) and
 *   the server (a cached {@link ShardProvider}) supply shards their own way without the core knowing
 *   how.
 */

import { existsSync } from "node:fs"

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { hardCountryFor, isBareLocalityTree } from "@mailwoman/core/pipeline"
import { normalize } from "@mailwoman/normalize"
import type { AddressPointLookup, InterpolationLookup, ResolveOpts, Resolver } from "@mailwoman/resolver"

import { type DataReleaseManifest, readReleaseManifest, resolveShardPath } from "./data-release.js"
import { loadDefaultPlaceCountry, type PlaceCountryFn } from "./default-placer.js"
import { interpCalibrationForRegion, type InterpCalibrationTable } from "./interp-calibration.js"
import { recognizeUSRegions } from "./region-recognition.js"

/**
 * The resolution tier that produced the coordinate. `address_point` > `interpolated` > `admin`.
 *
 * - `address_point` — rooftop / parcel centroid; uncertainty_m is a small floor (~1 m)
 * - `interpolated` — house-number estimate; uncertainty_m is honest (calibrated bracket span)
 * - `admin` — admin centroid; uncertainty_m is null (no sub-locality estimate available)
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
	hierarchy: Array<{ tag: string; value: string; lat?: number; lon?: number; placeID?: string }>
}

/**
 * The per-state shards to wire into a single geocode resolve. Either/both may be absent (admin-only).
 */
export interface StateShards {
	addressPoints?: AddressPointLookup
	interpolation?: InterpolationLookup
}

/** Resolve the situs/interpolation shards for a state slug (e.g. `"tx"`). `null` slug → no shards. */
export type ShardResolver = (stateSlug: string | null) => StateShards

/** The minimal classifier surface the cascade needs (a `NeuralAddressClassifier` satisfies it). */
export interface GeocodeClassifier {
	parse(text: string, opts?: { postcodeRepair?: boolean; normalizeCase?: boolean }): Promise<AddressTree>
}

export interface GeocodeDeps {
	classifier: GeocodeClassifier
	resolver: Resolver
	/** Per-state shard resolver. Omit for admin-only geocoding. */
	shards?: ShardResolver
	/**
	 * OSM rooftop shards keyed by ISO-3166 alpha-2 country (#247) — the opt-in international precision tier. Consulted
	 * ONLY when no US per-state situs shard matched (a non-US parse), so the US path is untouched. Inject from
	 * `@mailwoman/osm`'s `OSMShardProvider`; absent = no OSM tier. ODbL — see `osm/README.md`.
	 */
	osmShards?: (country: string) => StateShards
	/** Country constraint passed to the resolver (e.g. `"US"`). */
	defaultCountry?: string
	/**
	 * Title-case all-caps ASCII input before the model (#690), detection-gated so mixed-case + non-Latin pass through
	 * untouched. **Default `true`** — validated-beneficial on this geocode/resolveTree path (#619: TX-facility locality
	 * 90.1 → 99.7%). The #694 comma-less crater was the space-join, not the casing, so on comma-joined input it is a
	 * clean win. Set `false` to restore the legacy raw-case parse.
	 */
	normalizeCase?: boolean
	/**
	 * Stage 1 deterministic preprocessing (`@mailwoman/normalize`: NFC + whitespace-collapse + punctuation) on the input
	 * before parse. **Default `true`.** `createRuntimePipeline` runs this as a stage, but the drop-in servers
	 * (nominatim/photon) call `geocodeAddress` directly — without it a double-spaced / odd-punctuation query was fragile
	 * (`"Damrak 1, 1012 LG"` → unresolved). Idempotent; `false` opts out for callers that already normalized.
	 */
	normalizeInput?: boolean
	/**
	 * A pre-parsed tree to resolve, skipping the internal `classifier.parse` (the address's single most expensive step).
	 * Supply the output of {@link parseForGeocode} when a caller already parsed the same address for another purpose — a
	 * PostalAddress, say — so the inference runs once, not twice. MUST come from `parseForGeocode` (same input + opts),
	 * or the resolved tree won't match the address. Omit for the normal one-shot path.
	 */
	parsedTree?: AddressTree
	/**
	 * Interpolation-radius conformal calibration (#374) so reported radii are an honest ~90% bound; `1` or `undefined`
	 * keeps the raw half-segment heuristic. Accepts either a single multiplier (the legacy Travis 1.7) OR a per-region
	 * {@link InterpCalibrationTable} — when a table is supplied the factor is selected by the parsed region (DC 1.44 … AZ
	 * 3.12, `default` otherwise, #584). See `docs/articles/evals/2026-06-14-interp-multiregion-recalibration.md`.
	 */
	interpCalibration?: number | InterpCalibrationTable
	/**
	 * Coarse country router (#244, soft prior). A `(text) → { country, confidence }` predictor. A confident IN-MAP guess
	 * becomes an `anchorPosterior` the resolver's #369 re-rank boosts (never filters); abstain (`null`) / off-map
	 * (`OTHER`) are no-ops, and an explicit {@link defaultCountry} still wins (we never overwrite a caller-set
	 * posterior).
	 *
	 * **Default-on (#244 M2, after the misroute gate):**
	 *
	 * - `undefined` (default) → the bundled placer ({@link loadDefaultPlaceCountry}, open-set @ 0.9) is lazy-loaded and
	 *   applied. Degrades to no prior if the model can't be resolved.
	 * - A function → use it (a custom placer / threshold).
	 * - `false` → disabled (no prior; the pre-M2 byte-stable behavior).
	 */
	placeCountry?: PlaceCountryFn | false
	/**
	 * Proximity-bias points (viewport center, user location, …), strongest first — forwarded to the resolver as
	 * ResolveOpts.bias (soft prominence re-rank; the ambiguous-postcode disambiguator).
	 */
	bias?: Array<{ lat: number; lon: number; weight?: number }>
	/**
	 * #743/#194: promote a CONFIDENT placer guess to a HARD country filter (empty→unresolved) for coverage-safelisted
	 * countries — see {@link hardCountryFor}. **DEFAULT-ON** (#743): a pure win on well-covered countries
	 * (US/ES/IT/NL/DE/FR), soft (no-op) for the rest. Pass `false` to opt out.
	 */
	hardPlaceCountry?: boolean
	/** #743/#194: override the coverage safelist gating {@link hardPlaceCountry}. Undefined → built-in. */
	hardCountrySafelist?: ReadonlySet<string>
	/**
	 * Admin descendant-consistency (#263, `ResolveOpts.adminCoherence`) — re-pick a (region, locality) pair so the
	 * locality descends from the region ("Portland, ME" → Maine, not Messina). **Default-on** for the geocode path; only
	 * fires when a region's child locality fell through, so the well-resolved path is byte-identical. Pass `false` to opt
	 * out.
	 */
	adminCoherence?: boolean
}

/**
 * Anchor weight for the coarse-placer's country prior. Matches the runtime-pipeline default — a whole-string country
 * guess is broader/softer than a postcode anchor (2.0), so it blends gently.
 */
const COARSE_PLACER_ANCHOR_WEIGHT = 1.0

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

/**
 * Walk a (parsed or resolved) tree for its region → the per-state shard slug (e.g. `"tx"`), else null.
 */
export function regionSlugFromTree(tree: AddressTree): string | null {
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

	return regionToStateSlug(regionValue, regionResolverName)
}

/**
 * Per-state situs shard path under `<dataRoot>/address-points/`, or null if the slug/file is absent.
 */
export function selectAddressPointsDB(dataRoot: string, stateSlug: string | null): string | null {
	if (!stateSlug) return null
	const candidate = `${dataRoot}/address-points/address-points-us-${stateSlug}.db`

	return existsSync(candidate) ? candidate : null
}

/** Per-state interpolation shard path under `<dataRoot>/interpolation/`, or null if absent. */
export function selectInterpolationDB(dataRoot: string, stateSlug: string | null): string | null {
	if (!stateSlug) return null
	const candidate = `${dataRoot}/interpolation/interpolation-us-${stateSlug}.db`

	return existsSync(candidate) ? candidate : null
}

/** The lookup-class surface a {@link ShardProvider} needs from `@mailwoman/resolver-wof-sqlite`. */
export interface ShardLookupFactory {
	AddressPointSqliteLookup: new (dbPath: string) => AddressPointLookup & { close(): void }
	StreetInterpolator: new (opts: { dbPath: string }) => InterpolationLookup & { close(): void }
}

interface ShardCacheEntry extends StateShards {
	_ap?: { close(): void }
	_ip?: { close(): void }
	/** The resolved on-disk paths this entry was opened from — reload() diffs against these. */
	apPath: string | null
	ipPath: string | null
}

/**
 * Opens + CACHES per-state situs/interpolation lookups so a batch geocoding many addresses in one state opens that
 * state's (possibly multi-GB) shards once, not once per row. Versioned-data aware (#485): paths resolve through the
 * `releases.json` manifest (legacy unversioned fallback), and {@link reload} performs a zero-downtime atomic switchover
 * when a new version is published. Call {@link close} when done to release every cached handle.
 */
export class ShardProvider {
	readonly #factory: ShardLookupFactory
	readonly #dataRoot: string
	readonly #cache = new Map<string, ShardCacheEntry>()
	/** Previous-generation handles, retired by reload() and closed on the NEXT reload (one-gen grace). */
	#retired: Array<{ close(): void }> = []
	#manifest: DataReleaseManifest | null

	constructor(factory: ShardLookupFactory, dataRoot: string) {
		this.#factory = factory
		this.#dataRoot = dataRoot
		this.#manifest = readReleaseManifest(dataRoot)
	}

	#open(stateSlug: string): ShardCacheEntry {
		const apPath = resolveShardPath(this.#dataRoot, "address-points", stateSlug, this.#manifest)
		const ipPath = resolveShardPath(this.#dataRoot, "interpolation", stateSlug, this.#manifest)
		const ap = apPath ? new this.#factory.AddressPointSqliteLookup(apPath) : undefined
		const ip = ipPath ? new this.#factory.StreetInterpolator({ dbPath: ipPath }) : undefined

		return { addressPoints: ap, interpolation: ip, _ap: ap, _ip: ip, apPath, ipPath }
	}

	readonly for: ShardResolver = (stateSlug) => {
		if (!stateSlug) return {}
		let entry = this.#cache.get(stateSlug)

		if (!entry) {
			entry = this.#open(stateSlug)
			this.#cache.set(stateSlug, entry)
		}

		return { addressPoints: entry.addressPoints, interpolation: entry.interpolation }
	}

	/** The current data-release versions ({@link readReleaseManifest}), or null in legacy mode. */
	versions(): DataReleaseManifest | null {
		return this.#manifest ? { ...this.#manifest } : null
	}

	/**
	 * Re-read the manifest and atomically swap any cached shard whose resolved path changed. New requests see the new
	 * version immediately; the old handles are RETIRED and closed on the next reload (one-generation grace — safe because
	 * find() is synchronous, so no in-flight query can still hold a handle once a request yields). Returns the new
	 * version map.
	 */
	reload(): DataReleaseManifest | null {
		for (const h of this.#retired) h.close()
		this.#retired = []
		this.#manifest = readReleaseManifest(this.#dataRoot)

		for (const [slug, old] of this.#cache) {
			const apPath = resolveShardPath(this.#dataRoot, "address-points", slug, this.#manifest)
			const ipPath = resolveShardPath(this.#dataRoot, "interpolation", slug, this.#manifest)

			if (apPath === old.apPath && ipPath === old.ipPath) continue // unchanged — keep the open handle
			this.#cache.set(slug, this.#open(slug))

			if (old._ap) this.#retired.push(old._ap)

			if (old._ip) this.#retired.push(old._ip)
		}

		return this.versions()
	}

	close(): void {
		for (const e of this.#cache.values()) {
			e._ap?.close()
			e._ip?.close()
		}

		for (const h of this.#retired) h.close()
		this.#cache.clear()
		this.#retired = []
	}
}

/**
 * The exact parse `geocodeAddress` runs internally: Stage-1 deterministic preprocessing (`normalizeInput`) →
 * `classifier.parse` (postcodeRepair + normalizeCase) → `recognizeUSRegions`. Exposed so a caller can run it once and
 * feed the result to both {@link geocodeAddress} (via `GeocodeDeps.parsedTree`) and another consumer of the parse (e.g.
 * `decodeAsJSON(tree)` → a PostalAddress), instead of parsing the same address twice. The inference is ~3 ms/row — the
 * single most expensive step — so sharing it is a ~1.3× win on a parse-then-geocode pipeline.
 */
export async function parseForGeocode(
	input: string,
	deps: Pick<GeocodeDeps, "classifier" | "normalizeInput" | "normalizeCase">
): Promise<AddressTree> {
	const parseInput = deps.normalizeInput === false ? input : normalize(input).normalized

	return recognizeUSRegions(
		await deps.classifier.parse(parseInput, { postcodeRepair: true, normalizeCase: deps.normalizeCase ?? true })
	)
}

/**
 * Run the full street-level cascade on one address and return the structured geocode result. Always returns a result
 * (admin tier even with no coordinate shards). Throws only on a fatal parse/resolve error — callers doing batch work
 * should catch per-row.
 */
export async function geocodeAddress(input: string, deps: GeocodeDeps): Promise<GeocodeResult> {
	// Stage 1 deterministic preprocessing (GeocodeDeps.normalizeInput) — drop-ins call geocodeAddress directly with no
	// createRuntimePipeline wrapper, so without this a double-spaced / odd-punctuation query was fragile. `input` stays
	// raw for the result; the parse + placer see the normalized form. A caller-supplied `parsedTree` (from
	// parseForGeocode, same input + opts) skips the re-parse — the address's most expensive step.
	const parseInput = deps.normalizeInput === false ? input : normalize(input).normalized
	const tree = deps.parsedTree ?? (await parseForGeocode(input, deps))
	const stateSlug = regionSlugFromTree(tree)
	const usShards = deps.shards?.(stateSlug) ?? {}
	let addressPoints = usShards.addressPoints
	const interpolation = usShards.interpolation

	const opts: ResolveOpts = {}

	// Admin descendant-consistency (#263) — joint-consistency resolve over the gazetteer's containment graph.
	// Default-ON at the core resolver too since #895 (drift D1 settled); the explicit propagation here keeps
	// `deps.adminCoherence: false` an effective opt-out (an unset ResolveOpts field would otherwise re-default
	// ON downstream). Fixes the "Portland, ME → Messina IT" class structurally, without a prior or safelist.
	opts.adminCoherence = deps.adminCoherence !== false

	if (deps.defaultCountry) opts.defaultCountry = deps.defaultCountry

	if (deps.bias && deps.bias.length > 0) opts.bias = deps.bias
	// Coarse country router (#244, soft prior) — DEFAULT-ON (#244 M2). undefined → the bundled placer;
	// a function → that placer; false → disabled. A confident in-map guess feeds the resolver's
	// anchorPosterior re-rank; abstain/OTHER are no-ops and an explicit defaultCountry isn't disturbed.
	const placeCountry: PlaceCountryFn | null =
		deps.placeCountry === false ? null : (deps.placeCountry ?? (await loadDefaultPlaceCountry()))

	// The placer's country (in-map, non-OTHER) — reused below to select an OSM rooftop shard for a non-US parse.
	let placedCountry: string | null = null

	// #912 lever 1: the placer abstains on a single bare locality — OOD input, and the wrong soft
	// posterior overrides the resolver's better-informed exact-tier/population ranking (see
	// isBareLocalityTree). Explicit defaultCountry / anchorPosterior from the caller are untouched.
	if (placeCountry && !isBareLocalityTree(tree)) {
		const placed = placeCountry(parseInput)
		placedCountry = placed.country && placed.country !== "OTHER" ? placed.country : null

		if (placed.country && placed.country !== "OTHER" && !opts.anchorPosterior) {
			// The full in-map distribution when supplied (resolver breaks ties); else the one-hot argmax.
			opts.anchorPosterior = placed.posterior ?? { [placed.country]: placed.confidence }
			opts.anchorWeight = COARSE_PLACER_ANCHOR_WEIGHT
			// #743/#194: default-on coverage-guarded HARD country filter (same gate as the runtime pipeline,
			// via the shared helper so the two production paths can't drift).
			const hardCountry = hardCountryFor(
				placed.country,
				placed.confidence,
				opts,
				deps.hardPlaceCountry ?? true,
				deps.hardCountrySafelist
			)

			if (hardCountry) opts.hardCountry = hardCountry
		}
	}

	// OSM international rooftop tier (#247): only when no US situs shard matched (a non-US parse). An explicit
	// defaultCountry wins; otherwise the coarse placer's country. Bbox fall-through is ON for OSM — its points
	// often carry no postcode/locality tag, so the resolved locality's box scopes the (street, number) probe.
	if (!addressPoints) {
		const country = (deps.defaultCountry ?? placedCountry)?.toLowerCase()

		if (country && country !== "us") {
			const osm = deps.osmShards?.(country)

			if (osm?.addressPoints) {
				addressPoints = osm.addressPoints
				opts.addressPointBboxFallback = true
			}
		}
	}

	if (addressPoints) opts.addressPoints = addressPoints

	if (interpolation) {
		opts.interpolation = interpolation
		// Resolve to a single multiplier: a per-region table selects by the parsed region (`stateSlug`);
		// a bare number is used as-is (legacy single-factor / explicit caller override).
		const calibration =
			typeof deps.interpCalibration === "object"
				? interpCalibrationForRegion(deps.interpCalibration, stateSlug)
				: deps.interpCalibration

		if (calibration && calibration !== 1) {
			opts.interpolationRadiusCalibration = calibration
		}
	}

	const resolved = await deps.resolver.resolveTree(tree, opts)

	return extractGeocodeResult(input, resolved)
}

/**
 * Walk the resolved tree and extract the geocode result: the street node's address-point / interpolation coordinate
 * (whichever tier won), else the best admin centroid (locality → region → country).
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
		// `postcode` joins the ladder (after the locality tiers, before region): a lone-postcode
		// query resolves the postcode node itself — without it here the result reported 0,0 despite
		// a resolved coordinate (found building the proximity-bias feature's 48026 case).
		const adminPriority: ReadonlyArray<string> = ["locality", "dependent_locality", "postcode", "region", "country"]

		for (const tag of adminPriority) {
			const node = allNodes.find((n) => n.tag === tag && n.lat != null && n.lon != null)

			if (node) {
				lat = node.lat!
				lon = node.lon!
				break
			}
		}
	}

	const locality = allNodes.find((n) => n.tag === "locality" || n.tag === "dependent_locality")?.value?.trim() || null
	const region = allNodes.find((n) => n.tag === "region")?.value?.trim() || null
	const postcode = allNodes.find((n) => n.tag === "postcode")?.value?.trim() || null

	const HIERARCHY_TAGS = ["locality", "dependent_locality", "subregion", "region", "country"]
	const hierarchy = allNodes
		.filter((n) => HIERARCHY_TAGS.includes(n.tag) && (n.lat != null || n.placeID))
		.sort((a, b) => HIERARCHY_TAGS.indexOf(a.tag) - HIERARCHY_TAGS.indexOf(b.tag))
		.map((n) => ({
			tag: n.tag,
			value: n.value.trim(),
			...(n.lat != null ? { lat: n.lat, lon: n.lon! } : {}),
			...(n.placeID ? { placeID: n.placeID } : {}),
		}))

	return { input, lat, lon, resolution_tier: tier, uncertainty_m: uncertaintyM, locality, region, postcode, hierarchy }
}
