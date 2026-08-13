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
 *   This module reaches into the `parse` command for `resolverDefaultCountry`, so it carries a JSX
 *   dependency and bare node cannot type-strip it. It must not gain a package `exports` entry with a
 *   `node → .ts` condition until that function has a non-command home.
 */

import { existsSync } from "node:fs"

import { CoarsePlacer } from "@mailwoman/core/coarse-placer"
import type { AddressTree } from "@mailwoman/core/decoder"
import { $public } from "@mailwoman/core/env"
import { isBareLocalityTree, isBarePostcodeTree } from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/core/resolver"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { commandError } from "mailwoman/cli-kit"

import { resolverDefaultCountry } from "./commands/parse.tsx"
import {
	countriesFromPostcodeFormat,
	geocodeAddress,
	parseForGeocode,
	ShardProvider,
	type GeocodeDeps,
	type GeocodeResult,
	type ShardResolver,
	type StateShards,
} from "./geocode-core.ts"
import { INTERP_RADIUS_CALIBRATION } from "./interp-calibration.ts"
import { createResolverBackend, resolveCandidateDBPath, wofShardPaths } from "./resolver-backend.ts"

//#region Contract

/**
 * The slice of the geocode command's parsed options a session reads.
 *
 * Declared structurally rather than as `zod.infer<typeof OptionsSchema>`: the session is the lower layer, and naming
 * the command's schema here would point the dependency the wrong way. The command hands over its whole parsed options
 * object and structural typing accepts the superset — the field types are copied from the schema, so a default in the
 * schema shows up here as a required field.
 */
export interface GeocodeSessionOptions {
	locale: string
	bias?: string
	defaultCountry?: string
	countryScope: "auto" | "locale" | "none"
	resolveDb?: string
	candidateDb?: string
	dataRoot: string
	addressPointsDb?: string
	interpolationDb?: string
	interpCalibration?: number
	localeCountryPrior: boolean
	placeCountry: boolean
	postcodeCountryCoherence: boolean
	forkEntity: boolean
	postcodeShapeCoherence: boolean
	postcodeContainmentCoherence: boolean
	placeCountryThreshold: number
}

/**
 * One address through the session: the geocode result plus the {@link AddressTree} it was resolved from (nodes carry
 * their start/end character offsets, which is what a span-rendering caller needs).
 */
export interface GeocodeRun {
	result: GeocodeResult
	tree: AddressTree
}

/**
 * A warm geocoder over one set of options. Call {@link GeocodeSession.close} when done — the gazetteer, shard, OSM and
 * poi.db handles stay open for the session's whole life, and `close` releases every one of them.
 */
export interface GeocodeSession {
	geocode(input: string): Promise<GeocodeRun>
	close(): void
}

//#endregion

//#region Path + flag helpers

function resolveWOFPath(options: Pick<GeocodeSessionOptions, "resolveDb">): string[] {
	// Comma-separated multi-shard paths (the HealthRouter/$MAILWOMAN_WOF_DB convention), else the
	// wofShardPaths default set filtered to what exists on disk — the same auto-attach the server
	// and drop-ins use, so `mailwoman geocode` works out of the box on a standard data root.
	const raw = options.resolveDb ?? $public.MAILWOMAN_WOF_DB

	const paths = (
		raw
			? raw
					.split(",")
					.map((p: string) => p.trim())
					.filter(Boolean)
			: wofShardPaths()
	).filter((p: string) => existsSync(p))

	if (!paths.length) {
		throw commandError(
			"geocode needs a WOF admin SQLite path. Set $MAILWOMAN_WOF_DB or pass --resolve-db <path>. " +
				"Build one with `mailwoman gazetteer build admin` + `mailwoman gazetteer build fts`."
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

			if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw commandError(`--bias: bad point '${part}'`)

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
async function loadForkEntityDeps(options: Pick<GeocodeSessionOptions, "forkEntity">): Promise<ForkEntityProbe> {
	const poiDBPath = String(dataRootPath("poi", "poi.db"))

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
	// Resolve the gazetteer path FIRST — it's the most common missing prerequisite and the cheapest to
	// check, so surface that error before the (slower) weights load. (Order matters for the CLI contract:
	// a missing gazetteer must report the gazetteer error even when the weights are also absent.) A
	// candidate.db (--candidate-db / $MAILWOMAN_CANDIDATE_DB) is the demo-parity backend; when present it
	// stands alone and a WOF admin path isn't required.
	const candidateDb = resolveCandidateDBPath(options.candidateDb)
	const wofPath = candidateDb ? [] : resolveWOFPath(options)

	// Load the neural classifier (required for street-level; weights must be present).
	let classifier: NeuralAddressClassifier

	try {
		classifier = await NeuralAddressClassifier.loadFromWeights({ locale: options.locale })
	} catch {
		throw commandError(
			"geocode requires the neural weights. Install @mailwoman/neural-weights-en-us (or pass --locale with installed weights)."
		)
	}

	// Open the WOF admin resolver + the situs/interpolation shard provider.
	let mod: typeof import("@mailwoman/resolver-wof-sqlite")

	try {
		mod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		throw commandError(
			"geocode requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
				"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
		)
	}

	const lookup = createResolverBackend(mod, { candidateDb: options.candidateDb, wofPaths: wofPath })
	const shardProvider = new ShardProvider(mod, options.dataRoot)
	// Explicit --address-points-db / --interpolation-db flags override per-state selection (testing a
	// specific file); an unset tier still falls back to the region-derived per-state shard. The street-key
	// locale follows --locale's region (fr-FR → "fr") — the shard's keys were built with its country's
	// normalizer, and a "us"-keyed probe against an FR shard silently misses wherever the rules diverge.
	const explicitApLocale = options.locale.split("-")[1]?.toLowerCase() === "fr" ? ("fr" as const) : ("us" as const)

	const explicitAp = options.addressPointsDb
		? new mod.AddressPointSqliteLookup(options.addressPointsDb, { streetLocale: explicitApLocale })
		: undefined

	const explicitIp = options.interpolationDb
		? new mod.StreetInterpolator({ dbPath: options.interpolationDb })
		: undefined

	const shards: ShardResolver =
		explicitAp || explicitIp
			? (slug) => {
					const base = explicitAp && explicitIp ? {} : shardProvider.for(slug)

					return { addressPoints: explicitAp ?? base.addressPoints, interpolation: explicitIp ?? base.interpolation }
				}
			: shardProvider.for

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

	try {
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

	const geocode = async (input: string): Promise<GeocodeRun> => {
		// #912 lever 3: parse ONCE up front (shared into geocodeAddress via parsedTree — no re-parse)
		// so a single bare locality can skip the locale-INFERRED default country. "Paris" under the
		// en-US locale must not be hard-scoped to Paris, Texas; an explicit --default-country still
		// wins (resolverDefaultCountry returns it before the locale inference is consulted).
		const parsedTree = await parseForGeocode(input, { classifier })

		// #1589, the #912 guard's sibling: a bare POSTCODE whose format implies countries that exclude
		// the locale-inferred one must not be hard-scoped by the locale. `SW1A 1AA` under the default
		// en-US locale was scoped to US and resolved nothing while the gazetteer held the GB row; the
		// code's own format is harder evidence than the locale hint. An explicit --default-country
		// still wins (checked first, same as #912), and the bare 5-digit family implies no countries
		// (countriesFromPostcodeFormat returns []) so the 75008 locale-prior contract is untouched.
		const barePostcodeFormatConflict = (): boolean => {
			if (!isBarePostcodeTree(parsedTree)) return false
			const inferred = resolverDefaultCountry(options, !!candidateDb)

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
		const withheldCountry = inferredScopeOK ? undefined : resolverDefaultCountry(options, !!candidateDb)

		const result = await geocodeAddress(input, {
			classifier,
			resolver,
			shards,
			...(nationalShards ? { nationalShards } : {}),
			...(osmProvider ? { osmShards: osmProvider.for } : {}),
			parsedTree,
			...(bias.length ? { bias } : {}),
			defaultCountry: (inferredScopeOK && resolverDefaultCountry(options, !!candidateDb)) || undefined,
			// The street-miss fallback's #912 posture switch: explicit --default-country stays supreme
			// through the retry; a locale-inferred scope is withheld there like any bare-locality walk.
			defaultCountryIsInferred: !options.defaultCountry,
			...(options.localeCountryPrior && withheldCountry ? { localeCountryPrior: withheldCountry } : {}),
			// #1585: the locale hint's country scopes the typo-fuzzy tier — threaded UNCONDITIONALLY, including where
			// the #912 guard withholds the hard scope (the withheld case is the one the restriction exists for).
			...(resolverDefaultCountry(options, !!candidateDb)
				? { fuzzyCountryScope: resolverDefaultCountry(options, !!candidateDb) || undefined }
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
			...forkEntityDeps,
		})

		return { result, tree: parsedTree }
	}

	return { geocode, close }
}

//#endregion
