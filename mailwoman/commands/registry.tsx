/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry <csv>` — the geocode-first record matcher, end to end (#613).
 *
 *   This is the integration that runs `@mailwoman/registry`'s cascade on real data: it constructs the
 *   heavy geocoder (neural parser + WOF resolver + per-state situs/interp shards — the same wiring
 *   as `geocode`) and injects it into the matcher's `GeocodeAddress` seam, so the registry package
 *   itself never imports the runtime. Then:
 *
 *   CSV → ingest (column-map + normalize) → geocode (the seam) → resolveEntities (block →
 *   Fellegi-Sunter score, EM-trained label-free → cluster) → GeoJSON.
 *
 *   The thesis it grades: two rows reading `123 Main St` and `123 Main Street Apt 2` — different
 *   strings — collapse to one entity because they resolve to the same place. Blocking is
 *   geographic, not textual. Needs the weights + shards in hand, so the real run is
 *   operator-verifiable (not CI).
 */

import { Spinner } from "@inkjs/ui"
import { decodeAsJson } from "@mailwoman/core/decoder"
import { createWofResolver, type ResolverBackend } from "@mailwoman/core/resolver"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import {
	geocodeAddressVia,
	ingestRows,
	parseCsv,
	resolveEntities,
	toGeoJSON,
	type ColumnMapping,
} from "@mailwoman/registry"
import { Text } from "ink"
import { readFileSync, writeFileSync } from "node:fs"
import { setImmediate } from "node:timers/promises"
import { useEffect, useState } from "react"
import zod from "zod"
import { geocodeAddress, ShardProvider, type ShardResolver } from "../geocode-core.js"
import { INTERP_RADIUS_CALIBRATION } from "../interp-calibration.js"
import type { CommandComponent } from "../sdk/cli.js"
import { resolverDefaultCountry } from "./parse.js"

// ---------------------------------------------------------------------------
// CLI contract — args + options
// ---------------------------------------------------------------------------

const ArgumentsSchema = zod.array(zod.string().describe("Path to a CSV file of contact / organization records"))

const OptionsSchema = zod.object({
	mapping: zod
		.string()
		.optional()
		.describe(
			"Column mapping: a path to a JSON file (or inline JSON) of { id?, source?, name?, organization?, address?, " +
				"phone?, email? }, where each field names the CSV column(s) to draw from. Merged over the built-in default; " +
				"column names are matched case-sensitively. Inferring the mapping from the header is the #603 fast-follow."
		),
	out: zod.string().optional().describe("Write the GeoJSON FeatureCollection here. Default: print to stdout."),
	trainEm: zod
		.boolean()
		.optional()
		.default(true)
		.describe(
			"Fit the Fellegi-Sunter m/u + prior to the data with EM (label-free) before scoring. --no-train-em uses the seeds."
		),
	threshold: zod
		.number()
		.optional()
		.default(0)
		.describe("Link two records into one entity at or above this match weight (bits). Higher = stricter. Default 0."),
	maxBlockSize: zod
		.number()
		.optional()
		.describe("Skip + report blocks larger than this rather than scanning them (recall vs cost). Default: scan all."),
	source: zod.string().optional().describe("A provenance label stamped on every record (e.g. the dataset name)."),
	locale: zod
		.string()
		.regex(/^[a-z]{2}(-[A-Z]{2})?$/u, "Expected a BCP-47 tag like en-US or fr-FR")
		.optional()
		.default("en-US")
		.describe("Locale tag matching an installed weights package. Default en-US."),
	defaultCountry: zod
		.string()
		.optional()
		.describe("ISO-3166 country to scope the resolver. Defaults from --locale's region subtag (en-US → US)."),
	placeCountry: zod
		.boolean()
		.optional()
		.default(true)
		.describe("The #244 coarse-placer soft country prior (on by default). --no-place-country disables it."),
	resolveDb: zod
		.string()
		.optional()
		.describe("Path to a WOF admin SQLite distribution. Defaults to $MAILWOMAN_WOF_DB; errors if neither is set."),
	dataRoot: zod
		.string()
		.optional()
		.default("/mnt/playpen/mailwoman-data")
		.describe(
			"Root directory for per-state address-point + interpolation shards. Default: /mnt/playpen/mailwoman-data."
		),
})

export { ArgumentsSchema as args, OptionsSchema as options }

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

/**
 * Built-in best-effort mapping for tidy contact/org CSVs. Multi-column fields are joined (so a CSV
 * that splits the address across columns composes one string). Real datasets with bespoke headers
 * (e.g. NPPES "Provider First Line Business Practice Location Address") pass an explicit --mapping;
 * inferring it from the header is the #603 fast-follow.
 */
export const DEFAULT_MAPPING: ColumnMapping = {
	id: "id",
	name: ["name", "full_name", "first_name", "last_name"],
	organization: ["organization", "org", "company"],
	address: ["address", "address1", "street", "city", "state", "zip", "postal_code"],
	phone: "phone",
	email: "email",
}

/** Resolve --mapping (a file path or inline JSON) and merge it over {@link DEFAULT_MAPPING}. */
export function loadMapping(option: string | undefined, source: string | undefined): ColumnMapping {
	let provided: Partial<ColumnMapping> = {}
	if (option) {
		const text = option.trim().startsWith("{") ? option : readFileSync(option, "utf8")
		try {
			provided = JSON.parse(text) as Partial<ColumnMapping>
		} catch (err) {
			throw new Error(`--mapping is neither a readable file nor valid JSON: ${(err as Error).message}`)
		}
	}
	return { ...DEFAULT_MAPPING, ...provided, ...(source ? { source } : {}) }
}

function resolveWofPath(options: zod.infer<typeof OptionsSchema>): string {
	const path = options.resolveDb ?? process.env["MAILWOMAN_WOF_DB"]
	if (!path) {
		throw new Error("registry needs a WOF admin SQLite path. Set $MAILWOMAN_WOF_DB or pass --resolve-db <path>.")
	}
	return path
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

async function runRegistry(csvPath: string, options: zod.infer<typeof OptionsSchema>): Promise<string> {
	const wofPath = resolveWofPath(options)
	const mapping = loadMapping(options.mapping, options.source)
	const rows = parseCsv(readFileSync(csvPath, "utf8"))

	let classifier: NeuralAddressClassifier
	try {
		classifier = await NeuralAddressClassifier.loadFromWeights({ locale: options.locale })
	} catch {
		throw new Error(
			"registry requires the neural weights. Install @mailwoman/neural-weights-en-us (or a --locale match)."
		)
	}

	let mod: typeof import("@mailwoman/resolver-wof-sqlite")
	try {
		mod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		throw new Error("registry requires `@mailwoman/resolver-wof-sqlite` to be installed.")
	}

	const lookup = new mod.WofSqlitePlaceLookup({ databasePath: wofPath })
	const shardProvider = new ShardProvider(mod, options.dataRoot)
	const shards: ShardResolver = shardProvider.for
	const defaultCountry = resolverDefaultCountry(options) || undefined

	try {
		const resolver = createWofResolver(lookup as unknown as ResolverBackend)

		// Wire the heavy geocoder into the matcher's seam: parse → components (for the canonical key +
		// formatting) and geocode → the resolved coordinate/tier. GeocodeResult is a structural superset
		// of the RawGeocode the adapter consumes. --no-place-country disables the default-on prior.
		const seam = geocodeAddressVia({
			parse: async (raw) => decodeAsJson(await classifier.parse(raw, { postcodeRepair: true })),
			geocode: (raw) =>
				geocodeAddress(raw, {
					classifier,
					resolver,
					shards,
					defaultCountry,
					interpCalibration: INTERP_RADIUS_CALIBRATION,
					...(options.placeCountry ? {} : { placeCountry: false }),
				}),
			country: defaultCountry,
		})

		const records = await ingestRows(rows, mapping, { geocodeAddress: seam })
		const result = resolveEntities(records, {
			trainEM: options.trainEm,
			threshold: options.threshold,
			...(options.maxBlockSize !== undefined ? { maxBlockSize: options.maxBlockSize } : {}),
		})
		const geojson = toGeoJSON(result.entities)

		const geocoded = records.filter((r) => r.address?.geocode).length
		const summary =
			`registry: ${rows.length} rows → ${records.length} records (${geocoded} geocoded) → ` +
			`${result.entities.length} entities ` +
			`(${result.candidatePairs} candidate pairs${result.droppedBlocks.length ? `, ${result.droppedBlocks.length} oversized blocks skipped` : ""})`

		if (options.out) {
			writeFileSync(options.out, JSON.stringify(geojson, null, 2))
			return `${summary}\nwrote ${geojson.features.length} features → ${options.out}`
		}
		return JSON.stringify(geojson, null, 2)
	} finally {
		shardProvider.close()
		lookup.close()
	}
}

// ---------------------------------------------------------------------------
// React command component
// ---------------------------------------------------------------------------

const RegistryCommand: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) => {
	const [output, setOutput] = useState<string>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		if (error) {
			setImmediate().then(() => process.exit(1))
		}
	}, [error])

	useEffect(() => {
		const csv = args[0]
		if (!csv || csv.trim().length === 0) {
			setError("registry requires a positional CSV path (e.g. mailwoman registry contacts.csv --out entities.geojson)")
			return
		}

		runRegistry(csv.trim(), options)
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

export default RegistryCommand
