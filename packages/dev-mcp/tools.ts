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

import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { normalizeTokens } from "@mailwoman/resolver-wof-sqlite/fst-matcher"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import { channelsRow, decodeRow, localeHeadRow, systemRow, tokensRow } from "mailwoman/debug-view/trace-rows"
import { checkCase } from "mailwoman/eval-harness/gauntlet/check-case"
import { toGauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import { listGateSpecs } from "mailwoman/eval-harness/promotion-gate"
import type { GeocodeRun } from "mailwoman/geocode-session"
import { z } from "zod"

import { assembleBench, summarizeLatency } from "./bench.ts"
import { checkCLIAllowlist } from "./cli-allowlist.ts"
import { assertCompiledFresh } from "./compiled-tree.ts"
import { checkConfounds } from "./confound.ts"
import type { EngineConfig, EngineRegistry } from "./engine-registry.ts"
import { missingWeightsCacheArtifacts, readGateReport, summarizeGateReport, type GateReport } from "./gate-report.ts"
import { parseGauntletReport, summarizeGauntletReport, type GauntletReport } from "./gauntlet-report.ts"
import { gradeRow, significance, type RowGrade } from "./grade.ts"
import { resolveInputSet, type InputSetRef, type ResolvedInputSet } from "./input-sets.ts"
import type { JobRegistry } from "./jobs.ts"
import { loadFSTArtifact, lookupFST, lookupNormalize, lookupStreetMorphology, LookupSource } from "./lookup.ts"
import { describeObservedRate } from "./power.ts"
import { buildSpawnTools } from "./spawn-tools.ts"
import {
	ENGINE_CONFIG_SCHEMA,
	INPUT_SET_SCHEMA,
	componentsOf,
	firingSignals,
	provenanceFor,
	renderTrace,
	stratify,
	summarizeJob,
	type ComparedRow,
	type DevTool,
	type DevToolDeps,
} from "./tool-kit.ts"

export type { DevTool, DevToolDeps, Provenance } from "./tool-kit.ts"

/**
 * Where each gate job wrote its battery, keyed by job id.
 *
 * Kept beside the table rather than re-derived from the log afterwards: the out-dir is chosen when the job STARTS, so
 * recovering it from printed output would fail exactly when the run died before printing any — the case where knowing
 * the directory matters most.
 */
const gateOutDirs = new Map<string, string>()

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
				"a MEASURED ZERO (it has one, scored zero) — the distinction most resolve failures turn on.",
			inputSchema: z.object({
				source: z.enum(["fst", "street_morphology", "normalize"]),
				queries: z.array(z.string()).min(1).max(50),
				locale: z.string().optional().describe("Normalization locale; defaults to `und`."),
				config: ENGINE_CONFIG_SCHEMA.optional().describe(
					"Only selects WHICH weights package to read the artifact from; `gazetteer_prior` is forced on regardless, since\n\t\t\t\t\ta session resolves the FST path only when it would feed the prior."
				),
			}),
			handler: async (args) => {
				const source = args["source"] as LookupSource
				const queries = args["queries"] as string[]

				if (source === LookupSource.Normalize) {
					return {
						source,
						rows: lookupNormalize(queries, (args["locale"] as string | undefined) ?? "und"),
						notes: [
							"Normalization always answers, so every row is a hit. The useful column is `changed`: a query whose " +
								"normalized form differs is the usual reason a lookup against another source misses.",
						],
					}
				}

				// `gazetteer_prior: true` is forced. The session resolves the FST paths only when it will actually feed the
				// prior, and it is right to: `artifacts` reports what a session READ, not what it could have. A lookup
				// wants the artifact the decoder would consult, so it asks for an engine that loads one — resolving the
				// path any other way would answer about an FST no runtime configuration reads.
				const engine = await registry.acquire({
					...(args["config"] as EngineConfig | undefined),
					gazetteer_prior: true,
				})

				const path =
					source === LookupSource.FST ? engine.session.artifacts.fstPath : engine.session.artifacts.streetMorphologyPath

				const loaded = loadFSTArtifact(path, deserializeFST as never)

				if ("unavailable" in loaded) {
					return {
						source,
						rows: [],
						unavailable_reason: loaded.unavailable,
						notes: [
							"No row is reported, because a source whose artifact is missing answers 'no' to everything — which " +
								"would read as absence for every query rather than as an unavailable source.",
						],
					}
				}

				return {
					source,
					provenance: { engine_id: engine.engineID, artifact: path },
					rows:
						source === LookupSource.FST
							? lookupFST(loaded.fst, normalizeTokens, queries)
							: lookupStreetMorphology(loaded.fst, queries),
					notes:
						source === LookupSource.FST
							? [
									"Entries are the per-BIO-tag MAX, which is all the emission prior reads. A surface accepted with no " +
										"BIO-mapped placetype gives the decoder nothing — different from a zero.",
								]
							: [],
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
