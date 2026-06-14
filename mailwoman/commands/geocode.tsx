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
 *   2. Resolve admin hierarchy via `createWofResolver(WofSqlitePlaceLookup)`.
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

import { Spinner } from "@inkjs/ui"
import { createWofResolver, type ResolverBackend } from "@mailwoman/core/resolver"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { Text } from "ink"
import { setImmediate } from "node:timers/promises"
import { useEffect, useState } from "react"
import zod from "zod"
import { geocodeAddress, ShardProvider, type GeocodeResult, type ShardResolver } from "../geocode-core.js"
import { INTERP_RADIUS_CALIBRATION } from "../interp-calibration.js"
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
		.describe("Path to a WOF admin SQLite distribution. Defaults to $MAILWOMAN_WOF_DB; errors if neither is set."),
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
	interpCalibration: zod
		.number()
		.optional()
		.describe(
			"Conformal calibration multiplier for the interpolation tier's reported uncertainty_m (#374). " +
				"The raw half-segment radius covers only ~72% of true errors. Default (unset): the per-region " +
				"table (#584) selects by parsed region — 1.44 (DC) … 3.12 (AZ), 1.95 for unmeasured states — " +
				"for a ~90% bound. Pass an explicit number to force a single multiplier everywhere (1 = raw)."
		),
	format: zod
		.enum(["json", "text"])
		.optional()
		.default("json")
		.describe('Output format. "json" (default) emits a machine-readable object; "text" prints a human summary.'),
})

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

// ---------------------------------------------------------------------------
// Core geocode logic
// ---------------------------------------------------------------------------

async function runGeocode(input: string, options: zod.infer<typeof OptionsSchema>): Promise<string> {
	// Resolve the WOF admin path FIRST — it's the most common missing prerequisite and the cheapest to
	// check, so surface that error before the (slower) weights load. (Order matters for the CLI contract:
	// a missing WOF DB must report the WOF error even when the weights are also absent.)
	const wofPath = resolveWofPath(options)

	// Load the neural classifier (required for street-level; weights must be present).
	let classifier: NeuralAddressClassifier
	try {
		classifier = await NeuralAddressClassifier.loadFromWeights({ locale: options.locale })
	} catch {
		throw new Error(
			"geocode requires the neural weights. Install @mailwoman/neural-weights-en-us (or pass --locale with installed weights)."
		)
	}

	// Open the WOF admin resolver + the situs/interpolation shard provider.
	let mod: typeof import("@mailwoman/resolver-wof-sqlite")
	try {
		mod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		throw new Error(
			"geocode requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
				"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
		)
	}

	const lookup = new mod.WofSqlitePlaceLookup({ databasePath: wofPath })
	const shardProvider = new ShardProvider(mod, options.dataRoot)
	// Explicit --address-points-db / --interpolation-db flags override per-state selection (testing a
	// specific file); an unset tier still falls back to the region-derived per-state shard.
	const explicitAp = options.addressPointsDb ? new mod.AddressPointSqliteLookup(options.addressPointsDb) : undefined
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

	try {
		const resolver = createWofResolver(lookup as unknown as ResolverBackend)
		const result = await geocodeAddress(input, {
			classifier,
			resolver,
			shards,
			defaultCountry: resolverDefaultCountry(options) || undefined,
			// Explicit --interp-calibration forces a single multiplier; unset → the per-region table (#584).
			interpCalibration: options.interpCalibration ?? INTERP_RADIUS_CALIBRATION,
		})
		return options.format === "text" ? formatText(result) : JSON.stringify(result, null, 2)
	} finally {
		explicitAp?.close()
		explicitIp?.close()
		shardProvider.close()
		lookup.close()
	}
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
			setError('geocode requires a positional address argument  (e.g. mailwoman geocode "350 5th Ave, New York, NY")')
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
