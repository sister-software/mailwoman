/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { QueryIntentMarker } from "@mailwoman/core/pipeline"
import { channelsRow, decodeRow, localeHeadRow, systemRow, tokensRow } from "mailwoman/debug-view/trace-rows"
import type { GeocodeRun } from "mailwoman/geocode"
import { z } from "zod"

import type { Engine, EngineRegistryLike } from "#engine/registry"
import type { EvalReport } from "#eval-report"
import { summarizeEvalReport } from "#eval-report"
import { summarizeGauntletReport, type GauntletReport } from "#gauntlet-report"
import type { RowGrade } from "#grade"
import { HOLDOUT_DEFAULT_N, HOLDOUT_SOURCES, type ResolvedInputSet } from "#input-sets"
import type { JobRegistry } from "#jobs"

/**
 * The provenance attached to each measurement result.
 */
export interface Provenance {
	engine_id: string
	tree_fingerprint: string
	git_head: string
	dirty: boolean
	dirty_files: string[]
	config_effective: Record<string, unknown>
	engine_build_ms: number
	engine_was_warm: boolean
	input_set: {
		set_id: string
		n: number
		sha256: string
		selection: string
		population_n?: number
		why?: string
		not_covered: string[]
		has_truth: ResolvedInputSet["hasTruth"]
		corpus_hash?: string
		notes: string[]
	}
}

/**
 * Converts input-set metadata to the provenance shape.
 */
export function inputSetProvenance(set: ResolvedInputSet): Provenance["input_set"] {
	return {
		set_id: set.setID,
		n: set.n,
		sha256: set.sha256,
		selection: set.selection,
		...(set.populationN === undefined ? {} : { population_n: set.populationN }),
		...(set.why === undefined ? {} : { why: set.why }),
		not_covered: set.notCovered,
		has_truth: set.hasTruth,
		...(set.corpusHash === undefined ? {} : { corpus_hash: set.corpusHash }),
		notes: set.notes,
	}
}

/**
 * Builds the provenance record for a result from the engine that produced it and the input set it measured.
 */
export function provenanceFor(
	engine: {
		engineID: string
		effective: Record<string, unknown>
		fingerprint: { digest: string; gitHead: string; dirtyFiles: string[] }
		buildMs: number
		uses: number
	},
	set: ResolvedInputSet
): Provenance {
	return {
		engine_id: engine.engineID,
		tree_fingerprint: engine.fingerprint.digest,
		git_head: engine.fingerprint.gitHead,
		dirty: engine.fingerprint.dirtyFiles.length > 0,
		dirty_files: engine.fingerprint.dirtyFiles,
		config_effective: engine.effective,
		engine_build_ms: engine.buildMs,
		engine_was_warm: engine.uses > 1,
		input_set: inputSetProvenance(set),
	}
}

const LITERAL_INPUT_WITH_TRUTH_SCHEMA = z.object({
	input: z.string().min(1),
	lat: z.number().describe("Truth latitude. Say where it came from in `why` — an invented pin grades nothing."),
	lon: z.number(),
	tolerance_m: z
		.number()
		.positive()
		.optional()
		.describe("Per-row distance tolerance. Omit to let the caller's threshold apply."),
	truth_type: z
		.string()
		.optional()
		.describe(
			"How the point was established — `rooftop`, `parcel`, `interpolated`, `centroid`. Stratifiable, because a " +
				"headline at 1 km lives or dies on it."
		),
})

const LITERAL_INPUT_SCHEMA = z.union([z.string(), LITERAL_INPUT_WITH_TRUTH_SCHEMA])

const LITERAL_INPUTS_DESCRIPTION =
	"Bare strings are observed without a truth point, so they are not graded. An object carrying `lat`/`lon` is GRADED against that point, " +
	"which is what makes this the authoring loop for a new board row: measure the candidates before writing the case " +
	"file, rather than writing rows and discovering the score afterwards."

/**
 * Validates the input-set selection that measurement tools accept.
 */
export const INPUT_SET_SCHEMA = z
	.union([
		z.object({
			kind: z.literal("board"),
			country: z.string().optional(),
			address_kind: z.string().optional(),
			status: z.string().optional(),
		}),
		z.object({
			kind: z.literal("panel"),
			version: z.enum(["v1", "v2", "v2.1", "v3", "v3.1"]).optional(),
			country: z.string().optional(),
			truth_type: z.string().optional(),
		}),
		z.object({
			kind: z.literal("golden"),
			version: z.string().optional(),
			split: z.enum(["dev", "full"]).optional(),
		}),
		z.object({
			kind: z.literal("parity"),
			country: z.string().optional(),
		}),
		z.object({
			kind: z.literal("holdout"),
			source: z.enum(HOLDOUT_SOURCES).optional().describe("fr = BAN, us = FDIC. Default fr."),
			n: z.number().int().positive().optional().describe(`Draw size. Default ${HOLDOUT_DEFAULT_N}.`),
			seed: z
				.number()
				.int()
				.optional()
				.describe(
					"Omit for a genuinely fresh draw — the property that makes this the one set the model cannot have " +
						"memorized. Pass a seed only to REPRODUCE a draw (re-running one arm later, or a recorded-arm " +
						"comparison); a seeded set can be iterated against, which is how a held-out set stops being one."
				),
		}),
		z
			.object({
				kind: z.literal("ladder"),
				country: z.string().optional(),
				address_kind: z.string().optional(),
				status: z.string().optional(),
			})
			.describe(
				"The autocomplete ladder over a board filter: every truth-containing row expanded into its prefix rungs, each graded at the row's own truth and tolerance with the row's country as the locale hint. Rows read as <id>@<rung length>."
			),
		z.object({
			kind: z.literal("literal"),
			inputs: z.array(LITERAL_INPUT_SCHEMA).min(1).describe(LITERAL_INPUTS_DESCRIPTION),
			why: z
				.string()
				.min(1)
				.describe("Why these inputs and not the board. Echoed into every result derived from this set."),
		}),
	])
	.describe('Which inputs to measure. `{"kind":"board"}` is the full 558-row regression board and is the default.')

/**
 * Validates engine configuration pins, using the CLI's key names.
 *
 * An unset key keeps the production default.
 * It never turns the feature off.
 */
export const ENGINE_CONFIG_SCHEMA = z
	.object({
		locale: z.string().optional(),
		country_scope: z.enum(["auto", "locale", "none"]).optional(),
		default_country: z.string().optional(),
		bias: z.string().optional(),
		candidate_db: z.string().optional(),
		resolve_db: z.string().optional(),
		data_root: z.string().optional(),
		weights_cache: z
			.string()
			.optional()
			.describe(
				"Grade a CANDIDATE model instead of the installed one: a package-shaped directory " +
					"(`<root>/node_modules/@mailwoman/neural-weights-<locale>/`), as `mwdev_promotion_eval` takes. This is what makes " +
					"shipped-vs-candidate an ordinary two-arm comparison rather than a script. A root that is not staged is " +
					"REFUSED, not silently replaced by the shipped weights — the resolution ladder falls through, so an " +
					"unchecked typo would grade the default model under the candidate's name."
			),
		gazetteer_prior: z.boolean().optional(),
		place_country: z.boolean().optional(),
		place_country_threshold: z.number().optional(),
		postcode_country_coherence: z.boolean().optional(),
		fork_entity: z.boolean().optional(),
		locale_country_prior: z.boolean().optional(),
		postcode_shape_coherence: z.boolean().optional(),
		postcode_containment_coherence: z.boolean().optional(),
		admin_containment_rerank: z.boolean().optional(),
		poi_venue_tier: z.boolean().optional(),
		capital_tier: z.boolean().optional(),
		variant_alias_exemption: z.boolean().optional(),
	})
	.strict()
	.describe("Every pin, in the CLI's vocabulary. Unset means the PRODUCTION DEFAULT, never off.")

/**
 * The shared services that each dev MCP tool factory receives.
 */
export interface DevToolDeps {
	registry: EngineRegistryLike
	jobs: JobRegistry
	startedAt: number
}

/**
 * One dev MCP tool as registered with the server.
 */
export interface DevTool {
	name: string
	description: string
	inputSchema: z.ZodObject<z.ZodRawShape>
	handler: (args: Record<string, unknown>) => Promise<unknown>
}

/**
 * The maximum number of diffs rendered as text.
 * Beyond it, results carry only the structured list.
 */
export const RENDERED_DIFF_LIMIT = 40

/**
 * Two acquired engines, or the error that prevented the comparison.
 */
export type TwoArms =
	| { base: Engine; candidate: Engine; error?: undefined }
	| { base?: undefined; candidate?: undefined; error: Record<string, unknown> }

/**
 * Acquires a baseline engine and a candidate engine.
 *
 * It returns an error when `weightsCache` yields the baseline's engine,
 * because the candidate weights were then not applied.
 */
export async function acquireTwoArms(
	registry: EngineRegistryLike,
	options: { locale?: string | undefined; weightsCache?: string | undefined }
): Promise<TwoArms> {
	const { locale, weightsCache } = options
	const base = await registry.acquire(locale ? { locale } : {})

	const candidate = await registry.acquire({
		...(locale ? { locale } : {}),
		...(weightsCache ? { weights_cache: weightsCache } : {}),
	})

	if (weightsCache && base.engineID === candidate.engineID) {
		return {
			error: {
				error: "weights_cache did not take",
				requested: weightsCache,
				engine_id: candidate.engineID,
				summary:
					"Both arms resolved to the SAME engine, so the candidate weights were not applied and any " +
					"zero-difference result here would be meaningless. Check the path is a package-shaped directory " +
					"(<root>/node_modules/@mailwoman/neural-weights-<locale>/) and that it exists.",
			},
		}
	}

	return { base, candidate }
}

/**
 * Returns the flat component map of a geocode run's result as string values.
 */
export function componentsOf(run: GeocodeRun): Record<string, string> {
	return run.result.components as Record<string, string>
}

/**
 * Returns the parse trace without its large numeric matrices, keeping only each channel's confidence.
 */
export function slimParseTrace(parse: NonNullable<GeocodeRun["trace"]>["parse"]): Record<string, unknown> {
	const { logits, emissions, anchor, gazetteer, country, ...rest } = parse

	void logits
	void emissions

	const channel = (c: { confidence?: unknown } | undefined): unknown =>
		c && typeof c === "object" ? { confidence: c.confidence } : c

	return {
		...rest,
		anchor: channel(anchor),
		gazetteer: channel(gazetteer),
		country: channel(country),
		matrices_omitted:
			"logits, emissions, and per-channel feature matrices omitted (thousands of floats) — pass " +
			"full_parse_trace: true for the raw numbers.",
	}
}

function droppedRow(run: GeocodeRun): string[] {
	const dropped = (run.result as { dropped_components?: Array<{ tag: string; value: string; kept: string }> })
		.dropped_components

	if (!dropped?.length) return []

	return [
		"projection: " +
			dropped.map((d) => `${d.tag} "${d.value}" DELETED — "${d.kept}" held the slot`).join("; ") +
			" — the flat map holds one value per tag, so these spans were parsed and then discarded (#1755). " +
			"A null component below may be this, not an absence in the input.",
	]
}

function refusalRow(run: GeocodeRun): string[] {
	const markers = (run.result as { intent_markers?: QueryIntentMarker[] }).intent_markers

	if (!markers?.length) return []

	const named = markers
		.map((marker) => {
			const evidence = marker.evidence ? ` ${stringifyJSON(marker.evidence)}` : ""

			return `${marker.kind} via ${marker.mechanism}${evidence}`
		})
		.join(", ")

	return [
		`intent: REFUSED as ${named} — the #1649 check discarded a completed parse rather than the parse failing. ` +
			"Every empty component below follows from that decision, not from the model.",
	]
}

/**
 * Renders a geocode run's trace as text rows, or explains in `absent_reason` why no trace exists.
 */
export function renderTrace(run: GeocodeRun): { rendered: string[]; absent_reason?: string } {
	if (!run.trace) {
		return {
			rendered: [],
			absent_reason:
				"No trace was recorded. Either the session was opened without `trace`, or the loaded bundle's classifier " +
				"cannot produce one — a property of the bundle, not a zero.",
		}
	}

	return {
		rendered: [
			systemRow(run.trace),
			tokensRow(run.trace),
			channelsRow(run.trace),
			localeHeadRow(run.trace),
			decodeRow(run.trace),
			...refusalRow(run),
			...droppedRow(run),
			...resolverRows(run.trace),
		],
	}
}

function resolverRows(trace: NonNullable<GeocodeRun["trace"]>): string[] {
	const records = trace.resolver

	if (!records) {
		return ["resolver: (absent — this trace predates the resolver-interior records)"]
	}

	if (!records.length) {
		return ["resolver: no lookups performed (no resolvable node reached the walk)"]
	}

	return records.map((record) => {
		const query = [
			record.placetype,
			record.query.country ? `country=${record.query.country}` : null,
			record.query.parentID !== undefined ? `parent=${record.query.parentID}` : null,
			record.query.regionQualifier ? `qualifier=${stringifyJSON(record.query.regionQualifier)}` : null,
			`limit=${record.query.limit}`,
		]
			.filter((part) => part !== null)
			.join(" ")

		const reach =
			record.reachableIn === undefined
				? ""
				: record.reachableIn.length
					? `\n    UNREACHABLE, not absent — the key lives in ${record.reachableIn
							.map((b) => `${b.placetype}×${b.n}`)
							.join(", ")}. The band was chosen by the parse tag, so this is a mislabel, not missing data.`
					: "\n    absent — every admin band was probed and none holds this key. COVERAGE, not reachability."

		const rows = record.candidates.map((c) => {
			const ranks = Object.entries(c.ranks)
				.map(([stage, rank]) => `${stage}:${rank}`)
				.join("→")

			const picked = record.picked && record.picked.id === c.id ? " ◀ PICKED" : ""

			return `    ${c.name} (${c.country} ${c.placetype} id=${c.id}) score=${c.score}${
				c.prominence !== undefined ? ` prom=${c.prominence.toFixed(2)}` : ""
			}${c.importance !== undefined ? ` imp=${c.importance.toFixed(2)}` : ""}${
				c.population !== undefined ? ` pop=${c.population}` : ""
			}${c.containedByQualifier !== undefined ? ` contained=${c.containedByQualifier}` : ""} [${ranks}]${picked}`
		})

		const head =
			`resolver ${stringifyJSON(record.value)} → ${query}` +
			(record.checks.length ? ` checks=[${record.checks.join(",")}]` : "") +
			(record.picked
				? record.picked.source === "ranked"
					? ""
					: ` picked-via=${record.picked.source}`
				: " → NOTHING (picked: null)") +
			(record.candidatesTruncated ? ` (+${record.candidatesTruncated} rows past the cap)` : "") +
			reach

		return [head, ...rows].join("\n")
	})
}

/**
 * Counts, for each arm, the rows on which each opt-in mechanism fired, whether or not the outcome changed.
 */
export function firingSignals(rows: ComparedRow[]): Record<string, { a: number; b: number }> {
	const scoped = (row: ComparedRow, arm: "a" | "b"): boolean =>
		Boolean((row[arm] as { postcode_country_scope?: string | null }).postcode_country_scope)

	const promoted = (row: ComparedRow, arm: "a" | "b"): boolean =>
		Boolean((row[arm] as { capital_promotion?: string }).capital_promotion)

	const exempted = (row: ComparedRow, arm: "a" | "b"): boolean =>
		(row[arm] as { variant_alias_exemption?: true }).variant_alias_exemption === true

	return {
		postcode_country_scope: {
			a: rows.filter((row) => scoped(row, "a")).length,
			b: rows.filter((row) => scoped(row, "b")).length,
		},
		capital_promotion: {
			a: rows.filter((row) => promoted(row, "a")).length,
			b: rows.filter((row) => promoted(row, "b")).length,
		},
		variant_alias_exemption: {
			a: rows.filter((row) => exempted(row, "a")).length,
			b: rows.filter((row) => exempted(row, "b")).length,
		},
	}
}

/**
 * One input measured under both comparison arms.
 *
 * `differed` and `grade` are independent, because the output can change without changing the grade.
 */
export interface ComparedRow {
	id: string
	input: string
	country?: string
	address_kind?: string
	status?: string
	differed: boolean
	grade: RowGrade
	a: unknown
	b: unknown
	issues_a: string[]
	issues_b: string[]

	/**
	 * True when the place ID chains differ.
	 * It is present only when both arms report `place_ids`.
	 */
	identity_differed?: boolean

	/**
	 * True when the result tiers differ.
	 * It is present only when both arms report a tier.
	 */
	tier_differed?: boolean
}

/**
 * A field that comparison results can be stratified by.
 *
 * `truth_tolerance_m` applies only to rows graded against a coordinate.
 */
export type StratumKey = "country" | "address_kind" | "status" | "truth_tolerance_m" | "truth_type"

const STRATUM_KEYS: readonly StratumKey[] = ["country", "address_kind", "status", "truth_tolerance_m", "truth_type"]

/**
 * Asserts that `by` is a known {@linkcode StratumKey}.
 *
 * @throws If `by` is not a known stratum.
 */
export function assertStratumKey(by: string): asserts by is StratumKey {
	if (!STRATUM_KEYS.includes(by as StratumKey)) {
		throw new Error(
			`stratify_by ${stringifyJSON(by)} is not a stratum. Known: ${STRATUM_KEYS.join(", ")}. Bucketing an ` +
				"unrecognised key would report one `unknown` bucket, which reads as a stratified result and is not one."
		)
	}
}

/**
 * Groups rows by the key that `key` returns.
 * Every stratifier uses this function.
 */
export function bucketRows<Row>(rows: Row[], key: (row: Row) => string): Map<string, Row[]> {
	const buckets = new Map<string, Row[]>()

	for (const row of rows) {
		const bucket = buckets.get(key(row))

		if (bucket) {
			bucket.push(row)
		} else {
			buckets.set(key(row), [row])
		}
	}

	return buckets
}

/**
 * Returns the difference and grade counts for each stratum.
 */
export function stratify(rows: ComparedRow[], by: StratumKey): Record<string, unknown> {
	const buckets = bucketRows(
		rows,
		(row) => (by === "country" ? row.country : by === "address_kind" ? row.address_kind : row.status) ?? "unknown"
	)

	const out: Record<string, unknown> = {}

	for (const [key, bucket] of [...buckets.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
		out[key] = {
			n: bucket.length,
			differed: bucket.filter((row) => row.differed).length,
			improved: bucket.filter((row) => row.grade === "improved").length,
			regressed: bucket.filter((row) => row.grade === "regressed").length,
			ungradeable: bucket.filter((row) => row.grade === "ungradeable").length,
		}
	}

	return out
}

/**
 * Summarizes a background job's report for display.
 *
 * A running check has no summary yet, because it writes `verdict.json` only when it finishes.
 */
export function summarizeJob(
	state: string,
	elapsedSeconds: number,
	report: GauntletReport | EvalReport,
	isCheck: boolean
): string {
	if (state === "running") {
		return isCheck
			? `Still running (${elapsedSeconds}s). A check writes verdict.json only at the end, so there is nothing to read yet.`
			: `Still running (${elapsedSeconds}s). Parsed from the log SO FAR: ${summarizeGauntletReport(report as GauntletReport)}`
	}

	return isCheck ? summarizeEvalReport(report as EvalReport) : summarizeGauntletReport(report as GauntletReport)
}
