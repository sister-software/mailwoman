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
 *   Steps 1–4 and every dependency they need live in `geocode-session.ts`, so a caller that geocodes more
 *   than once opens the classifier and the databases once. This module is the CLI shell around it: flags,
 *   format selection, and the three renderers.
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
 *
 *   NOTHING ON THE SUCCESS PATH RENDERS THROUGH INK (#1577). Measured 2026-08-10 with `script` on a
 *   TTY, the pre-fix command damaged the terminal two ways, both caused by Ink owning stdout while
 *   the result was written to it:
 *
 *   1. `--format text` rendered an Ink `<Text>` frame. When that frame is at least as tall as the
 *      viewport, Ink emits `\x1b[2J\x1b[3J\x1b[H` — and `3J` wipes the SCROLLBACK, not just the
 *      screen. Reproduced at `stty rows 6`: two full clears per run.
 *   2. Every format left a one-line `<Spinner />` frame on screen while the task ran. The final
 *      (empty) frame then erased two lines — the ones our raw write had just put there — so a piped-
 *      to-nothing `mailwoman geocode "…"` printed JSON with its closing `}` rubbed out.
 *
 *   Both disappear when Ink is given nothing to draw: the running state renders `null` (height 0, so
 *   there is no previous frame to erase and no frame that can overflow the viewport) and every
 *   format goes out through {@linkcode writeRawStdout}. The cost is the spinner; a spinner on stderr
 *   would collide with the `[resolver] …` banner the resolver already writes there, and no progress
 *   indicator is worth corrupting stdout.
 */

import type { SchemaOrgPlace } from "@mailwoman/annotations"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { Text } from "ink"
import { type CommandComponent, commandError, lazyComponent, useCommandTask, writeRawStdout } from "mailwoman/cli-kit"
import { argument } from "pastel"
import zod from "zod"

import type { GeocodeResult } from "../geocode-core.ts"

//#region CLI contract — args + options

const ArgumentsSchema = zod
	.array(zod.string())
	.describe(argument({ name: "address", description: "A formatted postal address to geocode" }))

/**
 * Shown at the top of `mailwoman geocode --help` — which is also what a bare `mailwoman geocode` now prints (#1577, see
 * `cli.ts`) — and reused by commander for the root command listing, so it stays to two sentences.
 */
export const description =
	"Turn an address into a coordinate: parse it, then resolve the parts against the gazetteer and the " +
	"rooftop/interpolation shards. Reports which tier answered (address_point > interpolated > admin); run " +
	"`mailwoman doctor` when a lookup comes back admin-only or errors on a missing database."

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
	countryScope: zod
		.enum(["auto", "locale", "none"])
		.optional()
		.default("auto")
		.describe(
			"Whether the locale-inferred country scopes the resolver: 'locale' always, 'none' never, " +
				"'auto' (default) only on the FTS backend. Pin 'locale' or 'none' to hold country policy fixed " +
				"while changing backends. An explicit --default-country outranks all three."
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
				"The raw half-segment radius covers only ~72% of true errors. Default (unset): the shard's own " +
				"baked value (its interp_calibration metadata table) when it carries one, else the in-code " +
				"per-region table (#584) selected by parsed region — 1.44 (DC) … 3.12 (AZ), 1.95 for unmeasured " +
				"states — for a ~90% bound. Pass an explicit number to force a single multiplier everywhere (1 = raw)."
		),
	localeCountryPrior: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"#27: when --locale's country is withheld from the resolver (a bare city name — see #912), hand it down " +
				"as a SOFT ranking bonus instead of dropping it, so `--locale en-GB Whitby` stops answering Whitby, " +
				"Ontario. OFF by default: the bonus that flips the bare GB names also flips 'Paris' to Texas and " +
				"'Athens' to Georgia, because population plus a locale cannot separate the two classes."
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
	postcodeCountryCoherence: zod
		.boolean()
		.optional()
		.default(true)
		.describe(
			"#42: let a (postcode, locality) pair that is geographically consistent in exactly ONE country override a " +
				"wrong --default-country / locale scope. '12 Rue de Rivoli, 75001 Paris' under en-US otherwise geocodes " +
				"to Addison, Texas (ZIP 75001). Abstains when the default country is already consistent, when no country " +
				"is, or when more than one is. ON by default (promoted 2026-08-05); pass " +
				"--no-postcode-country-coherence to restore the un-overridden country scope."
		),
	forkEntity: zod
		.boolean()
		.optional()
		.default(true)
		.describe(
			"#1585: when the parse declares a FORK (a surface structure cannot decide) and nothing resolves, probe " +
				"poi.db for the single entity bearing the query's exact name ('COMER parís.méxico' → the Paris " +
				"restaurant). Positive evidence only; street-flavored forks and ambiguous names abstain. Needs poi.db " +
				"in the data root; pass --no-fork-entity to disable."
		),
	postcodeShapeCoherence: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"#31: shape as confidence and EXCLUSION — a postcode span whose codex shape intersects NO confident " +
				"sibling signal (country/region) is demoted: digit-only → house_number, letter-bearing → stamped " +
				"'postcode_shape_excluded'. A shape no system recognizes, or no confident siblings, abstains. " +
				"DEFAULT OFF (demotion is the failure mode with teeth); pass --postcode-shape-coherence to opt in."
		),
	postcodeContainmentCoherence: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"#31: re-rank locality candidates by proximity to the postcode's own centroid (25 km gate) — the " +
				"locality that CONTAINS the postcode wins the name-match tie. DEFAULT OFF; pass " +
				"--postcode-containment-coherence to opt in."
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
				'"jsonld" emits a schema.org Place/PostalAddress/GeoCoordinates JSON-LD object (the web\'s native address format). ' +
				"Each value also has a bare-flag shorthand: --json, --text, --jsonld."
		),
	json: zod.boolean().optional().default(false).describe("Shorthand for --format json (the default)."),
	text: zod.boolean().optional().default(false).describe("Shorthand for --format text — the human-readable summary."),
	jsonld: zod.boolean().optional().default(false).describe("Shorthand for --format jsonld — schema.org JSON-LD."),
	debug: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Interactive three-panel debug view (input / parse+resolution / map) on a TTY; " +
				"a single rendered frame on a pipe. Not combinable with --json/--text/--jsonld."
		),
	debugSize: zod
		.string()
		.regex(/^\d+x\d+$/u, "Expected COLSxROWS, e.g. 120x36")
		.optional()
		.default("120x36")
		.describe("Frame size for the non-TTY --debug render. Ignored on a TTY (the terminal sizes the view)."),
	tiles: zod
		.string()
		.optional()
		.describe(
			"PMTiles archive for the --debug map pane. Defaults to $MAILWOMAN_TILES, then " +
				"<dataRoot>/tiles/planet.pmtiles when present. Absent tiles degrade the pane to a note."
		),
})

/**
 * The command's fully-parsed options — every zod default applied. Exported so `debug-view/command.tsx` can name the
 * type its `GeocodeDebugCommand` / `runStaticDebug` accept without importing the schema itself (the debug module is the
 * consumer here; `geocode-session.ts`'s structural {@link GeocodeSessionOptions} is a separate, narrower contract).
 */
export type GeocodeCommandOptions = zod.infer<typeof OptionsSchema>

//#endregion

//#region Format resolution

/**
 * The format this invocation actually emits. `--json` / `--text` / `--jsonld` are bare-flag shorthands for the
 * corresponding `--format` value (#1577), and a shorthand OUTRANKS `--format` — `--format` carries a default, so there
 * is no way to tell "the user typed `--format json`" from "nobody passed one", and silently ignoring an explicit
 * `--jsonld` because of a default would be the worse failure.
 *
 * Two shorthands at once is a usage error rather than a silent pick: `--json --jsonld` has no defensible winner.
 */
export function resolveFormat(options: {
	format?: "json" | "text" | "jsonld"
	json?: boolean
	text?: boolean
	jsonld?: boolean
}): "json" | "text" | "jsonld" {
	const shorthands = (["json", "text", "jsonld"] as const).filter((name) => options[name])

	if (shorthands.length > 1) {
		throw commandError(
			`Pick one output format: ${shorthands.map((name) => `--${name}`).join(" and ")} were both passed.`
		)
	}

	return shorthands[0] ?? options.format ?? "json"
}

//#endregion

//#region Core geocode logic

async function runGeocode(input: string, options: zod.infer<typeof OptionsSchema>): Promise<string> {
	// Validate the format pair BEFORE any DB/weights work — a `--json --jsonld` typo should fail in
	// milliseconds, not after a multi-second model load. The import is part of that load: `geocode-session.ts`
	// reaches onnxruntime and the SentencePiece WASM blob.
	const format = resolveFormat(options)
	const { createGeocodeSession } = await import("../geocode-session.ts")
	const session = await createGeocodeSession(options)

	try {
		const { result } = await session.geocode(input)

		if (format === "text") return formatText(result)

		if (format === "jsonld") return JSON.stringify(await geocodeToSchemaOrg(result), null, 2)

		return JSON.stringify(result, null, 2)
	} finally {
		session.close()
	}
}

//#endregion

//#region schema.org JSON-LD projection (#1052)

/**
 * Project a {@link GeocodeResult} into a schema.org `Place` JSON-LD object (`--format jsonld`, #1052). `streetAddress`
 * is rendered locale-aware by `@mailwoman/formatter` (house number placement follows the resolved country); the rest of
 * the mapping (locality/region/postcode/ISO country → PostalAddress; coordinate → GeoCoordinates) lives in
 * `@mailwoman/annotations`' {@link toSchemaOrg}. Lossy by design: tiers/uncertainty/candidates don't fit the vocabulary
 * and are dropped.
 */
async function geocodeToSchemaOrg(result: GeocodeResult): Promise<SchemaOrgPlace> {
	const { toSchemaOrg } = await import("@mailwoman/annotations")
	const { formatAddress } = await import("@mailwoman/formatter")

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

//#endregion

//#region Text formatter

function formatText(result: GeocodeResult): string {
	const lines: string[] = [`input:            ${result.input}`, `resolution_tier:  ${result.resolution_tier}`]

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

	if (result.hierarchy.length) {
		lines.push("hierarchy:")

		for (const h of result.hierarchy) {
			const coord = h.lat != null ? ` (${h.lat.toFixed(4)}, ${h.lon!.toFixed(4)})` : ""
			const id = h.placeID ? ` [${h.placeID}]` : ""
			lines.push(`  ${h.tag.padEnd(20)} ${h.value}${id}${coord}`)
		}
	}

	return lines.join("\n")
}

//#endregion

//#region React command component

const GeocodeOneShot: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) => {
	const state = useCommandTask(async () => {
		const input = args[0]

		if (!input || !input.trim().length) {
			throw commandError(
				'geocode requires a positional address argument  (e.g. mailwoman geocode "350 5th Ave, New York, NY")'
			)
		}

		return runGeocode(input.trim(), options)
	})

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	// No spinner: an Ink frame here is what erased the tail of the raw output on a TTY, and a tall
	// one wipes the scrollback outright (see the module docstring). Height 0 means neither can happen.
	if (state.status !== "done") {
		return null
	}

	// EVERY format — `text` included — bypasses Ink's <Text> renderer. It word-wraps at the terminal
	// width (80 when piped), which corrupts JSON string values, and a frame taller than the viewport
	// makes Ink clear the terminal + scrollback.
	return writeRawStdout(state.result)
}

/**
 * `--debug`'s three-panel view, loaded on first render. The debug module reaches the neural classifier, onnxruntime and
 * the SentencePiece WASM blob, and Pastel imports this file on EVERY invocation — a static import would put all of it
 * behind `mailwoman --version`.
 */
const GeocodeDebugCommand = lazyComponent<{ input: string; options: GeocodeCommandOptions }>(async () => {
	const module = await import("../debug-view/command.tsx")

	return module.GeocodeDebugCommand
})

/**
 * Top-level dispatch between the one-shot output path and `--debug`'s three-panel view. Deliberately hook-free:
 * `GeocodeOneShot` and `GeocodeDebugCommand` each own their own hook lifecycle, so switching on `options.debug` HERE —
 * above both — can never make either branch's hook calls conditional.
 */
const GeocodeCommand: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) =>
	options.debug ? (
		<GeocodeDebugCommand input={(args[0] ?? "").trim()} options={options} />
	) : (
		<GeocodeOneShot args={args} options={options} />
	)

export default GeocodeCommand

//#endregion
