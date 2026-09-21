/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared street-level geocode cascade — the reusable core behind the `geocode` CLI command and
 *   `mailwoman serve`'s `/v1/geocode` + `/v1/batch` endpoints (via `api-engine.ts`, #485). One
 *   implementation of the cascade, so the CLI and the service never drift.
 *
 *   Cascade (the eval-validated path — 98.8% within 100m on the non-circular Travis holdout):
 *
 *   1. RAW neural parse (`classifier.parse`, postcodeRepair). Not the runtime pipeline — its reconcile
 *        stage merges street into house_number, dropping the street node the coordinate tiers need
 *        (#566).
 *   2. Read the parsed region → pick the per-state situs + interpolation databases.
 *   3. `resolveTree` with the coordinate tiers wired (additive. admin-only when databases absent).
 *   4. Extract the best coordinate + resolution tier (address_point > interpolated > admin).
 *
 *   The cascade depends on a {@link RegionDatabaseResolver} — a `(stateSlug) => { addressPoints?,
 *   interpolation? }` function — so the CLI (honoring its explicit `--address-points-db` flags) and
 *   the server (a cached {@link RegionDatabaseProvider}) supply databases their own way without the core knowing
 *   how.
 */

import type { GeocodeOutcomeLike } from "@mailwoman/api"
import { placetypeMapForCountry } from "@mailwoman/codex/placetype-map"
import type { AddressTree } from "@mailwoman/core/decoder"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import {
	COARSE_PLACER_ANCHOR_WEIGHT,
	deriveInputMode,
	type InputMode,
	hardCountryFor,
	isBareLocalityTree,
	isBarePostcodeTree,
	type QueryKindResult,
	WORD_CONSISTENCY_SHIP_DEFAULT,
	streetContextRequirementFor,
} from "@mailwoman/core/pipeline"
import type {
	AuthoritativeProvider,
	AddressPointLookup,
	PostcodePrefixIndexLike,
	ResolveOpts,
	Resolver,
	WeakResolutionReading,
} from "@mailwoman/core/resolver"
import { countriesFromPostcodeFormat, countryFromPostcodeFormat } from "@mailwoman/core/resolver"
import { classifyKindSync } from "@mailwoman/kind-classifier"
import { computeQueryShape, type QueryShape } from "@mailwoman/query-shape"

import { authoritativeQueryFrom, consultAuthoritativeProvider } from "#authoritative"
import { loadDefaultPlaceCountry, type PlaceCountryFn } from "#default/placer"
import { applyEntityTiers } from "#fork-entity"
import { classifierForInput, type GeocodeClassifier, normalizeGeocodeInput } from "#geocode/classifier"
import { traceCollector } from "#geocode/derivation"
import { type RegionDatabaseResolver, type RegionDatabases, regionSlugFromTree } from "#geocode/regions"
import { extractGeocodeResult } from "#geocode/result"
import {
	postcodeCountryScopeOf,
	recognizeBarePostcode,
	resolvedCountryOf,
	treePostcodeValue,
} from "#geocode/tree-reads"
import { shouldDropInferredScope } from "#inferred-scope"
import { thingQueryRefusalMarkers } from "#intent-refusal"
import { interpCalibrationForRegion, type InterpCalibrationTable } from "#interp-calibration"
// Everything this file takes from the observation surface comes from its barrel rather than
// from the individual modules: the three route types are the same kind of thing here —
// an optional, already-open spatial layer — and the one conversion that reads them
// takes all three, so a fourth layer costs no import at this call site.
import { layerDesignationMarkers, type LayerDesignationRoutes } from "#observations/index"
import { applyPlusCodeOverride } from "#plus-code-override"
import type { POIExecutorLookup } from "#poi/executor"
import { repairPostcodeContradiction } from "#postcode-repair"
import { coarserAnswerMarker, declaredAmbiguityMarker } from "#query-intent"
import { recognizeUSRegions } from "#region-recognition"
import { repairStrandedAffix } from "#stranded-affix-repair"
import { applyStreetMissFallback } from "#street/miss-fallback"

export type { GeocodeClassifier } from "#geocode/classifier"

// The attached spatial layers ride in as one bundle: `layerDesignationMarkers` reads
// all of them together and this module reads none of them, so a fourth layer is an
// edit in `observations/observation-marker.ts` and none here.
export interface GeocodeDeps extends LayerDesignationRoutes {
	/**
	 * Poi.db reader for the fork→entity probe (`fork-entity.ts`).
	 * Absent = the probe never runs (tolerate-and-degrade, like every optional artifact).
	 * Both this and {@link isStreetGeneric} are required for a probe.
	 */
	poiLookup?: POIExecutorLookup
	/**
	 * OPT-IN venue tier (#1684's POI half): upgrade a venue-led address's admin/street
	 * answer to the poi.db entity with the venue's exact name-key near the resolved anchor.
	 * Off by default — the ceiling is measured (15 tracked gb_venue rows are data-visible)
	 * but the D-rule promotion needs its own full-board battery.
	 */
	poiVenueTier?: boolean
	/**
	 * Street-morphology token test (the #1315 check's matcher) — check 2 of the fork→entity probe.
	 * Absent = no probe: an unrestricted probe is the Savile Row hijack, so degrading
	 * the guard degrades the whole mechanism, never just the guard.
	 */
	isStreetGeneric?: (token: string) => boolean
	/**
	 * The gazetteer FST prior (#1497). Absent = the prior is never constructed and the decode
	 * is byte-identical to the pre-#1497 geocode path — which is what every caller got,
	 * because this field did not exist and `classifier.parse` has no config fallback for it.
	 */
	fst?: import("@mailwoman/core/pipeline").FSTMatcherLike
	/**
	 * Street-morphology matcher, consumed only as the street-context check's signal
	 * source with the emission prior zeroed (`streetContextRequirementFor`).
	 * Inert without {@link GeocodeDeps.fst}.
	 */
	streetMorphology?: import("@mailwoman/core/pipeline").FSTMatcherLike
	/**
	 * True when {@link defaultCountry} was inferred from the locale rather than user-declared.
	 * The street-miss fallback retries a mis-tagged bare toponym as a locality, and a
	 * bare-locality retry must run under the #912 posture — the inferred scope withheld —
	 * while an explicit scope stays supreme. Only the caller knows which. the CLI threads it.
	 */
	defaultCountryIsInferred?: boolean
	/**
	 * Lexicon-aware kind classifier (#1649) — `createKindClassifier({ poiLexicon })` from
	 * `@mailwoman/kind-classifier`. When present it gets first refusal on the query:
	 * a top-slot POI/category/near-me verdict abstains from the address lanes with the intent
	 * markers attached, instead of manufacturing a confident wrong answer from a thing-query.
	 * Absent → byte-identical geocoding (the sync register derivation is untouched either way —
	 * the kind-intent invariance receipt covers both classifiers).
	 */
	classifyKind?: (
		input: { raw: string; normalized: string },
		shape: ReturnType<typeof computeQueryShape>
	) => Promise<QueryKindResult>
	classifier: GeocodeClassifier
	resolver: Resolver
	/**
	 * Explicit input register (Decision A / GTM B10 — canonical docs on
	 * `@mailwoman/core/pipeline`'s `InputMode`). Unset → derived per parse from the
	 * kind classifier's verdict. Endpoint wrappers set their register default here
	 * (`/v1/batch` + CSV → `"formatted"`, autocomplete drop-ins → `"fragmented"`).
	 */
	inputMode?: InputMode
	/**
	 * Per-state database resolver. Omit for admin-only geocoding.
	 */
	databases?: RegionDatabaseResolver
	/**
	 * Authoritative national open-register rooftop databases keyed by ISO-3166 alpha-2
	 * country (#1012) — the government address registers (BAN-FR today, 26M points).
	 * Consulted only when no US per-state situs database matched (a non-US parse), and ahead of
	 * {@link osmDatabases}: a national register is denser + coordinate-authoritative, so it outranks
	 * the community OSM fallback. Inject from `@mailwoman/ban`'s `BANRegionDatabaseProvider`;
	 * absent = no national tier. Licence Ouverte/Etalab (permissive) — see `ban/readme.md`.
	 * The shape generalises to other national registers.
	 */
	nationalDatabases?: (country: string) => RegionDatabases
	/**
	 * OSM rooftop databases keyed by ISO-3166 alpha-2 country (#247) — the opt-in international
	 * precision tier. Consulted only when no US per-state situs database matched (a non-US parse)
	 * and no {@link nationalDatabases} register covered the country, so the US path is untouched
	 * and BAN wins where it exists. Inject from `@mailwoman/osm`'s `OSMRegionDatabaseProvider`;
	 * absent = no OSM tier. ODbL — see `osm/readme.md`.
	 */
	osmDatabases?: (country: string) => RegionDatabases
	/**
	 * A configured authoritative provider (#1901) — OS Places, an OS NGD-backed service,
	 * or any adapter implementing `@mailwoman/core/resolver`'s interface.
	 * Absent = the geocode result is byte-identical to a run without the field
	 * existing (the consult never happens, the `authoritative` block never appears).
	 * When present, the provider is consulted after the open result is assembled
	 * and its answer is carried beside that result, never merged into it.
	 */
	authoritativeProvider?: AuthoritativeProvider
	/**
	 * Country constraint passed to the resolver (e.g. `"US"`).
	 */
	defaultCountry?: string
	/**
	 * #27 — the locale's country as a soft ranking prior (`ResolveOpts.localeCountryPrior`), for the query shape where
	 * {@link defaultCountry} is deliberately withheld: a bare toponym.
	 *
	 * The #912 guard in `mailwoman/commands/geocode.tsx` drops the locale-inferred
	 * country for a bare-locality tree, because as a hard filter it is a
	 * disaster (`--locale en-US "Zürich"` scoped to US answers Zurich, Kansas).
	 * What it does not do is hand the country down in a form that cannot filter —
	 * so `--locale en-GB "Whitby"` and `--default-country GB "Whitby"` disagree,
	 * and only the second is gold. This field is that form.
	 *
	 * Ignored when {@link defaultCountry} is set (a hard scope makes the prior a no-op), and OPT-IN at
	 * the CLI — see `ResolveOpts.localeCountryPrior` for the measured reason it is not a default.
	 */
	localeCountryPrior?: string
	/**
	 * Weight of {@link localeCountryPrior} in log10(population + 1).
	 * Default 2 at the resolver.
	 */
	localeCountryPriorWeight?: number
	/**
	 * #1880 — capital status of a candidate (2 national capital, 1 admin-1 seat, 0 neither), for the resolver's bounded
	 * capital promotion on the bare-toponym class (`ResolveOpts.capitalLevel`).
	 * The session builds it from the capitals reference by default (`capitalTier`, on);
	 * undefined — an opted-out session, or a reference-less artifact under the
	 * degrade path — leaves resolution byte-identical.
	 */
	capitalLevel?: (place: { name: string; country?: string; lat: number; lon: number }) => number
	/**
	 * #1585 — the locale hint's country, scoping the backend's typo-fuzzy tier only (`ResolveOpts.fuzzyCountryScope`).
	 * Unlike {@link localeCountryPrior} this is not opt-in and not a ranking prior:
	 * exact matches stay worldwide, a typo correction stays inside the hinted country, and a
	 * scoped-empty correction abstains instead of falling through to a world-fuzzy candidate.
	 * Threaded even when {@link defaultCountry} is set (harmless — the hard scope is already narrower).
	 */
	fuzzyCountryScope?: string
	/**
	 * Title-case all-caps ascii input before the model (#690), detection-restricted
	 * so mixed-case + non-Latin pass through untouched. **Default `true`** — validated-beneficial
	 * on this geocode/resolveTree path (#619: TX-facility locality 90.1 → 99.7%).
	 * The #694 comma-less crater was the space-join rather than the casing, so on comma-joined
	 * input it is a clean win. Set `false` to restore the legacy raw-case parse.
	 */
	normalizeCase?: boolean
	/**
	 * Stage 1 deterministic preprocessing (`@mailwoman/normalize`: NFC + whitespace-collapse + punctuation)
	 * on the input before parse. **Default `true`.** `createRuntimePipeline` runs this as a stage,
	 * but the drop-in servers (nominatim/photon) call `geocodeAddress` directly — without it a
	 * double-spaced / odd-punctuation query was fragile (`"Damrak 1, 1012 LG"` → unresolved).
	 * Idempotent; `false` opts out for callers that already normalized.
	 */
	normalizeInput?: boolean
	/**
	 * A pre-parsed tree to resolve, skipping the internal `classifier.parse`
	 * (the address's single most expensive step). Supply the output of {@link parseForGeocode}
	 * when a caller already parsed the same address for another purpose — a PostalAddress, say —
	 * so the inference runs once rather than twice. Must come from `parseForGeocode` (same input + opts),
	 * or the resolved tree won't match the address. Omit for the normal one-shot path.
	 */
	parsedTree?: AddressTree
	/**
	 * Interpolation-radius conformal calibration (#374) so reported radii are an honest ~90% bound.
	 * The multiplier is a property of the calibration set the artifact was built against,
	 * so a database that carries one in its `interp_calibration` metadata table is self-calibrating
	 * (`InterpolationLookup.radiusCalibration`, read at database open — the pair-index δ precedent)
	 * and this option is not consulted for it. The two remaining roles:
	 *
	 * - A per-region {@link InterpCalibrationTable} — the legacy-database fallback,
	 *   selected by the parsed region (DC 1.44 … AZ 3.12, `default` otherwise, #584),
	 *   applied only when the database predates the metadata table (the artifact is silent).
	 * - A single number — an explicit instrument override forced everywhere,
	 *   artifact value included (the CLI's `--interp-calibration`).
	 *   `1` or `undefined` + artifact-silent keeps the raw half-segment heuristic.
	 *
	 * See `docs/articles/evals/calibration/2026-06-14-interp-multiregion-recalibration.md`.
	 */
	interpCalibration?: number | InterpCalibrationTable
	/**
	 * Coarse country router (#244, soft prior). A `(text) → { country, confidence }` predictor.
	 * A confident IN-MAP guess becomes an `anchorPosterior` the resolver's #369 re-rank boosts
	 * (never filters); abstain (`null`) / off-map (`other`) are no-ops, and an explicit
	 * {@link defaultCountry} still wins (we never overwrite a caller-set posterior).
	 *
	 * **Default-on (#244 M2, after the misroute check):**
	 *
	 * - `undefined` (default) → the bundled placer ({@link loadDefaultPlaceCountry}, open-set @ 0.9)
	 *   is lazy-loaded and applied. Degrades to no prior if the model can't be resolved.
	 * - A function → use it (a custom placer / threshold).
	 * - `false` → disabled (no prior. the pre-M2 byte-stable behavior).
	 */
	placeCountry?: PlaceCountryFn | false
	/**
	 * Proximity-bias points (viewport center, user location, …), strongest first — forwarded to the
	 * resolver as ResolveOpts.bias (soft prominence re-rank. the ambiguous-postcode disambiguator).
	 */
	bias?: Array<{ lat: number; lon: number; weight?: number }>
	/**
	 * #743/#194: promote a confident placer guess to a hard country filter (empty→unresolved) for coverage-safelisted
	 * countries — see {@link hardCountryFor}. **default-on** (#743): a pure win on well-covered countries
	 * (US/ES/IT/NL/DE/FR), soft (no-op) for the rest. Pass `false` to opt out.
	 */
	hardPlaceCountry?: boolean
	/**
	 * #743/#194: override the coverage safelist that bounds {@link hardPlaceCountry}. Undefined → the loaded gazetteer
	 * artifact's own coverage manifest when it carries one, else the built-in constant (the fallback for artifacts
	 * predating the manifest).
	 */
	hardCountrySafelist?: ReadonlySet<string>
	/**
	 * #928: when the parsed postcode's format unambiguously implies a country ({@link POSTCODE_FORMAT_COUNTRY} — GB `E4
	 * 9AZ`, CA `K2P 1L4`), use it as the country prior IN place OF the coarse placer, which conflates GB/CA with US on
	 * shared English patterns and mis-routes them to US namesakes at high confidence (London E4 → London, Ohio).
	 * **default-on** (promoted 2026-07-06. check: GB 63→90% ok, CA 42→67%, US byte-identical 0/150 — the formats never
	 * match a US ZIP / NL / FR code). Only fires when no explicit `defaultCountry`. Pass `false` to opt out (the
	 * pre-promote behavior). A format is a stronger, unforgeable signal than the language model.
	 */
	postcodeCountryPrior?: boolean
	/**
	 * Admin descendant-consistency (#263, `ResolveOpts.adminCoherence`) — re-pick a (region, locality)
	 * pair so the locality descends from the region ("Portland, ME" → Maine rather than Messina).
	 * **Default-on** for the geocode path. only fires when a region's child locality fell through,
	 * so the well-resolved path is byte-identical. Pass `false` to opt out.
	 */
	adminCoherence?: boolean
	/**
	 * #1721 resolver-interior trace sink, forwarded verbatim to `ResolveOpts.traceSink`. Absent = zero bookkeeping.
	 */
	resolveTraceSink?: import("@mailwoman/core/resolver").ResolveOpts["traceSink"]
	/**
	 * Re-probe a resolved-nothing lookup across the other admin bands and record
	 * which hold it (#1741/#1756). diagnostic — the answer never changes, only the
	 * record of why it was not found. Requires `resolveTraceSink`.
	 */
	diagnoseUnreachable?: boolean
	/**
	 * Lineage attachment (#404, `ResolveOpts.includeAncestors`) — stamp each resolved node's
	 * containment chain onto `metadata.ancestors`, which is what puts region-class ancestry in
	 * front of the admin-coherence verdicts (#1717): without it `region` reads `unverifiable`
	 * on every winner. **Default-on** for the geocode path — the stamp is flag-only metadata
	 * (no ranking or re-pick reads it) served from a per-id memoized backend probe, and it no-ops
	 * on a backend/artifact without `ancestors()`. Pass `false` to opt out.
	 */
	includeAncestors?: boolean
	/**
	 * Postcode-country coherence (#42, `ResolveOpts.postcodeCountryCoherence`) — let a (postcode, locality) pair that is
	 * geographically consistent in exactly one country override a wrong {@link defaultCountry}. `12 Rue de Rivoli, 75001
	 * Paris` under the en-US locale otherwise lands in Texas, and with the postal databases attached in Addison.
	 * **Default on** (operator-promoted 2026-08-05 — gauntlet zero newly-failing conditional cases pinned either way,
	 * 56,000 pair evaluations across both backends at zero false positives. see
	 * `docs/records/evals/2026-08-05-postcode-coherence-default-on-evidence.md`). Pass `false` to opt out.
	 *
	 * On this path it also re-selects the rooftop tier. Database selection happens before the
	 * resolve and keys off `defaultCountry ?? placedCountry`, so a US-scoped call would pick
	 * no national/OSM database and leave the corrected FR address at its commune centroid.
	 * When the resolver reports an override (the `postcode_country_scope` stamp), the rooftop/street
	 * databases are re-selected for the corrected country and the tree is resolved once more.
	 * Self-limiting: the second pass costs nothing unless an override actually fired.
	 */
	postcodeCountryCoherence?: boolean
	/**
	 * Postcode-shape coherence (#31, Mechanism 1, `ResolveOpts.postcodeShapeCoherence`) — shape as
	 * confidence and exclusion: a postcode span whose codex shape intersects no confident sibling system
	 * is demoted (digit-only → `house_number`; letter-containing → stamped `postcode_shape_excluded`).
	 * **Default off** — demotion is the failure mode with teeth. pass `true` to opt in
	 * (the pre-registered B1 criterion set lives in `resolver/postcode-shape-coherence.ts`).
	 */
	postcodeShapeCoherence?: boolean
	/**
	 * Postcode-containment coherence (#31, Mechanism 2, `ResolveOpts.postcodeContainmentCoherence`) —
	 * re-rank locality candidates by proximity to the postcode's own centroid
	 * (25 km check, the same value the country pass measures at). **Default off**; pass `true` to opt in.
	 */
	postcodeContainmentCoherence?: boolean
	/**
	 * Admin-containment re-rank (#1717 stage 2, `ResolveOpts.adminContainmentRerank`) —
	 * a parsed region qualifier participates in locality-candidate selection:
	 * candidates the ancestors sidecar vouches sit under the qualifier rank ahead of
	 * (and can be surfaced past a locale-inferred country scope over) the ones it cannot
	 * vouch for. **Default off** (D-rule); pass `true` to opt in.
	 */
	adminContainmentRerank?: boolean
	/**
	 * Span-rescore context remainder (#2266, `ResolveOpts.spanRescoreRequireContextRemainder`) —
	 * a recovered sub-span may drop context but never a word of the name,
	 * so a fragment of a multi-word locality stops being enumerated as a candidate in
	 * its own right. **Default off** (D-rule); pass `true` to opt in.
	 */
	spanRescoreRequireContextRemainder?: boolean
	/**
	 * Weak-resolution reading (#2264, `ResolveOpts.spanRescoreWeakResolution`).
	 * **Default unset**, the shipped brake.
	 */
	spanRescoreWeakResolution?: WeakResolutionReading
	/**
	 * Postcode-prefix prior (#31, Mechanism 3, `ResolveOpts.postcodePrefixPrior` + `.postcodePrefixIndex`) —
	 * on a `postalcode` miss, resolve the code's prefix from the injected PFX1 index
	 * (GB outward / US section) so an ungazetted unit still contributes its district + centroid.
	 * **Default off** (the PCN1 posture — data + loader + offline probe, no decode wiring);
	 * pass `true` plus the index to opt in.
	 */
	postcodePrefixPrior?: boolean
	/**
	 * The PFX1 postcode-prefix index to probe (structural — `PostcodePrefixIndexLike`,
	 * core/resolver/types.ts. the loader is `@mailwoman/neural/postcode-prefix-index.ts`).
	 * Only consulted when `postcodePrefixPrior` is on.
	 */
	postcodePrefixIndex?: PostcodePrefixIndexLike
}

/**
 * The kind-derived register for a geocode input (Decision A) — shared by the parse and the retry rider.
 */
export function deriveGeocodeRegister(parseInput: string, queryShape = computeQueryShape(parseInput)): InputMode {
	return deriveInputMode(classifyKindSync({ raw: parseInput, normalized: parseInput }, queryShape).kind)
}

/**
 * Everything {@link parseForGeocode} derives before the model runs: the text the classifier
 * actually sees, the query-shape prior, the register, and the classifier opts.
 *
 * Split out so a second consumer can run the same decode under a different
 * classifier entry point — today that is the `--debug` session, which calls
 * `classifier.traceParse(parseInput, opts)` to record what the model saw.
 * A trace built from re-derived opts would describe a decode nobody ran. sharing this function
 * is what makes the trace a receipt for the tree instead of a plausible reconstruction of it.
 */
export interface GeocodeParseInputs {
	/**
	 * The exact text handed to the classifier (post Stage-1 normalize), not the caller's raw input.
	 */
	parseInput: string
	queryShape: QueryShape
	inputMode: InputMode
	/**
	 * The kind verdict {@link inputMode} was derived from.
	 * Absent when the caller pinned a register — nothing was classified,
	 * and reporting a kind here would be inventing one.
	 */
	kind?: QueryKindResult
	opts: NonNullable<Parameters<GeocodeClassifier["parse"]>[1]>
}

export function geocodeParseInputs(
	input: string,
	deps: Pick<GeocodeDeps, "normalizeInput" | "normalizeCase" | "inputMode" | "fst" | "streetMorphology"> &
		Partial<Pick<GeocodeDeps, "classifier">>
): GeocodeParseInputs {
	// #1002: expandAbbreviations with the locale-unknown safe set (Bd/Bvd/Av/Imp → the expanded street
	// type). The model mis-parses undertrained FR abbreviations
	// ("2 Bd du Palais" → house_number "2 Bd", which then fails the point-tier number match);
	// the EN suffixes are deliberately not expanded (the model is trained-robust on them,
	// and St/Dr are ambiguous with Saint/Doctor). The locale isn't known pre-parse,
	// so only the collision-free multi-locale entries apply — see LOCALE_UNKNOWN_DICT.
	const parseInput = deps.normalizeInput === false ? input : normalizeGeocodeInput(input, deps.classifier).normalized

	// #981: apply the query-shape emission prior the runtime pipeline applies (core/pipeline/runtime-pipeline.ts:336
	// `computeQueryShape` → `safeClassify` → parse with `queryShape`).
	// Without it the geocode path — the drop-in servers (nominatim/photon `/api`) +
	// the geocode CLI — diverged from the pipeline: a detected known-format span
	// (`nl_postcode` → `B-postcode`, …) or a US region abbreviation never biased the emissions here.
	// Computed on `parseInput` (the exact text handed to the model), matching the pipeline
	// (which computes it on the normalized text, before the classifier's internal case-normalization).
	// It is a no-OP whenever the shape carries no known format and no region abbreviation
	// (the bare `street, city` class) — `buildEmissionPriors` returns an all-zeros matrix —
	// so both bare-form and well-formed inputs are byte-stable. it warrants its keep only on
	// the ambiguous digit-span / region-abbrev cases the model isn't already confident about.
	const queryShape = computeQueryShape(parseInput)

	// Decision A: explicit register wins. otherwise the kind verdict decides (same derivation as the
	// runtime pipeline — the drop-ins + geocode CLI reach parse through here rather than runPipeline).
	// The kind classifier stays uncalled under an explicit register, exactly as before the split.
	let inputMode = deps.inputMode
	let kind: QueryKindResult | undefined

	if (!inputMode) {
		kind = classifyKindSync({ raw: parseInput, normalized: parseInput }, queryShape)
		inputMode = deriveInputMode(kind.kind)
	}

	return {
		parseInput,
		queryShape,
		inputMode,
		...(kind ? { kind } : {}),
		opts: {
			postcodeRepair: true,
			normalizeCase: deps.normalizeCase ?? true,
			queryShape,
			inputMode,
			// Word-consistency heal on by default (2026-07-15) — semantics in neural/word-consistency.ts.
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			// #1497: the gazetteer prior. `classifier.parse` reads `fst` from opts only, with no config
			// fallback, so a path that never passes it never constructs the prior — it is not
			// a weaker decode, it is a different one. Absent `deps.fst` this spread is empty
			// and the decode is byte-identical to before.
			...(deps.fst ? { fst: deps.fst } : {}),
			// The street-context check pair, from the same helper runPipeline calls.
			// Transcribing it here would recreate exactly the drift #1669 catalogued:
			// two copies agreeing on every constant while the code around them diverges.
			...streetContextRequirementFor({
				...(deps.fst ? { fst: deps.fst } : {}),
				...(deps.streetMorphology ? { streetMorphology: deps.streetMorphology } : {}),
			}),
		},
	}
}

/**
 * The exact parse `geocodeAddress` runs internally: Stage-1 deterministic preprocessing
 * (`normalizeInput`) → `classifier.parse` (postcodeRepair + normalizeCase) → `recognizeUSRegions`
 * → {@link recognizeBarePostcode}. Exposed so a caller can run it once
 * and feed the result to both {@link geocodeAddress} (via `GeocodeDeps.parsedTree`)
 * and another consumer of the parse (e.g. `decodeAsJSON(tree)` → a PostalAddress),
 * instead of parsing the same address twice. The inference is ~3 ms/row — the single most
 * expensive step — so sharing it is a ~1.3× win on a parse-then-geocode pipeline.
 */
export async function parseForGeocode(
	input: string,
	deps: Pick<GeocodeDeps, "classifier" | "normalizeInput" | "normalizeCase" | "inputMode" | "fst" | "streetMorphology">
): Promise<AddressTree> {
	const classifier = await classifierForInput(deps.classifier, input)
	const { parseInput, opts, queryShape } = geocodeParseInputs(input, { ...deps, classifier })

	// #22: a bare unambiguous postcode the model read as a street ("N7 0BT" → `{ street: … }`) is retagged
	// before the resolve — see recognizeBarePostcode for why nothing downstream can recover it.
	const tree = recognizeBarePostcode(recognizeUSRegions(await classifier.parse(parseInput, opts)))

	// #1735: the multi-node generalization of #22 — a letter-digit postcode span the model split into
	// street + house_number ("KT2 6AB") is repaired from the shape stage's own span.
	// Runs here, before any caller derives scope from the tree: the session's
	// bare-postcode guard must see the repaired tree, or a locale-inferred country
	// filter starves the lookup the repair exists to enable.
	repairPostcodeContradiction(tree, queryShape)

	// #1747: a `street_suffix` with no `street` anywhere, abutting a place name, belongs to that name — `Brixton Hill`
	// parsed as locality `Brixton` + a floating `Hill` and resolved 300 km away.
	// Runs after the postcode repairs so it judges the final tree, and its adjacency
	// guard leaves a genuine one-word street untouched.
	repairStrandedAffix(tree)

	return tree
}

/**
 * Run the full street-level cascade on one address and return the structured geocode result.
 * Always returns a result (admin tier even with no coordinate databases).
 * Throws only on a fatal parse/resolve error — callers doing batch work should catch per-row.
 */
export async function geocodeAddress(input: string, deps: GeocodeDeps): Promise<GeocodeOutcomeLike> {
	// #1649 first refusal — before the resolve and before the register-flip retry rider, so a refused
	// thing-query can neither resolve nor be retried into
	// nonsense. See intent-refusal.ts.
	if (deps.classifyKind && !deps.inputMode) {
		const parseInput =
			deps.normalizeInput === false
				? input
				: normalizeGeocodeInput(input, await classifierForInput(deps.classifier, input)).normalized

		const refusal = await thingQueryRefusalMarkers(deps.classifyKind, parseInput)

		if (refusal) {
			// The parse succeeded and used to be thrown away: this built the outcome from an empty tree,
			// so a refused `Cafe at St Mary's, Oxford` reported `components: {}` while `parseForGeocode`
			// had produced `locality: Oxford` › `dependent_locality: St Mary's` › `street: Cafe`.
			// `intent_markers` said why we abstained. nothing said what we understood, and a caller
			// could not tell a refusal from a parse that found nothing without reading the marker.
			//
			// No extra parse on any production path — the session computes the
			// tree once and threads it as `parsedTree` (geocode-session.ts:679).
			// The fallback only runs for a direct `geocodeAddress` caller on a refused input,
			// and this branch returns, so nothing can parse twice.
			//
			// The tree has not been resolved here, so no node carries a coordinate
			// and the outcome is coordinate-free by construction rather than by nulling.
			// The abstain interface is graded on the coordinate alone (`check-case.ts`'s `expect_abstain`),
			// and none of the six abstain board rows declares `expectComponents` —
			// so this adds what was understood without weakening the refusal.
			const tree = deps.parsedTree ?? (await parseForGeocode(input, deps))
			const abstained = extractGeocodeResult(input, tree)

			abstained.intent_markers = refusal

			return abstained
		}
	}

	// The Decision-A retry rider (a zero-hit in a derived register earned one attempt in the flipped one)
	// lived here from 2026-07-28 to 2026-08-19 and was retired under the #486 repair-retirement
	// policy with a measured record of exactly zero: no effect on the full board, none on its
	// 199-row failure subset (counterfactual sweep), and none on 300 fresh BAN + 300 fresh fdic
	// register records — the misrouted- record class it was specced for. #1694 holds the receipts.
	return geocodeAddressOnce(input, deps)
}

/**
 * Thread the address's country evidence into the walk's options — one path for the whole
 * precedence chain: an explicit caller scope is supreme. an inferred scope yields to the
 * #1684 check. postcode-format countries (#1589) reach the scoped `postalcode` probe. the
 * fuzzy tier's locale scope (#1585) and the soft locale prior (#27) thread beneath.
 */
function applyCountryEvidence(opts: ResolveOpts, tree: AddressTree, deps: GeocodeDeps): void {
	// #1589: the parsed postcode's format-implied countries. Computed before the scope block so the scope
	// check can read them. threaded to the resolver either way.
	const formatCountries = countriesFromPostcodeFormat(treePostcodeValue(tree))

	if (deps.defaultCountry) {
		// #1684 conditional scope: a locale-inferred scope yields to the model's own confident contrary
		// read of the text, or to a postcode format that excludes the inferred country
		// (see shouldDropInferredScope). The scope is dropped, never re-pointed —
		// the worldwide race with cross-country primary preference + fame decides,
		// which is the behavior the graded scope=none arm measured on exactly this class
		// ("Nanjing Road, Huangpu, Shanghai" was a West Virginia namesake under the inferred filter).
		// An explicit caller scope never enters here.
		if (shouldDropInferredScope(tree, deps.defaultCountry, deps.defaultCountryIsInferred === true, formatCountries)) {
			// No hard scope. the postcode-format block below may still scope, which is the
			// documented order (format evidence outranks a locale hint).
		} else {
			opts.defaultCountry = deps.defaultCountry

			// The resolver withholds an inferred scope from `country`-placetype lookups only
			// (see `ResolveOpts.defaultCountryIsInferred`) — without this thread, bare "Germany" under
			// the default locale filters out the DE country row and falls to a US alias locality.
			if (deps.defaultCountryIsInferred === true) {
				opts.defaultCountryIsInferred = true
			}
		}
	}

	// #1589: the format-implied countries also reach the resolver's scoped `postalcode` probe. The
	// resolver applies them only when no explicit country selection applies — which keeps an
	// explicit defaultCountry supreme over format evidence, which in turn outranks a locale hint.
	if (formatCountries.length) {
		opts.postcodeFormatCountries = formatCountries
	}

	// #1585: the locale hint's country scopes the typo-fuzzy tier — always threaded, never a filter on
	// exact matches (the backend's fuzzy block is the only consumer).
	if (deps.fuzzyCountryScope) {
		opts.fuzzyCountryScope = deps.fuzzyCountryScope
	}

	// #27: the locale country as a soft prior, only where no hard scope is in force. Nothing else in the
	// cascade is disturbed — the resolver ignores it under a `defaultCountry` or an `anchorPosterior`.
	if (deps.localeCountryPrior && !opts.defaultCountry) {
		opts.localeCountryPrior = deps.localeCountryPrior

		if (deps.localeCountryPriorWeight !== undefined) {
			opts.localeCountryPriorWeight = deps.localeCountryPriorWeight
		}
	}

	// #1880: capital status for the resolver's bounded capital promotion. Threaded verbatim — the
	// resolver applies its own stand-downs (bare-toponym class, no anchor posterior, exact tier).
	if (deps.capitalLevel) {
		opts.capitalLevel = deps.capitalLevel
	}
}

/**
 * The resolver pins a caller opts into. Each defaults to off at the resolver,
 * so an unset dep stays absent rather than becoming an explicit `false`;
 * a pin promoted to default-on leaves this list for an `!== false` read.
 */
const OPT_IN_RESOLVER_PINS = [
	"postcodeShapeCoherence",
	"postcodeContainmentCoherence",
	"spanRescoreRequireContextRemainder",
	"postcodePrefixPrior",
] as const satisfies readonly (keyof GeocodeDeps & keyof ResolveOpts)[]

async function geocodeAddressOnce(input: string, deps: GeocodeDeps): Promise<GeocodeOutcomeLike> {
	// Stage 1 deterministic preprocessing (GeocodeDeps.normalizeInput) —
	// drop-ins call geocodeAddress directly with no createRuntimePipeline wrapper,
	// so without this a double-spaced / odd-punctuation query was fragile.
	// `input` stays raw for the result. the parse + placer see the normalized form.
	// A caller-supplied `parsedTree` (from parseForGeocode, same input + opts) skips
	// the re-parse — the address's most expensive step.
	const parseInput =
		deps.normalizeInput === false
			? input
			: normalizeGeocodeInput(input, await classifierForInput(deps.classifier, input)).normalized

	const tree = deps.parsedTree ?? (await parseForGeocode(input, deps))
	const queryShape = computeQueryShape(parseInput)
	const stateSlug = regionSlugFromTree(tree)
	const usDatabases = deps.databases?.(stateSlug) ?? {}
	let addressPoints = usDatabases.addressPoints
	const interpolation = usDatabases.interpolation

	// The caller's trace sink, wrapped so the same records also feed the derivation
	// projection at the end. see `traceCollector` for the no-sink guarantee.
	const trace = traceCollector(deps.resolveTraceSink)
	const traceSink = trace.traceSink

	const opts: ResolveOpts = {
		// Admin descendant-consistency (#263) — joint-consistency resolve over the gazetteer's
		// containment graph. Default-on at the core resolver too since #895 (drift D1 settled);
		// the explicit propagation here keeps `deps.adminCoherence: false` an effective
		// opt-out (an unset ResolveOpts field would otherwise re-default on downstream).
		// Fixes the "Portland, ME → Messina IT" class structurally, without a prior or safelist.
		adminCoherence: deps.adminCoherence !== false,
		// Lineage attachment (#404) — default-on here so the admin-coherence verdicts (#1717)
		// check the winner's real ancestry instead of reporting `unverifiable` wholesale.
		// Explicit propagation for the same reason as `adminCoherence` above.
		// The resolver still guards on the backend actually serving `ancestors()`,
		// so an artifact predating the sidecar stays byte-identical.
		includeAncestors: deps.includeAncestors !== false,
		...(traceSink ? { traceSink } : {}),
		...(deps.diagnoseUnreachable ? { diagnoseUnreachable: true } : {}),
	}

	applyCountryEvidence(opts, tree, deps)

	if (deps.bias && deps.bias.length) {
		opts.bias = deps.bias
	}

	// Coarse country router (#244, soft prior) — default-on (#244 M2). undefined
	// → the bundled placer. a function → that placer. false → disabled.
	// A confident in-map guess feeds the resolver's anchorPosterior re-rank. abstain/other
	// are no-ops and an explicit defaultCountry isn't disturbed.
	const placeCountry: PlaceCountryFn | null =
		deps.placeCountry === false ? null : (deps.placeCountry ?? (await loadDefaultPlaceCountry()))

	// The placer's country (in-map, non-other) — reused below to select an OSM rooftop database for a non-US parse.
	let placedCountry: string | null = null

	// The placer's prediction, computed once and unrestricted
	// (so it's available even for a bare-locality tree, where the
	// #912 change below deliberately withholds it from the anchor). Reused by that change and by the #1042 street tier's
	// country hint (a bare thoroughfare "Avenue des Champs-Élysées, Paris" is a
	// bare-locality tree — the only reliable FR signal there is this unrestricted placer).
	// Byte-stable: the anchor/hardCountry logic stays conditional exactly as before.
	const placerResult = placeCountry ? placeCountry(parseInput) : null

	const streetPlacerCountry =
		placerResult?.country && placerResult.country !== "OTHER" ? placerResult.country.toLowerCase() : null

	// #928: a distinctive postcode format outranks the language-based placer (which conflates GB/US → US
	// namesakes). When conditioned on and no explicit defaultCountry, set the country prior from the
	// parsed postcode's format. the placer block below then no-ops via its `!opts.anchorPosterior` guard.
	// Confidence 1.0 — a matched format is unambiguous. hardCountry still checks on the
	// safelist (GB isn't on it yet, so this is a soft anchorPosterior re-rank for GB —
	// enough to de-boost the US namesakes. a safelist add would make it hard, see #985).
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

	// #912 change 1: the placer abstains on a single bare locality — OOD input, and the wrong soft
	// posterior overrides the resolver's better-informed exact-tier/population ranking
	// (see isBareLocalityTree). Explicit defaultCountry / anchorPosterior from the caller are untouched.
	// #1589 extends the abstention to a bare postcode: the placer's language model reading `SW1A 1AA`
	// as English placed US at safelist confidence, and the resulting hardCountry filtered the GB row out
	// before the format-implied probe could run. The code's own format says more than its script.
	if (placeCountry && placerResult && !isBareLocalityTree(tree) && !isBarePostcodeTree(tree)) {
		const placed = placerResult
		placedCountry = placed.country && placed.country !== "OTHER" ? placed.country : null

		if (placed.country && placed.country !== "OTHER" && !opts.anchorPosterior) {
			// #1738's disagreement test, hoisted. It used to sit inside the hardCountry branch below and
			// check the hard filter only, which left the soft posterior unrestricted —
			// and the soft posterior is enough on its own: the within-tier sort
			// key is `(prominence ?? score) + w·posterior[country]` at w = 1.
			// Therefore, on `Queen Street, Bristol` a 0.9261 posterior gap overturns GB Bristol's
			// 0.884776 prominence lead and the answer moves 5,274 km to Connecticut (#1751).
			// The placer reads the street token — `King Street, Bristol` reads GB 0.5227
			// and survives, `Queen` does not — and nothing else in the tree names a country.
			//
			// One probe, read by both checks. An unknown or fuzzy bearer is not disagreement,
			// and a resolver without the findPlace passthrough behaves exactly as before.
			const localityValue = decodeAsJSON(tree).locality as string | undefined

			const dominant =
				localityValue && deps.resolver.findPlace
					? (await deps.resolver.findPlace({ text: localityValue, placetype: "locality", limit: 1 }).catch(() => []))[0]
					: undefined

			const dominantBearer = dominant?.country !== undefined && dominant.exactMatch !== false ? dominant.country : null

			const dominantDisagreesWithPlacer =
				dominantBearer !== null && dominantBearer.toUpperCase() !== placed.country.toUpperCase()

			// The full in-map distribution when supplied (resolver breaks ties); else the one-hot argmax.
			// Withheld entirely when the locality's own dominant bearer lives elsewhere: the placer is
			// then contradicting retrieval about the one component that does name a place, and retrieval wins.
			if (!dominantDisagreesWithPlacer) {
				opts.anchorPosterior = placed.posterior ?? { [placed.country]: placed.confidence }
				opts.anchorWeight = COARSE_PLACER_ANCHOR_WEIGHT
			}

			// #743/#194: default-on coverage-guarded hard country filter (same check as the runtime pipeline,
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
				// #1738: a language read is not a country verdict. The placer's languages are pluricentric —
				// French text licenses {FR, CA, be, CH, …} — and hardening on the language's home country
				// exiled the francophone-CA class ("1001 Boulevard Saint-Laurent, Montréal" answered
				// Montréal-la-Cluse, Ain: the FR hard filter excluded Québec before any race ran).
				// The promotion therefore yields when the tree's own locality names a place whose
				// dominant bearer (population-first, unscoped, exact) lives in a different country:
				// Paris under French text still hardens (the dominant Paris is in FR);
				// Montréal does not, and the placer's posterior stays the soft anchor the
				// worldwide race weighs. An unknown or fuzzy bearer is not disagreement,
				// and a resolver without the findPlace passthrough hardens exactly as before —
				// absence degrades to the prior behavior, never to a crash.
				const dominantDisagrees = dominantBearer !== null && dominantBearer.toUpperCase() !== hardCountry.toUpperCase()

				if (!dominantDisagrees) {
					opts.hardCountry = hardCountry
				}
			}
		}
	}

	// Rooftop tier for a NON-US parse, in precedence order:
	//
	//   1. National open-register (#1012) — an authoritative government address register
	//      (BAN-FR today), denser + coordinate-authoritative, so it goes ahead of OSM.
	//   2. OSM (#247) — the community fallback, only when no national register covered the country.
	//
	// Bbox fall-through is on for both: the rows carry postcode + commune but the query
	// often doesn't ("181 Rue du Chevaleret, Paris" — no postcode, and BAN communes are
	// insee-arrondissement-granular so the locality probe keys "paris" ≠ "paris 13e arrondissement").
	// The resolved locality's box then scopes the (street, number) probe. measured safe — zero
	// ambiguous (street, number) pairs across Paris arrondissements in the 2026-05-18 BAN database.
	//
	// Factored into a function because #42's postcode-country coherence can correct
	// the country after the resolve, and the corrected country then needs the same
	// selection re-run (see the second pass at the bottom).
	const rooftopFor = (country: string | undefined): AddressPointLookup | undefined => {
		if (!country || country.toLowerCase() === "us") return undefined
		const slug = country.toLowerCase()

		return deps.nationalDatabases?.(slug)?.addressPoints ?? deps.osmDatabases?.(slug)?.addressPoints
	}

	// An explicit defaultCountry wins. otherwise the coarse placer's country.
	const preResolveCountry = (deps.defaultCountry ?? placedCountry)?.toLowerCase()

	// The tag → placetype map is the country's where WOF types a tier differently
	// (TW `subregion` is a locality-band placetype rather than a county).
	// The default object is answered for every other country, so this line is byte-stable for them.
	opts.placetypeMap = placetypeMapForCountry(preResolveCountry)

	// A NON-US pre-resolve country outranks a US state-slug database match.
	// The state-slug selection above is country-blind, and AU state codes collide with US
	// postal states — 'Kingsley WA 6026' under an AU scope reads region 'WA' and opens
	// the Washington database, which can only miss. `rooftopFor` returns nothing for `us`
	// or no-evidence, so the US path is byte-stable.
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

	// National street-centroid tier (#1042): wire the country-keyed street-centroid provider
	// (BAN-FR today) + the pre-resolution country hints so a street-only query (no house number) —
	// which no rooftop tier can serve — gets a street-level coordinate instead of the
	// commune centroid. The resolver's applyStreetCentroid self-checks on no-house-number
	// (a numbered query is byte-identical) and unions these hints with the resolved-tree
	// countries, because the pre-resolution country of a bare thoroughfare is unreliable
	// (bare-locality tree / placer mis-route). US never supplies a street database,
	// so `provider("us")` is undefined and the US path stays byte-stable.
	const streetHints: string[] = []

	if (deps.nationalDatabases) {
		const provider = deps.nationalDatabases

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
		// #374 doctrine: a database that carries its own conformal multiplier (the `interp_calibration`
		// metadata table, read at open — `radiusCalibration`) is self-calibrating. the resolver
		// reads it directly and this path passes nothing. Two carve-outs preserve the ladder:
		//   1. an explicit caller number (`deps.interpCalibration` — the CLI's
		//      --interp-calibration instrument flag) still overrides the artifact, and
		//   2. a database predating the metadata table (the shipped fleet) falls back to the in-code
		//      per-region table selected by the parsed region (`stateSlug`) — byte-identical to before.
		const explicit = typeof deps.interpCalibration === "number" ? deps.interpCalibration : undefined

		const fallback =
			interpolation.radiusCalibration == null && typeof deps.interpCalibration === "object"
				? interpCalibrationForRegion(deps.interpCalibration, stateSlug)
				: undefined

		const calibration = explicit ?? fallback

		// A factor of 1 is a no-op — skipped, except as an explicit override of an artifact value ("force raw").
		if (calibration && (calibration !== 1 || (explicit !== undefined && interpolation.radiusCalibration != null))) {
			opts.interpolationRadiusCalibration = calibration
		}
	}

	// #42 postcode-country coherence, default-on at the core resolver. Propagated explicitly for the same reason
	// `adminCoherence` is — so `deps.postcodeCountryCoherence: false` stays an
	// effective opt-out rather than an unset field that re-defaults on downstream.
	// The resolver owns the verdict, and its answer is read back off the tree.
	opts.postcodeCountryCoherence = deps.postcodeCountryCoherence !== false

	for (const pin of OPT_IN_RESOLVER_PINS) {
		if (deps[pin] === true) {
			opts[pin] = true
		}
	}

	// #1717 stage 2 is promoted default-on, so an explicit `false` is the only thing that withholds it. The resolver
	// core keeps its byte-stable `=== true` read, so the default lives here
	// and in the session, where every promotion's does.
	if (deps.adminContainmentRerank !== false) {
		opts.adminContainmentRerank = true
	}

	// #2264 is not a boolean: unset is the shipped brake, so only a named reading pins it.
	if (deps.spanRescoreWeakResolution) {
		opts.spanRescoreWeakResolution = deps.spanRescoreWeakResolution
	}

	if (deps.postcodePrefixIndex) {
		opts.postcodePrefixIndex = deps.postcodePrefixIndex
	}

	let resolved = await deps.resolver.resolveTree(tree, opts)

	// Second pass, whenever the resolve settled a different country than the databases were
	// selected for. Rooftop + street-centroid databases are selected before the resolve
	// (they have to be — they're resolver inputs), off a country that can be corrected by
	// any of several mechanisms mid-resolve: the #42 coherence override and the
	// #1735 explicit pre-scope stamp receipts, but the placer and the #1684 dropped-scope worldwide race do not —
	// `92 Laurell Road, Gander, NL A1V 0A9` resolved Gander CA with no receipt
	// and sat at the city centroid while the CA rooftop database held the exact point.
	// So the trigger is the resolved tree's own country, with the receipt kept as
	// the fallback for trees whose scope changed without a resolved carrier node.
	// `opts.defaultCountry` is deliberately left alone so a receipt-driven verdict re-derives
	// identically and survives onto the returned tree. Bounded at one extra resolve.
	const scopeCountry = resolvedCountryOf(resolved) ?? postcodeCountryScopeOf(resolved)

	if (scopeCountry && scopeCountry.toLowerCase() !== preResolveCountry && !usDatabases.addressPoints) {
		const rooftop = rooftopFor(scopeCountry)
		let changed = false

		if (rooftop) {
			opts.addressPoints = rooftop
			opts.addressPointBboxFallback = true
			changed = true
		}

		// The corrected country may type a tier differently than the one the first pass resolved under.
		const scopedMap = placetypeMapForCountry(scopeCountry)

		if (scopedMap !== opts.placetypeMap) {
			opts.placetypeMap = scopedMap
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

	// ROAD_TO_V9 §4. One `classifyKindSync` over the text the parse actually saw — computed before the
	// street-miss fallback below because that fallback stands down on a declared fork (see there).
	const verdict = classifyKindSync({ raw: parseInput, normalized: parseInput }, queryShape)
	const forkDeclared = (verdict.intentMarkers ?? []).some((m) => m.code === "declared_fork")

	result = await applyStreetMissFallback(result, {
		tree,
		opts,
		deps,
		input,
		forkDeclared,
		extract: extractGeocodeResult,
	})

	applyPlusCodeOverride(result, input, resolved)

	// ROAD_TO_V9 §4 marker assembly — the verdict itself is computed above the street-miss fallback.
	const markers = [...(verdict.intentMarkers ?? [])]

	// The two resolve-time readings, side by side because they are the same question from opposite ends:
	// too many answers for the query is `declared_ambiguity`, too FEW is `declared_coarser_answer`.
	// Only the first existed, so a street parsed and a locality centroid returned came back as
	// an ordinary admin answer, indistinguishable from a correct answer to the locality alone.
	// Each returns `null` when its rule did not fire.
	const kinds = [verdict.kind, ...verdict.alternatives.map((a) => a.kind)]

	markers.push(
		...[
			declaredAmbiguityMarker({ kinds, tree: resolved, lat: result.lat, lon: result.lon }),
			coarserAnswerMarker({
				kinds,
				// Named rather than passed whole: `GeocodeResult` carries arrays and records
				// beside its component strings, and a structural pass would let a future field
				// of the wrong shape reach a reader expecting a surface form.
				components: {
					house_number: result.house_number,
					unit: result.unit,
					street: result.street,
					postcode: result.postcode,
				},
				reachedTier: result.resolution_tier,
			}),
		].filter((marker) => marker !== null)
	)

	// Entity answers (fork-entity.ts owns both probes and their checks): the declared-fork rescue
	// and the opt-in venue tier, extracted as one unit — see applyEntityTiers.
	applyEntityTiers(result, markers, parseInput, resolved.roots, deps)

	// #1989 / #1991: what each attached spatial layer designates for the coordinate this answer reached, recorded beside
	// it. Every route reads a finished result and returns a record — no candidate,
	// no ordering, no abstain — and each contributes nothing when absent,
	// so an unconfigured session produces the identical marker list.
	result.intent_markers = [...markers, ...layerDesignationMarkers(deps, result.lat, result.lon, verdict)]

	// #1901: the authoritative consult runs last, over the finished result's evidence, and attaches its answer
	// beside it. Nothing above this line reads the block, so an unconfigured
	// session skips it byte-identically.
	if (deps.authoritativeProvider) {
		const query = authoritativeQueryFrom(input, parseInput, result)

		result.authoritative = await consultAuthoritativeProvider(deps.authoritativeProvider, query)
	}

	return trace.attach(result)
}
