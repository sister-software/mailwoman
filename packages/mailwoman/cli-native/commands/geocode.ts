/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Native `mw geocode`: no React, Ink, or Zod on the ordinary data path.
 */

import type { PipelineTiming } from "@mailwoman/core/pipeline"

import type { GeocodeCommandOptions } from "../../geocode-command-options.ts"
import type { GeocodeResult } from "../../geocode-core.ts"
import { CLIUsageError, type CommandSpec, parseCommand, renderCommandHelp } from "../spec.ts"

const localePattern = /^[a-z]{2}(-[A-Z]{2})?$/u
const debugSizePattern = /^\d+x\d+$/u

/**
 * Native geocode CLI contract; detailed help and parsing are both derived from this value.
 */
export const spec = {
	name: "geocode",
	description:
		"Turn an address into a coordinate: parse it, then resolve the parts against the gazetteer and rooftop/interpolation shards.",
	positionals: [
		{ name: "address", description: "A formatted postal address to geocode. Omit when using --stdin.", multiple: true },
	],
	options: {
		locale: {
			type: "string",
			default: "en-US",
			hint: "locale",
			description: "Locale tag matching a weights package, such as en-US or fr-FR.",
			validate: (value) => localePattern.test(value),
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
			description: "ISO-3166 resolver country scope; pass none to disable it.",
		},
		"country-scope": {
			type: "string",
			default: "auto",
			choices: ["auto", "locale", "none"],
			description: "Apply the locale-inferred resolver scope automatically, always, or never.",
		},
		"resolve-db": { type: "string", hint: "path", description: "WOF admin SQLite distribution." },
		"candidate-db": { type: "string", hint: "path", description: "Demo-parity byte-range candidate database." },
		"data-root": {
			type: "string",
			hint: "path",
			description: "Root containing address-point, interpolation, WOF, POI, and other data shards.",
		},
		"address-points-db": {
			type: "string",
			hint: "path",
			description: "Explicit address-point SQLite shard, bypassing region selection.",
		},
		"interpolation-db": {
			type: "string",
			hint: "path",
			description: "Explicit interpolation SQLite shard, bypassing region selection.",
		},
		"interp-calibration": {
			type: "number",
			hint: "multiplier",
			description: "Force one interpolation uncertainty calibration multiplier.",
		},
		"locale-country-prior": {
			type: "boolean",
			default: false,
			description: "Use a withheld locale country as a soft resolver ranking prior.",
		},
		"gazetteer-prior": {
			type: "boolean",
			default: true,
			description: "Feed the gazetteer FST prior to the parse; --no-gazetteer-prior disables it.",
		},
		"place-country": {
			type: "boolean",
			default: true,
			description: "Use the coarse-placer country prior; --no-place-country disables it.",
		},
		"postcode-country-coherence": {
			type: "boolean",
			default: true,
			description: "Allow coherent postcode/locality evidence to override a wrong country scope.",
		},
		"fork-entity": {
			type: "boolean",
			default: true,
			description: "Probe POI data for exact entities when a fork parse does not resolve.",
		},
		"postcode-shape-coherence": {
			type: "boolean",
			default: false,
			description: "Opt into postcode shape exclusion/demotion.",
		},
		"postcode-containment-coherence": {
			type: "boolean",
			default: false,
			description: "Opt into postcode-centroid locality reranking.",
		},
		"place-country-threshold": {
			type: "number",
			default: 0.9,
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

function stringValue(values: Record<string, unknown>, name: string): string | undefined {
	const value = values[name]

	return typeof value === "string" ? value : undefined
}

function booleanValue(values: Record<string, unknown>, name: string): boolean {
	return values[name] === true
}

function numberValue(values: Record<string, unknown>, name: string): number | undefined {
	const value = values[name]

	return typeof value === "number" ? value : undefined
}

async function optionsOf(values: Record<string, unknown>): Promise<GeocodeOptions> {
	const dataRoot = stringValue(values, "data-root") ?? (await import("@mailwoman/core/utils")).mailwomanDataRoot()

	return {
		locale: stringValue(values, "locale")!,
		...(stringValue(values, "bias") ? { bias: stringValue(values, "bias") } : {}),
		...(stringValue(values, "default-country") ? { defaultCountry: stringValue(values, "default-country") } : {}),
		countryScope: stringValue(values, "country-scope") as GeocodeOptions["countryScope"],
		...(stringValue(values, "resolve-db") ? { resolveDB: stringValue(values, "resolve-db") } : {}),
		...(stringValue(values, "candidate-db") ? { candidateDB: stringValue(values, "candidate-db") } : {}),
		dataRoot,
		...(stringValue(values, "address-points-db") ? { addressPointsDB: stringValue(values, "address-points-db") } : {}),
		...(stringValue(values, "interpolation-db") ? { interpolationDB: stringValue(values, "interpolation-db") } : {}),
		...(numberValue(values, "interp-calibration") !== undefined
			? { interpCalibration: numberValue(values, "interp-calibration") }
			: {}),
		localeCountryPrior: booleanValue(values, "locale-country-prior"),
		gazetteerPrior: booleanValue(values, "gazetteer-prior"),
		placeCountry: booleanValue(values, "place-country"),
		postcodeCountryCoherence: booleanValue(values, "postcode-country-coherence"),
		forkEntity: booleanValue(values, "fork-entity"),
		postcodeShapeCoherence: booleanValue(values, "postcode-shape-coherence"),
		postcodeContainmentCoherence: booleanValue(values, "postcode-containment-coherence"),
		placeCountryThreshold: numberValue(values, "place-country-threshold")!,
		format: stringValue(values, "format") as Format,
		json: booleanValue(values, "json"),
		text: booleanValue(values, "text"),
		jsonld: booleanValue(values, "jsonld"),
		debug: booleanValue(values, "debug"),
		debugSize: stringValue(values, "debug-size")!,
		stdin: booleanValue(values, "stdin"),
		timing: booleanValue(values, "timing"),
		...(stringValue(values, "tiles") ? { tiles: stringValue(values, "tiles") } : {}),
	}
}

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

async function formatResult(result: GeocodeResult, format: Format, compact: boolean): Promise<string> {
	if (format === "text") {
		return formatText(result)
	}

	if (format === "jsonld") {
		const [{ toSchemaOrg }, { formatAddress }] = await Promise.all([
			import("@mailwoman/annotations"),
			import("@mailwoman/formatter"),
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

		return JSON.stringify(value, null, compact ? 0 : 2)
	}

	return JSON.stringify(result, null, compact ? 0 : 2)
}

async function openSession(options: GeocodeOptions) {
	const importStartedAt = performance.now()
	const { createGeocodeSession } = await import("../../geocode-session.ts")
	const importedAt = performance.now()
	const showProgress = process.stderr.isTTY === true && !options.timing

	const session = await createGeocodeSession({
		...options,
		...(showProgress ? { onProgress: (message: string) => console.error(`[geocode] ${message}`) } : {}),
	})

	if (options.timing) {
		const cliStartedAt = (globalThis as { __mailwomanCLIStartedAt?: number }).__mailwomanCLIStartedAt

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
	const session = await openSession(options)

	try {
		const geocoded = await session.geocode(input)

		if (options.timing) {
			reportTiming("geocode", geocoded.timing)
		}

		process.stdout.write(`${await formatResult(geocoded.result, format, false)}\n`)
	} finally {
		session.close()
	}
}

async function runStdin(options: GeocodeOptions): Promise<void> {
	const format = resolveFormat(options)

	if (format === "text") {
		throw new CLIUsageError("--stdin emits one record per line; use --json or --jsonld, not --text.")
	}

	const { createInterface } = await import("node:readline")
	const session = await openSession(options)
	let index = 0

	try {
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
	} finally {
		session.close()
	}
}

export async function run(args: readonly string[]): Promise<number> {
	const parsed = parseCommand(spec, args)

	if (parsed.values.help) {
		process.stdout.write(`${await renderCommandHelp(spec)}\n`)

		return 0
	}

	const options = await optionsOf(parsed.values)

	if (options.debug) {
		const input = parsed.positionals.join(" ").trim()

		const [{ render }, { createElement }, { GeocodeDebugCommand }] = await Promise.all([
			import("ink"),
			import("react"),
			import("../../debug-view/command.tsx"),
		])

		const instance = render(createElement(GeocodeDebugCommand, { input, options }))

		await instance.waitUntilExit()

		return typeof process.exitCode === "number" ? process.exitCode : 0
	}

	const input = parsed.positionals.join(" ").trim()

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
}
