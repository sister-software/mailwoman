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

import { Spinner } from "@inkjs/ui"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import type { NeuralAddressClassifier } from "@mailwoman/neural"
import type { ColumnMapping, EntityGeoData, GeocodeAddress, SourceRecord } from "@mailwoman/registry"
import type { EvalGeocoder, EvalGeocoderFactory } from "@mailwoman/registry/tools"
import type { GeoFeatureCollection, PointLiteral } from "@mailwoman/spatial"
import { Text } from "ink"
import { CommandError, type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

import { resolverDefaultCountry } from "../../country-scope.ts"
import type { ShardResolver } from "../../geocode-core.ts"

/**
 * Bare `mailwoman registry <csv>` stays the end-to-end matcher now that `registry/` hosts subcommands.
 */
export const isDefault = true

//#region CLI contract — args + options

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "run",
	description: "Resolve records into matched entities",
	positionals: [{ name: "csv", multiple: true, description: "CSV input paths" }],
	options: {
		mapping: { type: "string", description: "Column mapping JSON or path" },
		"infer-mapping": { type: "boolean", default: false, description: "Infer mapping from headers" },
		sources: { type: "string", description: "Multi-source specification JSON or path" },
		out: { type: "string", description: "GeoJSON output" },
		"map-out": { type: "string", description: "Standalone HTML map output" },
		"train-em": { type: "boolean", default: true, description: "Train Fellegi-Sunter parameters" },
		threshold: { type: "number", default: 0, description: "Entity link threshold" },
		"max-block-size": { type: "number", description: "Maximum scanned block size" },
		reconcile: { type: "boolean", default: false, description: "Run coverage reconciliation" },
		source: { type: "string", description: "Provenance label" },
		locale: {
			type: "string",
			default: "en-US",
			validate: (v: string) => /^[a-z]{2}(-[A-Z]{2})?$/u.test(v),
			description: "BCP-47 locale",
		},
		"default-country": { type: "string", description: "Resolver country scope" },
		"place-country": { type: "boolean", default: true, description: "Enable coarse country prior" },
		"resolve-db": { type: "string", description: "WOF admin database" },
		"data-root": { type: "string", default: mailwomanDataRoot(), description: "State-shard root" },
	},
} as const satisfies CommandSpec

interface Options {
	mapping?: string
	inferMapping: boolean
	sources?: string
	out?: string
	mapOut?: string
	trainEm: boolean
	threshold: number
	maxBlockSize?: number
	reconcile: boolean
	source?: string
	locale: string
	defaultCountry?: string
	placeCountry: boolean
	resolveDB?: string
	dataRoot: string
}

//#endregion

//#region Column mapping

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
		const parsed = tryParsingJSON<Partial<ColumnMapping>>(text)

		if (!parsed) {
			throw new CommandError(`--mapping is neither a readable file nor a JSON object: ${text}`)
		}

		provided = parsed
	}

	return { ...base, ...provided, ...(source ? { source } : {}) }
}

async function resolveWOFPath(options: Options): Promise<string> {
	const { $public } = await import("@mailwoman/core/env")
	const path = options.resolveDB ?? $public.MAILWOMAN_WOF_DB

	if (!path) {
		throw new CommandError("registry needs a WOF admin SQLite path. Set $MAILWOMAN_WOF_DB or pass --resolve-db <path>.")
	}

	return path
}

/**
 * Construct the heavy geocoder once (neural parser + WOF resolver + per-state shards) and wire it into the matcher's
 * {@link GeocodeAddress} seam. Returns the seam plus a `close` to release the DB handles. Shared by the single-CSV and
 * multi-source paths.
 */
async function buildGeocoder(options: Options): Promise<{ seam: GeocodeAddress; close: () => void }> {
	const { decodeAsJSON } = await import("@mailwoman/core/decoder")
	const { NeuralAddressClassifier } = await import("@mailwoman/neural")
	const { geocodeAddressVia } = await import("@mailwoman/registry")
	const { createWOFResolver } = await import("@mailwoman/resolver")
	const { geocodeAddress, ShardProvider } = await import("../../geocode-core.ts")
	const { INTERP_RADIUS_CALIBRATION } = await import("../../interp-calibration.ts")
	const { createResolverBackend, resolveCandidateDBPath } = await import("../../resolver-backend.ts")

	const wofPath = await resolveWOFPath(options)

	let classifier: NeuralAddressClassifier

	try {
		classifier = await NeuralAddressClassifier.loadFromWeights({ locale: options.locale })
	} catch {
		throw new CommandError(
			"registry requires the neural weights. Install @mailwoman/neural-weights-en-us (or a --locale match)."
		)
	}

	let mod: typeof import("@mailwoman/resolver-wof-sqlite")

	try {
		mod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		throw new CommandError("registry requires `@mailwoman/resolver-wof-sqlite` to be installed.")
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
 * Command-level wiring for the record-matcher tool geocoder (`--wof`/`--data-root`/`--locale` + model swaps).
 */
export interface EvalGeocoderFlags {
	/**
	 * WOF admin SQLite path. Default `$MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db`.
	 */
	wof?: string
	/**
	 * Per-state shard root. Default `$MAILWOMAN_DATA_ROOT`.
	 */
	dataRoot?: string
	/**
	 * Weights locale. Default en-US.
	 */
	locale?: string
	/**
	 * Model-swap overrides (`nppes-benchmark` multi-version curves). `modelCardPath` is MANDATORY with `modelPath`.
	 */
	modelPath?: string
	tokenizerPath?: string
	modelCardPath?: string
}

/**
 * Build the {@link EvalGeocoderFactory} the `@mailwoman/registry/tools` record-matcher tools take. This is the eval
 * scripts' historical construction, preserved exactly: a plain `WOFSqlitePlaceLookup` over an explicit WOF path (NOT
 * the candidate-table backend {@link buildGeocoder} uses), `defaultCountry: "US"`, `placeCountry: false`, and
 * `postcodeRepair: true` at the parse — so migrated evals reproduce the retired scripts' numbers. Shared by the
 * `registry train-scorer` and `registry scorer-eval` commands.
 */
export function evalGeocoderFactory(flags: EvalGeocoderFlags): EvalGeocoderFactory {
	return async (init): Promise<EvalGeocoder> => {
		const { dataRootPath } = await import("@mailwoman/core/utils")
		const { decodeAsJSON } = await import("@mailwoman/core/decoder")
		const { NeuralAddressClassifier } = await import("@mailwoman/neural")
		const { geocodeAddressVia } = await import("@mailwoman/registry")
		const { createWOFResolver } = await import("@mailwoman/resolver")
		const { geocodeAddress, ShardProvider } = await import("../../geocode-core.ts")

		const wof = flags.wof || String(dataRootPath("wof", "admin-global-priority.db"))
		const dataRoot = flags.dataRoot || mailwomanDataRoot()

		const classifier = await NeuralAddressClassifier.loadFromWeights({
			locale: flags.locale || "en-US",
			...(flags.modelPath ? { modelPath: flags.modelPath } : {}),
			...(flags.tokenizerPath ? { tokenizerPath: flags.tokenizerPath } : {}),
			...(flags.modelCardPath ? { modelCardPath: flags.modelCardPath } : {}),
		})

		const mod = await import("@mailwoman/resolver-wof-sqlite")
		const lookup = new mod.WOFSqlitePlaceLookup({ databasePath: wof })
		const resolver = createWOFResolver(lookup)
		const shardProvider = new ShardProvider(mod, dataRoot)

		const geocode = (raw: string) =>
			geocodeAddress(raw, {
				classifier,
				resolver,
				shards: shardProvider.for,
				defaultCountry: "US",
				placeCountry: false,
				...(init?.normalizeCase !== undefined ? { normalizeCase: init.normalizeCase } : {}),
			})

		const seam = geocodeAddressVia({
			parse: async (raw) => decodeAsJSON(await classifier.parse(raw, { postcodeRepair: true })),
			geocode,
			country: "US",
		})

		return {
			seam,
			geocode,
			close: () => {
				shardProvider.close()
				lookup.close()
			},
		}
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
	/**
	 * For --reconcile: whether this dataset denotes eligibility/membership or funding/enrollment.
	 */
	role?: "eligibility" | "funding"
	/**
	 * Read at most this many rows (the head of the file) — sampling a huge source without pre-filtering.
	 */
	limit?: number
}

/**
 * Parse `--sources` (a file path or inline JSON) into specs.
 */
export function loadSources(option: string): MultiSourceSpec[] {
	const text = /^[[{]/.test(option.trim()) ? option : readFileSync(option, "utf8")
	const parsed = tryParsingJSON(text)

	if (parsed === null) {
		throw new CommandError(`--sources is neither a readable file nor valid JSON: ${text}`)
	}

	if (!Array.isArray(parsed) || parsed.some((s) => !s || typeof (s as MultiSourceSpec).path !== "string")) {
		throw new CommandError("--sources must be a JSON array of { path, mapping, source?, delimiter?, limit? }.")
	}

	return parsed as MultiSourceSpec[]
}

/**
 * Write the artifacts requested via `--out` (GeoJSON) and/or `--map-out` (standalone HTML map), returning the lines to
 * append to the run summary. Returns `null` when neither is set — the signal to dump GeoJSON to stdout (the original
 * default). Shared by both pipeline paths.
 */
async function writeOutputs(
	geojson: GeoFeatureCollection<PointLiteral, EntityGeoData>,
	options: Options
): Promise<string | null> {
	if (!options.out && !options.mapOut) return null

	const { toMapHTML } = await import("@mailwoman/registry")
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
async function runMultiSource(specs: MultiSourceSpec[], options: Options): Promise<string> {
	const {
		ingestRows,
		reconcileCoverage,
		reconciliationGeoJSON,
		reconciliationReport,
		resolveEntities,
		streamRows,
		toGeoJSON,
	} = await import("@mailwoman/registry")

	const { seam, close } = await buildGeocoder(options)

	try {
		const records: SourceRecord[] = []
		const perSource: string[] = []

		for (const sourceSpec of specs) {
			const label = sourceSpec.source ?? sourceSpec.path
			const mapping: ColumnMapping = { ...sourceSpec.mapping, source: label }
			let read = 0

			const rows = (async function* () {
				for await (const row of streamRows(
					sourceSpec.path,
					sourceSpec.delimiter ? { delimiter: sourceSpec.delimiter } : {}
				)) {
					if (sourceSpec.limit !== undefined && read >= sourceSpec.limit) break

					read++
					yield row
				}
			})()

			const recs = await ingestRows(rows, mapping, { geocodeAddress: seam })

			for (const record of recs) {
				record.id = `${label}:${record.id}`
			}

			// namespace ids so cross-source ids never collide
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
		// SAME @mailwoman/registry library as `registry scorer-eval coverage-reconciliation`.
		if (options.reconcile) {
			const labelOf = (s: MultiSourceSpec) => s.source ?? s.path
			const eligibilitySources = specs.filter((s) => s.role === "eligibility").map(labelOf)
			const fundingSources = specs.filter((s) => s.role === "funding").map(labelOf)

			if (!eligibilitySources.length || !fundingSources.length) {
				throw new CommandError(
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

			const written = await writeOutputs(geojson, options)

			return written === null ? report : `${report}\n\n${written}`
		}

		const geojson = toGeoJSON(result.entities)

		const crossSource = result.entities.filter(
			(e) => new Set(e.records.map((r) => r.source).filter(Boolean)).size >= 2
		).length

		const summary =
			`registry --sources: ${specs.length} sources (${perSource.join(", ")}) → ${records.length} records ` +
			`(${geocoded} geocoded) → ${result.entities.length} entities; ${crossSource} span ≥2 sources (cross-dataset links)`

		const written = await writeOutputs(geojson, options)

		return written === null ? JSON.stringify(geojson, null, 2) : `${summary}\n${written}`
	} finally {
		close()
	}
}

//#endregion

//#region Core

async function runRegistry(csvPath: string, options: Options): Promise<string> {
	const { inferMapping, ingestRows, parseCSV, resolveEntities, toGeoJSON } = await import("@mailwoman/registry")

	if (options.reconcile) {
		throw new CommandError(
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

		const written = await writeOutputs(geojson, options)

		return written === null ? JSON.stringify(geojson, null, 2) : `${summary}\n${written}`
	} finally {
		close()
	}
}

//#endregion

//#region React command component

const RegistryCommand: ParsedCommandComponent<Options> = ({ args, options }) => {
	const state = useCommandTask(async () => {
		// `loadSources` can throw on a malformed config — the hook routes its error to the same handler.
		if (options.sources) {
			return runMultiSource(loadSources(options.sources), options)
		}

		const csv = args?.[0]

		if (!csv || !csv.trim().length) {
			throw new CommandError(
				"registry requires a positional CSV path (or --sources <config.json> for multi-source). " +
					"e.g. mailwoman registry contacts.csv --out entities.geojson"
			)
		}

		return runRegistry(csv.trim(), options)
	})

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	if (state.status !== "done") {
		return <Spinner />
	}

	return <Text>{state.result}</Text>
}

export default RegistryCommand

//#endregion
