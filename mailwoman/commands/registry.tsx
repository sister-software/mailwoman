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

import { readFileSync, writeFileSync } from "node:fs"
import { setImmediate } from "node:timers/promises"

import { Spinner } from "@inkjs/ui"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import {
	geocodeAddressVia,
	inferMapping,
	ingestRows,
	parseCSV,
	reconcileCoverage,
	reconciliationGeoJSON,
	reconciliationReport,
	resolveEntities,
	streamRows,
	toGeoJSON,
	toMapHTML,
	type ColumnMapping,
	type EntityGeoData,
	type GeocodeAddress,
	type SourceRecord,
} from "@mailwoman/registry"
import { createWOFResolver } from "@mailwoman/resolver"
import type { GeoFeatureCollection, PointLiteral } from "@mailwoman/spatial"
import { Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import { geocodeAddress, ShardProvider, type ShardResolver } from "../geocode-core.js"
import { INTERP_RADIUS_CALIBRATION } from "../interp-calibration.js"
import { createResolverBackend, mailwomanDataRoot, resolveCandidateDBPath } from "../resolver-backend.js"
import type { CommandComponent } from "../sdk/cli.js"
import { resolverDefaultCountry } from "./parse.js"

// ---------------------------------------------------------------------------
// CLI contract — args + options
// ---------------------------------------------------------------------------

const ArgumentsSchema = zod
	.array(zod.string().describe("Path to a CSV file of contact / organization records"))
	.optional()
	.describe("CSV path(s). Optional when --sources is given (multi-source mode supplies the inputs).")

const OptionsSchema = zod.object({
	mapping: zod
		.string()
		.optional()
		.describe(
			"Column mapping: a path to a JSON file (or inline JSON) of { id?, source?, name?, organization?, address?, " +
				"phone?, email? }, where each field names the CSV column(s) to draw from. Merged over the base (the built-in " +
				"default, or --infer-mapping's inference); column names are matched case-sensitively."
		),
	inferMapping: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Infer the column mapping from the header by keyword (best-effort — point it at any reasonably-named CSV). " +
				"Used as the base instead of the built-in default; an explicit --mapping still merges on top. Single-CSV mode."
		),
	sources: zod
		.string()
		.optional()
		.describe(
			"Multi-source mode: a path to a JSON file (or inline JSON) of [{ path, delimiter?, mapping, source?, limit? }] " +
				"— each dataset gets its own column mapping + provenance label, all resolved into ONE entity set across " +
				"sources with no shared key. An entity spanning ≥2 sources is a cross-dataset link. The positional CSV is " +
				"ignored when --sources is set. Inputs are streamed as UNQUOTED delimited files (tab inferred from .tsv) — " +
				"right for the big government TSVs; convert a quoted CSV first or use the single-CSV path for those."
		),
	out: zod.string().optional().describe("Write the GeoJSON FeatureCollection here. Default: print to stdout."),
	mapOut: zod
		.string()
		.optional()
		.describe(
			"Also write a standalone HTML map of the resolved entities here (MapLibre + the house Protomaps " +
				"basemap). Points are sized by records-merged and colored by cross-dataset-link status. SERVE IT OVER " +
				"localhost (e.g. `npx serve`), don't open the file directly — the basemap tiles are CORS-restricted to " +
				"localhost + the docs domain. Pairs naturally with --sources."
		),
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
	reconcile: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Coverage reconciliation (#621): classify each resolved entity by which KIND of source its records " +
				"span — `enrolled` (eligibility + funding), `eligible-not-enrolled` (the anti-join), or " +
				'`funded-not-eligible`. Requires --sources where each spec carries `role: "eligibility" | "funding"`. ' +
				"Prints a set-membership report to stdout; --out writes bucket-tagged GeoJSON, --map-out a bucket-colored " +
				"map. A reconciliation, never a determination."
		),
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
		.default(mailwomanDataRoot())
		.describe("Root directory for per-state address-point + interpolation shards. Defaults to $MAILWOMAN_DATA_ROOT."),
})

export { ArgumentsSchema as args, OptionsSchema as options }

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

/**
 * Built-in best-effort mapping for tidy contact/org CSVs. Multi-column fields are joined (so a CSV that splits the
 * address across columns composes one string). Real datasets with bespoke headers (e.g. NPPES "Provider First Line
 * Business Practice Location Address") pass an explicit --mapping; inferring it from the header is the #603
 * fast-follow.
 */
export const DEFAULT_MAPPING: ColumnMapping = {
	id: "id",
	name: ["name", "full_name", "first_name", "last_name"],
	organization: ["organization", "org", "company"],
	address: ["address", "address1", "street", "city", "state", "zip", "postal_code"],
	phone: "phone",
	email: "email",
}

/**
 * Resolve --mapping (a file path or inline JSON) and merge it over `base` (default {@link DEFAULT_MAPPING}).
 */
export function loadMapping(
	option: string | undefined,
	source: string | undefined,
	base: ColumnMapping = DEFAULT_MAPPING
): ColumnMapping {
	let provided: Partial<ColumnMapping> = {}

	if (option) {
		const text = option.trim().startsWith("{") ? option : readFileSync(option, "utf8")

		try {
			provided = JSON.parse(text) as Partial<ColumnMapping>
		} catch (err) {
			throw new Error(`--mapping is neither a readable file nor valid JSON: ${(err as Error).message}`)
		}
	}

	return { ...base, ...provided, ...(source ? { source } : {}) }
}

function resolveWOFPath(options: zod.infer<typeof OptionsSchema>): string {
	const path = options.resolveDb ?? process.env["MAILWOMAN_WOF_DB"]

	if (!path) {
		throw new Error("registry needs a WOF admin SQLite path. Set $MAILWOMAN_WOF_DB or pass --resolve-db <path>.")
	}

	return path
}

/**
 * Construct the heavy geocoder once (neural parser + WOF resolver + per-state shards) and wire it into the matcher's
 * {@link GeocodeAddress} seam. Returns the seam plus a `close` to release the DB handles. Shared by the single-CSV and
 * multi-source paths.
 */
async function buildGeocoder(
	options: zod.infer<typeof OptionsSchema>
): Promise<{ seam: GeocodeAddress; close: () => void }> {
	const wofPath = resolveWOFPath(options)

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

	// $MAILWOMAN_CANDIDATE_DB → the demo-parity candidate backend; else FTS over wofPath.
	const lookup = createResolverBackend(mod, { wofPaths: wofPath })
	const shardProvider = new ShardProvider(mod, options.dataRoot)
	const shards: ShardResolver = shardProvider.for
	const defaultCountry = resolverDefaultCountry(options, !!resolveCandidateDBPath()) || undefined
	const resolver = createWOFResolver(lookup)

	const seam = geocodeAddressVia({
		parse: async (raw) => decodeAsJSON(await classifier.parse(raw, { postcodeRepair: true })),
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

	return {
		seam,
		close: () => {
			shardProvider.close()
			lookup.close()
		},
	}
}

/**
 * One dataset in a `--sources` config: where it lives, its mapping, an optional provenance label + row cap.
 */
interface MultiSourceSpec {
	path: string
	delimiter?: "comma" | "tab"
	mapping: ColumnMapping
	source?: string
	/** For --reconcile: whether this dataset denotes eligibility/membership or funding/enrollment. */
	role?: "eligibility" | "funding"
	/**
	 * Read at most this many rows (the head of the file) — sampling a huge source without pre-filtering.
	 */
	limit?: number
}

/** Parse `--sources` (a file path or inline JSON) into specs. */
export function loadSources(option: string): MultiSourceSpec[] {
	const text = /^[[{]/.test(option.trim()) ? option : readFileSync(option, "utf8")
	let parsed: unknown

	try {
		parsed = JSON.parse(text)
	} catch (err) {
		throw new Error(`--sources is neither a readable file nor valid JSON: ${(err as Error).message}`)
	}

	if (!Array.isArray(parsed) || parsed.some((s) => !s || typeof (s as MultiSourceSpec).path !== "string")) {
		throw new Error("--sources must be a JSON array of { path, mapping, source?, delimiter?, limit? }.")
	}

	return parsed as MultiSourceSpec[]
}

/**
 * Write the artifacts requested via `--out` (GeoJSON) and/or `--map-out` (standalone HTML map), returning the lines to
 * append to the run summary. Returns `null` when neither is set — the signal to dump GeoJSON to stdout (the original
 * default). Shared by both pipeline paths.
 */
function writeOutputs(
	geojson: GeoFeatureCollection<PointLiteral, EntityGeoData>,
	options: zod.infer<typeof OptionsSchema>
): string | null {
	if (!options.out && !options.mapOut) return null
	const lines: string[] = []

	if (options.out) {
		writeFileSync(options.out, JSON.stringify(geojson, null, 2))
		lines.push(`wrote ${geojson.features.length} features → ${options.out}`)
	}

	if (options.mapOut) {
		writeFileSync(options.mapOut, toMapHTML(geojson, options.source ? { title: `Mailwoman — ${options.source}` } : {}))
		lines.push(`wrote map → ${options.mapOut} (serve over localhost to view)`)
	}

	return lines.join("\n")
}

/**
 * Multi-source mode (#618): stream each dataset under its own mapping + provenance label into ONE combined record set,
 * geocode, resolve, and report the entities that span ≥2 sources — the cross-dataset links. No shared key required;
 * geography is the join.
 */
async function runMultiSource(specs: MultiSourceSpec[], options: zod.infer<typeof OptionsSchema>): Promise<string> {
	const { seam, close } = await buildGeocoder(options)

	try {
		const records: SourceRecord[] = []
		const perSource: string[] = []

		for (const spec of specs) {
			const label = spec.source ?? spec.path
			const mapping: ColumnMapping = { ...spec.mapping, source: label }
			let read = 0
			const rows = (async function* () {
				for await (const row of streamRows(spec.path, spec.delimiter ? { delimiter: spec.delimiter } : {})) {
					if (spec.limit !== undefined && read >= spec.limit) break
					read++
					yield row
				}
			})()
			const recs = await ingestRows(rows, mapping, { geocodeAddress: seam })

			for (const record of recs) record.id = `${label}:${record.id}` // namespace ids so cross-source ids never collide
			records.push(...recs)
			perSource.push(`${label} ${recs.length}`)
		}

		// learnedScorer:false — multi-source is CROSS-dataset link discovery (recall-oriented): the same
		// facility under different operational names across sources is the signal we want. The default GBT is
		// dedup-calibrated and rejects exactly that (it learned "same place + name drift = distinct"), so the
		// cross-dataset path uses the FS spine. (Single-CSV dedup below keeps the GBT default.)
		const result = resolveEntities(records, {
			trainEM: options.trainEm,
			threshold: options.threshold,
			learnedScorer: false,
			...(options.maxBlockSize !== undefined ? { maxBlockSize: options.maxBlockSize } : {}),
		})
		const geocoded = records.filter((r) => r.address?.geocode).length

		// Reconciliation mode (#621): classify entities by eligibility/funding role membership, via the
		// SAME @mailwoman/registry library as scripts/record-matcher/coverage-reconciliation.ts.
		if (options.reconcile) {
			const labelOf = (s: MultiSourceSpec) => s.source ?? s.path
			const eligibilitySources = specs.filter((s) => s.role === "eligibility").map(labelOf)
			const fundingSources = specs.filter((s) => s.role === "funding").map(labelOf)

			if (!eligibilitySources.length || !fundingSources.length) {
				throw new Error(
					'--reconcile needs each --sources entry tagged with `role: "eligibility"` or `role: "funding"` ' +
						"(at least one of each)."
				)
			}
			const recon = reconcileCoverage(result.entities, { eligibilitySources, fundingSources })
			const geojson = reconciliationGeoJSON(recon)
			const report = reconciliationReport(recon, {
				scopeNote:
					`Resolved BLIND across ${specs.length} sources via \`mailwoman registry --reconcile\` ` +
					`(${perSource.join(", ")}). Eligibility: ${eligibilitySources.join(", ")}; funding/enrollment: ` +
					`${fundingSources.join(", ")}.`,
				scorerNote:
					"Scored with the Fellegi-Sunter spine (cross-dataset join, recall-oriented): the dedup-calibrated " +
					'GBT default (#603) rejects the "same place, different operational name" pattern that IS the ' +
					"cross-source signal, so it is pinned off here. See #655.",
			})
			const written = writeOutputs(geojson, options)

			return written === null ? report : `${report}\n\n${written}`
		}

		const geojson = toGeoJSON(result.entities)
		const crossSource = result.entities.filter(
			(e) => new Set(e.records.map((r) => r.source).filter(Boolean)).size >= 2
		).length
		const summary =
			`registry --sources: ${specs.length} sources (${perSource.join(", ")}) → ${records.length} records ` +
			`(${geocoded} geocoded) → ${result.entities.length} entities; ${crossSource} span ≥2 sources (cross-dataset links)`

		const written = writeOutputs(geojson, options)

		return written === null ? JSON.stringify(geojson, null, 2) : `${summary}\n${written}`
	} finally {
		close()
	}
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

async function runRegistry(csvPath: string, options: zod.infer<typeof OptionsSchema>): Promise<string> {
	if (options.reconcile) {
		throw new Error(
			"--reconcile is a cross-source mode: pass --sources <config.json> (each entry tagged with a " +
				"`role`), not a single positional CSV."
		)
	}
	const rows = parseCSV(readFileSync(csvPath, "utf8"))
	// --infer-mapping reads the header (the first row's keys) and guesses the mapping; an explicit --mapping
	// still merges on top of it. Otherwise the base is the built-in default.
	const base = options.inferMapping && rows[0] ? inferMapping(Object.keys(rows[0])) : DEFAULT_MAPPING
	const mapping = loadMapping(options.mapping, options.source, base)
	const { seam, close } = await buildGeocoder(options)

	try {
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

		const written = writeOutputs(geojson, options)

		return written === null ? JSON.stringify(geojson, null, 2) : `${summary}\n${written}`
	} finally {
		close()
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
		// `loadSources` can throw on a malformed config — wrap so its error routes to the same handler.
		const task = options.sources
			? Promise.resolve().then(() => runMultiSource(loadSources(options.sources!), options))
			: (() => {
					const csv = args?.[0]

					if (!csv || csv.trim().length === 0) {
						return Promise.reject(
							new Error(
								"registry requires a positional CSV path (or --sources <config.json> for multi-source). " +
									"e.g. mailwoman registry contacts.csv --out entities.geojson"
							)
						)
					}

					return runRegistry(csv.trim(), options)
				})()

		task.then(setOutput).catch((err: unknown) => setError((err as Error).message))
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
