/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The tool table — the tested contract. `server.ts` only adapts it to the SDK's envelope.
 *
 *   Three tools, deliberately, out of the eleven the spec describes (§11). These three carry the whole argument: a warm
 *   engine, the board as the default input set, and per-stage evidence returned in a form an agent can diff. The other
 *   eight are elaborations of a fix that has not been shown to work yet, and specifying a platform in one pass is how a
 *   platform fails to get built.
 *
 *   Two rules bind every result here:
 *
 *   1. **A number never travels without its denominator.** `n_requested`, `n_evaluated`, `n_errored` are mandatory, and
 *      the confidence bound lives inside `summary` — the sentence an agent relays — rather than in a field it can drop.
 *   2. **Absence is reported as absence.** A stage that produced nothing says so and says why; nothing here fills in a
 *      value the pipeline did not produce.
 */

import { channelsRow, decodeRow, localeHeadRow, systemRow, tokensRow } from "mailwoman/debug-view/trace-rows"
import { checkCase } from "mailwoman/eval-harness/gauntlet/check-case"
import { toGauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import type { GeocodeRun } from "mailwoman/geocode-session"
import { z } from "zod"

import { checkConfounds } from "./confound.ts"
import type { EngineConfig, EngineRegistry } from "./engine-registry.ts"
import { gradeRow, significance, type RowGrade } from "./grade.ts"
import { resolveInputSet, type InputSetRef, type ResolvedInputSet } from "./input-sets.ts"
import { describeObservedRate } from "./power.ts"

//#region Provenance

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

function provenanceFor(
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
		input_set: {
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
		},
	}
}

//#endregion

//#region Schemas

const INPUT_SET_SCHEMA = z
	.union([
		z.object({
			kind: z.literal("board"),
			country: z.string().optional(),
			address_kind: z.string().optional(),
			status: z.string().optional(),
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

const ENGINE_CONFIG_SCHEMA = z
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
	})
	.describe("Every lever, in the CLI's vocabulary. Unset means the PRODUCTION DEFAULT, never off.")

//#endregion

export interface DevToolDeps {
	registry: EngineRegistry
	startedAt: number
}

export interface DevTool {
	name: string
	description: string
	inputSchema: z.ZodObject<z.ZodRawShape>
	handler: (args: Record<string, unknown>) => Promise<unknown>
}

function componentsOf(run: GeocodeRun): Record<string, string> {
	return run.result.components as Record<string, string>
}

/**
 * The rendered evidence rows for one run, or a stated absence.
 *
 * `trace-rows` is pure and Ink-free by its own design, so the same strings the `--debug` pane shows are returnable
 * here. Both forms go back: the structured trace is what makes evidence diffable across arms, and the rendered rows are
 * what let a human read it in a transcript without an agent paraphrasing — which is where detail goes missing.
 */
function renderTrace(run: GeocodeRun): { rendered: string[]; absent_reason?: string } {
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
function firingSignals(rows: ComparedRow[]): Record<string, { a: number; b: number }> {
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
interface ComparedRow {
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
 * Per-stratum counts. Reported rather than blended because the benchmark plan's own rule is that a headline number
 * "lives or dies on `truth_type`" — a blended figure hides an arm that won one stratum and lost another.
 */
function stratify(rows: ComparedRow[], by: "country" | "address_kind" | "status"): Record<string, unknown> {
	const buckets = new Map<string, ComparedRow[]>()

	for (const row of rows) {
		const key = (by === "country" ? row.country : by === "address_kind" ? row.address_kind : row.status) ?? "unknown"

		buckets.set(key, [...(buckets.get(key) ?? []), row])
	}

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

export function buildToolTable(deps: DevToolDeps): DevTool[] {
	const { registry } = deps

	return [
		{
			name: "mwdev_daemon",
			description:
				"Status of the warm engine registry: what is resident, what it cost to build, and whether the working " +
				"tree has moved since. `reload` drops every session so the next call rebuilds.",
			inputSchema: z.object({
				action: z.enum(["status", "reload", "evict"]).default("status"),
				engine_id: z.string().optional(),
			}),
			handler: async (args) => {
				const action = (args["action"] as string) ?? "status"
				const fingerprint = registry.fingerprint()

				if (action === "reload") {
					const closed = registry.closeAll()

					return {
						action,
						engines_closed: closed,
						tree_fingerprint: fingerprint.digest,
						note:
							"Sessions dropped; the next call rebuilds them. This does NOT re-import source — Node cannot evict a " +
							"module from its ESM cache. If you edited source, restart the MCP server.",
					}
				}

				if (action === "evict") {
					const id = args["engine_id"] as string | undefined

					if (!id) throw new Error("mwdev_daemon: `evict` needs an `engine_id` (see `status`).")

					return { action, evicted: registry.evict(id), engine_id: id }
				}

				return {
					action,
					pid: process.pid,
					uptime_s: Math.round((Date.now() - deps.startedAt) / 1000),
					repo_root: registry.repoRoot,
					tree_fingerprint: fingerprint.digest,
					git_head: fingerprint.gitHead,
					dirty_files: fingerprint.dirtyFiles,
					newest_source: fingerprint.newestPath,
					newest_source_mtime_iso: new Date(fingerprint.newestMtimeMs).toISOString(),
					source_files_walked: fingerprint.filesWalked,
					engines: registry.summaries(),
					max_resident: registry.maxResident,
				}
			},
		},

		{
			name: "mwdev_run",
			description:
				"Geocode an input set through a warm engine. Defaults to the FULL regression board — pass a literal set " +
				"only with a reason, and the result will carry that reason and its confidence bound.",
			inputSchema: z.object({
				inputs: INPUT_SET_SCHEMA.optional(),
				config: ENGINE_CONFIG_SCHEMA.optional(),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Cap on rows evaluated. Never the default; reported against the set's real n."),
			}),
			handler: async (args) => {
				const ref = (args["inputs"] as InputSetRef | undefined) ?? { kind: "board" }
				const config = (args["config"] as EngineConfig | undefined) ?? {}
				const limit = args["limit"] as number | undefined

				const set = await resolveInputSet(ref)
				const engine = await registry.acquire(config)
				const selected = limit ? set.inputs.slice(0, limit) : set.inputs

				const startedAt = Date.now()
				const rows: unknown[] = []
				const errors: Array<{ id: string; input: string; message: string }> = []

				for (const item of selected) {
					try {
						const run = await engine.session.geocode(item.input)

						rows.push({
							id: item.id,
							input: item.input,
							components: componentsOf(run),
							lat: run.result.lat,
							lon: run.result.lon,
							tier: run.result.resolution_tier,
							timing_ms: run.timing,
						})
					} catch (error) {
						errors.push({ id: item.id, input: item.input, message: (error as Error).message })
					}
				}

				const resolvedCount = rows.filter((row) => (row as { lat: number | null }).lat !== null).length

				const power = describeObservedRate({
					events: resolvedCount,
					n: rows.length,
					selection: set.selection,
					eventLabel: "resolved to a coordinate",
					...(set.populationN === undefined ? {} : { populationN: set.populationN }),
				})

				return {
					provenance: provenanceFor(engine, set),
					summary:
						power.sentence +
						(limit ? ` A limit of ${limit} was applied to a set of ${set.n}.` : "") +
						(set.why ? ` Hand-picked because: ${set.why}` : ""),
					n_requested: selected.length,
					n_evaluated: rows.length,
					n_errored: errors.length,
					errors,
					power,
					elapsed_ms: Date.now() - startedAt,
					rows,
				}
			},
		},

		{
			name: "mwdev_compare",
			description:
				"Run one input set through two configurations and diff them. Reports what CHANGED separately from what " +
				"IMPROVED, checks that only the declared lever moved, and states the smallest effect this many rows " +
				"could have detected.",
			inputSchema: z.object({
				inputs: INPUT_SET_SCHEMA.optional(),
				arm_a: ENGINE_CONFIG_SCHEMA.optional().describe("Baseline. Omit for the production defaults."),
				arm_b: ENGINE_CONFIG_SCHEMA.describe("The arm under test."),
				variable: z
					.array(z.string())
					.min(1)
					.describe(
						'Which config keys you intend to differ, in EngineConfig\'s vocabulary (e.g. ["gazetteer_prior"]). ' +
							"Checked against what actually differs; a mismatch warns and marks the result ambiguous."
					),
				stratify_by: z.enum(["country", "address_kind", "status"]).optional(),
			}),
			handler: async (args) => {
				const ref = (args["inputs"] as InputSetRef | undefined) ?? { kind: "board" }
				const configA = (args["arm_a"] as EngineConfig | undefined) ?? {}
				const configB = args["arm_b"] as EngineConfig
				const declared = args["variable"] as string[]
				const stratifyBy = args["stratify_by"] as "country" | "address_kind" | "status" | undefined

				const set = await resolveInputSet(ref)

				// Both arms are acquired BEFORE either runs, so a source edit between them cannot go unnoticed. §3.4(d):
				// a single run may transparently rebuild, but two arms under different trees are not a comparison.
				const engineA = await registry.acquire(configA)
				const engineB = await registry.acquire(configB)

				if (engineA.fingerprint.digest !== engineB.fingerprint.digest) {
					throw new Error(
						`Arms were built against different source trees (${engineA.fingerprint.digest} vs ` +
							`${engineB.fingerprint.digest}). That is not a comparison. Restart the MCP server and re-run.`
					)
				}

				const confounds = checkConfounds(
					engineA.effective as unknown as Record<string, unknown>,
					engineB.effective as unknown as Record<string, unknown>,
					declared
				)

				const rows: ComparedRow[] = []
				const errors: Array<{ id: string; input: string; arm: "a" | "b"; message: string }> = []

				for (const item of set.inputs) {
					let a
					let b

					try {
						a = toGauntletResult((await engineA.session.geocode(item.input)).result)
					} catch (error) {
						errors.push({ id: item.id, input: item.input, arm: "a", message: (error as Error).message })

						continue
					}

					try {
						b = toGauntletResult((await engineB.session.geocode(item.input)).result)
					} catch (error) {
						errors.push({ id: item.id, input: item.input, arm: "b", message: (error as Error).message })

						continue
					}

					const { grade, issuesA, issuesB } = gradeRow(item.seed, a, b, checkCase)

					rows.push({
						id: item.id,
						input: item.input,
						country: item.country,
						address_kind: item.addressKind,
						status: item.status,
						differed: JSON.stringify(a) !== JSON.stringify(b),
						grade,
						a,
						b,
						issues_a: issuesA,
						issues_b: issuesB,
					})
				}

				const gradeable = rows.filter((row) => row.grade !== "ungradeable")
				const differed = rows.filter((row) => row.differed)

				const graded = {
					improved: rows.filter((row) => row.grade === "improved").length,
					regressed: rows.filter((row) => row.grade === "regressed").length,
					neutral: rows.filter((row) => row.grade === "neutral").length,
					ungradeable: rows.filter((row) => row.grade === "ungradeable").length,
				}

				// A diff is not a verdict (§5.5). With no truth anywhere in the set, the change count is ALL this can say.
				const mode = gradeable.length ? "truth" : "diff-only"

				const test = significance(
					gradeable.filter((row) => row.issues_a.length === 0).length,
					gradeable.filter((row) => row.issues_b.length === 0).length,
					gradeable.length
				)

				const changeReading = describeObservedRate({
					events: differed.length,
					n: rows.length,
					selection: set.selection,
					eventLabel: "differed between the arms",
					...(set.populationN === undefined ? {} : { populationN: set.populationN }),
				})

				// §5.4, learned the hard way on 2026-08-16: this tool's first real run reported "0 of 558 differed —
				// tight enough to read as a real absence" for a lever that was never reaching a decode at all
				// (`geocode-session`'s parseDeps omitted `fst`, and the path parses once up front). A zero-difference
				// result has TWO readings and the number cannot separate them, so it must not be relayed as one.
				const zeroDifferenceCaveat = !differed.length
					? "A zero here has two readings — the lever changed nothing, or the lever never ran. This comparison " +
						"cannot separate them. Confirm participation with mwdev_trace on an input the lever should move " +
						"before reporting this as no effect."
					: ""

				if (zeroDifferenceCaveat) {
					confounds.warnings.push(zeroDifferenceCaveat)
				}

				const summary = [
					changeReading.sentence,
					mode === "truth"
						? `Of those, ${graded.improved} improved and ${graded.regressed} regressed against truth; ${graded.ungradeable} rows carry no expectations and were not graded. ${test.sentence}`
						: `No row in this set carries expectations, so nothing here is graded — these are described changes, not improvements.`,
					zeroDifferenceCaveat,
					confounds.attribution === "clean"
						? ""
						: `ATTRIBUTION ${confounds.attribution.toUpperCase()}: ${confounds.warnings.filter((w) => w !== zeroDifferenceCaveat).join(" ")}`,
					set.why ? `Hand-picked because: ${set.why}` : "",
				]
					.filter(Boolean)
					.join(" ")

				return {
					provenance_a: provenanceFor(engineA, set),
					provenance_b: provenanceFor(engineB, set),
					summary,
					grade_mode: mode,
					...(mode === "diff-only"
						? {
								verdict: null,
								verdict_withheld_reason:
									'no truth for this input set; changes are described, not graded. Run against {kind:"board"} to grade.',
							}
						: {}),
					attribution: confounds.attribution,
					variable_declared: confounds.declared,
					variable_effective: confounds.variable_effective,
					n_requested: set.n,
					n_evaluated_both: rows.length,
					n_errored: errors.length,
					errors,
					arms_differed_on: { n: differed.length, of: rows.length },
					// Separate from arms_differed_on on purpose: a lever that fired on 400 rows and moved 0 outcomes is a
					// different fact from a lever that never fired.
					mechanism_fired_on: firingSignals(rows),
					mechanism_fired_on_note:
						"Only signals a GauntletResult carries for free are counted here. A lever with no signal of its own " +
						"cannot be confirmed to have run from this result — use mwdev_trace.",
					graded,
					significance: test,
					power: changeReading,
					...(stratifyBy ? { strata: stratify(rows, stratifyBy) } : {}),
					// Complete, never truncated. The 837-row FST run produced 24 changed rows; that is the evidence, and a
					// "first 30" cap would have hidden the tail on a larger one.
					rows_changed: differed,
					warnings: confounds.warnings,
				}
			},
		},

		{
			name: "mwdev_trace",
			description:
				"Per-stage evidence for a handful of inputs — what the model was told, what it was fed, what it decided. " +
				"Returns the structured trace AND the rendered rows. Not a measurement tool: it emits no rate and no verdict.",
			inputSchema: z.object({
				inputs: z.array(z.string()).min(1).max(20).describe("Up to 20 raw address strings."),
				config: ENGINE_CONFIG_SCHEMA.optional(),
			}),
			handler: async (args) => {
				const inputs = args["inputs"] as string[]
				const config = (args["config"] as EngineConfig | undefined) ?? {}
				// Tracing is the answer here, so it is forced on regardless of what the caller passed.
				const engine = await registry.acquire({ ...config, trace: true })

				const set = await resolveInputSet({
					kind: "literal",
					inputs,
					why: "mwdev_trace inspects named inputs by design; it reports no rate, so no panel is implied.",
				})

				const rows: unknown[] = []

				for (const input of inputs) {
					const run = await engine.session.geocode(input)
					const { rendered, absent_reason } = renderTrace(run)

					rows.push({
						input,
						components: componentsOf(run),
						lat: run.result.lat,
						lon: run.result.lon,
						tier: run.result.resolution_tier,
						query_shape: run.trace?.queryShape ?? null,
						kind: run.trace?.kind ?? null,
						input_mode: run.trace?.inputMode ?? null,
						parse_trace: run.trace?.parse ?? null,
						rendered,
						...(absent_reason ? { trace_absent_reason: absent_reason } : {}),
						timing_ms: run.timing,
					})
				}

				return {
					provenance: provenanceFor(engine, set),
					summary: `Traced ${rows.length} input${rows.length === 1 ? "" : "s"}. This tool reports evidence, never a rate — use mwdev_run over the board for that.`,
					n_requested: inputs.length,
					n_evaluated: rows.length,
					n_errored: 0,
					rows,
				}
			},
		},
	]
}
