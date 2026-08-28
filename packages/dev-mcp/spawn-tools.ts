/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The tools that SPAWN the compiled CLI, and the one that polls them.
 *
 *   They are together because they share three properties nothing else here has. Each writes its report to stdout,
 *   which in this process is the JSON-RPC channel — so each must run as a child rather than an import. Each therefore
 *   puts the COMPILED tree back on a path this server otherwise keeps off it, and pays `assertCompiledFresh` for the
 *   privilege. And each pays the full ~1.4 s cold start the warm tools exist to avoid, which is a fact their results
 *   state rather than hide.
 */

import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { listGateSpecs } from "mailwoman/eval-harness/promotion-gate"
import { z } from "zod"

import { checkCLIAllowlist } from "./cli-allowlist.ts"
import { assertCompiledFresh } from "./compiled-tree.ts"
import type { EngineRegistry } from "./engine-registry.ts"
import { missingWeightsCacheArtifacts, readGateReport } from "./gate-report.ts"
import { parseGauntletReport } from "./gauntlet-report.ts"
import type { JobRegistry } from "./jobs.ts"
import { summarizeJob, type DevTool } from "./tool-kit.ts"

/**
 * Where each gate job wrote its battery, keyed by job id.
 *
 * Kept beside the tools rather than re-derived from the log afterwards: the out-dir is chosen when the job STARTS, so
 * recovering it from printed output would fail exactly when the run died before printing any — the case where knowing
 * the directory matters most.
 */
const gateOutDirs = new Map<string, string>()

export function buildSpawnTools(registry: EngineRegistry, jobs: JobRegistry): DevTool[] {
	return [
		{
			name: "mwdev_gauntlet",
			description:
				"Run a gauntlet layer and return a job id. The gauntlet is the release authority — this adds nothing to " +
				"its grading, it only surfaces the gated header, the levers line and the firing count rather than leaving " +
				"them in a log. Poll with mwdev_job.",
			inputSchema: z.object({
				layer: z
					.enum(["regression", "metamorphic", "holdout", "ablation", "all"])
					.default("regression")
					.describe("`all` runs the multi-layer sequence and takes considerably longer."),
				gazetteer_prior: z.boolean().optional(),
				postcode_country_coherence: z.boolean().optional(),
				candidate: z.string().optional().describe("Candidate ONNX path — required for the held-out layer."),
				weights_cache: z.string().optional(),
				tokenizer: z.string().optional(),
				card: z.string().optional(),
				source: z.enum(["fr", "us"]).optional(),
				n: z.number().int().positive().optional(),
			}),
			handler: async (args) => {
				// The gauntlet writes its whole report to stdout, and stdout here is the JSON-RPC channel — so it is
				// spawned rather than imported. That puts the COMPILED tree back on the path, which is what this guard is
				// for: a stale out/ would grade replaced code and report a verdict rather than an error.
				const freshness = assertCompiledFresh(registry.repoRoot)

				const layer = (args["layer"] as string) ?? "regression"
				const argv = ["packages/mailwoman/out/cli.js", "eval", "gauntlet"]

				if (layer !== "all") {
					argv.push("--layer", layer)
				}

				if (args["gazetteer_prior"]) {
					argv.push("--gazetteer-prior")
				}

				// The CLI spells the two directions as separate flags rather than one boolean, and `undefined` must reach
				// neither: unset means the production default, which is what the board grades.
				if (args["postcode_country_coherence"] === true) {
					argv.push("--postcode-country-coherence")
				}

				if (args["postcode_country_coherence"] === false) {
					argv.push("--postcode-country-coherence-off")
				}

				for (const [flag, key] of [
					["--candidate", "candidate"],
					["--weights-cache", "weights_cache"],
					["--tokenizer", "tokenizer"],
					["--card", "card"],
					["--source", "source"],
				] as const) {
					const value = args[key]

					if (value) {
						argv.push(flag, String(value))
					}
				}

				if (args["n"]) {
					argv.push("--limit", String(args["n"]))
				}

				const job = jobs.start(`gauntlet:${layer}`, process.execPath, argv, registry.repoRoot)

				return {
					job_id: job.jobID,
					layer,
					command: [process.execPath, ...argv].join(" "),
					compiled_tree: {
						newest_source: freshness.newestSource?.path ?? null,
						newest_compiled: freshness.newestCompiled?.path ?? null,
					},
					note:
						"Started. Poll with mwdev_job. The result carries the gated header, the levers line and the firing " +
						"count parsed out of the log, plus the log itself — read the gated fraction, not the tail.",
				}
			},
		},

		{
			name: "mwdev_gate",
			description:
				"Run the promotion gate against a spec and return a job id. Reports every floor with its reading and its " +
				"margin, names WHICH ARTIFACT was graded, and surfaces the pre-filled ledger command — which it never runs. " +
				"Call with no `gate` to list the registered specs.",
			inputSchema: z.object({
				gate: z
					.string()
					.optional()
					.describe("Gate-spec name or path. Omit to list the registered specs instead of running anything."),
				weights_cache: z.string().optional().describe("Package-shaped candidate weights directory."),
				int8_weights_cache: z.string().optional(),
				model: z.string().optional().describe("Candidate fp32 ONNX."),
				int8: z.string().optional(),
				tokenizer: z.string().optional(),
				card: z.string().optional(),
				out_dir: z.string().optional().describe("Battery output dir. Defaults to a scratch dir."),
			}),
			handler: async (args) => {
				const gate = args["gate"] as string | undefined

				if (!gate) {
					return {
						registered_gate_specs: listGateSpecs(),
						note: "Pass one of these as `gate`, or an absolute path to a spec JSON.",
					}
				}

				if (!args["weights_cache"] && !args["model"]) {
					throw new Error(
						"mwdev_gate needs a candidate: `weights_cache` (a package-shaped directory) or `model` (a raw fp32 " +
							"ONNX). They grade different things — a package cache's model.onnx is whatever the package ships, " +
							"which is int8 in every shipped weights package."
					)
				}

				const weightsCache = args["weights_cache"] as string | undefined

				if (weightsCache) {
					const cache = missingWeightsCacheArtifacts(weightsCache)

					if (cache.kind === "wrong-shape") {
						throw new Error(
							"`weights_cache` must be a PACKAGE-SHAPED root — a directory containing " +
								"node_modules/@mailwoman/neural-weights-<locale>/ — not the workspace directory itself. " +
								`Missing under ${weightsCache}: ${cache.paths.join(", ")}. ` +
								"Pass `model` instead to grade a raw fp32 ONNX."
						)
					}

					if (cache.kind === "under-staged") {
						throw new Error(
							`This cache is shaped correctly but is missing artifacts its OWN model-card declares: ` +
								`${cache.paths.join(", ")}. Grading it anyway would resolve those channels OFF and score several ` +
								"cases lower with no signal of its own, which reads as a model regression — the #1516 failure. " +
								"Stage the declared files, or grade a raw ONNX with `model`."
						)
					}
				}

				// Spawned for the same reason the gauntlet is: it writes its battery report to stdout, which here is the
				// JSON-RPC channel. The gate ALSO runs its own recompile-before-eval guard, stricter than this one and meant
				// to fire — it is surfaced verbatim rather than pre-empted.
				const freshness = assertCompiledFresh(registry.repoRoot)
				const outDir = (args["out_dir"] as string | undefined) ?? join(tmpdir(), `mwdev-gate-${jobs.list().length}`)
				const argv = ["packages/mailwoman/out/cli.js", "eval", "gate", "--gate", gate, "--out-dir", outDir]

				for (const [flag, key] of [
					["--weights-cache", "weights_cache"],
					["--int8-weights-cache", "int8_weights_cache"],
					["--model", "model"],
					["--int8", "int8"],
					["--tokenizer", "tokenizer"],
					["--card", "card"],
				] as const) {
					const value = args[key]

					if (value) {
						argv.push(flag, String(value))
					}
				}

				const job = jobs.start(`gate:${gate}`, process.execPath, argv, registry.repoRoot)

				gateOutDirs.set(job.jobID, outDir)

				return {
					job_id: job.jobID,
					gate,
					out_dir: outDir,
					command: [process.execPath, ...argv].join(" "),
					compiled_tree: { newest_compiled: freshness.newestCompiled?.path ?? null },
					note:
						"Started. Poll with mwdev_job. The result reads verdict.json and provenance.txt from the out-dir " +
						"directly — no number in it is parsed out of prose.",
				}
			},
		},

		{
			name: "mwdev_cli",
			description:
				"Run a READ-ONLY mailwoman CLI command and return its output. An override, not the main road: every " +
				"call pays the full ~1.4s cold start that the warm tools exist to avoid.",
			inputSchema: z.object({
				args: z.array(z.string()).describe('Argument vector, e.g. ["geocode", "350 5th Ave", "--json"]. No shell.'),
				timeout_s: z.number().int().positive().max(600).default(120),
			}),
			handler: async (args) => {
				const argv = args["args"] as string[]
				const verdict = checkCLIAllowlist(argv)

				if (!verdict.allowed) throw new Error(`mwdev_cli refused: ${verdict.reason}`)

				const freshness = assertCompiledFresh(registry.repoRoot)
				const verb = argv.find((argument) => !argument.startsWith("-")) ?? "help"

				const job = jobs.start(
					`cli:${verb}`,
					process.execPath,
					["packages/mailwoman/out/cli.js", ...argv],
					registry.repoRoot
				)

				const timeoutMs = ((args["timeout_s"] as number | undefined) ?? 120) * 1000
				const startedAt = Date.now()

				while (jobs.get(job.jobID)!.state === "running" && Date.now() - startedAt < timeoutMs) {
					await new Promise((resolve) => {
						setTimeout(resolve, 100)
					})
				}

				const finished = jobs.get(job.jobID)!

				if (finished.state === "running") {
					jobs.cancel(job.jobID)

					throw new Error(
						`mwdev_cli timed out after ${timeoutMs / 1000}s and the child was cancelled. Partial output is on ` +
							`job ${job.jobID}; raise timeout_s or run it as a job if it is genuinely long.`
					)
				}

				let parsed: unknown

				try {
					parsed = parseJSONStrict(finished.stdout)
				} catch {
					// Not JSON. Ordinary for most verbs, so this is not reported as an error.
				}

				return {
					command: ["node", "packages/mailwoman/out/cli.js", ...argv].join(" "),
					allowlist_reason: verdict.reason,
					exit_code: finished.exitCode,
					stdout: finished.stdout,
					...(parsed === undefined ? {} : { stdout_json: parsed }),
					stderr: finished.stderr,
					compiled_tree: { newest_compiled: freshness.newestCompiled?.path ?? null },
					note:
						"This paid a full cold start. If you are running the same verb repeatedly, mwdev_run or mwdev_lookup " +
						"answer the same questions against a warm engine.",
				}
			},
		},

		{
			name: "mwdev_job",
			description: "Poll, read or cancel a background job started by another tool.",
			inputSchema: z.object({
				action: z.enum(["status", "result", "list", "cancel"]).default("status"),
				job_id: z.string().optional(),
				tail_lines: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Return only the last N log lines. The parsed report is unaffected."),
			}),
			handler: async (args) => {
				const action = (args["action"] as string) ?? "status"

				if (action === "list") return { jobs: jobs.list() }

				const jobID = args["job_id"] as string | undefined

				if (!jobID) throw new Error('mwdev_job: this action needs a `job_id` (see action "list").')

				const job = jobs.get(jobID)

				if (!job) throw new Error(`mwdev_job: no job ${jobID}.`)

				if (action === "cancel") return { job_id: jobID, cancelled: jobs.cancel(jobID) }

				const summary = jobs.summarize(job)

				if (action === "status" && job.state === "running") {
					return { ...summary, note: 'Still running. Call again, or use action "result" once it has finished.' }
				}

				const gateOutDir = gateOutDirs.get(jobID)

				// A gate job's numbers come from its own artifacts; only a gauntlet job needs its log parsed.
				const report = gateOutDir
					? readGateReport(gateOutDir, job.stdout, job.stderr)
					: parseGauntletReport(job.stdout, job.stderr)

				const tail = args["tail_lines"] as number | undefined
				// oxlint-disable-next-line mailwoman/prefer-spliterator -- the log is already buffered and capped at 8 MB
				const log = tail ? job.stdout.split("\n").slice(-tail).join("\n") : job.stdout

				return {
					...summary,
					// A running job still reports what it has produced so far, clearly marked — a partial log is useful and
					// a silent "not ready" is not.
					partial: job.state === "running",
					// A graded FAIL exits 1, so `state: "failed"` is what a completed-and-failing gauntlet looks like. That
					// reads as a crash, and the two need different responses — say which happened.
					...(job.state === "failed" && report.verdict
						? {
								job_outcome: `The run COMPLETED and graded ${report.verdict}. The non-zero exit is the verdict, not a crash.`,
							}
						: {}),
					summary: summarizeJob(job.state, summary.elapsed_s, report, Boolean(gateOutDir)),
					report,
					log,
					stderr: job.stderr,
				}
			},
		},
	]
}
