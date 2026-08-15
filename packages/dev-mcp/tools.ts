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
import type { GeocodeRun } from "mailwoman/geocode-session"
import { z } from "zod"

import type { EngineConfig, EngineRegistry } from "./engine-registry.ts"
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
