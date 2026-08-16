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

import { z } from "zod"

import { ARM_SPEC_SCHEMA } from "./arms.ts"
import { assembleBench, summarizeLatency } from "./bench.ts"
import { runCompare } from "./compare.ts"
import type { EngineConfig } from "./engine-registry.ts"
import { resolveInputSet, type InputSetRef } from "./input-sets.ts"
import { runLookup } from "./lookup-tool.ts"
import { LookupSource } from "./lookup.ts"
import { describeObservedRate } from "./power.ts"
import { buildSpawnTools } from "./spawn-tools.ts"
import {
	ENGINE_CONFIG_SCHEMA,
	INPUT_SET_SCHEMA,
	componentsOf,
	provenanceFor,
	renderTrace,
	type DevTool,
	type DevToolDeps,
} from "./tool-kit.ts"

export type { DevTool, DevToolDeps, Provenance } from "./tool-kit.ts"

export function buildToolTable(deps: DevToolDeps): DevTool[] {
	const { registry, jobs } = deps

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
			name: "mwdev_inputs",
			description:
				"Describe an input set BEFORE measuring it: how many rows, which strata, what kind of truth it carries, " +
				"and — for a slice — what it excluded. Cheap and idempotent; call it first.",
			inputSchema: z.object({
				inputs: INPUT_SET_SCHEMA.optional().describe("Defaults to the full board."),
			}),
			handler: async (args) => {
				const set = await resolveInputSet((args["inputs"] as InputSetRef | undefined) ?? { kind: "board" })
				const byCountry: Record<string, number> = {}
				const byAddressKind: Record<string, number> = {}
				const byStatus: Record<string, number> = {}

				for (const row of set.inputs) {
					if (row.country) {
						byCountry[row.country] = (byCountry[row.country] ?? 0) + 1
					}

					if (row.addressKind) {
						byAddressKind[row.addressKind] = (byAddressKind[row.addressKind] ?? 0) + 1
					}

					if (row.status) {
						byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
					}
				}

				// `any`, never the sum: the per-kind counts overlap, and summing them produced 839 of 558 on the first run.
				const gradeable = set.hasTruth.any

				return {
					set_id: set.setID,
					n: set.n,
					sha256: set.sha256,
					selection: set.selection,
					...(set.populationN === undefined ? {} : { population_n: set.populationN }),
					...(set.why === undefined ? {} : { why: set.why }),
					...(set.corpusHash === undefined ? {} : { corpus_hash: set.corpusHash }),
					strata: { by_country: byCountry, by_address_kind: byAddressKind, by_status: byStatus },
					has_truth: set.hasTruth,
					not_covered: set.notCovered,
					summary:
						`${set.setID}: ${set.n} rows, selection ${set.selection}` +
						(set.populationN ? ` drawn from ${set.populationN}` : "") +
						`. ${gradeable ? `${gradeable} of them carry some expectation` : "NO row carries an expectation, so this set can be observed but not graded"}` +
						`, ${set.hasTruth.none} carry none` +
						` (by kind, overlapping: ${set.hasTruth.components} components, ${set.hasTruth.coordinates} coordinates, ${set.hasTruth.tier} tier).` +
						(set.notCovered.length ? ` Excluded — ${set.notCovered.join("; ")}.` : ""),
					notes: set.notes,
				}
			},
		},

		{
			name: "mwdev_lookup",
			description:
				"Ask a data source directly whether it knows a string. Keeps ABSENCE (the source has no entry) apart from " +
				"a MEASURED ZERO (it has one, scored zero) and from a hit that carries nothing actionable — the " +
				"distinction most resolve failures turn on. Every gazetteer source keys on a NORMALIZED form, not the " +
				"string you type, and reports the key it used beside what it found.",
			inputSchema: z.object({
				source: z.enum([
					LookupSource.FST,
					LookupSource.StreetMorphology,
					LookupSource.Normalize,
					LookupSource.Candidate,
					LookupSource.WOF,
					LookupSource.POI,
					LookupSource.Codex,
					LookupSource.Postcode,
				]),
				queries: z.array(z.string()).min(1).max(50),
				locale: z
					.string()
					.optional()
					.describe(
						"`normalize`: the normalization locale, default `und`. `postcode`: which weights package's anchor " +
							"artifact to read, default `en-us`. Ignored elsewhere."
					),
				country: z
					.string()
					.optional()
					.describe(
						"ISO alpha-2 filter for `candidate` and `poi`. A key that exists but has no row in this country is " +
							"reported as a FILTER miss, never as an absence."
					),
				limit: z.number().int().positive().max(100).optional().describe("Rows per query; the count is always exact."),
				config: ENGINE_CONFIG_SCHEMA.optional().describe(
					"Selects WHICH artifacts to read — `candidate_db`, `resolve_db`, `data_root`, and for the FST sources the " +
						"weights package. `gazetteer_prior` is forced on for those two, since a session resolves the FST path " +
						"only when it would feed the prior."
				),
			}),
			handler: async (args) =>
				runLookup(registry, {
					source: args["source"] as LookupSource,
					queries: args["queries"] as string[],
					...(args["locale"] === undefined ? {} : { locale: args["locale"] as string }),
					...(args["country"] === undefined ? {} : { country: args["country"] as string }),
					...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
					...(args["config"] === undefined ? {} : { config: args["config"] as EngineConfig }),
				}),
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
				"Run one input set through two arms and diff them. An arm is a mailwoman configuration or an ALREADY-RUNNING " +
				"external geocoder (Pelias / Photon / Nominatim) — this server never starts one. Reports what CHANGED " +
				"separately from what IMPROVED, checks that only the declared lever moved, and states the smallest effect this " +
				"many rows could have detected. A cross-engine comparison is graded on the pre-registered distance protocol " +
				"(top-1, 1/5/25km, a no-result a miss at every threshold) and claims parity only against the pre-registered " +
				"±5pp equivalence bound.",
			inputSchema: z.object({
				inputs: INPUT_SET_SCHEMA.optional(),
				arm_a: ARM_SPEC_SCHEMA.optional().describe("Baseline. Omit for the production mailwoman defaults."),
				arm_b: ARM_SPEC_SCHEMA.describe("The arm under test."),
				variable: z
					.array(z.string())
					.min(1)
					.describe(
						'Which keys you intend to differ, in EngineConfig\'s vocabulary (e.g. ["gazetteer_prior"]), or ' +
							'["engine"] across geocoders. Checked against what actually differs; a mismatch warns and marks the ' +
							"result ambiguous."
					),
				grade: z
					.enum(["auto", "truth", "diff-only"])
					.default("auto")
					.describe(
						'"auto" grades where the set carries truth. "truth" REFUSES where it does not, rather than quietly ' +
							"describing differences instead."
					),
				grade_threshold_km: z
					.number()
					.positive()
					.optional()
					.describe("Cross-engine only: which distance threshold rows are graded at. Defaults to 25km."),
				stratify_by: z.enum(["country", "address_kind", "status", "truth_tolerance_m", "truth_type"]).optional(),
			}),
			handler: async (args) => runCompare(registry, args),
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
		{
			name: "mwdev_bench",
			description:
				"Latency and throughput for the geocode path, cold and warm reported SEPARATELY. Single-threaded on " +
				"purpose — the result says why.",
			inputSchema: z.object({
				inputs: INPUT_SET_SCHEMA.optional(),
				config: ENGINE_CONFIG_SCHEMA.optional(),
				repetitions: z.number().int().positive().max(5).default(1),
				include_cold: z
					.boolean()
					.default(false)
					.describe("Evict first and time a construction. Costs ~1.4s and is the number a user actually experiences."),
				limit: z.number().int().positive().optional(),
			}),
			handler: async (args) => {
				const set = await resolveInputSet((args["inputs"] as InputSetRef | undefined) ?? { kind: "board" })
				const config = (args["config"] as EngineConfig | undefined) ?? {}
				const repetitions = (args["repetitions"] as number | undefined) ?? 1
				const limit = args["limit"] as number | undefined
				const selected = limit ? set.inputs.slice(0, limit) : set.inputs

				let cold: { engine_build_ms: number; first_query_ms: number; total_ms: number } | null = null

				if (args["include_cold"]) {
					// Evicting is what makes this a COLD measurement rather than a second warm one.
					registry.closeAll()

					const startedAt = Date.now()
					const coldEngine = await registry.acquire(config)
					const builtAt = Date.now()

					await coldEngine.session.geocode(selected[0]!.input)

					cold = {
						engine_build_ms: coldEngine.buildMs,
						first_query_ms: Date.now() - builtAt,
						total_ms: Date.now() - startedAt,
					}
				}

				const engine = await registry.acquire(config)
				const samples: number[] = []

				for (let pass = 0; pass < repetitions; pass++) {
					for (const item of selected) {
						const startedAt = performance.now()

						await engine.session.geocode(item.input)
						samples.push(performance.now() - startedAt)
					}
				}

				const reading = assembleBench(cold, summarizeLatency(samples))

				return {
					provenance: provenanceFor(engine, set),
					...reading,
					repetitions,
					n_inputs: selected.length,
				}
			},
		},

		...buildSpawnTools(registry, jobs),
	]
}
