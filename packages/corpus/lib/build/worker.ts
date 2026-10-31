/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The tasks a parallel corpus build runs in worker processes, and the process entry that runs one.
 *
 *   A source passes through three kinds of task. `adapter` drives the source's adapter to its `canonical.jsonl`,
 *   exactly as the serial adapter phase does. `align` aligns one contiguous range of that file into the range's
 *   own directory. `finish` sorts the source's ids, writes its parquet files through the same writer, shuffle and
 *   derivation as the serial build, and writes `SOURCE_COMPLETE.json` last.
 *
 *   The coordinator writes each task as JSON and forks this module with an explicit `--max-old-space-size` and a
 *   `MAILWOMAN_TEMP_ROOT` of the task's own. The worker reports progress over IPC and states its result by its
 *   exit code and the records it leaves on disk. Those records outlive the worker process.
 */

import { readLocalJSONFile, tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { removePathIfPresent, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { heapLimitBytes } from "@mailwoman/core/utils/system"
import { PathBuilder } from "path-ts"

import { alignSettings } from "#build/align"
import {
	ALIGN_RANGE_RECORD_FILE,
	alignRangeDirectory,
	alignRangeSplitFiles,
	reusableAlignRange,
	runAlignRange,
	type AlignRangePlan,
	type AlignRangeRecord,
} from "#build/align/range"
import { mergeAlignTotals, serializeAlignTotals } from "#build/align/totals"
import type { WorkerResources } from "#build/budget"
import { loadAdapterFromModule } from "#build/code-hash"
import { readSourceEligibility } from "#build/eligibility"
import { streamJSONL } from "#build/rows"
import {
	recordFile,
	SOURCE_RECORD_FILE,
	type SourceBuildSettings,
	type SourceCompletionRecord,
} from "#build/source-record"
import { BuildProfile } from "#build/types"
import { resolveDerivation, type FileDerivation } from "#parquet/record"
import { shuffleSplitRows, SPLIT_SHUFFLE_SALT } from "#parquet/shuffle"
import { writeParquetSplits, type ParquetManifest } from "#parquet/writers"
import { runAdapter, type AdapterRunManifest } from "#runner"
import type { AdapterOptions, LabeledRow } from "#types"
import type { LicensePolicy } from "#utils/license"
import { SPLIT_NAMES, sortLines, type CountryHoldout, type SplitName } from "#utils/split"

/**
 * The align settings a task contains, with each license pattern as its source and flags.
 */
export interface AlignTaskSettings {
	corpusVersion: string
	synthesize: boolean
	profile: BuildProfile
	licensePolicy: LicensePolicy
	excludeLicenses: { source: string; flags: string }[]
	holdouts: Record<string, CountryHoldout>
}

interface TaskBase {
	/**
	 * Unique within the build, e.g. `ban/align-1-of-3`.
	 */
	id: string
	source: string
	resources: WorkerResources
	/**
	 * The task's own temporary root.
	 * DuckDB uses it for the spill directory too.
	 */
	temporaryRoot: string
}

export interface AdapterTask extends TaskBase {
	kind: "adapter"
	/**
	 * The module exporting the adapter, repository-relative, as `adapterModules` found it.
	 */
	adapterModule: string
	adapterOptions: Omit<AdapterOptions, "signal" | "dropped" | "inputPath"> & { inputPath: string }
	corpusVersion: string
	intermediateDir: string
}

export interface AlignTask extends TaskBase {
	kind: "align"
	canonicalPath: string
	plan: AlignRangePlan
	sourceDir: string
	settings: AlignTaskSettings
}

export interface FinishTask extends TaskBase {
	kind: "finish"
	sourceDir: string
	outputDir: string
	adapterManifestPath: string
	plans: AlignRangePlan[]
	settings: AlignTaskSettings
	buildSettings: SourceBuildSettings
	derivation: FileDerivation
	/**
	 * Continue from the per-source parquet manifest an earlier attempt left.
	 */
	resume: boolean
}

export type WorkerTask = AdapterTask | AlignTask | FinishTask

/**
 * A message a worker sends its coordinator.
 */
export type WorkerMessage =
	| { type: "started"; task: string; heapLimitBytes: number; pid: number }
	| { type: "progress"; task: string; message: string }
	| { type: "finished"; task: string; maxRSSBytes: number }

/**
 * The per-source parquet manifest a `finish` task keeps, so an interrupted one resumes at its next part.
 */
export const SOURCE_PARQUET_MANIFEST_FILE = "PARQUET_MANIFEST.json"

export function compileTaskLicensePatterns(settings: AlignTaskSettings): RegExp[] {
	return settings.excludeLicenses.map((pattern) => new RegExp(pattern.source, pattern.flags))
}

function alignInputs(settings: AlignTaskSettings) {
	return {
		corpusVersion: settings.corpusVersion,
		synthesize: settings.synthesize,
		profile: settings.profile,
		licensePolicy: settings.licensePolicy,
		excludeLicenses: compileTaskLicensePatterns(settings),
		holdouts: settings.holdouts,
	}
}

/**
 * The module a worker process runs: `worker.ts` from source, `worker.js` from the compiled tree.
 *
 * The coordinator imports this function at runtime, so this module and what it
 * reaches enter the build's code hash beside the coordinator.
 */
export function workerModulePath(): string {
	return import.meta.filename
}

async function runAdapterTask(task: AdapterTask): Promise<void> {
	const adapter = await loadAdapterFromModule(task.adapterModule, task.source)

	await runAdapter({
		adapter,
		adapterOptions: task.adapterOptions,
		outputDir: task.intermediateDir,
		corpusVersion: task.corpusVersion,
	})
}

async function runAlignTask(task: AlignTask): Promise<void> {
	const inputs = alignInputs(task.settings)

	await runAlignRange({
		...inputs,
		canonicalPath: task.canonicalPath,
		plan: task.plan,
		sourceDir: task.sourceDir,
		eligibility: inputs.profile === BuildProfile.ReleaseEligible ? await readSourceEligibility() : null,
	})
}

/**
 * Why the per-source parquet manifest cannot be resumed from, or `null` when it can or does not exist.
 */
async function finishedPartProblem(manifestPath: PathBuilder): Promise<string | null> {
	const manifest = await tryReadLocalJSONFile<ParquetManifest>(manifestPath).catch(() => null)

	if (!manifest) return (await tryStat(manifestPath)) ? `${manifestPath.toString()} is unreadable` : null

	for (const part of manifest.files) {
		const stat = await tryStat(part.path)

		if (!stat) return `${manifestPath.toString()} records ${part.path}, which is missing`

		if (stat.size !== part.bytes) return `${part.path} is ${stat.size} bytes and its record states ${part.bytes}`
	}

	return null
}

async function* concatenated<T>(paths: readonly PathBuilder[]): AsyncGenerator<T> {
	for (const path of paths) {
		yield* streamJSONL<T>(path)
	}
}

async function runFinishTask(task: FinishTask, report: (message: string) => void): Promise<void> {
	const sourceDir = PathBuilder.from(task.sourceDir)
	const settings = alignSettings(alignInputs(task.settings))
	const ranges: AlignRangeRecord[] = []

	for (const plan of task.plans) {
		const range = await reusableAlignRange(sourceDir, plan, settings)

		if (!range) {
			throw new Error(
				`worker ${task.id}: ${alignRangeDirectory(sourceDir, plan)(ALIGN_RANGE_RECORD_FILE).toString()} is ` +
					`missing or does not match its outputs, so the source cannot be finished from it`
			)
		}

		ranges.push(range)
	}

	const files = alignRangeSplitFiles(sourceDir, task.plans)
	const sourceIDs = {} as Record<SplitName, Awaited<ReturnType<typeof recordFile>>>

	for (const split of SPLIT_NAMES) {
		const sorted = sourceDir(`source-ids-${split}.sorted.txt`)

		await sortLines(files[split].sourceIDs, sorted)

		sourceIDs[split] = await recordFile(sorted)
	}

	const manifestPath = sourceDir(SOURCE_PARQUET_MANIFEST_FILE)
	let resume = task.resume

	// The writer refuses a resume whose recorded part is gone or resized.
	// A source's parts are rewritten from the same rows to the same bytes,
	// so the record is dropped and every part written again.
	// The writer keeps each store file whose sha256 matches the part it writes.
	const broken = resume ? await finishedPartProblem(manifestPath) : null

	if (broken) {
		report(`writing every part again: ${broken}`)
		await removePathIfPresent(manifestPath)
		resume = false
	}

	report("writing parquet files")

	const derivation = task.derivation

	const parquet = await writeParquetSplits(
		Object.fromEntries(
			SPLIT_NAMES.map((split) => [
				split,
				shuffleSplitRows(concatenated<LabeledRow>(files[split].labeled), {
					seed: task.buildSettings.shuffleSeed,
					salt: SPLIT_SHUFFLE_SALT[split],
					window: task.buildSettings.shuffleWindow,
				}),
			])
		),
		{
			outputDir: task.outputDir,
			corpusVersion: task.settings.corpusVersion,
			rowsPerFile: task.buildSettings.rowsPerFile,
			resume,
			manifestPath,
			duckdb: {
				memoryLimitBytes: task.resources.duckdbBytes,
				threads: task.resources.duckdbThreads,
				temporaryDirectory: PathBuilder.from(task.temporaryRoot)("duckdb").toString(),
			},
			derivationFor: (source) => {
				if (source !== task.source) {
					throw new Error(
						`worker ${task.id}: a row of ${source} reached ${task.source}'s parquet files. ` +
							`A source's rows come from its own adapter alone.`
					)
				}

				return derivation
			},
		}
	)

	const record: SourceCompletionRecord = {
		source: task.source,
		settings: task.buildSettings,
		derivation: await resolveDerivation(derivation),
		adapter: await readLocalJSONFile<AdapterRunManifest>(task.adapterManifestPath),
		alignRanges: task.plans.map((plan) => ({ start: plan.start, end: plan.end })),
		parts: parquet.files,
		sourceIDs,
		quarantine: await Promise.all(
			task.plans.map((plan) => recordFile(alignRangeDirectory(sourceDir, plan)("quarantine.jsonl")))
		),
		totals: serializeAlignTotals(mergeAlignTotals(ranges.map((range) => range.totals))),
		completed_at: new Date().toISOString(),
	}

	// The last write of a source's work, so a record on disk means every file it lists was finished first.
	await writeLocalJSONFile(record, sourceDir(SOURCE_RECORD_FILE))
}

/**
 * Run one task in this process.
 */
export async function runWorkerTask(task: WorkerTask, report: (message: string) => void = () => {}): Promise<void> {
	switch (task.kind) {
		case "adapter":
			return runAdapterTask(task)
		case "align":
			return runAlignTask(task)
		case "finish":
			return runFinishTask(task, report)
	}
}

function send(message: WorkerMessage): Promise<void> {
	return new Promise((resolve) => {
		if (process.send) {
			process.send(message, undefined, {}, () => resolve())
		} else {
			resolve()
		}
	})
}

async function runWorkerProcess(): Promise<void> {
	const [taskPath] = cliArguments()

	if (!taskPath) throw new Error("corpus build worker: expected a task file path as the first argument")

	const task = await readLocalJSONFile<WorkerTask>(taskPath)

	// The coordinator's exit closes the channel.
	// A worker left running would keep writing into an output directory whose lock
	// a later build may take over, so it stops.
	process.on("disconnect", () => process.exit(1))

	await send({ type: "started", task: task.id, heapLimitBytes: heapLimitBytes(), pid: process.pid })
	await runWorkerTask(task, (message) => void send({ type: "progress", task: task.id, message }))
	// `maxRSS` is in kibibytes.
	await send({ type: "finished", task: task.id, maxRSSBytes: process.resourceUsage().maxRSS * 1024 })
}

if (import.meta.main) {
	runWorkerProcess().then(
		() => {
			process.removeAllListeners("disconnect")
			process.disconnect?.()
			process.exit(0)
		},
		(error: unknown) => {
			console.error(error instanceof Error ? (error.stack ?? error.message) : error)

			process.exit(1)
		}
	)
}
