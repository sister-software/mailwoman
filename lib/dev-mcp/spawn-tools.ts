// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * These tools spawn the compiled CLI and poll its jobs.
 *
 * Each CLI writes its report to stdout.
 * The JSON-RPC server also uses stdout, so each command runs as a child process.
 *
 * This lets the command verify the compiled tree with `assertCompiledFresh`.
 * A child process adds a cold start of about 1.4 seconds.
 */

import { tempRootPath } from "@mailwoman/core/data-root"
import { parseJSONStrict, tryParsingJSON } from "@mailwoman/core/json"
import { NodeModulesState, readCheckoutLocality } from "@mailwoman/core/module/checkout-locality"
import { listEvalSpecs } from "mailwoman/tools/eval-harness/promotion/eval"
import { SwitchPinSchema } from "mailwoman/tools/eval-harness/rig/switch-pin"
import { resolvePath } from "path-ts"
import { z } from "zod"

import { checkCommands } from "#check-kit/registry"
import { readWorktreeStatus } from "#check-kit/worktree/status"
import { checkCLIAllowlist } from "#dev-mcp/cli/allowlist"
import { assertCompiledFresh } from "#dev-mcp/compiled-tree"
import type { EngineRegistryLike } from "#dev-mcp/engine/registry"
import { missingWeightsCacheArtifacts, readEvalReport } from "#dev-mcp/eval-report"
import { parseGauntletReport } from "#dev-mcp/gauntlet-report"
import { resolveCheckout } from "#dev-mcp/github"
import type { JobRegistry } from "#dev-mcp/jobs"
import { summarizeJob, type DevTool } from "#dev-mcp/tool-kit"

/**
 * Where each check job wrote its battery, keyed by job id.
 *
 * The out-dir is chosen when the job starts, so recovering it from printed output
 * would fail exactly when the run died before printing any.
 */
const promotionEvalOutDirs = new Map<string, string>()

/**
 * The jobs `mwdev_check`, `mwdev_probe` and `mwdev_worktree` started.
 *
 * Their stdout is the `mwops check --json`, `mwops probe --json`
 * or `mwops worktree prepare --json` result, and `mwdev_job` returns it parsed.
 */
const repositoryCheckJobs = new Set<string>()

let checkLaunches = 0

/**
 * Names the out-dir of a check that gave none.
 *
 * The name takes the launch instant and a per-process counter.
 * A name derived from the job count repeats after a worker restart, and the new run
 * then reads the earlier run's `verdict.json` as its own until it writes one.
 */
export function defaultCheckOutDirName(now: Date = new Date()): string {
	const stamp = now.toISOString().replaceAll(/[:.]/gu, "-").replace(/Z$/u, "")

	return `mwdev-check-${stamp}-${++checkLaunches}`
}

/**
 * Build the CLI-spawning tools and the job poller over the given engine and job registries.
 */
export async function buildSpawnTools(registry: EngineRegistryLike, jobs: JobRegistry): Promise<DevTool[]> {
	return [
		{
			name: "mwdev_gauntlet",
			description:
				"Run a gauntlet layer and return a job id. The gauntlet is the release authority — this adds nothing to " +
				"its grading, it only surfaces the counted header, the pins line and the firing count rather than leaving " +
				"them in a log. Poll with mwdev_job.",
			inputSchema: z.object({
				layer: z
					.enum(["regression", "metamorphic", "holdout", "ablation", "all"])
					.default("regression")
					.describe("`all` runs the multi-layer sequence and takes considerably longer."),
				gazetteer_prior: SwitchPinSchema.default("production"),
				postcode_country_coherence: SwitchPinSchema.default("production"),
				candidate: z.string().optional().describe("Candidate ONNX path — required for the held-out layer."),
				weights_cache: z.string().optional(),
				tokenizer: z.string().optional(),
				card: z.string().optional(),
				source: z.enum(["fr", "us"]).optional(),
				n: z.number().int().positive().optional(),
			}),
			handler: async (args) => {
				// The gauntlet writes its report to stdout.
				// Here stdout is the JSON-RPC channel, so the gauntlet runs as a child process.
				// The child puts the compiled tree back on the path.
				// A stale out/ directory could grade replaced code and report a verdict instead of an error.
				const freshness = await assertCompiledFresh(registry.repoRoot)

				const layer = (args["layer"] as string) ?? "regression"
				const argv = ["packages/mailwoman/out/cli/main.js", "eval", "gauntlet"]

				if (layer !== "all") {
					argv.push("--layer", layer)
				}

				for (const [flag, key] of [
					["--gazetteer-prior", "gazetteer_prior"],
					["--postcode-country-coherence", "postcode_country_coherence"],
				] as const) {
					argv.push(flag, SwitchPinSchema.parse(args[key] ?? "production"))
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
						"Started. Poll with mwdev_job. The result carries the counted header, the pins line and the firing " +
						"count parsed out of the log, plus the log itself — read the counted fraction, not the tail.",
				}
			},
		},

		{
			name: "mwdev_promotion_eval",
			description:
				"Run the promotion check against a spec and return a job id. Reports every floor with its reading and its " +
				"margin, names WHICH ARTIFACT was graded, and surfaces the pre-filled ledger command — which it never runs. " +
				"Call with no `check` to list the registered specs.",
			inputSchema: z.object({
				check: z
					.string()
					.optional()
					.describe("Check-spec name or path. Omit to list the registered specs instead of running anything."),
				weights_cache: z.string().optional().describe("Package-shaped candidate weights directory."),
				int8_weights_cache: z.string().optional(),
				model: z.string().optional().describe("Candidate fp32 ONNX."),
				int8: z.string().optional(),
				tokenizer: z.string().optional(),
				card: z.string().optional(),
				out_dir: z.string().optional().describe("Battery output dir. Defaults to a scratch dir."),
			}),
			handler: async (args) => {
				const check = args["check"] as string | undefined

				if (!check) {
					return {
						registered_threshold_specs: await listEvalSpecs(),
						note: "Pass one of these as `check`, or an absolute path to a spec JSON.",
					}
				}

				if (!args["weights_cache"] && !args["model"]) {
					throw new Error(
						"mwdev_promotion_eval needs a candidate: `weights_cache` (a package-shaped directory) or `model` (a raw fp32 " +
							"ONNX). They grade different things — a package cache's model.onnx is whatever the package ships, " +
							"which is int8 in every shipped weights package."
					)
				}

				const weightsCache = args["weights_cache"] as string | undefined

				if (weightsCache) {
					const cache = await missingWeightsCacheArtifacts(weightsCache)

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

				// Spawned for the same reason the gauntlet is.
				// The eval runs its own recompile-before-eval guard, stricter than this one
				// and surfaced verbatim rather than pre-empted.
				const freshness = await assertCompiledFresh(registry.repoRoot)
				const outDir = (args["out_dir"] as string | null) ?? tempRootPath(defaultCheckOutDirName())
				// The promotion battery is `mailwoman eval promote --check <spec>`; a wrong
				// subcommand can exit 0 with no verdict, so the job "succeeds" silently.
				const argv = ["packages/mailwoman/out/cli/main.js", "eval", "promote", "--check", check, "--out-dir", outDir]

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

				const job = jobs.start(`check:${check}`, process.execPath, argv, registry.repoRoot)

				promotionEvalOutDirs.set(job.jobID, outDir)

				return {
					job_id: job.jobID,
					check,
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
			name: "mwdev_check",
			description:
				"Run a registered repository check (`mwops check`) in a checkout and return a job id. The job runs that " +
				"checkout's own `lib/ops-cli/cli.ts`, so a worktree is graded by its own packages. A heavy check waits for " +
				"the host lock and for CI within `max_wait_minutes`. Poll with mwdev_job; a finished job returns the parsed " +
				"result: exit status, error and warning counts, failing tests, and the log path.",
			inputSchema: z.object({
				name: z
					.enum(["preflight", ...checkCommands.map((check) => check.name)] as [string, ...string[]])
					.describe("The registered check, or `preflight` for the direct-push set."),
				checkout: z
					.string()
					.min(1)
					.optional()
					.describe("Absolute path of the working tree to check. Defaults to the server's checkout."),
				paths: z.array(z.string()).default([]).describe("Test paths for `vitest`, relative to the checkout."),
				no_wait: z.boolean().default(false).describe("Refuse rather than wait when the host lock is held."),
				max_wait_minutes: z.number().nonnegative().optional(),
				log_dir: z.string().optional().describe("Absolute directory for the log. Defaults to the cache root."),
			}),
			handler: async (args) => {
				const cwd = await resolveCheckout(registry.repoRoot, args["checkout"] as string | undefined)

				// The child's checkout-locality guard refuses a tree without its own install.
				// This refusal returns the repair at once rather than as a failed job.
				const locality = await readCheckoutLocality(cwd)

				if (locality?.nodeModules.state === NodeModulesState.Absent) {
					throw new Error(`${cwd} has no node_modules. Run \`yarn install\` there before mwdev_check.`)
				}

				const name = args["name"] as string
				const paths = (args["paths"] as string[] | undefined) ?? []
				const argv = [resolvePath(cwd, "lib", "ops-cli", "cli.ts"), "check", name, ...paths, "--json"]

				if (args["no_wait"] === true) {
					argv.push("--no-wait")
				}

				if (typeof args["max_wait_minutes"] === "number") {
					argv.push("--max-wait-minutes", String(args["max_wait_minutes"]))
				}

				if (typeof args["log_dir"] === "string") {
					argv.push("--log-dir", args["log_dir"])
				}

				const job = jobs.start(`check:${name}`, process.execPath, argv, cwd)

				repositoryCheckJobs.add(job.jobID)

				return {
					job_id: job.jobID,
					checkout: cwd,
					command: [process.execPath, ...argv].join(" "),
					note: "Started. Poll with mwdev_job; the finished job's `result` is the parsed `mwops check --json` output.",
				}
			},
		},

		{
			name: "mwdev_probe",
			description:
				"Start one workspace's server (`mwops probe`) in a checkout on 127.0.0.1 with an unused port, send each GET " +
				"path to it, stop it by its process id, and return a job id. The job runs that checkout's own " +
				"`lib/ops-cli/cli.ts`, so a worktree's server runs from its own source. Poll with mwdev_job; a finished job " +
				"returns the parsed result: the startup time and output, each request's status, content type and body or " +
				"projected value, the peak memory, and how the server stopped. A server that exited before listening returns " +
				"its exit status and last output lines.",
			inputSchema: z.object({
				workspace: z
					.string()
					.min(1)
					.describe("The probe target, such as `ogc`, `photon`, `nominatim`, `libpostal` or `api`."),
				get: z
					.array(z.string().startsWith("/"))
					.min(1)
					.describe("Request paths, each starting with `/`, sent in order."),
				checkout: z
					.string()
					.min(1)
					.optional()
					.describe("Absolute path of the working tree whose server runs. Defaults to the server's checkout."),
				json_path: z.string().min(1).optional().describe("A dotted path projected out of each JSON body."),
				max_bytes: z.number().int().positive().optional(),
				env: z
					.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*=/u))
					.default([])
					.describe("NAME=value pairs."),
				env_file: z.string().min(1).optional().describe("A file Node reads with --env-file before the server starts."),
				startup_timeout_seconds: z.number().positive().optional(),
				log_dir: z.string().optional().describe("Absolute directory for the server log. Defaults to the cache root."),
				server_args: z.array(z.string()).default([]).describe("Flags passed to the server after `--`."),
			}),
			handler: async (args) => {
				const cwd = await resolveCheckout(registry.repoRoot, args["checkout"] as string | undefined)
				const locality = await readCheckoutLocality(cwd)

				if (locality?.nodeModules.state === NodeModulesState.Absent) {
					throw new Error(`${cwd} has no node_modules. Run \`yarn install\` there before mwdev_probe.`)
				}

				const workspace = args["workspace"] as string
				const argv = [resolvePath(cwd, "lib", "ops-cli", "cli.ts"), "probe", workspace, "--json"]

				for (const path of args["get"] as string[]) {
					argv.push("--get", path)
				}

				for (const assignment of (args["env"] as string[] | undefined) ?? []) {
					argv.push("--env", assignment)
				}

				for (const [flag, key] of [
					["--json-path", "json_path"],
					["--max-bytes", "max_bytes"],
					["--env-file", "env_file"],
					["--startup-timeout-seconds", "startup_timeout_seconds"],
					["--log-dir", "log_dir"],
				] as const) {
					const value = args[key]

					if (value != null) {
						argv.push(flag, String(value))
					}
				}

				const serverArgs = (args["server_args"] as string[] | undefined) ?? []

				if (serverArgs.length) {
					argv.push("--", ...serverArgs)
				}

				// A job cancel sends SIGTERM to the command.
				// The command then stops the server it started.
				const job = jobs.start(`probe:${workspace}`, process.execPath, argv, cwd)

				repositoryCheckJobs.add(job.jobID)

				return {
					job_id: job.jobID,
					checkout: cwd,
					command: [process.execPath, ...argv].join(" "),
					note: "Started. Poll with mwdev_job; the finished job's `result` is the parsed `mwops probe --json` output.",
				}
			},
		},

		{
			name: "mwdev_worktree",
			description:
				"Read or prepare another working tree. `status` reports each prerequisite (node_modules, a current out/, " +
				"the weights files) as satisfied, missing or unread, with the tree's position against origin/main and its " +
				".env. `prepare` returns a job id: it runs this server checkout's `mwops worktree prepare`, which runs the " +
				"missing `yarn install`, `yarn compile` and `yarn mwops release copy-weights` in the target tree under one " +
				"host lock. Poll with mwdev_job; a finished job returns the parsed result with the status after the steps.",
			inputSchema: z.object({
				action: z.enum(["status", "prepare"]).default("status"),
				path: z.string().min(1).describe("Absolute path inside the working tree to read or prepare."),
				max_wait_minutes: z.number().nonnegative().optional(),
				dry_run: z.boolean().default(false).describe("For `prepare`: list the steps it would run, and run none."),
			}),
			handler: async (args) => {
				const path = resolvePath(registry.repoRoot.toString(), args["path"] as string)

				if ((args["action"] ?? "status") === "status") {
					return readWorktreeStatus(path, { callingCheckout: registry.repoRoot.toString() })
				}

				// The target tree may have no install, so the job runs the server checkout's command.
				// That command acts on the path.
				const argv = [
					resolvePath(registry.repoRoot.toString(), "lib", "ops-cli", "cli.ts"),
					"worktree",
					"prepare",
					"--path",
					path,
					"--json",
				]

				if (typeof args["max_wait_minutes"] === "number") {
					argv.push("--max-wait-minutes", String(args["max_wait_minutes"]))
				}

				if (args["dry_run"] === true) {
					argv.push("--dry-run")
				}

				const job = jobs.start("worktree:prepare", process.execPath, argv, registry.repoRoot)

				repositoryCheckJobs.add(job.jobID)

				return {
					job_id: job.jobID,
					path,
					command: [process.execPath, ...argv].join(" "),
					note: "Started. Poll with mwdev_job; the finished job's `result` is the parsed `mwops worktree prepare --json` output.",
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

				const freshness = await assertCompiledFresh(registry.repoRoot)
				const verb = argv.find((argument) => !argument.startsWith("-")) ?? "help"

				const job = jobs.start(
					`cli:${verb}`,
					process.execPath,
					["packages/mailwoman/out/cli/main.js", ...argv],
					registry.repoRoot
				)

				const timeoutMs = ((args["timeout_s"] as number | null) ?? 120) * 1000
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
					// Not JSON — ordinary for most verbs, so this isn't reported as an error.
				}

				return {
					command: ["node", "packages/mailwoman/out/cli/main.js", ...argv].join(" "),
					allowlist_reason: verdict.reason,
					exit_code: finished.exitCode,
					stdout: finished.stdout,
					...(!parsed ? {} : { stdout_json: parsed }),
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

				if (repositoryCheckJobs.has(jobID)) {
					// The check's own log holds its output, so the job returns the result and the child's stderr.
					const result = job.state === "running" ? null : tryParsingJSON(job.stdout)

					return {
						...summary,
						partial: job.state === "running",
						result,
						...(job.state !== "running" && !result
							? { note: "The job printed no JSON result. Its stderr says why the check did not report." }
							: {}),
						stderr: job.stderr,
					}
				}

				const promotionEvalOutDir = promotionEvalOutDirs.get(jobID)

				// A check job's numbers come from its own artifacts.
				// Only a gauntlet job needs its log parsed.
				const report = promotionEvalOutDir
					? await readEvalReport(promotionEvalOutDir, job.stdout, job.stderr, { startedAt: job.startedAt })
					: parseGauntletReport(job.stdout, job.stderr)

				const tail = args["tail_lines"] as number | undefined
				// oxlint-disable-next-line mailwoman/prefer-spliterator -- the log is already buffered and capped at 8 MB
				const log = tail ? job.stdout.split("\n").slice(-tail).join("\n") : job.stdout

				return {
					...summary,
					// A running job still reports what it has produced so far, marked as partial,
					// because a partial log is useful and a silent "not ready" isn't.
					partial: job.state === "running",
					// A graded `fail` exits 1, so `state: "failed"` is what a completed-and-failing
					// A completed failing gauntlet has `state: "failed"`.
					// The status can resemble a crash, but callers need to distinguish a
					// graded failure from a process crash.
					...(job.state === "failed" && report.verdict
						? {
								job_result: `The run COMPLETED and graded ${report.verdict}. The non-zero exit is the verdict, not a crash.`,
							}
						: {}),
					summary: summarizeJob(job.state, summary.elapsed_s, report, Boolean(promotionEvalOutDir)),
					report,
					log,
					stderr: job.stderr,
				}
			},
		},
	]
}
