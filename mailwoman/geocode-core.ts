/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared street-level geocode cascade — the reusable core behind the `geocode` CLI command AND
 *   `mailwoman serve`'s `/v1/geocode` + `/v1/batch` endpoints (via `api-engine.ts`, #485). One
 *   implementation of the cascade, so the CLI and the service never drift.
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
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { hardCountryFor, isBareLocalityTree } from "@mailwoman/core/pipeline"
import { normalize } from "@mailwoman/normalize"
import { computeQueryShape, type QueryShape } from "@mailwoman/query-shape"
import type {
	AddressPointLookup,
	InterpolationLookup,
	ResolveOpts,
	Resolver,
	StreetCentroidLookup,
} from "@mailwoman/resolver"

import { type DataReleaseManifest, readReleaseManifest, resolveShardPath } from "./data-release.ts"
import { loadDefaultPlaceCountry, type PlaceCountryFn } from "./default-placer.ts"
import { interpCalibrationForRegion, type InterpCalibrationTable } from "./interp-calibration.ts"
import { recognizeUSRegions } from "./region-recognition.ts"

/**
 * The resolution tier that produced the coordinate. `address_point` > `interpolated` > `street` > `admin`.
 *
 * - `address_point` — rooftop / parcel centroid; uncertainty_m is a small floor (~1 m)
 * - `interpolated` — house-number estimate; uncertainty_m is honest (calibrated bracket span)
 * - `street` — street centroid for a street-only query (#1042); uncertainty_m is half the street's bbox diagonal
 * - `admin` — admin centroid; uncertainty_m is null (no sub-locality estimate available)
 */
export type ResolutionTier = "address_point" | "interpolated" | "street" | "admin"

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
	/**
	 * The PARSED house number + full street name (reassembled from the street subtree — prefix + base + suffix, since
	 * `street.value` alone is the bare base span), or null when the parse found neither. #1041 — lets a forward consumer
	 * that resolved to a house-number-grade coordinate (the `address_point` / `interpolated` {@link resolution_tier})
	 * render the result HOUSE-GRADE (`type: house` + `housenumber`/`street`, matching upstream Photon) instead of
	 * mislabeling a rooftop as its admin locality. Populated regardless of tier (they are the parsed spans); the consumer
	 * gates the house-grade rendering on the tier so an admin-only fallback is never dressed up as a rooftop.
	 */
	house_number: string | null
	street: string | null
	/**
	 * ISO-3166 alpha-2 of the resolved place (the gazetteer/candidate country of the deepest resolved node), or null.
	 * #1014 — lets a forward consumer fill `country`/`countrycode` without a full ancestry walk (the candidate backend
	 * carries the country code even when it has no `ancestors()` table).
	 */
	countryCode: string | null
	/**
	 * Admin hierarchy from the resolver, locality → country (most specific first). `name` is the resolved gazetteer name
	 * (proper-cased canonical, #1014) — distinct from `value`, the raw parsed input span.
	 */
	hierarchy: Array<{ tag: string; value: string; name: string; lat?: number; lon?: number; placeID?: string }>
	/**
	 * Ranked candidate resolutions for the query's primary place — the winning place first, then the resolver's
	 * same-query alternatives (Springfield MO, MA, IL, …), each with its own coordinate + country. #1016 — lets a
	 * `limit`>1 / autocomplete client return the top-N matches instead of only the single best. The order reflects any
	 * proximity `bias`; an unambiguous result yields a single entry.
	 */
	candidates: Array<{
		name: string
		tag: string
		lat: number
		lon: number
		countryCode: string | null
		placeID?: string
	}>
}

/**
 * The per-state shards to wire into a single geocode resolve. Either/both may be absent (admin-only).
 */
export interface StateShards {
	addressPoints?: AddressPointLookup
	interpolation?: InterpolationLookup
	/**
	 * Derived street-centroid tier (#1042) — a `GROUP BY street` roll-up of a national register's rooftop points, keyed
	 * for a street-only query (no house number). Supplied today only by `@mailwoman/ban`'s `BANShardProvider` for FR (the
	 * US per-state {@link ShardProvider} never opens one), so the tier is FR-only in practice and every non-FR path stays
	 * byte-stable. Consulted BELOW the address-point/interpolation tiers, ABOVE admin.
	 */
	streetCentroids?: StreetCentroidLookup
}

/** Resolve the situs/interpolation shards for a state slug (e.g. `"tx"`). `null` slug → no shards. */
export type ShardResolver = (stateSlug: string | null) => StateShards

/** The minimal classifier surface the cascade needs (a `NeuralAddressClassifier` satisfies it). */
export interface GeocodeClassifier {
	parse(
		text: string,
		opts?: { postcodeRepair?: boolean; normalizeCase?: boolean; queryShape?: QueryShape }
	): Promise<AddressTree>
}

export interface GeocodeDeps {
	classifier: GeocodeClassifier
	resolver: Resolver
	/** Per-state shard resolver. Omit for admin-only geocoding. */
	shards?: ShardResolver
	/**
	 * Authoritative national open-register rooftop shards keyed by ISO-3166 alpha-2 country (#1012) — the government
	 * address registers (BAN-FR today, 26M points). Consulted ONLY when no US per-state situs shard matched (a non-US
	 * parse), and AHEAD of {@link osmShards}: a national register is denser + coordinate-authoritative, so it outranks the
	 * community OSM fallback. Inject from `@mailwoman/ban`'s `BANShardProvider`; absent = no national tier. Licence
	 * Ouverte/Etalab (permissive) — see `ban/README.md`. The shape generalises to other national registers.
	 */
	nationalShards?: (country: string) => StateShards
	/**
	 * OSM rooftop shards keyed by ISO-3166 alpha-2 country (#247) — the opt-in international precision tier. Consulted
	 * ONLY when no US per-state situs shard matched (a non-US parse) AND no {@link nationalShards} register covered the
	 * country, so the US path is untouched and BAN wins where it exists. Inject from `@mailwoman/osm`'s
	 * `OSMShardProvider`; absent = no OSM tier. ODbL — see `osm/README.md`.
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
	 * 3.12, `default` otherwise, #584). See
	 * `docs/articles/evals/calibration/2026-06-14-interp-multiregion-recalibration.md`.
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
	 * #928: when the parsed postcode's FORMAT unambiguously implies a country ({@link POSTCODE_FORMAT_COUNTRY} — GB `E4
	 * 9AZ`, CA `K2P 1L4`), use it as the country prior IN PLACE OF the coarse placer, which conflates GB/CA with US on
	 * shared English patterns and mis-routes them to US namesakes at high confidence (London E4 → London, Ohio).
	 * **DEFAULT-ON** (promoted 2026-07-06; gate: GB 63→90% ok, CA 42→67%, US byte-identical 0/150 — the formats never
	 * match a US ZIP / NL / FR code). Only fires when no explicit `defaultCountry`. Pass `false` to opt out (the
	 * pre-promote behavior). A format is a stronger, unforgeable signal than the language model.
	 */
	postcodeCountryPrior?: boolean
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

/**
 * #928: distinctive postcode FORMATS that unambiguously indicate a country — a stronger country signal than the
 * language-based coarse placer, which conflates GB/US (both carry English street patterns) and mis-routes GB addresses
 * to US namesakes (`London E4 9AZ` → London, Ohio) at 0.94–0.96 confidence. The format is unforgeable across these
 * countries: the GB pattern (letters-first) never matches a US ZIP or an NL `\d{4} [A-Z]{2}` code. Extend ONLY with
 * formats validated as non-overlapping. Feeds the `postcodeCountryPrior` lever (gated, default-off pending its gate).
 */
const POSTCODE_FORMAT_COUNTRY: ReadonlyArray<{ readonly re: RegExp; readonly country: string }> = [
	// GB `E4 9AZ` — letters-first, ends `\d[A-Z]{2}`. Never matches a US ZIP / NL / FR / CA code.
	{ re: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i, country: "GB" },
	// CA `K2P 1L4` — `A#A #A#`, ends `\d[A-Z]\d` (distinct from GB's `\d[A-Z]{2}`). The placer conflates CA
	// with US (English) / FR (Québec) at 0.9–1.0 confidence, same failure as GB; the format is unambiguous.
	{ re: /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i, country: "CA" },
	// IE Eircode `D02 AF30` — routing key (letter + 2 digits, or the D6W special) + a 4-alnum unique part.
	// The 4-char unique part is what separates it from GB's 3-char `\d[A-Z]{2}` inward (no real-code
	// overlap; Belfast `BT1 5GS` stays GB — Northern Ireland uses GB postcodes). The placer mis-routes IE
	// 5/5 (Cork→US 0.99, Drogheda→US 1.00) — the same conflation class as GB/CA.
	{ re: /^(?:[A-Z]\d{2}|D6W)\s?[A-Z\d]{4}$/i, country: "IE" },
]

/** The country a parsed postcode's FORMAT implies, or null. See {@link POSTCODE_FORMAT_COUNTRY}. */
export function countryFromPostcodeFormat(postcode: string | undefined): string | null {
	const p = postcode?.trim()

	if (!p) return null

	for (const { re, country } of POSTCODE_FORMAT_COUNTRY) if (re.test(p)) return country

	return null
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
		for (const h of this.#retired) {
			h.close()
		}
		this.#retired = []
		this.#manifest = readReleaseManifest(this.#dataRoot)

		for (const [slug, old] of this.#cache) {
			const apPath = resolveShardPath(this.#dataRoot, "address-points", slug, this.#manifest)
			const ipPath = resolveShardPath(this.#dataRoot, "interpolation", slug, this.#manifest)

			if (apPath === old.apPath && ipPath === old.ipPath) continue // unchanged — keep the open handle
			this.#cache.set(slug, this.#open(slug))

			if (old._ap) {
				this.#retired.push(old._ap)
			}

			if (old._ip) {
				this.#retired.push(old._ip)
			}
		}

		return this.versions()
	}

	close(): void {
		for (const e of this.#cache.values()) {
			e._ap?.close()
			e._ip?.close()
		}

		for (const h of this.#retired) {
			h.close()
		}
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
	// #1002: expandAbbreviations with the locale-UNKNOWN safe set (Bd/Bvd/Av/Imp → the expanded street
	// type). The model mis-parses undertrained FR abbreviations ("2 Bd du Palais" → house_number "2 Bd",
	// which then fails the point-tier number match); the EN suffixes are deliberately NOT expanded (the
	// model is trained-robust on them, and St/Dr are ambiguous with Saint/Doctor). The locale isn't known
	// pre-parse, so only the collision-free multi-locale entries apply — see LOCALE_UNKNOWN_DICT.
	const parseInput =
		deps.normalizeInput === false ? input : normalize(input, { expandAbbreviations: true, locale: "und" }).normalized

	// #981: apply the query-shape emission prior the runtime pipeline applies (core/pipeline/runtime-pipeline.ts:336
	// `computeQueryShape` → `safeClassify` → parse with `queryShape`). Without it the geocode path — the drop-in
	// servers (nominatim/photon `/api`) + the geocode CLI — diverged from the pipeline: a detected known-format span
	// (`nl_postcode` → `B-postcode`, …) or a US region abbreviation never biased the emissions here. Computed on
	// `parseInput` (the exact text handed to the model), matching the pipeline (which computes it on the normalized
	// text, before the classifier's internal case-normalization). It is a NO-OP whenever the shape carries no known
	// format and no region abbreviation (the bare `street, city` class) — `buildEmissionPriors` returns an all-zeros
	// matrix — so both bare-form and well-formed inputs are byte-stable; it earns its keep only on the ambiguous
	// digit-span / region-abbrev cases the model isn't already confident about.
	const queryShape = computeQueryShape(parseInput)

	return recognizeUSRegions(
		await deps.classifier.parse(parseInput, {
			postcodeRepair: true,
			normalizeCase: deps.normalizeCase ?? true,
			queryShape,
		})
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
	const parseInput =
		deps.normalizeInput === false ? input : normalize(input, { expandAbbreviations: true, locale: "und" }).normalized
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

	if (deps.defaultCountry) {
		opts.defaultCountry = deps.defaultCountry
	}

	if (deps.bias && deps.bias.length > 0) {
		opts.bias = deps.bias
	}
	// Coarse country router (#244, soft prior) — DEFAULT-ON (#244 M2). undefined → the bundled placer;
	// a function → that placer; false → disabled. A confident in-map guess feeds the resolver's
	// anchorPosterior re-rank; abstain/OTHER are no-ops and an explicit defaultCountry isn't disturbed.
	const placeCountry: PlaceCountryFn | null =
		deps.placeCountry === false ? null : (deps.placeCountry ?? (await loadDefaultPlaceCountry()))

	// The placer's country (in-map, non-OTHER) — reused below to select an OSM rooftop shard for a non-US parse.
	let placedCountry: string | null = null

	// The placer's prediction, computed ONCE and UNGATED (so it's available even for a bare-locality tree, where the
	// #912 lever below deliberately withholds it from the anchor). Reused by that lever AND by the #1042 street tier's
	// country hint (a bare thoroughfare "Avenue des Champs-Élysées, Paris" is a bare-locality tree — the only reliable
	// FR signal there is this ungated placer). Byte-stable: the anchor/hardCountry logic stays gated exactly as before.
	const placerResult = placeCountry ? placeCountry(parseInput) : null
	const streetPlacerCountry =
		placerResult?.country && placerResult.country !== "OTHER" ? placerResult.country.toLowerCase() : null

	// #928: a distinctive postcode FORMAT outranks the language-based placer (which conflates GB/US → US
	// namesakes). When gated on and no explicit defaultCountry, set the country prior from the parsed
	// postcode's format; the placer block below then no-ops via its `!opts.anchorPosterior` guard. Confidence
	// 1.0 — a matched format is unambiguous. hardCountry still gates on the safelist (GB isn't on it yet, so
	// this is a soft anchorPosterior re-rank for GB — enough to de-boost the US namesakes; a safelist add
	// would make it hard, see #985).
	if (
		deps.postcodeCountryPrior !== false &&
		!opts.defaultCountry &&
		!opts.anchorPosterior &&
		!isBareLocalityTree(tree)
	) {
		const pcCountry = countryFromPostcodeFormat(decodeAsJSON(tree).postcode as string | undefined)

		if (pcCountry) {
			placedCountry = pcCountry
			opts.anchorPosterior = { [pcCountry]: 1.0 }
			opts.anchorWeight = COARSE_PLACER_ANCHOR_WEIGHT
			const hardCountry = hardCountryFor(pcCountry, 1.0, opts, deps.hardPlaceCountry ?? true, deps.hardCountrySafelist)

			if (hardCountry) {
				opts.hardCountry = hardCountry
			}
		}
	}

	// #912 lever 1: the placer abstains on a single bare locality — OOD input, and the wrong soft
	// posterior overrides the resolver's better-informed exact-tier/population ranking (see
	// isBareLocalityTree). Explicit defaultCountry / anchorPosterior from the caller are untouched.
	if (placeCountry && placerResult && !isBareLocalityTree(tree)) {
		const placed = placerResult
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

			if (hardCountry) {
				opts.hardCountry = hardCountry
			}
		}
	}

	// National open-register rooftop tier (#1012): a non-US parse first consults an authoritative government
	// address register (BAN-FR today) AHEAD of OSM — it's denser + coordinate-authoritative. Bbox
	// fall-through is ON here too (like OSM below): the register's ROWS carry postcode + commune, but the
	// QUERY often doesn't ("181 Rue du Chevaleret, Paris" — no postcode, and BAN communes are
	// INSEE-arrondissement-granular so the locality probe keys "paris" ≠ "paris 13e arrondissement"). The
	// resolved locality's box then scopes the (street, number) probe; measured safe — zero ambiguous
	// (street, number) pairs across Paris arrondissements in the 2026-05-18 BAN shard.
	if (!addressPoints) {
		const country = (deps.defaultCountry ?? placedCountry)?.toLowerCase()

		if (country && country !== "us") {
			const national = deps.nationalShards?.(country)

			if (national?.addressPoints) {
				addressPoints = national.addressPoints
				opts.addressPointBboxFallback = true
			}
		}
	}

	// OSM international rooftop tier (#247): the community fallback, only when neither a US situs shard nor a
	// national register (above) covered the country. An explicit defaultCountry wins; otherwise the coarse
	// placer's country. Bbox fall-through is ON for OSM — its points often carry no postcode/locality tag, so
	// the resolved locality's box scopes the (street, number) probe.
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

	if (addressPoints) {
		opts.addressPoints = addressPoints
	}

	// National street-centroid tier (#1042): wire the country-keyed street-centroid PROVIDER (BAN-FR today) + the
	// pre-resolution country hints so a STREET-ONLY query (no house number) — which no rooftop tier can serve — gets a
	// street-level coordinate instead of the commune centroid. The resolver's applyStreetCentroid self-gates on
	// no-house-number (a numbered query is byte-identical) and unions these hints with the RESOLVED-tree countries,
	// because the pre-resolution country of a bare thoroughfare is unreliable (bare-locality tree / placer mis-route).
	// US never supplies a street shard, so `provider("us")` is undefined and the US path stays byte-stable.
	if (deps.nationalShards) {
		const provider = deps.nationalShards

		opts.streetCentroids = (country: string) => provider(country).streetCentroids
		const hints: string[] = []

		for (const c of [deps.defaultCountry?.toLowerCase(), placedCountry?.toLowerCase(), streetPlacerCountry]) {
			if (c && !hints.includes(c)) {
				hints.push(c)
			}
		}

		if (hints.length > 0) {
			opts.streetCountryHints = hints
		}
	}

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
 * Street-name component tags — the name-bearing subtree of a `street` node (`street.value` alone is the bare base:
 * "Sheldon" for "East Sheldon Rd"). Mirrors the resolver's `assembleStreetValue`; used to surface the FULL parsed
 * street on the result so a house-grade forward consumer renders "Boulevard du Palais", not just "Palais". #1041.
 */
const STREET_NAME_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/** Reassemble the full parsed street name from a street node's name-bearing subtree, ordered by span offset. #1041. */
function assembleStreetName(streetNode: AddressNode): string {
	const parts: AddressNode[] = []
	const stack = [streetNode]

	while (stack.length > 0) {
		const n = stack.pop()!

		if (STREET_NAME_TAGS.has(n.tag) && n.value.trim()) {
			parts.push(n)
		}
		stack.push(...n.children)
	}
	parts.sort((a, b) => a.start - b.start)

	return parts.map((n) => n.value.trim()).join(" ")
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

	// Street-centroid tier (#1042): below rooftop/interp, above admin. Only reached for a street-only query the
	// exact tiers couldn't serve (they require a house number), so this never displaces a rooftop coordinate.
	if (tier !== "address_point" && tier !== "interpolated" && streetNode?.metadata?.["resolution_tier"] === "street") {
		const sc = streetNode.metadata["street_centroid"] as { lat: number; lon: number } | undefined

		if (sc) {
			lat = sc.lat
			lon = sc.lon
			tier = "street"
			uncertaintyM = (streetNode.metadata["uncertainty_m"] as number | undefined) ?? null
		}
	}

	if (tier === "admin") {
		// `postcode` joins the ladder (after the locality tiers, before region): a lone-postcode
		// query resolves the postcode node itself — without it here the result reported 0,0 despite
		// a resolved coordinate (found building the proximity-bias feature's 48026 case).
		//
		// #977: EXCEPT when the resolved postcode is a full NL PC6 EXACT hit — a PC6 is street-block-class
		// (avg ~8 addresses; the CBS polygon centroid), categorically tighter than any locality centroid,
		// so it leads the ladder. Guarded three ways so the locality-first epoch convention (adopted for
		// FR, where 5-digit zone centroids are COARSER than communes) is untouched everywhere else:
		// (1) the parsed text is the full NL shape (`1012 LG`), (2) the node resolved, and (3) the
		// resolver's hit is the FULL code, not the 4-digit-stem fallback (the stem is area-class — the
		// lookup ladder can coarsen to it, and a stem hit must NOT outrank the locality).
		const pcNode = allNodes.find((n) => n.tag === "postcode" && n.lat != null && n.lon != null)
		const alnum = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase()
		const pc6Exact =
			pcNode !== undefined &&
			/^\d{4}\s?[A-Z]{2}$/i.test(pcNode.value.trim()) &&
			alnum(String(pcNode.metadata?.["resolver_name"] ?? "")) === alnum(pcNode.value)
		const adminPriority: ReadonlyArray<string> = pc6Exact
			? ["postcode", "locality", "dependent_locality", "region", "country"]
			: ["locality", "dependent_locality", "postcode", "region", "country"]

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

	// #1041: the parsed house number + full street name, so a house-grade forward consumer (photon `/api`) can decorate a
	// rooftop / interpolated result with `housenumber`/`street` (matching upstream Photon) instead of the admin locality.
	const houseNumber = allNodes.find((n) => n.tag === "house_number")?.value?.trim() || null
	const street = streetNode ? assembleStreetName(streetNode) || null : null

	const HIERARCHY_TAGS = ["locality", "dependent_locality", "subregion", "region", "country"]
	const hierarchy = allNodes
		.filter((n) => HIERARCHY_TAGS.includes(n.tag) && (n.lat != null || n.placeID))
		.sort((a, b) => HIERARCHY_TAGS.indexOf(a.tag) - HIERARCHY_TAGS.indexOf(b.tag))
		.map((n) => ({
			tag: n.tag,
			value: n.value.trim(),
			// The resolver stamps the gazetteer's canonical name (proper casing) on `resolver_name`; fall back to the raw
			// parsed span when a node resolved without one. #1014: consumers should DISPLAY this, not `value`.
			name: (n.metadata?.["resolver_name"] as string | undefined)?.trim() || n.value.trim(),
			...(n.lat != null ? { lat: n.lat, lon: n.lon! } : {}),
			...(n.placeID ? { placeID: n.placeID } : {}),
		}))

	// #1014: the resolved ISO-3166 alpha-2 country (`resolver_country`, stamped by decorateNode). Same for every
	// resolved node of one address, so the first that carries it wins.
	let countryCode: string | null = null

	for (const n of allNodes) {
		const c = (n.metadata?.["resolver_country"] as string | undefined)?.trim()

		if (c) {
			countryCode = c.toUpperCase()
			break
		}
	}

	// #1016: ranked candidate places for the winning result — the resolved primary node (self) plus its
	// `alternatives` (the resolver's same-query runner-ups, already ranked and bias-aware). Each is a distinct place
	// with its own coordinate, so an ambiguous name (Springfield MO/MA/IL) returns all its instances for limit>1.
	// The primary is the resolved node whose coordinate WON (else the first resolved admin node — a bare-name query).
	const primaryNode =
		allNodes.find((n) => n.metadata?.["resolver_name"] && n.lat === lat && n.lon === lon) ??
		allNodes.find((n) => n.metadata?.["resolver_name"] && n.lat != null)
	const candidates: GeocodeResult["candidates"] = []

	if (primaryNode?.lat != null) {
		// Collapse same-point duplicates (a city + its coincident township share a centroid): two places at one
		// coordinate are not distinct autocomplete suggestions. ~11 m grid (4 decimals) keeps genuinely distinct
		// namesakes (Springfield MA vs IL are far apart) while dropping the variants.
		const seen = new Set<string>()
		const coordKey = (lt: number, ln: number): string => `${lt.toFixed(4)},${ln.toFixed(4)}`
		seen.add(coordKey(primaryNode.lat, primaryNode.lon!))
		candidates.push({
			name: (primaryNode.metadata?.["resolver_name"] as string | undefined)?.trim() || primaryNode.value.trim(),
			tag: primaryNode.tag,
			lat: primaryNode.lat,
			lon: primaryNode.lon!,
			countryCode: (primaryNode.metadata?.["resolver_country"] as string | undefined)?.trim()?.toUpperCase() ?? null,
			...(primaryNode.placeID ? { placeID: primaryNode.placeID } : {}),
		})

		const alts =
			(primaryNode.alternatives as
				| ReadonlyArray<{
						name?: string
						placetype?: string
						lat?: number
						lon?: number
						country?: string
						id?: number | string
				  }>
				| undefined) ?? []

		for (const a of alts) {
			if (a.lat == null || a.lon == null || !a.name) continue
			const key = coordKey(a.lat, a.lon)

			if (seen.has(key)) continue
			seen.add(key)
			candidates.push({
				name: String(a.name).trim(),
				tag: a.placetype ?? primaryNode.tag,
				lat: a.lat,
				lon: a.lon,
				countryCode: a.country ? String(a.country).trim().toUpperCase() : null,
				...(a.id != null ? { placeID: `wof:${a.id}` } : {}),
			})
		}
	}

	return {
		input,
		lat,
		lon,
		resolution_tier: tier,
		uncertainty_m: uncertaintyM,
		locality,
		region,
		postcode,
		house_number: houseNumber,
		street,
		countryCode,
		hierarchy,
		candidates,
	}
}
