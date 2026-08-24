/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The warm half of `mailwoman geocode`: everything the command used to assemble inline, hoisted behind a
 *   session so a caller that geocodes more than once — the interactive debug view, a REPL, a batch loop —
 *   pays for the classifier, the gazetteer backend and the shard handles ONCE.
 *
 *   {@linkcode createGeocodeSession} runs the one-time loads in the order the CLI's error contract depends
 *   on, and each step's failure message IS that contract:
 *
 *   1. The gazetteer path (a candidate.db, else the WOF admin shards) — the most common missing prerequisite
 *        and the cheapest to check, so it reports before the multi-second weights load.
 *   2. The neural weights.
 *   3. `@mailwoman/resolver-wof-sqlite`, the optional peer carrying the SQLite backends.
 *
 *   Reordering them changes which error a half-configured install is told about.
 *
 *   {@linkcode GeocodeSession.geocode} does the per-input work — one parse, the #912/#1589 country-scope
 *   derivations that have to read the parsed tree, then the resolve — and returns the tree alongside the
 *   result, so a caller that also wants the parse (a debug view drawing spans, a PostalAddress) does not pay
 *   for the inference twice.
 *
 *   Country-scope policy lives in `country-scope.ts`, outside the CLI adapters, so constructing a session never
 *   imports React, Ink, or the parse command.
 */

import { existsSync, readFileSync } from "node:fs"

import { CoarsePlacer } from "@mailwoman/core/coarse-placer"
import type { AddressTree } from "@mailwoman/core/decoder"
import {
	isBareLocalityTree,
	isBarePostcodeTree,
	type InputMode,
	type PipelineTiming,
	type QueryKindResult,
	type FSTMatcherLike,
} from "@mailwoman/core/pipeline"
import type { ResolveNodeTrace, Resolver } from "@mailwoman/core/resolver"
import { createKindClassifier } from "@mailwoman/kind-classifier"
import { NeuralAddressClassifier, type NeuralParseTrace } from "@mailwoman/neural"
import type { QueryShape } from "@mailwoman/query-shape"
import { createWOFResolver } from "@mailwoman/resolver"
import { resolvePath } from "path-ts"

import { CommandError } from "#cli-kit"

import { resolverDefaultCountry } from "./country-scope.ts"
import {
	countriesFromPostcodeFormat,
	geocodeAddress,
	geocodeParseInputs,
	parseForGeocode,
	ShardProvider,
	type GeocodeDeps,
	type GeocodeResult,
	type ShardResolver,
	type StateShards,
} from "./geocode-core.ts"
import { INTERP_RADIUS_CALIBRATION } from "./interp-calibration.ts"
import { poiTaxonomyLookup } from "./poi-intent.ts"
import {
	createResolverBackend,
	loadCapitalIndex,
	resolveCandidateDBPath,
	resolveWOFShardPaths,
} from "./resolver-backend.ts"

//#region Contract

/**
 * The slice of the geocode command's parsed options a session reads.
 *
 * Declared structurally because the session is the lower layer; importing the CLI specification here would point the
 * dependency the wrong way. The command hands over its whole parsed options object and structural typing accepts the
 * superset. Fields with CLI defaults are required here.
 */
export interface GeocodeSessionOptions {
	/**
	 * Feed the gazetteer FST prior to the parse (#1497). **ON by default** since 2026-08-16; pass `false` to disable.
	 *
	 * Promoted on measured evidence in both arms of both batteries. Regression board 352/354 → 353/354 gated, with a
	 * row-level diff over all 209 failing rows showing exactly one fixed and ZERO broken. Parity corpus (321 fixtures)
	 * under en-US weights: every floor byte-identical, spurious `street` 13/54 → 10/54 (it stops `Perth`, `Dallas` and
	 * `California` being tagged as streets), full agreement US 54/99 → 57/99 and AU 9/20 → 10/20.
	 *
	 * The effect lands entirely in the PRECISION half that `parity-corpus.ts` documents the floors cannot see, so a
	 * floors-only reading reports "no change" — which is why the promotion rests on the full-agreement and spurious
	 * columns rather than the floor table.
	 *
	 * Known residual, carried deliberately: under fr-FR weights the US bucket moves 54/99 → 53/99. Every floor is
	 * identical there too, so that row moved on a NON-FLOOR tag. It is a US row parsed with FR weights — a pairing
	 * production does not route — and the FR bucket itself is unchanged, so the D-rule's tier-1 test is met.
	 */
	gazetteerPrior?: boolean
	locale: string
	/**
	 * Grade a CANDIDATE weights bundle instead of the installed one — a package-shaped directory
	 * (`<root>/node_modules/@mailwoman/neural-weights-<locale>/`), as staged by an eval harness or `npm install
	 * --prefix`. Unset loads whatever the resolution ladder finds, which is what production does.
	 *
	 * `resolveWeights` treats this rung as authoritative ONLY when the directory holds `model.onnx` and
	 * `tokenizer.model`; a cache missing them falls through to the installed workspace package, which in this repo always
	 * resolves. So a path typo does not fail here — it loads the SHIPPED model under the candidate's label. A caller that
	 * cannot tolerate that must check the layout before constructing the session and read
	 * {@link GeocodeSession.artifacts} back after; `missingWeightsCacheArtifacts` is the shared check.
	 */
	weightsCacheRoot?: string
	bias?: string
	defaultCountry?: string
	countryScope: "auto" | "locale" | "none"
	resolveDB?: string
	candidateDB?: string
	dataRoot: string
	addressPointsDB?: string
	interpolationDB?: string
	interpCalibration?: number
	localeCountryPrior: boolean
	placeCountry: boolean
	postcodeCountryCoherence: boolean
	forkEntity: boolean
	/**
	 * The opt-in venue tier (#1684's POI half) — see `GeocodeDeps.poiVenueTier`. Default OFF.
	 */
	poiVenueTier?: boolean
	/**
	 * The capital-status ranking axis (#1880) — bounded promotion of a NATIONAL capital among same-name candidates on the
	 * bare-toponym class (`promoteCapitals`, resolver/toponym-prior.ts — applied after the fame key, tier-safe). Reads
	 * the artifact's `capital` table, falling back to the repo's `data/gazetteer/capitals-v1.json`. Default ON (board-651
	 * receipt on PR #1888: +6/−0 with the exemption's +1 beside it); `false` disables. Unset, a missing reference
	 * degrades to no promotion; an EXPLICIT `true` throws instead, so an asked-for key can never no-op silently.
	 */
	capitalTier?: boolean
	/**
	 * #1882 — exempt own-name `variant` aliases (the holder's primary name in another orthography, stamped by the
	 * candidate build's own-name detector) from the cross-country primary-preference penalty. Candidate backend only;
	 * no-ops on an artifact without the `name_role` column. Default ON (same PR #1888 receipt); `false` disables.
	 */
	variantAliasExemption?: boolean
	postcodeShapeCoherence: boolean
	postcodeContainmentCoherence: boolean
	/**
	 * Admin-containment re-rank (#1717 stage 2) — a parsed region qualifier participates in locality-candidate selection
	 * via the candidate gazetteer's ancestors sidecar. Default OFF (D-rule); `undefined` keeps the production default.
	 */
	adminContainmentRerank?: boolean
	/**
	 * DEPRECATED NO-OP, removed at the next major. The Decision-A retry rider it controlled was retired 2026-08-19 under
	 * the #486 repair-retirement policy with a measured record of exactly zero effect (the board, its failure slice, and
	 * 600 fresh register records — #1694 holds the receipts). Accepted so existing callers keep compiling; ignored,
	 * because single-pass is now the only behavior.
	 */
	retryAlternateRegister?: boolean
	placeCountryThreshold: number
	/**
	 * Record a {@link GeocodeTrace} per input. OFF by default and NOT a command flag: the `--debug` surfaces opt in
	 * (`createGeocodeSession({ ...options, trace: true })`), and every other caller keeps the one-shot cost. Tracing
	 * spends one EXTRA decode per input (`traceParse` alongside the resolve's own parse, ~3 ms warm) — the two run the
	 * same opts through the same `#decode`, so the trace describes the decode that produced the tree, and the tree the
	 * resolver walks is still `parseForGeocode`'s.
	 */
	trace?: boolean
	/**
	 * When a lookup resolves NOTHING, re-probe the value across the other admin bands and record which hold it.
	 *
	 * DIAGNOSTIC ONLY and off by default: the answer is byte-identical either way, and what changes is that a miss can
	 * say WHY. A key we hold under another placetype is a reachability failure the model's tag caused; a key held nowhere
	 * is coverage. Both reach a caller as `null` without this, and they call for opposite work.
	 *
	 * Costs one extra backend call per band per miss and needs {@link trace}, since the record is the whole product.
	 */
	diagnoseUnreachable?: boolean
	/**
	 * Optional one-time initialization milestones for interactive callers.
	 */
	onProgress?: (message: string) => void
}

/**
 * What the model and the cheap structural stages had to say about one input — the `--debug` view's evidence rows.
 *
 * Assembled ONLY when the session was opened with {@link GeocodeSessionOptions.trace}. Every field is a value some stage
 * actually produced; there is no field here a surface has to invent a number for. What it deliberately does NOT carry
 * is a `PipelineResult`: `geocodeAddress`'s cascade is not `runPipeline` (see `geocode-core.ts`'s header — the
 * pipeline's reconcile stage drops the street node the coordinate tiers need), so the stages that never run on this
 * path — the locale gate, the phrase grouper, the POI branch — have nothing to report and are absent rather than
 * defaulted.
 */
export interface GeocodeTrace {
	/**
	 * The decode-path record for the parse this run resolved: pieces, soft-feature channels as fed, the locale head,
	 * prior participation, the viterbi path, repair diffs, final tokens.
	 */
	parse: NeuralParseTrace
	/**
	 * The Stage-2 structural priors the classifier conditioned on (known formats, segments, character class).
	 */
	queryShape: QueryShape
	/**
	 * The Stage-2.5 kind verdict {@link inputMode} was derived from — absent when a caller pinned the register (see
	 * {@link GeocodeParseInputs.kind}).
	 */
	kind?: QueryKindResult
	inputMode: InputMode
	/**
	 * The session's `--locale`, for the surface that shows the head's verdict next to the operator's assertion.
	 */
	locale: string
	/**
	 * #1721 — the resolver's interior: one record per backend lookup the walk performed, carrying the query as sent, the
	 * candidate table with per-stage ranks, the gates that fired, and the pick's provenance. An EMPTY array means the
	 * walk performed no lookups (nothing resolvable in the tree); the field is absent only when tracing was off.
	 */
	resolver: ResolveNodeTrace[]
}

/**
 * One address through the session: the geocode result plus the {@link AddressTree} it was resolved from (nodes carry
 * their start/end character offsets, which is what a span-rendering caller needs).
 */
export interface GeocodeRun {
	result: GeocodeResult
	tree: AddressTree
	/**
	 * Wall-clock milliseconds per phase — `parse`, `resolve`, `total`, plus `trace` on a session that ATTEMPTED one
	 * (present even when the attempt threw, so the phases always sum to `total`). MEASURED here rather than read off a
	 * `PipelineResult`, because this path never builds one: these are the phases the session actually runs, so a caller
	 * rendering them is reading its own clock, not a neighbouring path's.
	 */
	timing: PipelineTiming
	/**
	 * The debug evidence, present only when the session was opened with {@link GeocodeSessionOptions.trace} AND the loaded
	 * classifier could produce one. A bundle whose classifier throws on `traceParse` degrades to no trace — the geocode
	 * is the answer the caller came for, and the evidence rows report their own absence.
	 */
	trace?: GeocodeTrace
}

/**
 * A warm geocoder over one set of options. Call {@link GeocodeSession.close} when done — the gazetteer, shard, OSM and
 * poi.db handles stay open for the session's whole life, and `close` releases every one of them.
 */
export interface GeocodeSession {
	/**
	 * One-time session construction phases, in wall-clock milliseconds.
	 */
	initTiming: PipelineTiming
	/**
	 * The artifact paths this session RESOLVED, as opposed to the ones a caller asked for.
	 *
	 * Resolution walks several rungs and a missing artifact degrades silently by design, so "which file did you actually
	 * open" is not answerable from the options object. A probe reporting what the gazetteer knows has to read the same
	 * FST the decoder read, or it is describing a different system; `undefined` here means the session resolved none,
	 * which is absence and not an empty artifact.
	 */
	artifacts: {
		fstPath?: string
		streetMorphologyPath?: string
		/**
		 * The `model.onnx` the classifier loaded, and which rung of the resolution ladder produced it (`package:…`,
		 * `overlay:…`, `cache:…`, `explicit`). The pair is what makes {@link GeocodeSessionOptions.weightsCacheRoot}
		 * auditable: a candidate that fell through to the installed weights reports a `package:` source here while the
		 * options object still reads as a candidate run.
		 */
		weights?: { modelPath: string; source: string }
	}
	geocode(input: string): Promise<GeocodeRun>
	close(): void
}

//#endregion

//#region Path + flag helpers

function resolveWOFPath(options: Pick<GeocodeSessionOptions, "dataRoot" | "resolveDB">): string[] {
	// The shared shard SELECTION (explicit list, then $MAILWOMAN_WOF_DB, then the default set) with this
	// caller's own contract on top: filtered to what exists on disk — the same auto-attach the server and
	// drop-ins use, so `mailwoman geocode` works out of the box on a standard data root — and a hard error
	// when nothing survives, which is part of the CLI's construction-order contract.
	const paths = resolveWOFShardPaths(options.resolveDB, options.dataRoot).filter((p: string) => existsSync(p))

	if (!paths.length) {
		throw new CommandError(
			`geocode found no resolver database under ${options.dataRoot}. Run \`mailwoman data pull candidate\`, ` +
				"set $MAILWOMAN_DATA_ROOT, or pass --candidate-db / --resolve-db."
		)
	}

	return paths
}

/**
 * `--bias 'lat,lon[:weight];…'` → ordered soft proximity hints (viewport first by convention).
 */
function parseBiasPoints(raw: string | undefined): NonNullable<GeocodeDeps["bias"]> {
	return (raw ?? "")
		.split(";")
		.map((part: string) => part.trim())
		.filter((part) => part.length > 0)
		.map((part: string) => {
			const [coords, w] = part.split(":")
			const [lat, lon] = coords!.split(",").map(Number)

			if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new CommandError(`--bias: bad point '${part}'`)

			return { lat: lat!, lon: lon!, ...(w != null ? { weight: Number(w) } : {}) }
		})
}

export interface ForkEntityProbe {
	deps: Pick<GeocodeDeps, "poiLookup" | "isStreetGeneric">
	/**
	 * The poi.db handle behind {@link deps}' `poiLookup`, so the session can release it. Carried separately because
	 * `POIExecutorLookup` is a read interface and declares no `close`.
	 */
	handle?: { close(): void }
}

/**
 * The fork→entity probe's two signals — both or neither (an ungated probe is the Savile Row hijack; fork-entity.ts gate
 * 2). Tolerate-and-degrade: no poi.db in the data root, no probe.
 */
export async function loadForkEntityDeps(
	options: Pick<GeocodeSessionOptions, "dataRoot" | "forkEntity">
): Promise<ForkEntityProbe> {
	const poiDBPath = resolvePath(options.dataRoot, "poi", "poi.db")

	if (options.forkEntity === false || !existsSync(poiDBPath)) return { deps: {} }

	const [{ POILookup }, { loadStreetMorphologyFST }] = await Promise.all([
		import("@mailwoman/resolver-wof-sqlite/poi-lookup"),
		import("@mailwoman/resolver-wof-sqlite/street-morphology-fst-loader"),
	])

	const morphology = loadStreetMorphologyFST()
	const poiLookup = new POILookup({ databasePath: poiDBPath })

	return {
		deps: {
			poiLookup,
			isStreetGeneric: (token: string) => morphology.matcher.walk([token]) !== null,
		},
		handle: poiLookup,
	}
}

//#endregion

//#region Session

export async function createGeocodeSession(options: GeocodeSessionOptions): Promise<GeocodeSession> {
	const initStartedAt = performance.now()
	const progress = options.onProgress ?? (() => {})

	progress("Checking gazetteer…")
	// Resolve the gazetteer path FIRST — it's the most common missing prerequisite and the cheapest to
	// check, so surface that error before the (slower) weights load. (Order matters for the CLI contract:
	// a missing gazetteer must report the gazetteer error even when the weights are also absent.) A
	// candidate.db (--candidate-db / $MAILWOMAN_CANDIDATE_DB) is the demo-parity backend; when present it
	// stands alone and a WOF admin path isn't required.
	const candidateDB = resolveCandidateDBPath(options.candidateDB, options.dataRoot)
	const wofPath = candidateDB ? [] : resolveWOFPath(options)
	const pathsResolvedAt = performance.now()

	// Load the neural classifier (required for street-level; weights must be present).
	progress("Loading neural model…")

	let classifier: NeuralAddressClassifier

	try {
		// #1732 reach half: the session's dataRoot is authoritative for EVERYTHING it loads, weights and
		// their FSTs included. Before this line threaded it, a data_root override moved the gazetteer but
		// weights silently resolved from the process env — so a dev-mcp engine with data_root set measured
		// a mixed configuration, and no A/B seam for a staged FST existed on the warm path at all.
		classifier = await NeuralAddressClassifier.loadFromWeights({
			locale: options.locale,
			overlayRoot: resolvePath(options.dataRoot, "weights"),
			// Ahead of the overlay in the ladder rather than beside it: a caller naming a candidate bundle is naming
			// the thing under test, and an overlay silently winning would grade the artifact they were replacing.
			...(options.weightsCacheRoot ? { cacheRoot: options.weightsCacheRoot } : {}),
		})
	} catch {
		throw new CommandError(
			"geocode requires the neural weights. Install @mailwoman/neural-weights-en-us (or pass --locale with installed weights)."
		)
	}

	// #1497: the prior the geocode path has never had. Loaded from the classifier's own weights-package sibling, the
	// same artifact `runPipeline` auto-loads — one source, not a second resolution ladder. A failure degrades to
	// `undefined`, which is exactly the pre-#1497 behaviour.
	let fst: FSTMatcherLike | undefined
	let streetMorphology: FSTMatcherLike | undefined

	// Default-on: only an explicit `false` disables it.
	if (options.gazetteerPrior !== false) {
		const [{ deserializeFST }, { loadStreetMorphologyFST }] = await Promise.all([
			import("@mailwoman/resolver-wof-sqlite/fst-serialize"),
			import("@mailwoman/resolver-wof-sqlite/street-morphology-fst-loader"),
		])

		const fstPath = classifier.fstPath

		if (fstPath) {
			try {
				fst = deserializeFST(readFileSync(fstPath))
			} catch (error) {
				console.warn(`[mailwoman] failed to load the gazetteer FST at ${fstPath}: ${(error as Error).message}`)
			}
		}

		if (!fst) {
			// #1516's shape, one channel over: a requested prior that resolves no artifact leaves the channel OFF, scores
			// several cases lower, and has NO signal of its own — so the operator reads a model regression. Five shipped
			// overlays have no FST at all (#1705), which makes this the common case rather than the exotic one.
			console.warn(
				`[mailwoman] --gazetteer-prior was requested for locale ${options.locale} but no FST artifact resolved` +
					`${classifier.fstPath ? ` at ${classifier.fstPath}` : " (the weights package ships none)"} — the gazetteer ` +
					"channel is OFF for this run. Results are the base model's, not the prior's."
			)
		}

		if (fst) {
			try {
				streetMorphology = loadStreetMorphologyFST({
					...(classifier.streetMorphologyPath ? { artifactPath: classifier.streetMorphologyPath } : {}),
					onWarn: (message) => console.warn(`[mailwoman] ${message}`),
				}).matcher
			} catch (error) {
				console.warn(`[mailwoman] street-morphology FST unavailable: ${(error as Error).message} — gate off`)
			}
		}
	}

	const weightsLoadedAt = performance.now()

	// Open the WOF admin resolver + the situs/interpolation shard provider.
	progress("Opening resolver…")

	let mod: typeof import("@mailwoman/resolver-wof-sqlite")

	try {
		mod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		throw new CommandError(
			"geocode requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
				"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
		)
	}

	const resolverImportedAt = performance.now()

	const lookup = createResolverBackend(mod, {
		candidateDB,
		dataRoot: options.dataRoot,
		wofPaths: wofPath,
		...(options.variantAliasExemption !== false ? { variantAliasExemption: true } : {}),
	})

	// #1880: the capital-status reference, loaded once per session. Explicit `true` demands the
	// reference (throw on absence); the default tolerates an older artifact by degrading to no
	// promotion. The closure answers per candidate (name + country + coordinates) and threads into
	// the resolver's bounded capital promotion via GeocodeDeps.capitalLevel.
	const capitals =
		options.capitalTier === false
			? undefined
			: loadCapitalIndex({ candidateDB, missing: options.capitalTier === true ? "throw" : "degrade" })

	const capitalLevel = capitals
		? (place: { name: string; country?: string; lat: number; lon: number }): number =>
				capitals.levelOfPlace(place.name, place.country, place.lat, place.lon)
		: undefined

	const shardProvider = new ShardProvider(mod, options.dataRoot)
	// Explicit --address-points-db / --interpolation-db flags override per-state selection (testing a
	// specific file); an unset tier still falls back to the region-derived per-state shard. The street-key
	// locale follows --locale's region (fr-FR → "fr") — the shard's keys were built with its country's
	// normalizer, and a "us"-keyed probe against an FR shard silently misses wherever the rules diverge.
	const explicitApLocale = options.locale.split("-")[1]?.toLowerCase() === "fr" ? ("fr" as const) : ("us" as const)

	const explicitAp = options.addressPointsDB
		? new mod.AddressPointSqliteLookup(options.addressPointsDB, { streetLocale: explicitApLocale })
		: undefined

	const explicitIp = options.interpolationDB
		? new mod.StreetInterpolator({ dbPath: options.interpolationDB })
		: undefined

	const shards: ShardResolver =
		explicitAp || explicitIp
			? (slug) => {
					const base = explicitAp && explicitIp ? {} : shardProvider.for(slug)

					return { addressPoints: explicitAp ?? base.addressPoints, interpolation: explicitIp ?? base.interpolation }
				}
			: shardProvider.for

	const backendsOpenedAt = performance.now()
	progress("Loading optional data providers…")

	// National open-register rooftop tier (#1012): BAN-FR ahead of the OSM tier for a non-US parse. Optional
	// like the resolver backend above — absent `@mailwoman/ban` ⇒ no national tier (admin/OSM path unchanged),
	// and the provider itself is a no-op when the shard isn't on disk. Keeps the CLI backend-agnostic.
	let nationalShards: ((country: string) => StateShards) | undefined

	try {
		const { BANShardProvider } = await import("@mailwoman/ban/sdk")
		nationalShards = new BANShardProvider(options.dataRoot).for
	} catch {
		nationalShards = undefined
	}

	// Build-local OSM rooftop tier (#247), behind the package + on-disk-shard boundary. The provider
	// applies the country's street normalizer and enables the resolver's locality-bbox fall-through;
	// an absent unpublished @mailwoman/osm package or absent shard remains an admin-only no-op.
	let osmProvider: { for: (country: string) => StateShards; close(): void } | undefined

	try {
		const { OSMShardProvider } = await import("@mailwoman/osm/sdk")
		osmProvider = new OSMShardProvider(options.dataRoot)
	} catch {
		osmProvider = undefined
	}

	const optionalProvidersLoadedAt = performance.now()

	let poiHandle: { close(): void } | undefined

	const closeQuietly = (handle: { close(): void } | undefined): void => {
		try {
			handle?.close()
		} catch {
			// A handle that refuses to close must not strand the others open.
		}
	}

	const close = (): void => {
		closeQuietly(explicitAp)
		closeQuietly(explicitIp)
		closeQuietly(shardProvider)
		closeQuietly(osmProvider)
		closeQuietly(lookup)
		closeQuietly(poiHandle)
	}

	// Everything past this point can THROW while the handles above are already open, so it runs behind the
	// release the per-input path gets. ORDER inside the guard is the contract, not an implementation detail:
	// a coarse-placer or --bias failure still reports after the gazetteer, weights and resolver-package
	// checks, never in front of them.
	let placer: CoarsePlacer | undefined
	let resolver: Resolver
	let bias: NonNullable<GeocodeDeps["bias"]>
	let forkEntityDeps: Pick<GeocodeDeps, "poiLookup" | "isStreetGeneric">

	// #1649: the lexicon-aware kind classifier — same construction as the runtime pipeline's default-ON
	// POI arc, so a thing-query ("Statue of Liberty", "Pharmacy near me") abstains with intent markers
	// instead of the address lanes manufacturing a confident wrong answer.
	const kindClassifierWithLexicon = createKindClassifier({ poiLexicon: poiTaxonomyLookup })

	// The locale rides in the closure: category synonyms are locale-gated ("mailbox" is the en-US
	// register of post_box), and the geocode-core dep signature stays two-argument.
	const poiKindClassifier: NonNullable<GeocodeDeps["classifyKind"]> = (input, shape) =>
		kindClassifierWithLexicon(input, shape, {
			locale: options.locale ?? "en-US",
			confidence: 1,
			alternatives: [],
			source: "caller",
		})

	try {
		progress("Loading geographic priors…")

		// Coarse-placer soft country prior (#244) — opt-in. Loads the int8 model bundled in @mailwoman/core
		// at the requested abstention threshold; a confident in-map guess feeds the resolver's anchorPosterior.
		// The M2 open-set reject rule (reject on in-map MASS 1-P(OTHER), route on the in-map argmax) lifts in-map
		// right-country 85.3→91.2% with 0 regressions / 0 misroutes (the pipeline + misroute gates), so it's ON
		// by default. --no-place-country disables it (passes `false`); a custom --place-country-threshold builds
		// an explicit placer instead of the default-on bundled one.
		placer = options.placeCountry
			? await CoarsePlacer.fromBundled({ abstainBelow: options.placeCountryThreshold, openSet: true })
			: undefined

		resolver = createWOFResolver(lookup)
		bias = parseBiasPoints(options.bias)

		const probe = await loadForkEntityDeps(options)

		forkEntityDeps = probe.deps
		poiHandle = probe.handle
	} catch (error) {
		close()

		throw error
	}

	const initializedAt = performance.now()
	progress("Ready; geocoding…")

	const initTiming: PipelineTiming = {
		paths: pathsResolvedAt - initStartedAt,
		weights: weightsLoadedAt - pathsResolvedAt,
		resolver_import: resolverImportedAt - weightsLoadedAt,
		backends: backendsOpenedAt - resolverImportedAt,
		optional_providers: optionalProvidersLoadedAt - backendsOpenedAt,
		placer_and_priors: initializedAt - optionalProvidersLoadedAt,
		total: initializedAt - initStartedAt,
	}

	/**
	 * The parse dependencies, built ONCE. `parseForGeocode` and `geocodeParseInputs` must be handed the same object:
	 * every field on it (`normalizeInput`, `normalizeCase`, `inputMode`) changes what the classifier is given, so two
	 * separately-built dep objects are two decodes that can silently diverge — which is the exact failure the shared
	 * derivation exists to prevent.
	 *
	 * `fst` and `streetMorphology` belong here for a reason the type alone does not show. This path parses ONCE up front
	 * and hands the tree to `geocodeAddress` as `parsedTree`, so `geocodeAddress` never re-parses — which means the
	 * copies it receives are dead and THIS is the only parse the prior can reach. Omitting them here made
	 * `--gazetteer-prior` construct the FST, pass it on, and change nothing: bare `Moscow` stayed `street` in both arms.
	 */
	const parseDeps: Pick<
		GeocodeDeps,
		"classifier" | "normalizeInput" | "normalizeCase" | "inputMode" | "fst" | "streetMorphology"
	> = {
		classifier,
		...(fst ? { fst } : {}),
		...(streetMorphology ? { streetMorphology } : {}),
	}

	/**
	 * The debug evidence for one input, or undefined when tracing is off. Runs `traceParse` under the SAME opts
	 * `parseForGeocode` just used ({@link geocodeParseInputs} is the shared derivation), so the record describes this
	 * input's decode rather than a re-derived one.
	 */
	const traceOf = async (input: string): Promise<Omit<GeocodeTrace, "resolver"> | undefined> => {
		if (!options.trace) return undefined

		const inputs = geocodeParseInputs(input, parseDeps)

		try {
			return {
				parse: await classifier.traceParse(inputs.parseInput, inputs.opts),
				queryShape: inputs.queryShape,
				...(inputs.kind ? { kind: inputs.kind } : {}),
				inputMode: inputs.inputMode,
				locale: options.locale,
			}
		} catch {
			// Evidence is never worth the answer: a bundle that can't trace still geocodes, and the surface
			// renders its rows as absent instead of the whole run failing.
			return undefined
		}
	}

	const geocode = async (input: string): Promise<GeocodeRun> => {
		const startedAt = performance.now()

		// #912 lever 3: parse ONCE up front (shared into geocodeAddress via parsedTree — no re-parse)
		// so a single bare locality can skip the locale-INFERRED default country. "Paris" under the
		// en-US locale must not be hard-scoped to Paris, Texas; an explicit --default-country still
		// wins (resolverDefaultCountry returns it before the locale inference is consulted).
		const parsedTree = await parseForGeocode(input, parseDeps)
		const parsedAt = performance.now()
		const trace = await traceOf(input)
		const tracedAt = performance.now()
		// #1721: the resolver-interior records for THIS call. A fresh array per call (the deps spread below
		// carries it), so concurrent geocodes on one session never interleave their records.
		const resolverTrace: ResolveNodeTrace[] = []

		// #1589, the #912 guard's sibling: a bare POSTCODE whose format implies countries that exclude
		// the locale-inferred one must not be hard-scoped by the locale. `SW1A 1AA` under the default
		// en-US locale was scoped to US and resolved nothing while the gazetteer held the GB row; the
		// code's own format is harder evidence than the locale hint. An explicit --default-country
		// still wins (checked first, same as #912), and the bare 5-digit family implies no countries
		// (countriesFromPostcodeFormat returns []) so the 75008 locale-prior contract is untouched.
		const barePostcodeFormatConflict = (): boolean => {
			if (!isBarePostcodeTree(parsedTree)) return false
			const inferred = resolverDefaultCountry(options, !!candidateDB)

			if (!inferred) return false
			let postcodeValue: string | undefined
			const stack = [...parsedTree.roots]

			while (stack.length) {
				const node = stack.pop()!

				if (node.tag === "postcode") {
					postcodeValue = node.value

					break
				}

				stack.push(...node.children)
			}

			const implied = countriesFromPostcodeFormat(postcodeValue)

			return implied.length > 0 && !implied.includes(inferred)
		}

		const inferredScopeOK = options.defaultCountry || (!isBareLocalityTree(parsedTree) && !barePostcodeFormatConflict())

		// #27: the country #912 just withheld. `inferredScopeOK` false is precisely "we HAVE a locale
		// country and chose not to scope by it", so this is the one place that knows the value was
		// dropped rather than never derived. Handed on as a soft prior (never a filter) when the operator
		// opts in with --locale-country-prior; the resolver additionally ignores it under any hard scope.
		const withheldCountry = inferredScopeOK ? undefined : resolverDefaultCountry(options, !!candidateDB)

		const result = await geocodeAddress(input, {
			classifier,
			...(fst ? { fst } : {}),
			...(streetMorphology ? { streetMorphology } : {}),
			resolver,
			shards,
			...(nationalShards ? { nationalShards } : {}),
			...(osmProvider ? { osmShards: osmProvider.for } : {}),
			parsedTree,
			...(bias.length ? { bias } : {}),
			defaultCountry: (inferredScopeOK && resolverDefaultCountry(options, !!candidateDB)) || undefined,
			// The street-miss fallback's #912 posture switch: explicit --default-country stays supreme
			// through the retry; a locale-inferred scope is withheld there like any bare-locality walk.
			defaultCountryIsInferred: !options.defaultCountry,
			...(options.localeCountryPrior && withheldCountry ? { localeCountryPrior: withheldCountry } : {}),
			// #1880 opt-in: default-OFF downstream, so only the loaded closure needs threading.
			...(capitalLevel ? { capitalLevel } : {}),
			// #1585: the locale hint's country scopes the typo-fuzzy tier — threaded UNCONDITIONALLY, including where
			// the #912 guard withholds the hard scope (the withheld case is the one the restriction exists for).
			...(resolverDefaultCountry(options, !!candidateDB)
				? { fuzzyCountryScope: resolverDefaultCountry(options, !!candidateDB) || undefined }
				: {}),
			// #42: default-ON since 2026-08-05, so only the explicit --no-postcode-country-coherence opt-out needs
			// threading (an unset dep already reads as ON downstream).
			...(options.postcodeCountryCoherence === false ? { postcodeCountryCoherence: false } : {}),
			// #31 opt-in mechanisms: default-OFF downstream, so only the explicit opt-in needs threading.
			...(options.postcodeShapeCoherence === true ? { postcodeShapeCoherence: true } : {}),
			...(options.postcodeContainmentCoherence === true ? { postcodeContainmentCoherence: true } : {}),
			// #1717 stage 2, PROMOTED default-ON 2026-08-18 (evidence doc in docs/records/evals/). BOTH
			// directions forwarded explicitly: the first draft's `!== false ? {true} : {}` dropped the
			// opt-out on the floor, and geocode-core's own default-on resurrected it — the #1706
			// one-sided-forwarding class, caught by the promotion's confirmation battery reading
			// "0 of 558 differed" between the opt-out arm and the default.
			adminContainmentRerank: options.adminContainmentRerank !== false,
			// Explicit --interp-calibration forces a single multiplier; unset → the per-region table (#584).
			interpCalibration: options.interpCalibration ?? INTERP_RADIUS_CALIBRATION,
			// Enabled → our threshold-honoring placer; --no-place-country → `false` (disable the default-on prior).
			placeCountry: placer ? (t: string) => placer.predict(t) : false,
			// #1649: the lexicon-aware kind classifier — a thing-query abstains instead of resolving nonsense.
			classifyKind: poiKindClassifier,
			...forkEntityDeps,
			// The opt-in venue tier reuses the fork-entity wiring's poiLookup; the flag alone opts in.
			...(options.poiVenueTier === true ? { poiVenueTier: true } : {}),
			...(trace ? { resolveTraceSink: (record) => resolverTrace.push(record) } : {}),
			...(trace && options.diagnoseUnreachable ? { diagnoseUnreachable: true } : {}),
		})

		const finishedAt = performance.now()

		return {
			result,
			tree: parsedTree,
			timing: {
				parse: parsedAt - startedAt,
				// Present whenever tracing was ATTEMPTED, including the attempt that threw — its milliseconds are
				// real and were spent, and hiding them inside `total` would leave the phases not summing to it
				// (`meaning of zero`: a trace entry of 12 ms next to an absent trace says the attempt failed and
				// what it cost, which is a different fact from "tracing was off").
				...(options.trace ? { trace: tracedAt - parsedAt } : {}),
				resolve: finishedAt - tracedAt,
				total: finishedAt - startedAt,
			},
			...(trace ? { trace: { ...trace, resolver: resolverTrace } } : {}),
		}
	}

	return {
		initTiming,
		// The paths the FST block above actually opened, not the ones it was asked for — see `GeocodeSession.artifacts`.
		artifacts: {
			...(fst && classifier.fstPath ? { fstPath: classifier.fstPath } : {}),
			...(streetMorphology && classifier.streetMorphologyPath
				? { streetMorphologyPath: classifier.streetMorphologyPath }
				: {}),
			...(classifier.resolvedWeights ? { weights: classifier.resolvedWeights } : {}),
		},
		geocode,
		close,
	}
}

//#endregion
