/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The scaffolding every tool shares: the provenance block, the two input schemas, and the small readings that more
 *   than one tool needs. Extracted from `tools.ts` when the eighth tool pushed that file past its line cap — the tool
 *   definitions are the part worth reading top to bottom, and this is the part they all repeat.
 */

import { channelsRow, decodeRow, localeHeadRow, systemRow, tokensRow } from "mailwoman/debug-view/trace-rows"
import type { GeocodeRun } from "mailwoman/geocode-session"
import { z } from "zod"

import type { EngineRegistry } from "./engine-registry.ts"
import type { GateReport } from "./gate-report.ts"
import { summarizeGateReport } from "./gate-report.ts"
import { summarizeGauntletReport, type GauntletReport } from "./gauntlet-report.ts"
import type { RowGrade } from "./grade.ts"
import { HOLDOUT_DEFAULT_N, HOLDOUT_SOURCES, type ResolvedInputSet } from "./input-sets.ts"
import type { JobRegistry } from "./jobs.ts"

/**
 * On every result of every tool. What produced this number, under what source, with what actually fed.
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
 * The input-set half of a provenance block, on its own.
 *
 * An external arm has no engine, no tree fingerprint and no effective config, but it is measured over exactly the same
 * rows — and the denominators, hash and selection kind are the half that must be identical across a comparison's two
 * arms whatever either arm is.
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

export function provenanceFor(
	engine: {
		engineID: string
		effective: unknown
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
		config_effective: engine.effective as Record<string, unknown>,
		engine_build_ms: engine.buildMs,
		engine_was_warm: engine.uses > 1,
		input_set: inputSetProvenance(set),
	}
}

/**
 * Which inputs a measuring tool runs over.
 *
 * `{"kind":"board"}` is the shortest legal value and the default everywhere, so the well-powered choice is the cheapest
 * one to type. The hand-picked branch is deliberately wordier — an array AND a `why` — because choosing a small panel
 * is a claim about what is worth measuring, and the claim is echoed into every number the set produces.
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
			version: z.enum(["v1", "v2", "v3"]).optional(),
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
		z.object({
			kind: z.literal("literal"),
			inputs: z.array(z.string()).min(1),
			why: z
				.string()
				.min(1)
				.describe("Why these inputs and not the board. Echoed into every result derived from this set."),
		}),
	])
	.describe('Which inputs to measure. `{"kind":"board"}` is the full 558-row regression board and is the default.')

/**
 * Every construction- and call-time lever, in the CLI's own vocabulary.
 *
 * Unset means the PRODUCTION DEFAULT, never "off" — the rule `GauntletResolverLevers` states in `harness.ts`: "the
 * library defaults are the thing under test". A schema that coerced undefined to false would grade a configuration
 * nobody ships.
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
		gazetteer_prior: z.boolean().optional(),
		place_country: z.boolean().optional(),
		place_country_threshold: z.number().optional(),
		postcode_country_coherence: z.boolean().optional(),
		fork_entity: z.boolean().optional(),
		locale_country_prior: z.boolean().optional(),
		postcode_shape_coherence: z.boolean().optional(),
		postcode_containment_coherence: z.boolean().optional(),
		retry_alternate_register: z.boolean().optional(),
	})
	.describe("Every lever, in the CLI's vocabulary. Unset means the PRODUCTION DEFAULT, never off.")

export interface DevToolDeps {
	registry: EngineRegistry
	jobs: JobRegistry
	startedAt: number
}

export interface DevTool {
	name: string
	description: string
	inputSchema: z.ZodObject<z.ZodRawShape>
	handler: (args: Record<string, unknown>) => Promise<unknown>
}

export function componentsOf(run: GeocodeRun): Record<string, string> {
	return run.result.components as Record<string, string>
}

/**
 * The rendered evidence rows for one run, or a stated absence.
 *
 * `trace-rows` is pure and Ink-free by its own design, so the same strings the `--debug` pane shows are returnable
 * here. Both forms go back: the structured trace is what makes evidence diffable across arms, and the rendered rows are
 * what let a human read it in a transcript without an agent paraphrasing — which is where detail goes missing.
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
		],
	}
}

/**
 * Firing signals a {@link GauntletResult} carries for free — a mechanism reporting that it SPOKE, separately from
 * whether the outcome moved.
 *
 * `postcode_country_scope` is the worked example and the harness's own reason for carrying it (`harness.ts`): it is
 * "the FIRING COUNT, so a lever-pinned run can say how many rows the mechanism actually spoke on rather than leaving an
 * unchanged verdict to mean either 'harmless' or 'never ran'."
 */
export function firingSignals(rows: ComparedRow[]): Record<string, { a: number; b: number }> {
	const scoped = (row: ComparedRow, arm: "a" | "b"): boolean =>
		Boolean((row[arm] as { postcode_country_scope?: string | null }).postcode_country_scope)

	return {
		postcode_country_scope: {
			a: rows.filter((row) => scoped(row, "a")).length,
			b: rows.filter((row) => scoped(row, "b")).length,
		},
	}
}

/**
 * One input under both arms. `differed` and `grade` answer different questions and are reported separately, because an
 * unchanged verdict from a mechanism that never ran proves nothing (`run.ts:32`).
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
}

/**
 * Which column a result is broken out by.
 *
 * `truth_tolerance_m` is meaningful only where rows are graded against a coordinate: it separates rows whose truth is a
 * rooftop from rows whose truth is a 25 km area centroid, which is the difference between a sub-kilometre column that
 * measures the arm and one that measures the corpus.
 */
export type StratumKey = "country" | "address_kind" | "status" | "truth_tolerance_m" | "truth_type"

/**
 * Every legal stratum, for a runtime check the type cannot give a caller that reached the handler directly.
 *
 * An unrecognised key used to bucket every row as `unknown` and report a single stratum — a table that LOOKS like a
 * stratified result and is not one. Measured 2026-08-16: `stratify_by: "truth_type"` against a 60-row FR panel returned
 * `{"unknown": {n: 60}}` rather than saying the key did not exist.
 */
export const STRATUM_KEYS: readonly StratumKey[] = [
	"country",
	"address_kind",
	"status",
	"truth_tolerance_m",
	"truth_type",
]

/**
 * @throws When `by` is not a known stratum — silence here manufactures a fake one-bucket table.
 */
export function assertStratumKey(by: string): asserts by is StratumKey {
	if (!STRATUM_KEYS.includes(by as StratumKey)) {
		throw new Error(
			`stratify_by ${JSON.stringify(by)} is not a stratum. Known: ${STRATUM_KEYS.join(", ")}. Bucketing an ` +
				"unrecognised key would report one `unknown` bucket, which reads as a stratified result and is not one."
		)
	}
}

/**
 * Group rows by a key. One implementation so two stratifiers cannot drift on what an absent value is called.
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
 * Per-stratum counts. Reported rather than blended because the benchmark plan's own rule is that a headline number
 * "lives or dies on `truth_type`" — a blended figure hides an arm that won one stratum and lost another.
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
 * One sentence for a job, whichever kind it is. A still-running gate gets no partial reading: its numbers live in
 * `verdict.json`, which the assembler writes at the END, so anything read before then is not a partial answer — it is
 * no answer.
 */
export function summarizeJob(
	state: string,
	elapsedSeconds: number,
	report: GauntletReport | GateReport,
	isGate: boolean
): string {
	if (state === "running") {
		return isGate
			? `Still running (${elapsedSeconds}s). A gate writes verdict.json only at the end, so there is nothing to read yet.`
			: `Still running (${elapsedSeconds}s). Parsed from the log SO FAR: ${summarizeGauntletReport(report as GauntletReport)}`
	}

	return isGate ? summarizeGateReport(report as GateReport) : summarizeGauntletReport(report as GauntletReport)
}
