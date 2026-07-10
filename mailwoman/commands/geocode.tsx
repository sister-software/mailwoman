/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman geocode "<address>" [flags]` — end-to-end street-level geocoder.
 *
 *   Pipeline:
 *
 *   1. Parse the address with the neural classifier (same path as `parse` command).
 *   2. Resolve admin hierarchy via `createWOFResolver(WOFSqlitePlaceLookup)`.
 *   3. Augment with per-state address-point (situs) + interpolation shards, selected from the resolved
 *        region. Both are optional — absent shards degrade gracefully to admin-only.
 *   4. Extract the best available coordinate + resolution tier from the resolved tree and emit a flat
 *        geocode result object.
 *
 *   Resolution tiers (best → worst):
 *
 *   - `address_point` — exact situs coordinate from the address-points shard
 *   - `interpolated` — house-number estimate from the interpolation shard
 *   - `admin` — admin centroid from the WOF gazetteer
 *
 *   Exit-code contract:
 *
 *   - 0 successful geocode (including admin-only degradation when shards are absent)
 *   - 1 bad arguments, missing required DB, or fatal parse/resolve error
 */

import { existsSync } from "node:fs"

import { Spinner } from "@inkjs/ui"
import { type SchemaOrgPlace, toSchemaOrg } from "@mailwoman/annotations"
import { CoarsePlacer } from "@mailwoman/core/coarse-placer"
import { $public } from "@mailwoman/core/env"
import { isBareLocalityTree } from "@mailwoman/core/pipeline"
import { formatAddress } from "@mailwoman/formatter"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, commandError, useCommandTask } from "../cli-kit/index.ts"
import {
	geocodeAddress,
	parseForGeocode,
	ShardProvider,
	type GeocodeResult,
	type ShardResolver,
	type StateShards,
} from "../geocode-core.ts"
import { INTERP_RADIUS_CALIBRATION } from "../interp-calibration.ts"
import { createResolverBackend, mailwomanDataRoot, resolveCandidateDBPath, wofShardPaths } from "../resolver-backend.ts"
import { resolverDefaultCountry } from "./parse.tsx"

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
	bias: zod
		.string()
		.optional()
		.describe(
			"Proximity-bias points, strongest first: 'lat,lon[:weight];lat,lon' (e.g. the map viewport center, then " +
				"the user's location). Soft re-rank only — an ambiguous bare postcode follows the nearest hint."
		),
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
		.describe("Path to a WOF admin SQLite distribution. Defaults to $MAILWOMAN_WOF_DB; errors if neither is set."),
	candidateDb: zod
		.string()
		.optional()
		.describe(
			"Path to a byte-range candidate.db (build-candidate.ts) — the SAME gazetteer + population-first " +
				"ranking the browser demo uses. When set (or via $MAILWOMAN_CANDIDATE_DB), the resolver matches the " +
				"demo (e.g. bare 'Moscow' → Russia, not a US township) and --resolve-db is not required."
		),
	dataRoot: zod
		.string()
		.optional()
		.default(mailwomanDataRoot())
		.describe(
			"Root directory for per-state address-point and interpolation shards. " +
				"Shards are expected at <dataRoot>/address-points/address-points-us-<state>.db " +
				"and <dataRoot>/interpolation/interpolation-us-<state>.db. Defaults to $MAILWOMAN_DATA_ROOT."
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
	interpCalibration: zod
		.number()
		.optional()
		.describe(
			"Conformal calibration multiplier for the interpolation tier's reported uncertainty_m (#374). " +
				"The raw half-segment radius covers only ~72% of true errors. Default (unset): the per-region " +
				"table (#584) selects by parsed region — 1.44 (DC) … 3.12 (AZ), 1.95 for unmeasured states — " +
				"for a ~90% bound. Pass an explicit number to force a single multiplier everywhere (1 = raw)."
		),
	placeCountry: zod
		.boolean()
		.optional()
		.default(true)
		.describe(
			"The #244 coarse-placer soft country prior (open-set rule). A confident whole-string country guess biases " +
				"the resolver's locality/region ranking toward the right country (never filters); most useful when no " +
				"--default-country / locale pins it. ON by default after the M2 misroute gate (0 misroutes); pass " +
				"--no-place-country to disable."
		),
	placeCountryThreshold: zod
		.number()
		.optional()
		.default(0.9)
		.describe(
			"Abstention threshold for --place-country: below this calibrated confidence the prior is skipped. Default 0.9."
		),
	format: zod
		.enum(["json", "text", "jsonld"])
		.optional()
		.default("json")
		.describe(
			'Output format. "json" (default) emits the native machine-readable result; "text" prints a human summary; ' +
				'"jsonld" emits a schema.org Place/PostalAddress/GeoCoordinates JSON-LD object (the web\'s native address format).'
		),
})

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveWOFPath(options: zod.infer<typeof OptionsSchema>): string[] {
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

	if (paths.length === 0) {
		throw commandError(
			"geocode needs a WOF admin SQLite path. Set $MAILWOMAN_WOF_DB or pass --resolve-db <path>. " +
				"Build one with `mailwoman gazetteer build admin` + `mailwoman gazetteer build fts`."
		)
	}

	return paths
}

// ---------------------------------------------------------------------------
// Core geocode logic
// ---------------------------------------------------------------------------

async function runGeocode(input: string, options: zod.infer<typeof OptionsSchema>): Promise<string> {
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

	// Coarse-placer soft country prior (#244) — opt-in. Loads the int8 model bundled in @mailwoman/core
	// at the requested abstention threshold; a confident in-map guess feeds the resolver's anchorPosterior.
	// The M2 open-set reject rule (reject on in-map MASS 1-P(OTHER), route on the in-map argmax) lifts in-map
	// right-country 85.3→91.2% with 0 regressions / 0 misroutes (the pipeline + misroute gates), so it's ON
	// by default. --no-place-country disables it (passes `false`); a custom --place-country-threshold builds
	// an explicit placer instead of the default-on bundled one.
	const placer = options.placeCountry
		? await CoarsePlacer.fromBundled({ abstainBelow: options.placeCountryThreshold, openSet: true })
		: undefined

	try {
		const resolver = createWOFResolver(lookup)
		// #912 lever 3: parse ONCE up front (shared into geocodeAddress via parsedTree — no re-parse)
		// so a single bare locality can skip the locale-INFERRED default country. "Paris" under the
		// en-US locale must not be hard-scoped to Paris, Texas; an explicit --default-country still
		// wins (resolverDefaultCountry returns it before the locale inference is consulted).
		// --bias 'lat,lon[:weight];…' → ordered soft proximity hints (viewport first by convention).
		const bias = (options.bias ?? "")
			.split(";")
			.map((part: string) => part.trim())
			.filter(Boolean)
			.map((part: string) => {
				const [coords, w] = part.split(":")
				const [lat, lon] = coords!.split(",").map(Number)

				if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw commandError(`--bias: bad point '${part}'`)

				return { lat: lat!, lon: lon!, ...(w !== undefined ? { weight: Number(w) } : {}) }
			})
		const parsedTree = await parseForGeocode(input, { classifier })
		const inferredScopeOK = options.defaultCountry || !isBareLocalityTree(parsedTree)
		const result = await geocodeAddress(input, {
			classifier,
			resolver,
			shards,
			...(nationalShards ? { nationalShards } : {}),
			parsedTree,
			...(bias.length > 0 ? { bias } : {}),
			defaultCountry: (inferredScopeOK && resolverDefaultCountry(options, !!candidateDb)) || undefined,
			// Explicit --interp-calibration forces a single multiplier; unset → the per-region table (#584).
			interpCalibration: options.interpCalibration ?? INTERP_RADIUS_CALIBRATION,
			// Enabled → our threshold-honoring placer; --no-place-country → `false` (disable the default-on prior).
			placeCountry: placer ? (t: string) => placer.predict(t) : false,
		})

		if (options.format === "text") return formatText(result)

		if (options.format === "jsonld") return JSON.stringify(geocodeToSchemaOrg(result), null, 2)

		return JSON.stringify(result, null, 2)
	} finally {
		explicitAp?.close()
		explicitIp?.close()
		shardProvider.close()
		lookup.close()
	}
}

// ---------------------------------------------------------------------------
// schema.org JSON-LD projection (#1052)
// ---------------------------------------------------------------------------

/**
 * Project a {@link GeocodeResult} into a schema.org `Place` JSON-LD object (`--format jsonld`, #1052). `streetAddress`
 * is rendered locale-aware by `@mailwoman/formatter` (house number placement follows the resolved country); the rest of
 * the mapping (locality/region/postcode/ISO country → PostalAddress; coordinate → GeoCoordinates) lives in
 * `@mailwoman/annotations`' {@link toSchemaOrg}. Lossy by design: tiers/uncertainty/candidates don't fit the vocabulary
 * and are dropped.
 */
function geocodeToSchemaOrg(result: GeocodeResult): SchemaOrgPlace {
	const streetAddress = formatAddress(
		{
			...(result.house_number ? { house_number: result.house_number } : {}),
			...(result.street ? { street: result.street } : {}),
		},
		result.countryCode ?? "US",
		{ separator: " " }
	)

	return toSchemaOrg({
		lat: result.lat,
		lon: result.lon,
		streetAddress: streetAddress || undefined,
		locality: result.locality ?? undefined,
		region: result.region ?? undefined,
		postalCode: result.postcode ?? undefined,
		countryCode: result.countryCode ?? undefined,
	})
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

	if (result.locality) {
		lines.push(`locality:         ${result.locality}`)
	}

	if (result.region) {
		lines.push(`region:           ${result.region}`)
	}

	if (result.postcode) {
		lines.push(`postcode:         ${result.postcode}`)
	}

	if (result.hierarchy.length > 0) {
		lines.push("hierarchy:")

		for (const h of result.hierarchy) {
			const coord = h.lat != null ? ` (${h.lat.toFixed(4)}, ${h.lon!.toFixed(4)})` : ""
			const id = h.placeID ? ` [${h.placeID}]` : ""
			lines.push(`  ${h.tag.padEnd(20)} ${h.value}${id}${coord}`)
		}
	}

	return lines.join("\n")
}

// ---------------------------------------------------------------------------
// React command component
// ---------------------------------------------------------------------------

const GeocodeCommand: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) => {
	const state = useCommandTask(async () => {
		const input = args[0]

		if (!input || input.trim().length === 0) {
			throw commandError(
				'geocode requires a positional address argument  (e.g. mailwoman geocode "350 5th Ave, New York, NY")'
			)
		}

		return runGeocode(input.trim(), options)
	})

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	if (state.status !== "done") {
		return <Spinner />
	}

	return <Text>{state.result}</Text>
}

export default GeocodeCommand
