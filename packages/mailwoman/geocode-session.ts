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
import { $public } from "@mailwoman/core/env"
import {
	isBareLocalityTree,
	isBarePostcodeTree,
	type InputMode,
	type PipelineTiming,
	type QueryKindResult,
	type FSTMatcherLike,
} from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/core/resolver"
import { createKindClassifier } from "@mailwoman/kind-classifier"
import { NeuralAddressClassifier, type NeuralParseTrace } from "@mailwoman/neural"
import type { QueryShape } from "@mailwoman/query-shape"
import { createWOFResolver } from "@mailwoman/resolver"
import { CommandError } from "mailwoman/cli-kit"
import { resolvePath } from "path-ts"

import { resolverDefaultCountry } from "./country-scope.ts"
import {
	countriesFromPostcodeFormat,
	geocodeAddress,
	geocodeParseInputs,
	parseForGeocode,
	ShardProvider,
	type GeocodeDeps,
	type GeocodeParseInputs,
	type GeocodeResult,
	type ShardResolver,
	type StateShards,
} from "./geocode-core.ts"
import { INTERP_RADIUS_CALIBRATION } from "./interp-calibration.ts"
import { poiTaxonomyLookup } from "./poi-intent.ts"
import { createResolverBackend, resolveCandidateDBPath, wofShardPaths } from "./resolver-backend.ts"

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
	 * Feed the gazetteer FST prior to the parse (#1497). OFF by default: this path has never constructed the prior —
	 * `classifier.parse` reads `fst` from opts only and this path passed none — so turning it on is a decode change, not
	 * a repair, and it stays opt-in until measured on the board.
	 */
	gazetteerPrior?: boolean
	locale: string
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
	postcodeShapeCoherence: boolean
	postcodeContainmentCoherence: boolean
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
	geocode(input: string): Promise<GeocodeRun>
	close(): void
}

//#endregion

//#region Path + flag helpers

function resolveWOFPath(options: Pick<GeocodeSessionOptions, "dataRoot" | "resolveDB">): string[] {
	// Comma-separated multi-shard paths (the HealthRouter/$MAILWOMAN_WOF_DB convention), else the
	// wofShardPaths default set filtered to what exists on disk — the same auto-attach the server
	// and drop-ins use, so `mailwoman geocode` works out of the box on a standard data root.
	const raw = options.resolveDB ?? $public.MAILWOMAN_WOF_DB

	const paths = (
		raw
			? raw
					.split(",")
					.map((p: string) => p.trim())
					.filter(Boolean)
			: wofShardPaths(options.dataRoot)
	).filter((p: string) => existsSync(p))

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
		.filter(Boolean)
		.map((part: string) => {
			const [coords, w] = part.split(":")
			const [lat, lon] = coords!.split(",").map(Number)

			if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new CommandError(`--bias: bad point '${part}'`)

			return { lat: lat!, lon: lon!, ...(w != null ? { weight: Number(w) } : {}) }
		})
}

interface ForkEntityProbe {
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
async function loadForkEntityDeps(
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
		classifier = await NeuralAddressClassifier.loadFromWeights({ locale: options.locale })
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

	if (options.gazetteerPrior) {
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

	const lookup = createResolverBackend(mod, { candidateDB, dataRoot: options.dataRoot, wofPaths: wofPath })
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
	const traceOf = async (input: string): Promise<GeocodeTrace | undefined> => {
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
			// Explicit --interp-calibration forces a single multiplier; unset → the per-region table (#584).
			interpCalibration: options.interpCalibration ?? INTERP_RADIUS_CALIBRATION,
			// Enabled → our threshold-honoring placer; --no-place-country → `false` (disable the default-on prior).
			placeCountry: placer ? (t: string) => placer.predict(t) : false,
			// #1649: the lexicon-aware kind classifier — a thing-query abstains instead of resolving nonsense.
			classifyKind: poiKindClassifier,
			...forkEntityDeps,
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
			...(trace ? { trace } : {}),
		}
	}

	return { initTiming, geocode, close }
}

//#endregion
