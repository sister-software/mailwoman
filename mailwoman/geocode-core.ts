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

import { isUnitGradePostcodeHit } from "@mailwoman/codex"
import type { ComponentTag } from "@mailwoman/core"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import {
	deriveInputMode,
	type InputMode,
	type ClassifierOpts,
	hardCountryFor,
	isBareLocalityTree,
	isBarePostcodeTree,
	type QueryIntentMarker,
	WORD_CONSISTENCY_SHIP_DEFAULT,
} from "@mailwoman/core/pipeline"
import { countriesFromPostcodeFormat, countryFromPostcodeFormat } from "@mailwoman/core/resolver"
import { classifyKindSync } from "@mailwoman/kind-classifier"
import { normalize } from "@mailwoman/normalize"
import { computeQueryShape, type QueryShape } from "@mailwoman/query-shape"
import type {
	AddressPointLookup,
	InterpolationLookup,
	PostcodePrefixIndexLike,
	ResolveOpts,
	Resolver,
	StreetCentroidLookup,
} from "@mailwoman/resolver"

import { type DataReleaseManifest, readReleaseManifest, resolveShardPath } from "./data-release.ts"
import { loadDefaultPlaceCountry, type PlaceCountryFn } from "./default-placer.ts"
import { probeForkEntity } from "./fork-entity.ts"
import { interpCalibrationForRegion, type InterpCalibrationTable } from "./interp-calibration.ts"
import { declaredAmbiguityMarker } from "./query-intent.ts"
import { recognizeUSRegions } from "./region-recognition.ts"

export { isUnitGradePostcodeHit, UNIT_GRADE_POSTCODE } from "@mailwoman/codex"

export {
	countriesFromPostcodeFormat,
	countryFromPostcodeFormat,
	POSTCODE_FORMAT_COUNTRY,
} from "@mailwoman/core/resolver"

/**
 * The resolution tier that produced the coordinate. `address_point` > `interpolated` > `street` > `admin`.
 *
 * - `address_point` — rooftop / parcel centroid; uncertainty_m is a small floor (~1 m)
 * - `interpolated` — house-number estimate; uncertainty_m is honest (calibrated bracket span)
 * - `street` — street centroid for a street-only query (#1042); uncertainty_m is half the street's bbox diagonal
 * - `admin` — admin centroid; uncertainty_m is null (no sub-locality estimate available)
 */
export type ResolutionTier = "address_point" | "interpolated" | "street" | "admin" | "venue"

export interface GeocodeResult {
	input: string
	/**
	 * Every parsed component, projected directly from the resolved tree. The named fields below remain the stable,
	 * convenience surface (and `street` remains reassembled), while this map keeps locale-specific schema such as JP's
	 * `prefecture` / `block` observable instead of silently dropping it at the geocoder boundary.
	 */
	components: Partial<Record<ComponentTag, string>>
	lat: number | null
	lon: number | null
	resolution_tier: ResolutionTier
	/**
	 * The entity the fork→entity probe resolved (#1585's entity half) — present ONLY when the `venue` tier answered: the
	 * decoder declared a fork, the incumbent path produced no coordinate, and exactly one poi.db entity bears the query's
	 * exact name (see `fork-entity.ts` for the three gates). Positive evidence only; absent everywhere else.
	 */
	entity?: { name: string; categoryID: string | null; confidence: number; country: string }
	/**
	 * Uncertainty radius in meters. null for the admin tier.
	 */
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
	 * The PARSED venue span (same #1041 posture as house_number/street: populated regardless of tier, straight from the
	 * parse). Surfaced 2026-08-01 — the gauntlet's venue expectations had graded against nothing for their whole life
	 * because no result field carried the span (hierarchy filters to admin tags).
	 */
	venue: string | null
	/**
	 * The PARSED dependent-locality span (#1041 posture: the parse view, populated regardless of resolution). Distinct
	 * from `hierarchy`, which is the RESOLVED view — it only admits nodes the resolver decorated (lat/placeID), so a
	 * parsed-but-unresolved dependent locality (Abbey Hey with no gazetteer hit) never appears there. Surfaced 2026-08-01
	 * (hierarchy campaign R1) after the gauntlet's dep-loc expectations were found reading the resolved view.
	 */
	dependent_locality: string | null
	/**
	 * The PARSED unit / sub-venue span (#1041 posture, same as `venue` above: the parse view, populated regardless of
	 * tier) — `Terminal 5`, `Suite 300`, `Gate 12`.
	 *
	 * Surfaced 2026-08-05 for the same reason `venue` was in 2026-08-01, and found the same way: the gauntlet's sub-venue
	 * cases (added 2026-08-01) assert `unit`, no result field carried it, and `componentOf`'s deliberately-loud
	 * unknown-key throw meant the whole regression layer died the moment the corpus was rebuilt from its own seed. The
	 * committed corpus had been ungradeable since the day those cases landed; only the staleness of the built artifact
	 * hid it.
	 */
	unit: string | null
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
	/**
	 * The country #42's postcode-country coherence pass scoped the walk to, or null. Non-null ONLY when the pass actually
	 * overrode {@link GeocodeDeps.defaultCountry} — off, abstained and agreed-with-the-default all read null.
	 *
	 * This is the FIRING RECEIPT, and it exists because the alternative is unreadable evidence. A gate run with the lever
	 * OFF and one with it ON can come back identical for two opposite reasons: the mechanism ran on every row and changed
	 * nothing (the result worth having), or it never ran at all (the 2026-08-04 oa-resolver trap, where an identical 1.94
	 * MB dump turned out to mean the eval's shard set carried no US postcodes). A magnitude never carries its own
	 * absence, so the pass reports its own count instead of leaving the reader to infer it.
	 */
	postcode_country_scope: string | null
	/**
	 * Query-intent advisories (ROAD_TO_V9 §4) — what the intent vocabulary had to say about the QUESTION, alongside the
	 * answer. **Always present**; an empty array is this path stating that the vocabulary looked and found nothing, which
	 * is a different claim from a missing field (the {@link `PipelineResult.faults`} discipline).
	 *
	 * Nothing here changed the answer. Three of the four markers are raised by the kind classifier from the string alone;
	 * the fourth (`declared_ambiguity`) is raised after the resolve by reading the ranked candidate list's dominance
	 * margin and comparing it to the measured 0.5-log10 decisive cut — a read, never a re-rank. This is the same
	 * narrow-channel posture {@link postcode_country_scope} set: an advisory RECEIPT inside a resolution contract, not a
	 * second opinion about the result.
	 */
	intent_markers: QueryIntentMarker[]
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

/**
 * Resolve the situs/interpolation shards for a state slug (e.g. `"tx"`). `null` slug → no shards.
 */
export type ShardResolver = (stateSlug: string | null) => StateShards

/**
 * The minimal classifier surface the cascade needs (a `NeuralAddressClassifier` satisfies it).
 */
export interface GeocodeClassifier {
	parse(
		text: string,
		opts?: {
			postcodeRepair?: boolean
			normalizeCase?: boolean
			queryShape?: QueryShape
			inputMode?: InputMode
			enforceWordConsistency?: ClassifierOpts["enforceWordConsistency"]
		}
	): Promise<AddressTree>
}

export interface GeocodeDeps {
	/**
	 * Poi.db reader for the fork→entity probe (`fork-entity.ts`). Absent = the probe never runs (tolerate-and-degrade,
	 * like every optional artifact). Both this AND {@link isStreetGeneric} are required for a probe.
	 */
	poiLookup?: import("./poi-executor.ts").POIExecutorLookup
	/**
	 * Street-morphology token test (the #1315 gate's matcher) — gate 2 of the fork→entity probe. Absent = no probe: an
	 * ungated probe is the Savile Row hijack, so degrading the guard degrades the whole mechanism, never just the guard.
	 */
	isStreetGeneric?: (token: string) => boolean
	/**
	 * True when {@link defaultCountry} was INFERRED from the locale rather than user-declared. The street-miss fallback
	 * retries a mis-tagged bare toponym as a locality, and a bare-locality retry must run under the #912 posture — the
	 * inferred scope withheld — while an EXPLICIT scope stays supreme. Only the caller knows which; the CLI threads it.
	 */
	defaultCountryIsInferred?: boolean
	classifier: GeocodeClassifier
	resolver: Resolver
	/**
	 * Explicit input register (Decision A / GTM B10 — canonical docs on `@mailwoman/core/pipeline`'s `InputMode`). Unset
	 * → derived per parse from the kind classifier's verdict. Endpoint wrappers set their register default here
	 * (`/v1/batch` + CSV → `"formatted"`, autocomplete drop-ins → `"fragmented"`).
	 */
	inputMode?: InputMode
	/**
	 * The Decision-A retry rider (operator-specced 2026-07-28): when a geocode ZERO-HITS (no coordinate AND no
	 * candidates), re-parse ONCE in the alternative register and re-resolve. Fires only when the register was DERIVED (an
	 * explicit {@link inputMode} is never second-guessed) and never loops. Default ON; pass `false` to pin single-pass
	 * behavior.
	 */
	retryAlternateRegister?: boolean
	/**
	 * Per-state shard resolver. Omit for admin-only geocoding.
	 */
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
	/**
	 * Country constraint passed to the resolver (e.g. `"US"`).
	 */
	defaultCountry?: string
	/**
	 * #27 — the LOCALE's country as a SOFT ranking prior (`ResolveOpts.localeCountryPrior`), for the query shape where
	 * {@link defaultCountry} is deliberately withheld: a bare toponym.
	 *
	 * The #912 guard in `mailwoman/commands/geocode.tsx` drops the locale-inferred country for a bare-locality tree,
	 * because as a HARD filter it is a disaster (`--locale en-US "Zürich"` scoped to US answers Zurich, Kansas). What it
	 * does NOT do is hand the country down in a form that cannot filter — so `--locale en-GB "Whitby"` and
	 * `--default-country GB "Whitby"` disagree, and only the second is gold. This field is that form.
	 *
	 * Ignored when {@link defaultCountry} is set (a hard scope makes the prior a no-op), and OPT-IN at the CLI — see
	 * `ResolveOpts.localeCountryPrior` for the measured reason it is not a default.
	 */
	localeCountryPrior?: string
	/**
	 * Weight of {@link localeCountryPrior} in log10(population + 1). Default 2 at the resolver.
	 */
	localeCountryPriorWeight?: number
	/**
	 * #1585 — the locale hint's country, scoping the backend's TYPO-FUZZY tier only (`ResolveOpts.fuzzyCountryScope`).
	 * Unlike {@link localeCountryPrior} this is NOT opt-in and NOT a ranking prior: exact matches stay worldwide, a typo
	 * CORRECTION stays inside the hinted country, and a scoped-empty correction abstains instead of falling through to a
	 * world-fuzzy candidate. Threaded even when {@link defaultCountry} is set (harmless — the hard scope is already
	 * narrower).
	 */
	fuzzyCountryScope?: string
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
	 * Interpolation-radius conformal calibration (#374) so reported radii are an honest ~90% bound. The multiplier is a
	 * property of the calibration set the ARTIFACT was built against, so a shard that carries one in its
	 * `interp_calibration` metadata table is self-calibrating (`InterpolationLookup.radiusCalibration`, read at shard
	 * open — the pair-index δ precedent) and this option is not consulted for it. The two remaining roles:
	 *
	 * - A per-region {@link InterpCalibrationTable} — the LEGACY-SHARD fallback, selected by the parsed region (DC 1.44 …
	 *   AZ 3.12, `default` otherwise, #584), applied only when the shard predates the metadata table (the artifact is
	 *   silent).
	 * - A single number — an explicit instrument override forced everywhere, artifact value included (the CLI's
	 *   `--interp-calibration`). `1` or `undefined` + artifact-silent keeps the raw half-segment heuristic.
	 *
	 * See `docs/articles/evals/calibration/2026-06-14-interp-multiregion-recalibration.md`.
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
	/**
	 * #743/#194: override the coverage safelist gating {@link hardPlaceCountry}. Undefined → the loaded gazetteer
	 * artifact's own coverage manifest when it carries one, else the built-in constant (the fallback for artifacts
	 * predating the manifest).
	 */
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
	/**
	 * Postcode-country coherence (#42, `ResolveOpts.postcodeCountryCoherence`) — let a (postcode, locality) pair that is
	 * geographically consistent in exactly ONE country override a wrong {@link defaultCountry}. `12 Rue de Rivoli, 75001
	 * Paris` under the en-US locale otherwise lands in Texas, and with the postal shards attached in Addison. **Default
	 * ON** (operator-promoted 2026-08-05 — gauntlet zero newly-failing gated cases pinned either way, 56,000 pair
	 * evaluations across both backends at zero false positives; see
	 * `docs/records/evals/2026-08-05-postcode-coherence-default-on-evidence.md`). Pass `false` to opt out.
	 *
	 * On this path it also re-selects the rooftop tier. Shard selection happens BEFORE the resolve and keys off
	 * `defaultCountry ?? placedCountry`, so a US-scoped call would pick no national/OSM shard and leave the corrected FR
	 * address at its commune centroid. When the resolver reports an override (the `postcode_country_scope` stamp), the
	 * rooftop/street shards are re-selected for the corrected country and the tree is resolved ONCE more. Self-gating:
	 * the second pass costs nothing unless an override actually fired.
	 */
	postcodeCountryCoherence?: boolean
	/**
	 * Postcode-shape coherence (#31, Mechanism 1, `ResolveOpts.postcodeShapeCoherence`) — shape as confidence and
	 * EXCLUSION: a postcode span whose codex shape intersects NO confident sibling system is demoted (digit-only →
	 * `house_number`; letter-bearing → stamped `postcode_shape_excluded`). **Default OFF** — demotion is the failure mode
	 * with teeth; pass `true` to opt in (the pre-registered B1 gate set lives in
	 * `resolver/postcode-shape-coherence.ts`).
	 */
	postcodeShapeCoherence?: boolean
	/**
	 * Postcode-containment coherence (#31, Mechanism 2, `ResolveOpts.postcodeContainmentCoherence`) — re-rank locality
	 * candidates by proximity to the postcode's own centroid (25 km gate, the same value the country pass measures at).
	 * **Default OFF**; pass `true` to opt in.
	 */
	postcodeContainmentCoherence?: boolean
	/**
	 * Postcode-prefix prior (#31, Mechanism 3, `ResolveOpts.postcodePrefixPrior` + `.postcodePrefixIndex`) — on a
	 * `postalcode` miss, resolve the code's PREFIX from the injected PFX1 index (GB outward / US section) so an
	 * ungazetted unit still contributes its district + centroid. **Default OFF** (the PCN1 posture — data + loader +
	 * offline probe, no decode wiring); pass `true` plus the index to opt in.
	 */
	postcodePrefixPrior?: boolean
	/**
	 * The PFX1 postcode-prefix index to probe (structural — `PostcodePrefixIndexLike`, core/resolver/types.ts; the loader
	 * is `@mailwoman/neural/postcode-prefix-index.ts`). Only consulted when `postcodePrefixPrior` is on.
	 */
	postcodePrefixIndex?: PostcodePrefixIndexLike
}

/**
 * Anchor weight for the coarse-placer's country prior. Matches the runtime-pipeline default — a whole-string country
 * guess is broader/softer than a postcode anchor (2.0), so it blends gently.
 */
const COARSE_PLACER_ANCHOR_WEIGHT = 1

/**
 * The first `postcode` node's value in a parsed tree, or undefined.
 */
export function treePostcodeValue(tree: AddressTree): string | undefined {
	const stack = [...tree.roots]

	while (stack.length) {
		const node = stack.pop()!

		if (node.tag === "postcode") return node.value

		stack.push(...node.children)
	}

	return undefined
}

/**
 * Retag a WHOLE-INPUT span the model read as something else when the string is an unambiguous postcode — the
 * bare-postcode class (#22).
 *
 * `mailwoman geocode --locale en-GB "N7 0BT"` parses to `{ street: "N7 0BT" }` and returns no coordinate, while the
 * same code inside a full address (`… London, N7 0BT`) parses as a postcode and resolves to a point 38 m from the
 * rooftop. Nothing downstream can recover it: the walk only looks up a `postcode` node, and span-rescore's
 * confident-constituent guard treats the street span as un-recoverable material (correctly — that guard is what stops
 * "Ave" resolving to Ave, France).
 *
 * The gate is deliberately the narrowest one that fixes the class:
 *
 * - The tree carries NO postcode node already (never second-guess a parse that found one),
 * - The retagged node is the ONLY value-bearing node in the tree, and
 * - Its value matches a format that is UNFORGEABLE across the systems we resolve ({@link POSTCODE_FORMAT_COUNTRY} —
 *   GB/CA/IE, the same table #928 already trusts to name a country outright).
 *
 * So it fires on `N7 0BT` and `K2P 1L4` and on nothing that is also a plausible street, venue or city name. A US ZIP is
 * out of scope by construction: `90210` alone is five digits, which the model already tags `postcode`, and the format
 * table would not distinguish it from a DE PLZ anyway.
 *
 * Mutates and returns the tree (same posture as `recognizeUSRegions`).
 */
export function recognizeBarePostcode(tree: AddressTree): AddressTree {
	const valued: AddressNode[] = []
	const stack = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!

		// The parse already found a postcode — never second-guess it.
		if (n.tag === "postcode") return tree

		if (n.value.trim().length) {
			valued.push(n)
		}

		stack.push(...n.children)
	}

	if (valued.length !== 1) return tree
	const only = valued[0]!

	if (!countryFromPostcodeFormat(only.value)) return tree
	only.tag = "postcode"

	only.metadata = { ...only.metadata, bare_postcode_retag: true }

	return tree
}

/**
 * Lowercase 2-letter state slug from a parsed region value / resolver name, else null.
 */
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

	while (stack.length) {
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

/**
 * Per-state interpolation shard path under `<dataRoot>/interpolation/`, or null if absent.
 */
export function selectInterpolationDB(dataRoot: string, stateSlug: string | null): string | null {
	if (!stateSlug) return null
	const candidate = `${dataRoot}/interpolation/interpolation-us-${stateSlug}.db`

	return existsSync(candidate) ? candidate : null
}

/**
 * The lookup-class surface a {@link ShardProvider} needs from `@mailwoman/resolver-wof-sqlite`.
 */
export interface ShardLookupFactory {
	AddressPointSqliteLookup: new (dbPath: string) => AddressPointLookup & { close(): void }
	StreetInterpolator: new (opts: { dbPath: string }) => InterpolationLookup & { close(): void }
}

interface ShardCacheEntry extends StateShards {
	_ap?: { close(): void }
	_ip?: { close(): void }
	/**
	 * The resolved on-disk paths this entry was opened from — reload() diffs against these.
	 */
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
	/**
	 * Previous-generation handles, retired by reload() and closed on the NEXT reload (one-gen grace).
	 */
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

	/**
	 * The current data-release versions ({@link readReleaseManifest}), or null in legacy mode.
	 */
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
 * `classifier.parse` (postcodeRepair + normalizeCase) → `recognizeUSRegions` → {@link recognizeBarePostcode}. Exposed
 * so a caller can run it once and feed the result to both {@link geocodeAddress} (via `GeocodeDeps.parsedTree`) and
 * another consumer of the parse (e.g. `decodeAsJSON(tree)` → a PostalAddress), instead of parsing the same address
 * twice. The inference is ~3 ms/row — the single most expensive step — so sharing it is a ~1.3× win on a
 * parse-then-geocode pipeline.
 */
/**
 * The kind-derived register for a geocode input (Decision A) — shared by the parse and the retry rider.
 */
export function deriveGeocodeRegister(parseInput: string, queryShape = computeQueryShape(parseInput)): InputMode {
	return deriveInputMode(classifyKindSync({ raw: parseInput, normalized: parseInput }, queryShape).kind)
}

export async function parseForGeocode(
	input: string,
	deps: Pick<GeocodeDeps, "classifier" | "normalizeInput" | "normalizeCase" | "inputMode">
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

	// Decision A: explicit register wins; otherwise the kind verdict decides (same derivation as the
	// runtime pipeline — the drop-ins + geocode CLI reach parse through HERE, not runPipeline).
	const inputMode = deps.inputMode ?? deriveGeocodeRegister(parseInput, queryShape)

	// #22: a bare unambiguous postcode the model read as a street ("N7 0BT" → `{ street: … }`) is retagged
	// before the resolve — see recognizeBarePostcode for why nothing downstream can recover it.
	return recognizeBarePostcode(
		recognizeUSRegions(
			await deps.classifier.parse(parseInput, {
				postcodeRepair: true,
				normalizeCase: deps.normalizeCase ?? true,
				queryShape,
				inputMode,
				// Word-consistency heal on by default (2026-07-15) — semantics in neural/word-consistency.ts.
				enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			})
		)
	)
}

/**
 * Run the full street-level cascade on one address and return the structured geocode result. Always returns a result
 * (admin tier even with no coordinate shards). Throws only on a fatal parse/resolve error — callers doing batch work
 * should catch per-row.
 */
export async function geocodeAddress(input: string, deps: GeocodeDeps): Promise<GeocodeResult> {
	const result = await geocodeAddressOnce(input, deps)

	// Decision-A retry rider: a ZERO-HIT (no coordinate, no candidates) in a DERIVED register earns one
	// attempt in the alternative register — a misrouted fragment/record can resolve on the flip; a
	// second miss returns the original result. Explicit registers and caller-supplied trees are never
	// second-guessed; the retry itself passes an explicit mode, so it cannot recurse.
	const zeroHit = result.lat == null && result.candidates.length === 0

	if (
		zeroHit &&
		deps.retryAlternateRegister !== false &&
		deps.inputMode === undefined &&
		deps.parsedTree === undefined
	) {
		const parseInput =
			deps.normalizeInput === false ? input : normalize(input, { expandAbbreviations: true, locale: "und" }).normalized

		const used = deriveGeocodeRegister(parseInput)
		const flipped: InputMode = used === "formatted" ? "fragmented" : "formatted"
		const retried = await geocodeAddressOnce(input, { ...deps, inputMode: flipped })

		if (retried.lat != null || retried.candidates.length) return retried
	}

	return result
}

async function geocodeAddressOnce(input: string, deps: GeocodeDeps): Promise<GeocodeResult> {
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

	const opts: ResolveOpts = {
		// Admin descendant-consistency (#263) — joint-consistency resolve over the gazetteer's containment
		// graph. Default-ON at the core resolver too since #895 (drift D1 settled); the explicit propagation
		// here keeps `deps.adminCoherence: false` an effective opt-out (an unset ResolveOpts field would
		// otherwise re-default ON downstream). Fixes the "Portland, ME → Messina IT" class structurally,
		// without a prior or safelist.
		adminCoherence: deps.adminCoherence !== false,
	}

	if (deps.defaultCountry) {
		opts.defaultCountry = deps.defaultCountry
	}

	// #1589: the parsed postcode's format-implied countries, for the resolver's scoped `postalcode`
	// probe. Threaded unconditionally — the resolver applies it ONLY when no country constraint
	// survives, which keeps an explicit defaultCountry supreme over format evidence, which in turn
	// outranks a locale hint (the withheld-scope path in the CLI).
	{
		const formatCountries = countriesFromPostcodeFormat(treePostcodeValue(tree))

		if (formatCountries.length) {
			opts.postcodeFormatCountries = formatCountries
		}
	}

	// #1585: the locale hint's country scopes the typo-fuzzy tier — always threaded, never a filter on
	// exact matches (the backend's fuzzy block is the only consumer).
	if (deps.fuzzyCountryScope) {
		opts.fuzzyCountryScope = deps.fuzzyCountryScope
	}

	// #27: the locale country as a SOFT prior, only where no hard scope is in force. Nothing else in the
	// cascade is disturbed — the resolver ignores it under a `defaultCountry` or an `anchorPosterior`.
	if (deps.localeCountryPrior && !opts.defaultCountry) {
		opts.localeCountryPrior = deps.localeCountryPrior

		if (deps.localeCountryPriorWeight !== undefined) {
			opts.localeCountryPriorWeight = deps.localeCountryPriorWeight
		}
	}

	if (deps.bias && deps.bias.length) {
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
			opts.anchorPosterior = { [pcCountry]: 1 }
			opts.anchorWeight = COARSE_PLACER_ANCHOR_WEIGHT

			// Safelist precedence (survey candidate #2): per-call override (the eval instrument) → the loaded
			// gazetteer artifact's own coverage manifest → the code-constant fallback inside hardCountryFor.
			const hardCountry = hardCountryFor(
				pcCountry,
				1,
				opts,
				deps.hardPlaceCountry ?? true,
				deps.hardCountrySafelist ?? deps.resolver.artifactCoverage?.hardCountrySafelist
			)

			if (hardCountry) {
				opts.hardCountry = hardCountry
			}
		}
	}

	// #912 lever 1: the placer abstains on a single bare locality — OOD input, and the wrong soft
	// posterior overrides the resolver's better-informed exact-tier/population ranking (see
	// isBareLocalityTree). Explicit defaultCountry / anchorPosterior from the caller are untouched.
	// #1589 extends the abstention to a bare POSTCODE: the placer's language model reading `SW1A 1AA`
	// as English placed US at safelist confidence, and the resulting hardCountry filtered the GB row
	// out before the format-implied probe could run. The code's own format says more than its script.
	if (placeCountry && placerResult && !isBareLocalityTree(tree) && !isBarePostcodeTree(tree)) {
		const placed = placerResult
		placedCountry = placed.country && placed.country !== "OTHER" ? placed.country : null

		if (placed.country && placed.country !== "OTHER" && !opts.anchorPosterior) {
			// The full in-map distribution when supplied (resolver breaks ties); else the one-hot argmax.
			opts.anchorPosterior = placed.posterior ?? { [placed.country]: placed.confidence }
			opts.anchorWeight = COARSE_PLACER_ANCHOR_WEIGHT

			// #743/#194: default-on coverage-guarded HARD country filter (same gate as the runtime pipeline,
			// via the shared helper so the two production paths can't drift). Same safelist precedence as
			// above: per-call override → the artifact's coverage manifest → the code-constant fallback.
			const hardCountry = hardCountryFor(
				placed.country,
				placed.confidence,
				opts,
				deps.hardPlaceCountry ?? true,
				deps.hardCountrySafelist ?? deps.resolver.artifactCoverage?.hardCountrySafelist
			)

			if (hardCountry) {
				opts.hardCountry = hardCountry
			}
		}
	}

	// Rooftop tier for a NON-US parse, in precedence order:
	//
	//   1. National open-register (#1012) — an authoritative government address register (BAN-FR today), denser +
	//      coordinate-authoritative, so it goes AHEAD of OSM.
	//   2. OSM (#247) — the community fallback, only when no national register covered the country.
	//
	// Bbox fall-through is ON for both: the rows carry postcode + commune but the QUERY often doesn't ("181 Rue du
	// Chevaleret, Paris" — no postcode, and BAN communes are INSEE-arrondissement-granular so the locality probe keys
	// "paris" ≠ "paris 13e arrondissement"). The resolved locality's box then scopes the (street, number) probe;
	// measured safe — zero ambiguous (street, number) pairs across Paris arrondissements in the 2026-05-18 BAN shard.
	//
	// Factored into a function because #42's postcode-country coherence can correct the country AFTER the resolve, and
	// the corrected country then needs the same selection re-run (see the second pass at the bottom).
	const rooftopFor = (country: string | undefined): AddressPointLookup | undefined => {
		if (!country || country.toLowerCase() === "us") return undefined
		const slug = country.toLowerCase()

		return deps.nationalShards?.(slug)?.addressPoints ?? deps.osmShards?.(slug)?.addressPoints
	}

	// An explicit defaultCountry wins; otherwise the coarse placer's country.
	const preResolveCountry = (deps.defaultCountry ?? placedCountry)?.toLowerCase()

	// A NON-US pre-resolve country outranks a US state-slug shard match. The state-slug selection
	// above is country-blind, and AU state codes collide with US postal states — 'Kingsley WA 6026'
	// under an AU scope reads region 'WA' and opens the Washington shard, which can only miss.
	// `rooftopFor` returns nothing for `us` or no-evidence, so the US path is byte-stable.
	{
		const rooftop = rooftopFor(preResolveCountry)

		if (rooftop) {
			addressPoints = rooftop
			opts.addressPointBboxFallback = true
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
	const streetHints: string[] = []

	if (deps.nationalShards) {
		const provider = deps.nationalShards

		opts.streetCentroids = (country: string) => provider(country).streetCentroids

		for (const c of [deps.defaultCountry?.toLowerCase(), placedCountry?.toLowerCase(), streetPlacerCountry]) {
			if (c && !streetHints.includes(c)) {
				streetHints.push(c)
			}
		}

		if (streetHints.length) {
			opts.streetCountryHints = streetHints
		}
	}

	if (interpolation) {
		opts.interpolation = interpolation
		// #374 doctrine: a shard that carries its own conformal multiplier (the `interp_calibration`
		// metadata table, read at open — `radiusCalibration`) is self-calibrating; the resolver reads it
		// directly and this path passes nothing. Two carve-outs preserve the ladder:
		//   1. an explicit caller NUMBER (`deps.interpCalibration` — the CLI's --interp-calibration
		//      instrument flag) still overrides the artifact, and
		//   2. a shard predating the metadata table (the shipped fleet) falls back to the in-code
		//      per-region table selected by the parsed region (`stateSlug`) — byte-identical to before.
		const explicit = typeof deps.interpCalibration === "number" ? deps.interpCalibration : undefined

		const fallback =
			interpolation.radiusCalibration == null && typeof deps.interpCalibration === "object"
				? interpCalibrationForRegion(deps.interpCalibration, stateSlug)
				: undefined

		const calibration = explicit ?? fallback

		// A factor of 1 is a no-op — skipped, EXCEPT as an explicit override of an artifact value ("force raw").
		if (calibration && (calibration !== 1 || (explicit !== undefined && interpolation.radiusCalibration != null))) {
			opts.interpolationRadiusCalibration = calibration
		}
	}

	// #42 postcode-country coherence. Default-ON at the core resolver since 2026-08-05; propagated explicitly here for
	// the same reason `adminCoherence` is — so `deps.postcodeCountryCoherence: false` stays an effective opt-out rather
	// than an unset field that re-defaults ON downstream. The resolver owns the verdict (it is the only place that can
	// test the (postcode, locality) pair against the gazetteer); its answer is read back off the tree below.
	opts.postcodeCountryCoherence = deps.postcodeCountryCoherence !== false

	// #31 postcode-structure arc — the three OPT-IN mechanisms. All default-OFF at the resolver, so this
	// assembly only ever SETS a field when the dep explicitly requests it (`=== true`); an absent dep field
	// stays absent and the resolver's byte-stable defaults hold. The prefix index is the exception that rides
	// with its flag: it is a data artifact, only consulted when `postcodePrefixPrior` is on.
	if (deps.postcodeShapeCoherence === true) {
		opts.postcodeShapeCoherence = true
	}

	if (deps.postcodeContainmentCoherence === true) {
		opts.postcodeContainmentCoherence = true
	}

	if (deps.postcodePrefixPrior === true) {
		opts.postcodePrefixPrior = true
	}

	if (deps.postcodePrefixIndex) {
		opts.postcodePrefixIndex = deps.postcodePrefixIndex
	}

	let resolved = await deps.resolver.resolveTree(tree, opts)

	// Second pass, ONLY when the coherence pass actually overrode the country. Rooftop + street-centroid shards are
	// selected BEFORE the resolve (they have to be — they're resolver inputs), off a country that has now been shown
	// wrong, so a corrected FR address would otherwise sit at its commune centroid with no BAN shard ever consulted.
	// Re-select for the corrected country and resolve once more. `opts.defaultCountry` is deliberately left alone so
	// the coherence pass re-derives the same verdict (2 lookups) and its `postcode_country_scope` receipt survives onto
	// the returned tree. Bounded at one extra resolve, and unreachable unless an override fired.
	const scopeCountry = postcodeCountryScopeOf(resolved)

	if (scopeCountry && scopeCountry.toLowerCase() !== preResolveCountry && !usShards.addressPoints) {
		const rooftop = rooftopFor(scopeCountry)
		let changed = false

		if (rooftop) {
			opts.addressPoints = rooftop
			opts.addressPointBboxFallback = true
			changed = true
		}

		if (opts.streetCentroids && !streetHints.includes(scopeCountry.toLowerCase())) {
			opts.streetCountryHints = [scopeCountry.toLowerCase(), ...streetHints]
			changed = true
		}

		if (changed) {
			resolved = await deps.resolver.resolveTree(tree, opts)
		}
	}

	let result = extractGeocodeResult(input, resolved)

	// ROAD_TO_V9 §4. One `classifyKindSync` over the text the parse actually saw — computed BEFORE the
	// street-miss fallback below because that fallback stands down on a declared fork (see there).
	const verdict = classifyKindSync({ raw: parseInput, normalized: parseInput }, computeQueryShape(parseInput))
	const forkDeclared = (verdict.intentMarkers ?? []).some((m) => m.code === "declared_fork")

	result = await applyStreetMissFallback(result, { tree, opts, deps, input, forkDeclared })

	// ROAD_TO_V9 §4 marker assembly — the verdict itself is computed above the street-miss fallback.
	const markers = [...(verdict.intentMarkers ?? [])]

	const ambiguity = declaredAmbiguityMarker({
		kinds: [verdict.kind, ...verdict.alternatives.map((a) => a.kind)],
		tree: resolved,
		lat: result.lat,
		lon: result.lon,
	})

	if (ambiguity) {
		markers.push(ambiguity)
	}

	// The fork→entity probe (#1585's entity half; fork-entity.ts owns the three gates). Fires only on
	// a DECLARED fork whose incumbent resolution produced no coordinate — a null is the only thing
	// that can change, which is what makes this default-on under the D-rule. Positive evidence only:
	// the probe adds an answer where there was none; it never contests one.
	if (
		result.lat === null &&
		markers.some((m) => m.code === "declared_fork") &&
		deps.poiLookup &&
		deps.isStreetGeneric
	) {
		const entity = probeForkEntity(parseInput, { lookup: deps.poiLookup, isStreetGeneric: deps.isStreetGeneric })

		if (entity) {
			result.lat = entity.latitude
			result.lon = entity.longitude
			result.resolution_tier = "venue"
			result.countryCode = entity.country
			result.venue = entity.name

			result.entity = {
				name: entity.name,
				categoryID: entity.categoryID,
				confidence: entity.confidence,
				country: entity.country,
			}
		}
	}

	result.intent_markers = markers

	return result
}

/**
 * The bare-toponym STREET-MISS fallback (the Moscow/Wellington/Antwerpen class): the model tags a lone bare token
 * `street`, the street tier finds no such street, and the result is null — while the resolver walk, handed the same
 * span as a locality, answers directly. Four gates: null-only (the D-rule geometry the fork wire established); a lone
 * SINGLE-TOKEN street-tagged span (a multi-token retry re-enters the qualifier-strip scrape class — measured: the
 * unguarded retry stripped 'COMER parís.méxico' to Comer, Georgia); never on a declared fork (those belong to the
 * entity probe); and the retry runs under the #912 bare-locality posture — placer anchor/hard filter always withheld
 * (measured: keeping them handed bare 'Wellington' to the GB namesake, 18,726 km out), an INFERRED default country
 * withheld too, an explicit one supreme.
 */
async function applyStreetMissFallback(
	result: GeocodeResult,
	ctx: {
		tree: AddressTree
		opts: ResolveOpts
		deps: GeocodeDeps
		input: string
		forkDeclared: boolean
	}
): Promise<GeocodeResult> {
	const { tree, opts, deps, input, forkDeclared } = ctx

	if (result.lat !== null || !deps.resolver || forkDeclared) return result
	const bare = loneBareStreetSpan(tree)

	if (bare === null || /\s/.test(bare.trim())) return result

	const localityTree: AddressTree = {
		raw: tree.raw,
		roots: [{ tag: "locality", value: bare, start: 0, end: bare.length, confidence: 1, children: [] }],
	}

	const retryOpts = {
		...opts,
		hardCountry: undefined,
		anchorPosterior: undefined,
		...(deps.defaultCountryIsInferred === true ? { defaultCountry: undefined } : {}),
	}

	const reresolved = await deps.resolver.resolveTree(localityTree, retryOpts)
	const retried = extractGeocodeResult(input, reresolved)

	if (retried.lat === null) return result
	retried.components = { ...result.components }

	return retried
}

/**
 * The lone bare street span the street-miss fallback retries as a locality, or `null` when the tree is anything richer:
 * the gate is EXACTLY one value-bearing node, tagged `street`, no prefix/suffix siblings — the single-token shape the
 * model mis-tags on unfamiliar capitals.
 */
function loneBareStreetSpan(tree: AddressTree): string | null {
	const valued: AddressNode[] = []
	const stack: AddressNode[] = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!

		if (typeof n.value === "string" && n.value.trim().length) {
			valued.push(n)
		}

		stack.push(...n.children)
	}

	if (valued.length !== 1) return null

	const lone = valued[0]!

	return lone.tag === "street" ? lone.value : null
}

/**
 * The country #42's postcode-country coherence pass scoped the walk to, read back off the resolved tree's
 * `postcode_country_scope` stamp. `undefined` when the pass was off, abstained, or agreed with the caller's default —
 * i.e. whenever nothing was overridden.
 */
function postcodeCountryScopeOf(tree: AddressTree): string | undefined {
	const stack: AddressNode[] = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!
		const scope = n.metadata?.["postcode_country_scope"]

		if (typeof scope === "string" && scope.length) return scope

		stack.push(...n.children)
	}

	return undefined
}

/**
 * Street-name component tags — the name-bearing subtree of a `street` node (`street.value` alone is the bare base:
 * "Sheldon" for "East Sheldon Rd"). Mirrors the resolver's `assembleStreetValue`; used to surface the FULL parsed
 * street on the result so a house-grade forward consumer renders "Boulevard du Palais", not just "Palais". #1041.
 */
const STREET_NAME_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/**
 * Reassemble the full parsed street name from a street node's name-bearing subtree, ordered by span offset. #1041.
 */
function assembleStreetName(streetNode: AddressNode): string {
	const parts: AddressNode[] = []
	const stack = [streetNode]

	while (stack.length) {
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
	const components = decodeAsJSON(tree)
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
		// #977 / #22: EXCEPT when the resolved postcode is an EXACT hit on a UNIT-GRADE code — an NL PC6 or a
		// GB unit postcode is street-block-class (~8 and ~15 addresses respectively), categorically tighter
		// than any locality centroid, so it leads the ladder. See {@link isUnitGradePostcodeHit} for the
		// three-way guard that keeps the locality-first epoch convention (adopted for FR, where 5-digit zone
		// centroids are COARSER than communes) untouched everywhere else.
		//
		// The GB half is what #22 fixed: `29 Brecknock Road, London, N7 0BT` resolved its unit postcode to
		// 51.5500/-0.1307 — 38 m from the rooftop truth — and the ladder returned the London centroid 5.6 km
		// away, on all 15 GB rooftop rows of the 2026-08-09 panel run. Nothing was missing from the gazetteer
		// and no lookup failed; the answer was on the tree and this list did not ask for it.
		const pcNode = allNodes.find((n) => n.tag === "postcode" && n.lat != null && n.lon != null)

		const unitPostcodeExact =
			pcNode !== undefined &&
			isUnitGradePostcodeHit(pcNode.value, pcNode.metadata?.["resolver_name"] as string | undefined)

		const adminPriority: ReadonlyArray<string> = unitPostcodeExact
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

	// #1058: a commune-scoped street-centroid hit is REGISTER evidence of the street's locality — the
	// resolver stamps it as `street_locality` on the street node (and drops span-rescored locality
	// nodes that contradict it). Surface it as the result locality so `city` decorates from the
	// register's commune, never from a token of the street name ("Rue Sainte-Catherine, Bordeaux" →
	// "Bordeaux", not "Rue"). Unset for postcode-scoped hits (no commune evidence) and other tiers.
	const streetLocality =
		tier === "street" ? (streetNode?.metadata?.["street_locality"] as string | undefined)?.trim() || null : null

	const locality =
		streetLocality ??
		allNodes.find((n) => n.tag === "locality" || n.tag === "dependent_locality")?.value?.trim() ??
		null

	const region = allNodes.find((n) => n.tag === "region")?.value?.trim() || null
	const postcode = allNodes.find((n) => n.tag === "postcode")?.value?.trim() || null

	// #1041: the parsed house number + full street name, so a house-grade forward consumer (photon `/api`) can decorate a
	// rooftop / interpolated result with `housenumber`/`street` (matching upstream Photon) instead of the admin locality.
	const houseNumber = allNodes.find((n) => n.tag === "house_number")?.value?.trim() || null
	const street = streetNode ? assembleStreetName(streetNode) || null : null

	const HIERARCHY_TAGS = ["locality", "dependent_locality", "subregion", "region", "country"]

	const hierarchy = allNodes
		.filter((n) => HIERARCHY_TAGS.includes(n.tag) && (n.lat != null || n.placeID))
		.toSorted((a, b) => HIERARCHY_TAGS.indexOf(a.tag) - HIERARCHY_TAGS.indexOf(b.tag))
		.map((n) => ({
			tag: n.tag,
			value: n.value.trim(),
			// The resolver stamps the gazetteer's canonical name (proper casing) on `resolver_name`; fall back to the raw
			// parsed span when a node resolved without one. #1014: consumers should DISPLAY this, not `value`.
			name: (n.metadata?.["resolver_name"] as string | undefined)?.trim() || n.value.trim(),
			...(n.lat != null ? { lat: n.lat, lon: n.lon! } : {}),
			...(n.placeID ? { placeID: n.placeID } : {}),
		}))

	// #1058: the street tier's register commune fills the locality slot when no locality hierarchy entry
	// exists (the span-rescored false locality was dropped, or the parse never emitted one) — a
	// street-tier `city` must come from the register, not from the street's first token.
	if (streetLocality && !hierarchy.some((h) => h.tag === "locality" || h.tag === "dependent_locality")) {
		hierarchy.unshift({ tag: "locality", value: streetLocality, name: streetLocality })
	}

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
		components,
		lat,
		lon,
		resolution_tier: tier,
		uncertainty_m: uncertaintyM,
		locality,
		region,
		postcode,
		house_number: houseNumber,
		street,
		venue: allNodes.find((n) => n.tag === "venue")?.value ?? null,
		dependent_locality: allNodes.find((n) => n.tag === "dependent_locality")?.value?.trim() || null,
		unit: allNodes.find((n) => n.tag === "unit")?.value?.trim() || null,
		countryCode,
		hierarchy,
		candidates,
		postcode_country_scope: postcodeCountryScopeOf(tree) ?? null,
		// `extractGeocodeResult` is a pure tree->result projection and has no access to the kind verdict, so it states
		// the empty case. `geocodeAddressOnce` is the caller that classifies and fills this in.
		intent_markers: [],
	}
}
