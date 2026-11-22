// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Native `mw geocode`: no React or Ink on the ordinary data path.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { type GeocodeResult, VariantAliasExemptionSchema } from "@mailwoman/core/geocode"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import type { EngineCoverage } from "@mailwoman/core/license"
import type { PipelineTiming } from "@mailwoman/core/pipeline"

import { resolveEngineStamp } from "#cli/kit/engine-stamp"
import { type GeocodeCommandOptions, resolveGeocodeCommandOptions } from "#cli/native/commands/geocode/options"
import {
	CLIUsageError,
	type CommandSpec,
	isLocaleTag,
	renderCommandHelp,
	renderInkCommand,
	runNativeCommand,
} from "#cli/native/spec"
import { ceilingCandidate, coverageSentence, installedBundleNames, precisionCeiling } from "#data/ceiling"
import { GEOCODE_SESSION_DEFAULTS as defaults } from "#geocode/options"

const debugSizePattern = /^\d+x\d+$/u

/**
 * Native geocode CLI interface.
 * Detailed help and parsing are both derived from this value.
 *
 * A flag that states a session option takes its `default` from the session's option schema.
 */
export const spec = {
	name: "geocode",
	description:
		"Turn an address into a coordinate: parse it, then resolve the parts against the gazetteer and the rooftop/interpolation databases.",
	positionals: [
		{ name: "address", description: "A formatted postal address to geocode. Omit when using --stdin.", multiple: true },
	],
	options: {
		config: {
			type: "string",
			hint: "path",
			description:
				"Config file whose geocode key states session options. Without it, the mailwoman.config.* file in the working directory is read. A typed flag wins over the file.",
		},
		locale: {
			type: "string",
			default: defaults.locale,
			hint: "locale",
			description: "Locale tag matching a weights package, such as en-US or fr-FR.",
			validate: isLocaleTag,
			validationMessage: "--locale expects a BCP-47 tag like en-US or fr-FR.",
		},
		bias: {
			type: "string",
			hint: "points",
			description: "Soft proximity-bias points: lat,lon[:weight];lat,lon.",
		},
		"default-country": {
			type: "string",
			hint: "country",
			description: "ISO-3166 resolver country scope. Pass none to disable it.",
		},
		"country-scope": {
			type: "string",
			default: defaults.countryScope,
			choices: ["auto", "locale", "none"],
			description: "Apply the locale-inferred resolver scope automatically, always, or never.",
		},
		"resolve-db": { type: "string", hint: "path", description: "WOF admin SQLite distribution." },
		"candidate-db": { type: "string", hint: "path", description: "Demo-parity byte-range candidate database." },
		"data-root": {
			type: "string",
			hint: "path",
			description: "Root containing the address-point, interpolation, WOF, POI, and other data databases.",
		},
		"address-points-db": {
			type: "string",
			hint: "path",
			description: "Explicit address-point SQLite database, bypassing region selection.",
		},
		"interpolation-db": {
			type: "string",
			hint: "path",
			description: "Explicit interpolation SQLite database, bypassing region selection.",
		},
		"interp-calibration": {
			type: "number",
			hint: "multiplier",
			description: "Force one interpolation uncertainty calibration multiplier.",
		},
		"locale-country-prior": {
			type: "boolean",
			default: defaults.localeCountryPrior,
			description: "Use a withheld locale country as a soft resolver ranking prior.",
		},
		"gazetteer-prior": {
			type: "boolean",
			default: defaults.gazetteerPrior,
			description: "Feed the gazetteer FST prior to the parse; --no-gazetteer-prior disables it.",
		},
		"venue-head-prior": {
			type: "boolean",
			default: defaults.venueHeadPrior,
			description:
				"Feed the venue-head prior, from @mailwoman/poi-taxonomy's head-word table, to the parse; --no-venue-head-prior disables it.",
		},
		"venue-head-bias-scale": {
			type: "number",
			default: defaults.venueHeadBiasScale,
			hint: "multiplier",
			description: "Multiplier on the venue-head table's biases.",
		},
		"street-morphology-prior": {
			type: "boolean",
			default: defaults.streetMorphologyPrior,
			description:
				"Bias a trailing street-type affix toward the street labels when its segment opens with a house number; --no-street-morphology-prior disables it.",
		},
		"place-country": {
			type: "boolean",
			default: defaults.placeCountry,
			description: "Use the coarse-placer country prior; --no-place-country disables it.",
		},
		"postcode-country-coherence": {
			type: "boolean",
			default: defaults.postcodeCountryCoherence,
			description: "Allow coherent postcode/locality evidence to override a wrong country scope.",
		},
		"fork-entity": {
			type: "boolean",
			default: defaults.forkEntity,
			description: "Probe POI data for exact entities when a fork parse doesn't resolve.",
		},
		"postcode-shape-coherence": {
			type: "boolean",
			default: defaults.postcodeShapeCoherence,
			description: "Exclude a postcode span whose shape fits no postcode syntax of a country the address mentions.",
		},
		"postcode-containment-coherence": {
			type: "boolean",
			default: defaults.postcodeContainmentCoherence,
			description: "Opt into postcode-centroid locality reranking.",
		},
		"admin-containment-rerank": {
			type: "boolean",
			default: defaults.adminContainmentRerank,
			description:
				"Region-qualifier containment reranking of locality candidates; --no-admin-containment-rerank disables it.",
		},
		"dependent-locality-containment": {
			type: "boolean",
			default: defaults.dependentLocalityContainment,
			description:
				"Resolve a parsed dependent locality inside its parent and answer its point; --no-dependent-locality-containment disables it (#2804).",
		},
		"county-designator-fallback": {
			type: "boolean",
			default: defaults.countyDesignatorFallback,
			description:
				"Resolve a locality span written with its country's county designator (Harris County, TX) as the region's county when no locality of that name is there.",
		},
		"former-divisions": {
			type: "boolean",
			default: defaults.formerDivisions,
			description:
				"Accept a county or region that's a former division linked to the resolved locality (Avon in 34 Coldharbour Rd, Redland, Avon, Bristol BS6 7NA), without letting it scope the result.",
		},
		"scope-country-retrieval": {
			type: "boolean",
			default: defaults.scopeCountryRetrieval,
			description:
				"Retrieve a soft country scope's own rows and promote them after the importance rerank. A hard scope also reports the same-name places it excluded.",
		},
		"sibling-locality-containment": {
			type: "boolean",
			default: defaults.siblingLocalityContainment,
			description:
				"Resolve one of two locality spans inside the other when the gazetteer contains it there (Kensington, London).",
		},
		"pair-prior-word-pieces": {
			type: "boolean",
			default: defaults.pairPriorWordPieces,
			description: "Leave the comma after a place-pair child unbiased, biasing only the pieces with letters or digits.",
		},
		"pair-prior-child-postcode-strip": {
			type: "boolean",
			default: defaults.pairPriorChildPostcodeStrip,
			description: "Keep a place-pair child's bias off the postcode in its own segment (Sutton Coldfield B72 1PU).",
		},
		"pair-index-own-country": {
			type: "boolean",
			default: defaults.pairIndexOwnCountry,
			description:
				"Apply the place-pair index only when the address's country is the index's country. The country is the default country, a chosen locale's country, or the locale head's verdict.",
		},
		"fst-country-routing": {
			type: "boolean",
			default: defaults.fstCountryRouting,
			description:
				"Parse with the gazetteer FST of the country the locale head reads, when one ships for that country. Otherwise the locale's FST applies.",
		},
		parent: {
			type: "number",
			hint: "wof id",
			description: "A parent place that scopes every lookup, such as a borough, city, region or country WOF id.",
			validate: (value) => Number.isInteger(value) && value > 0,
			validationMessage: "--parent expects a positive integer WOF id.",
		},
		"parent-scope": {
			type: "string",
			default: "hard",
			choices: ["hard", "soft"],
			description:
				"How --parent acts. Hard keeps only places its lineage agrees with, and soft ranks the places inside it first.",
		},
		"capital-tier": {
			type: "string",
			default: defaults.capitalTier,
			choices: ["auto", "required", "off"],
			description:
				"Bounded national-capital promotion on bare city names: auto (skip when the capitals reference is missing), required (fail when it is missing), or off.",
		},
		"variant-alias-exemption": {
			type: "string",
			default: defaults.variantAliasExemption,
			choices: VariantAliasExemptionSchema.options,
			description:
				"Whether own-name variant aliases keep their holder's rank in cross-country contests: applied or not_applied.",
		},
		"place-country-threshold": {
			type: "number",
			default: defaults.placeCountryThreshold,
			hint: "probability",
			description: "Coarse-placer abstention threshold.",
			validate: (value) => value >= 0 && value <= 1,
			validationMessage: "--place-country-threshold must be between 0 and 1.",
		},
		format: {
			type: "string",
			default: "json",
			choices: ["json", "text", "jsonld"],
			description: "Output format.",
		},
		json: { type: "boolean", default: false, description: "Shorthand for --format json." },
		text: { type: "boolean", default: false, description: "Shorthand for --format text." },
		jsonld: { type: "boolean", default: false, description: "Shorthand for --format jsonld." },
		debug: { type: "boolean", default: false, description: "Open the interactive parse/resolution/map view." },
		"debug-size": {
			type: "string",
			default: "120x36",
			hint: "COLSxROWS",
			description: "Frame size for non-TTY debug rendering.",
			validate: (value) => debugSizePattern.test(value),
			validationMessage: "--debug-size expects COLSxROWS, for example 120x36.",
		},
		stdin: {
			type: "boolean",
			default: false,
			description: "Read one address per line and emit one JSON object per line using one warm session.",
		},
		timing: {
			type: "boolean",
			default: false,
			description: "Write startup, initialization, and per-address phase timings to stderr.",
		},
		tiles: { type: "string", hint: "path", description: "PMTiles archive for the debug map pane." },
	},
} as const satisfies CommandSpec

type Format = "json" | "text" | "jsonld"

type GeocodeOptions = GeocodeCommandOptions

function resolveFormat(options: Pick<GeocodeOptions, "format" | "json" | "text" | "jsonld">): Format {
	const shorthands = (["json", "text", "jsonld"] as const).filter((name) => options[name])

	if (shorthands.length > 1) {
		throw new CLIUsageError(`Pick one output format: ${shorthands.map((name) => `--${name}`).join(" and ")}.`)
	}

	return shorthands[0] ?? options.format
}

function reportTiming(group: string, timing: PipelineTiming): void {
	for (const [phase, milliseconds] of Object.entries(timing)) {
		console.error(`[timing] ${group}.${phase.padEnd(20)} ${milliseconds.toFixed(2)} ms`)
	}
}

function formatText(result: GeocodeResult): string {
	const lines = [
		`input:            ${result.input}`,
		`resolution_tier:  ${result.resolution_tier}`,
		result.lat != null && result.lon != null
			? `coordinate:       ${result.lat.toFixed(6)}, ${result.lon.toFixed(6)}`
			: "coordinate:       (unresolved)",
	]

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

	if (result.hierarchy.length) {
		lines.push("hierarchy:")

		for (const hierarchy of result.hierarchy) {
			const coordinate = hierarchy.lat != null ? ` (${hierarchy.lat.toFixed(4)}, ${hierarchy.lon!.toFixed(4)})` : ""
			const id = hierarchy.placeID ? ` [${hierarchy.placeID}]` : ""

			lines.push(`  ${hierarchy.tag.padEnd(20)} ${hierarchy.value}${id}${coordinate}`)
		}
	}

	return lines.join("\n")
}

/**
 * The ceiling this result met, read against the data root's installed bundles.
 *
 * A data root that cannot be read counts as one with no bundle installed,
 * so the statement still appears and the result is still printed.
 */
let installedBundlesOnce: Promise<ReadonlySet<string>> | null = null

async function resultCoverage(result: GeocodeResult): Promise<EngineCoverage | null> {
	// The disk is read only when a tiered bundle covers this result's country, and once per process after that.
	if (!ceilingCandidate(result)) return null

	installedBundlesOnce ??= installedBundleNames(dataRootPath()).catch((): ReadonlySet<string> => new Set())

	return precisionCeiling(result, await installedBundlesOnce)
}

async function formatResult(result: GeocodeResult, format: Format, compact: boolean): Promise<string> {
	// The JSON-LD projection has no engine block, so it reads no coverage.
	const coverage = format === "jsonld" ? null : await resultCoverage(result)

	if (format === "text") {
		return coverage ? `${formatText(result)}\n${coverageSentence(coverage)}` : formatText(result)
	}

	if (format === "jsonld") {
		const [{ toSchemaOrg }, { formatAddress }] = await Promise.all([
			import("@mailwoman/annotations"),
			import("@mailwoman/codex/address/format"),
		])

		const streetAddress = formatAddress(
			{
				...(result.house_number ? { house_number: result.house_number } : {}),
				...(result.street ? { street: result.street } : {}),
			},
			result.countryCode ?? "US",
			{ separator: " " }
		)

		const value = toSchemaOrg({
			lat: result.lat,
			lon: result.lon,
			streetAddress: streetAddress || undefined,
			locality: result.locality ?? undefined,
			region: result.region ?? undefined,
			postalCode: result.postcode ?? undefined,
			countryCode: result.countryCode ?? undefined,
		})

		return compact ? stringifyJSON(value) : prettyJSON(value, false, 2)
	}

	const { stamp } = await resolveEngineStamp()
	const engine = coverage ? { ...stamp, coverage } : stamp

	return compact ? stringifyJSON({ ...result, engine }) : prettyJSON({ ...result, engine }, false, 2)
}

async function openSession(options: GeocodeOptions) {
	const importStartedAt = performance.now()
	const { createGeocodeSession } = await import("#geocode/session")
	const importedAt = performance.now()
	const showProgress = process.stderr.isTTY === true && !options.timing

	const session = await createGeocodeSession({
		...options,
		...(showProgress ? { onProgress: (message: string) => console.error(`[geocode] ${message}`) } : {}),
	})

	if (options.timing) {
		const cliStartedAt = globalThis.__mailwomanCLIStartedAt

		if (cliStartedAt != null) {
			console.error(`[timing] startup.command_and_router   ${(importStartedAt - cliStartedAt).toFixed(2)} ms`)
		}

		console.error(`[timing] startup.session_import       ${(importedAt - importStartedAt).toFixed(2)} ms`)

		reportTiming("init", session.initTiming)
	}

	return session
}

async function runOne(input: string, options: GeocodeOptions): Promise<void> {
	const format = resolveFormat(options)

	await using session = await openSession(options)

	const geocoded = await session.geocode(input)

	if (options.timing) {
		reportTiming("geocode", geocoded.timing)
	}

	process.stdout.write(`${await formatResult(geocoded.result, format, false)}\n`)
}

async function runStdin(options: GeocodeOptions): Promise<void> {
	const format = resolveFormat(options)

	if (format === "text") {
		throw new CLIUsageError("--stdin emits one record per line; use --json or --jsonld, not --text.")
	}

	const { createInterface } = await import("node:readline")

	await using session = await openSession(options)

	let index = 0

	for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
		const input = line.trim()

		if (!input) {
			continue
		}

		const geocoded = await session.geocode(input)

		index++

		if (options.timing) {
			reportTiming(`geocode[${index}]`, geocoded.timing)
		}

		process.stdout.write(`${await formatResult(geocoded.result, format, true)}\n`)
	}
}

export async function run(args: readonly string[]): Promise<number> {
	return runNativeCommand(spec, args, async (parsed) => {
		const options = await resolveGeocodeCommandOptions(parsed)
		const input = parsed.positionals.join(" ").trim()

		if (options.debug) {
			const [{ createElement }, { GeocodeDebugCommand }] = await Promise.all([
				import("react"),
				import("#debug-view/command"),
			])

			return renderInkCommand(createElement(GeocodeDebugCommand, { input, options }))
		}

		if (options.stdin) {
			if (input) throw new CLIUsageError("Pass either a positional address or --stdin, not both.")
			await runStdin(options)

			return 0
		}

		if (!input) {
			process.stderr.write(`${await renderCommandHelp(spec)}\n`)

			return 1
		}

		await runOne(input, options)

		return 0
	})
}
