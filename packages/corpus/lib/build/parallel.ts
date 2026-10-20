/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The coordinator of a parallel corpus build: it runs each source's work in worker processes and assembles
 *   the corpus a serial build writes from the sources' completion records.
 *
 *   Sources are independent from the adapter through the parquet write. A source's rows come from its own adapter
 *   (the runner refuses any other `source`), its files are derived from its own extract and code, its shuffle draws
 *   from a generator seeded by its own id, and its part boundaries count its own rows. A source built alone
 *   therefore writes the bytes it writes in a serial build. What the serial build shares across sources (the split
 *   files, the corpus parquet manifest, the license tallies, the quarantine file, the frozen source record and the
 *   top-level manifest) the coordinator assembles from the records in adapter order.
 *
 *   Each source runs as `adapter`, then one `align` task per byte range of its canonical file, then `finish`
 *   (`#build/worker`). A task runs in its own process with the heap, DuckDB limits and temporary root of its
 *   worker class (`#build/budget`). The scheduler admits a task while fewer than `jobs` run and their reservations
 *   fit in the host budget, runs one resident-record adapter at a time, and prefers the largest source's next task,
 *   because the largest source's chain of tasks bounds the build's wall time.
 *
 *   A failed task fails its source alone. The other sources run to completion and keep their records, the build
 *   rejects naming each failed task and its log, and no corpus manifest is written. `--resume` then reuses every
 *   complete source and continues each incomplete one from its adapter run, finished ranges and finished parts.
 *   Cancelling through `signal` stops every worker with SIGTERM and rejects the same way.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { openReadStream, openWriteStream, pipeline } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, removePathIfPresent, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { forkProcess, type ChildProcess } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { sleep } from "@mailwoman/core/utils/sleep"
import type { PathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"

import { reusableRun } from "#build/adapters"
import { alignSettings } from "#build/align"
import { planAlignRanges, reusableAlignRange, type AlignRangePlan } from "#build/align-range"
import { mergeAlignTotals } from "#build/align-totals"
import {
	adapterWorkerClass,
	WORKER_CLASSES,
	workerReservationBytes,
	type WorkerBudget,
	type WorkerClass,
} from "#build/budget"
import { readRegisterDecisions } from "#build/eligibility"
import { writeBuildManifests } from "#build/manifest"
import { adapterDerivations, derivationConfig, type ResolvedBuildSettings } from "#build/settings"
import {
	readReusableSource,
	sourceStateDirectory,
	SOURCE_RECORD_FILE,
	type SourceBuildSettings,
	type SourceCompletionRecord,
} from "#build/source-record"
import type { BuildCorpusManifest, BuildCorpusOptions, BuildStage } from "#build/types"
import { workerModulePath, type AlignTaskSettings, type WorkerMessage, type WorkerTask } from "#build/worker"
import { corpusDirectoryName } from "#directory"
import { resolveDerivation } from "#parquet/record"
import { parquetManifestOf } from "#parquet/writers"
import type { SourceRightsAdmission } from "#source-register/corpus-inputs"
import type { CorpusAdapter } from "#types"
import { defaultHoldouts, SPLIT_NAMES, writeSplitManifestsFromLabeledFiles, type SplitName } from "#utils/split"

/**
 * Canonical bytes per align range when the caller states none.
 *
 * A source smaller than this aligns in one task.
 * The 2026-10-20 profile aligned 14.6 M rows in 189 s, so a 2 GiB range of `usgov-nad`'s
 * rows takes minutes and a large source spreads over every worker.
 */
export const ALIGN_RANGE_BYTES = 2 * 1024 ** 3

/**
 * What the coordinator needs from `buildCorpus`.
 */
export interface ParallelBuildContext {
	opts: BuildCorpusOptions
	/**
	 * The configured adapters, in the order a serial build drives them.
	 */
	adapters: readonly CorpusAdapter[]
	skipped: string[]
	settings: ResolvedBuildSettings
	rights: SourceRightsAdmission
	outputDir: PathBuilder
	intermediateDir: PathBuilder
	builtAt: string
	budget: WorkerBudget
}

/**
 * One finished worker process, as `WORKERS.json` records it.
 */
interface WorkerRun {
	task: string
	source: string
	kind: WorkerTask["kind"]
	workerClass: WorkerClass
	pid: number | null
	heapLimitBytes: number | null
	maxRSSBytes: number | null
	startedAt: string
	elapsedMs: number
	exitCode: number | null
	signal: string | null
	log: string
}

interface PendingTask {
	task: WorkerTask
	workerClass: WorkerClass
	/**
	 * Larger runs first.
	 *
	 * A source's estimated size, then the task's distance along the source's chain.
	 */
	priority: [number, number]
	resolve: () => void
	reject: (error: Error) => void
}

const KIND_RANK: Record<WorkerTask["kind"], number> = { adapter: 0, align: 1, finish: 2 }

const STAGE_OF: Record<WorkerTask["kind"], BuildStage> = { adapter: "adapter-run", align: "align", finish: "parquet" }

/**
 * The last lines of a worker's log, for the error that reports its failure.
 */
async function logTail(path: string, lines = 20): Promise<string> {
	const text = await readLocalTextFile(path).catch(() => "")

	return TextSpliterator.from(text.trimEnd(), { delimiter: "\n" }).toArray().slice(-lines).join("\n")
}

/**
 * Runs worker tasks under the job count and memory budget.
 */
class WorkerPool {
	readonly runs: WorkerRun[] = []
	#queue: PendingTask[] = []
	#running = new Map<string, { child: ChildProcess | null; workerClass: WorkerClass }>()
	#cancelled: Error | null = null
	readonly #jobs: number
	readonly #budgetBytes: number
	readonly #logDir: PathBuilder
	readonly #taskDir: PathBuilder
	readonly #onProgress: (stage: BuildStage, message: string) => void

	constructor(opts: {
		jobs: number
		budgetBytes: number
		logDir: PathBuilder
		taskDir: PathBuilder
		onProgress: (stage: BuildStage, message: string) => void
	}) {
		this.#jobs = opts.jobs
		this.#budgetBytes = opts.budgetBytes
		this.#logDir = opts.logDir
		this.#taskDir = opts.taskDir
		this.#onProgress = opts.onProgress
	}

	run(task: WorkerTask, workerClass: WorkerClass, sourceWeight: number): Promise<void> {
		if (this.#cancelled) return Promise.reject(this.#cancelled)

		return new Promise((resolve, reject) => {
			this.#queue.push({ task, workerClass, priority: [sourceWeight, KIND_RANK[task.kind]], resolve, reject })
			this.#dispatch()
		})
	}

	/**
	 * Stop every running worker and refuse every queued task with `reason`.
	 */
	cancel(reason: Error): void {
		if (this.#cancelled) return

		this.#cancelled = reason

		for (const pending of this.#queue.splice(0)) {
			pending.reject(reason)
		}

		// A slot whose process has not been forked yet has no child, and its start sees the cancellation.
		for (const { child } of this.#running.values()) {
			child?.kill("SIGTERM")
		}
	}

	/**
	 * Resolve once every running worker has exited.
	 */
	async drained(): Promise<void> {
		while (this.#running.size) {
			await sleep(50)
		}
	}

	#reservedBytes(): number {
		let reserved = 0

		for (const { workerClass } of this.#running.values()) {
			reserved += workerReservationBytes(workerClass)
		}

		return reserved
	}

	#admits(pending: PendingTask): boolean {
		if (this.#running.size >= this.#jobs) return false

		if (this.#reservedBytes() + workerReservationBytes(pending.workerClass) > this.#budgetBytes) return false

		if (pending.workerClass === "resident") {
			for (const { workerClass } of this.#running.values()) {
				if (workerClass === "resident") return false
			}
		}

		return true
	}

	#dispatch(): void {
		if (this.#cancelled) return

		// Highest priority first.
		// A task that does not fit waits rather than letting a smaller one pass it, except that
		// a resident adapter waiting on another resident adapter does not hold up standard work.
		const ordered = this.#queue.toSorted((a, b) => b.priority[0] - a.priority[0] || b.priority[1] - a.priority[1])

		for (const pending of ordered) {
			if (this.#running.size >= this.#jobs) return

			if (this.#admits(pending)) {
				this.#queue.splice(this.#queue.indexOf(pending), 1)
				void this.#start(pending)

				continue
			}

			const blockedOnResident =
				pending.workerClass === "resident" &&
				[...this.#running.values()].some((running) => running.workerClass === "resident")

			if (!blockedOnResident) return
		}
	}

	async #start(pending: PendingTask): Promise<void> {
		const { task, workerClass } = pending
		const name = task.id.replaceAll("/", "__")
		const taskPath = this.#taskDir(`${name}.json`)
		const logPath = this.#logDir(`${name}.log`).toString()
		const startedAt = new Date()
		const resources = WORKER_CLASSES[workerClass]

		const run: WorkerRun = {
			task: task.id,
			source: task.source,
			kind: task.kind,
			workerClass,
			pid: null,
			heapLimitBytes: null,
			maxRSSBytes: null,
			startedAt: startedAt.toISOString(),
			elapsedMs: 0,
			exitCode: null,
			signal: null,
			log: logPath,
		}

		// Reserved before the first await, so the next dispatch counts this worker.
		const slot: { child: ChildProcess | null; workerClass: WorkerClass } = { child: null, workerClass }

		this.#running.set(task.id, slot)

		try {
			await makeDirectories(task.temporaryRoot)
			await writeLocalJSONFile(task, taskPath)

			// A cancellation during the two writes above found no process to stop, so none is started.
			if (this.#cancelled) throw this.#cancelled

			const log = openWriteStream(logPath, { flags: "a" })

			const child = forkProcess(workerModulePath(), [taskPath.toString()], {
				execArgv: [`--max-old-space-size=${Math.floor(resources.heapBytes / 1024 ** 2)}`],
				// The parent's NODE_OPTIONS may carry its own heap ceiling, which would contend with this one.
				env: childEnv({ MAILWOMAN_TEMP_ROOT: task.temporaryRoot, NODE_OPTIONS: null }),
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			})

			slot.child = child
			run.pid = child.pid ?? null

			child.stdout?.pipe(log, { end: false })
			child.stderr?.pipe(log, { end: false })

			child.on("message", (message: WorkerMessage) => {
				if (message.type === "started") {
					run.heapLimitBytes = message.heapLimitBytes
				} else if (message.type === "finished") {
					run.maxRSSBytes = message.maxRSSBytes
				} else {
					this.#onProgress(STAGE_OF[task.kind], `[${task.id}] ${message.message}`)
				}
			})

			const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
				child.on("error", reject)
				child.on("close", (code, sig) => resolve([code, sig]))
			})

			log.end()

			run.exitCode = exitCode
			run.signal = signal
			run.elapsedMs = Date.now() - startedAt.getTime()
			this.runs.push(run)
			this.#running.delete(task.id)

			if (exitCode === 0) {
				this.#onProgress(STAGE_OF[task.kind], `[${task.id}] finished in ${(run.elapsedMs / 1000).toFixed(1)} s`)
				pending.resolve()
			} else {
				pending.reject(
					new Error(
						`corpus build worker ${task.id} (pid ${run.pid}) exited with ` +
							`${signal ? `signal ${signal}` : `code ${exitCode}`}. Its log is ${logPath}:\n${await logTail(logPath)}`
					)
				)
			}
		} catch (error) {
			this.#running.delete(task.id)
			pending.reject(error as Error)
		} finally {
			this.#dispatch()
		}
	}
}

/**
 * The number of align ranges for a canonical file of `bytes`: one per `rangeBytes`,
 * at most twice the job count.
 *
 * More ranges than workers lets a large source's ranges interleave with other sources' tasks,
 * and the cap keeps the per-process start cost below the work each range does.
 * The count changes which processes align which rows and never the bytes they write.
 */
export function alignRangeCount(bytes: number, rangeBytes: number, jobs: number): number {
	return Math.min(2 * jobs, Math.max(1, Math.ceil(bytes / rangeBytes)))
}

/**
 * Concatenate files in order into `destination`.
 */
async function concatenateFiles(sources: readonly string[], destination: PathBuilder): Promise<void> {
	const out = openWriteStream(destination, { flags: "w" })

	for (const source of sources) {
		await pipeline(openReadStream(source), out, { end: false })
	}

	await new Promise<void>((resolve, reject) => {
		out.end((error?: Error | null) => (error ? reject(error) : resolve()))
	})
}

/**
 * Remove one source's parallel-build state and its adapter run, so a resumed build builds it again.
 */
async function forgetSource(intermediateDir: PathBuilder, source: string): Promise<void> {
	await removePathIfPresent(sourceStateDirectory(intermediateDir, source))
	await removePathIfPresent(intermediateDir(source, "MANIFEST.json"))
}

/**
 * Build every configured source in worker processes and assemble the corpus.
 */
export async function runParallelBuild(ctx: ParallelBuildContext): Promise<BuildCorpusManifest> {
	const { opts, settings, intermediateDir, outputDir } = ctx
	const onProgress = (stage: BuildStage, message: string): void => opts.onProgress?.(stage, message)
	const holdouts = defaultHoldouts()
	const registerDecisions = await readRegisterDecisions()

	for (const source of opts.freshSources ?? []) {
		await forgetSource(intermediateDir, source)
	}

	const derivationFor = await adapterDerivations(ctx.adapters, opts.adapterInputs, derivationConfig(settings, holdouts))

	const taskSettings: AlignTaskSettings = {
		corpusVersion: opts.corpusVersion,
		synthesize: settings.synthesize,
		profile: settings.profile,
		licensePolicy: settings.licensePolicy,
		excludeLicenses: settings.excludeLicenses.map((pattern) => ({ source: pattern.source, flags: pattern.flags })),
		holdouts,
	}

	const buildSettings: SourceBuildSettings = {
		align: alignSettings({ ...taskSettings, excludeLicenses: settings.excludeLicenses }),
		rowsPerFile: settings.rowsPerFile,
		shuffleSeed: settings.shuffleSeed,
		shuffleWindow: settings.shuffleWindow,
	}

	await using workRoot = await temporaryDirectory("mailwoman-corpus-workers-")
	const workersDir = intermediateDir("workers")

	// A resumed build appends to the earlier attempts' logs, so a failure's history stays readable.
	if (!settings.resume) {
		await removePathIfPresent(workersDir)
	}

	await makeDirectories(workersDir("tasks"), workersDir("logs"))

	const pool = new WorkerPool({
		jobs: ctx.budget.jobs,
		budgetBytes: ctx.budget.budgetBytes,
		logDir: workersDir("logs"),
		taskDir: workersDir("tasks"),
		onProgress,
	})

	const onAbort = (): void =>
		pool.cancel(new Error(`corpus build cancelled: ${String(opts.signal?.reason ?? "aborted")}`))

	opts.signal?.addEventListener("abort", onAbort, { once: true })

	if (opts.signal?.aborted) {
		onAbort()
	}

	onProgress(
		"adapter-run",
		`parallel build: ${ctx.budget.jobs} workers in a ${(ctx.budget.budgetBytes / 1024 ** 3).toFixed(1)} GiB budget, ` +
			`${ctx.adapters.length} sources`
	)

	const buildSource = async (adapter: CorpusAdapter): Promise<SourceCompletionRecord> => {
		const source = adapter.id
		const sourceDir = sourceStateDirectory(intermediateDir, source)
		const options = opts.adapterInputs[source]!
		const temporaryRoot = (task: string): string => workRoot.path(source, task).toString()

		// Resolved lazily: the extract fingerprint hashes the source's input, which a large file makes slow.
		let derivation: ReturnType<typeof derivationFor> | null = null
		const sourceDerivation = (): ReturnType<typeof derivationFor> => (derivation ??= derivationFor(source))

		if (settings.resume) {
			const reusable = await readReusableSource(sourceDir, {
				settings: buildSettings,
				derivation: await resolveDerivation(await sourceDerivation()),
			})

			if (reusable.record) {
				onProgress("adapter-run", `[${source}] reused the complete source (${reusable.record.parts.length} parts)`)

				return reusable.record
			}

			onProgress("adapter-run", `[${source}] not complete: ${reusable.problem}`)
		}

		const inputStat = await tryStat(options.inputPath)
		// A directory input's size does not predict its rows, so it is ranked first and starts early.
		const inputWeight = inputStat?.isFile() ? inputStat.size : Number.MAX_SAFE_INTEGER
		const adapterDir = intermediateDir(source)
		let run = settings.resume ? await reusableRun(source, adapterDir) : null

		if (run) {
			onProgress("adapter-run", `[${source}] reused the adapter run (${run.yielded} canonical rows)`)
		} else {
			const { signal: _signal, dropped: _dropped, ...serializable } = options

			await pool.run(
				{
					kind: "adapter",
					id: `${source}/adapter`,
					source,
					resources: WORKER_CLASSES[adapterWorkerClass(source)],
					temporaryRoot: temporaryRoot("adapter"),
					adapterModule: derivationFor.modules.get(source)!,
					adapterOptions: { ...serializable, inputPath: options.inputPath.toString() },
					corpusVersion: opts.corpusVersion,
					intermediateDir: intermediateDir.toString(),
				},
				adapterWorkerClass(source),
				inputWeight
			)

			run = await readLocalJSONFile(adapterDir("MANIFEST.json"))
		}

		const canonicalPath = run!.jsonl_path
		const weight = run!.bytes

		const plans: AlignRangePlan[] = await planAlignRanges(
			canonicalPath,
			alignRangeCount(weight, opts.alignRangeBytes ?? ALIGN_RANGE_BYTES, ctx.budget.jobs)
		)

		await Promise.all(
			plans.map(async (plan) => {
				if (settings.resume && (await reusableAlignRange(sourceDir, plan, buildSettings.align))) return

				await pool.run(
					{
						kind: "align",
						id: `${source}/align-${plan.index + 1}-of-${plan.count}`,
						source,
						resources: WORKER_CLASSES.standard,
						temporaryRoot: temporaryRoot(`align-${plan.index}`),
						canonicalPath,
						plan,
						sourceDir: sourceDir.toString(),
						settings: taskSettings,
					},
					"standard",
					weight
				)
			})
		)

		await pool.run(
			{
				kind: "finish",
				id: `${source}/finish`,
				source,
				resources: WORKER_CLASSES.standard,
				temporaryRoot: temporaryRoot("finish"),
				sourceDir: sourceDir.toString(),
				outputDir: outputDir.toString(),
				adapterManifestPath: adapterDir("MANIFEST.json").toString(),
				plans,
				settings: taskSettings,
				buildSettings,
				derivation: await sourceDerivation(),
				resume: settings.resume,
			},
			"standard",
			weight
		)

		return readLocalJSONFile<SourceCompletionRecord>(sourceDir(SOURCE_RECORD_FILE))
	}

	const settled = await Promise.allSettled(ctx.adapters.map((adapter) => buildSource(adapter)))

	opts.signal?.removeEventListener("abort", onAbort)
	await pool.drained()
	await writeLocalJSONFile(pool.runs, workersDir("WORKERS.json"))

	const failures = settled.flatMap((outcome, index) =>
		outcome.status === "rejected" ? [`${ctx.adapters[index]!.id}: ${(outcome.reason as Error).message}`] : []
	)

	if (failures.length) {
		throw new Error(
			`corpus build: ${failures.length} of ${ctx.adapters.length} sources did not finish, so no corpus manifest ` +
				`was written. Every finished source kept its ${SOURCE_RECORD_FILE}; rerun with --resume to reuse them.\n` +
				failures.join("\n")
		)
	}

	const records = settled.map((outcome) => (outcome as PromiseFulfilledResult<SourceCompletionRecord>).value)
	const totals = mergeAlignTotals(records.map((record) => record.totals))

	// A row's `source` is its adapter's id, so this admits only sources the first check admitted.
	// It stays because the serial build checks the sources its rows carried,
	// and both builds record the same admission.
	ctx.rights.admitAll(totals.rowsBySource.keys())

	onProgress("split", `merging ${records.length} sources' sorted id lists (${totals.aligned} aligned rows)`)

	const splitCounts = await writeSplitManifestsFromLabeledFiles({
		labeledPaths: Object.fromEntries(
			SPLIT_NAMES.map((split) => [split, intermediateDir(`labeled-${split}.jsonl`)])
		) as Record<SplitName, PathBuilder>,
		sortedSourceIDPaths: Object.fromEntries(
			SPLIT_NAMES.map((split) => [split, records.map((record) => record.sourceIDs[split].path)])
		) as Record<SplitName, string[]>,
		outputDir: outputDir("splits"),
		corpusVersion: opts.corpusVersion,
		counts: totals.counts,
		holdouts,
	})

	await concatenateFiles(
		records.flatMap((record) => record.quarantine.map((file) => file.path)),
		intermediateDir("quarantine.jsonl")
	)

	onProgress("parquet", "writing the corpus parquet manifest")

	const parquetManifest = parquetManifestOf(
		records.flatMap((record) => record.parts),
		{ corpusVersion: opts.corpusVersion, rowsPerFile: settings.rowsPerFile }
	)

	await writeLocalJSONFile(parquetManifest, outputDir(corpusDirectoryName(opts.corpusVersion), "MANIFEST.json"))

	return await writeBuildManifests({
		outputDir,
		corpusVersion: opts.corpusVersion,
		builtAt: ctx.builtAt,
		profile: settings.profile,
		licensePolicy: settings.licensePolicy,
		adapterRuns: records.map((record) => record.adapter),
		skipped: ctx.skipped,
		splitCounts,
		holdouts,
		parquetManifest,
		totals,
		rights: ctx.rights,
		registerDecisions,
		onProgress: opts.onProgress,
	})
}
