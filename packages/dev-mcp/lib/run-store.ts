/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Past runs on disk, so a `{kind: "recorded"}` arm can be replayed rather than re-measured.
 *
 * A cache, not a record: `evals/scores-by-version.json` and `docs/records/evals/` are the record, and a pruned run has
 * to be re-measured. A run whose `tree_fingerprint` no longer matches the working tree is still evidence about that
 * tree, and `{kind:"recorded"}` refuses to compare across fingerprints anyway.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { tryReadLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { type PathBuilder, type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * Where runs land: under the data root, never the repo.
 */
export const RUN_STORE_DIR = dataRootPath("dev-mcp", "runs")

/**
 * Age ceiling in days; a stored run describes the tree that produced it, and
 * after two weeks of commits that tree is gone.
 */
export const RETENTION_DAYS = 14

/**
 * Hard ceiling on stored runs, newest first — the backstop the age rule cannot provide,
 * since a busy day can produce hundreds of runs inside the window.
 */
export const RETENTION_MAX_RUNS = 200

/**
 * What one arm answered for one row, deliberately the same shape a live arm produces
 * (`ExternalAnswer`) so a recorded arm and a live one are indistinguishable downstream.
 */
export interface RecordedAnswer {
	id: string
	input: string
	lat: number | null
	lon: number | null
	label: string | null
	resultType: string | null
	noResultReason: string | null
}

/**
 * One stored run; `payload` is opaque here because this module owns storage and retention
 * rather than result shape, while `answers` is the explicit replay index `{kind:"recorded"}` reads.
 */
export interface StoredRun {
	run_id: string
	tool: string
	/**
	 * ISO-8601, supplied by the caller so a deterministic workflow can stamp its own.
	 */
	created_at: string
	tree_fingerprint: string
	engine_id: string | null
	input_set_id: string | null
	/**
	 * Per-arm replay indices keyed by the arm's label, absent for a run no arm can replay.
	 */
	answers?: Record<string, RecordedAnswer[]>
	payload: unknown
}

/**
 * What one stored run looks like to a caller scanning the store.
 */
export interface RunSummary {
	file: string
	run_id: string
	tool: string
	created_at: string
	tree_fingerprint: string
	engine_id: string | null
	input_set_id: string | null
	bytes: number
	/**
	 * Arm labels this run can be replayed as; empty means it is stored evidence
	 * but not a usable `{kind:"recorded"}` arm.
	 */
	replayable_arms: string[]
	/**
	 * Whether this run's tree still matches the caller's, or `null` when the
	 * caller supplied none to compare against.
	 */
	fingerprint_matches_now: boolean | null
}

function runPath(runID: string, dir: PathBuilderLike): PathBuilder {
	return resolvePathBuilder(dir, `${runID}.json`)
}

/**
 * Persist a run and return its id.
 */
export async function putRun(run: StoredRun, dir: PathBuilderLike = RUN_STORE_DIR): Promise<string> {
	await makeDirectories(dir)
	await writeLocalJSONFile(run, runPath(run.run_id, dir))

	return run.run_id
}

/**
 * Persist a run and apply retention without failing the measurement that produced it,
 * returning a sentence the caller carries into its warnings when the store is unwritable.
 */
export async function tryPutRun(run: StoredRun, dir: PathBuilderLike, now: Date): Promise<string | null> {
	try {
		await putRun(run, dir)
		await pruneRuns(now, dir)

		return null
	} catch (error) {
		return (
			`This run could not be stored at ${dir}: ${(error as Error).message}. The result below is unaffected, but ` +
			`run_id ${run.run_id} is not replayable as a recorded arm.`
		)
	}
}

/**
 * Read one run back, or `null` when it is absent or unreadable; pruned, never stored and
 * unreadable are not distinguishable after the fact, so a caller finding none has to re-measure.
 */
export async function getRun(runID: string, dir: PathBuilderLike = RUN_STORE_DIR): Promise<StoredRun | null> {
	const path = runPath(runID, dir)

	return tryReadLocalJSONFile<StoredRun>(path).catch(() => null)
}

/**
 * The replay index for one arm of a stored run, keyed by row id.
 *
 * @throws When that arm was not recorded, naming what `was` recorded because a bare
 * "not found" sends the caller looking for the wrong thing.
 */
export function replayIndex(run: StoredRun, arm: string): Map<string, RecordedAnswer> {
	const answers = run.answers?.[arm]

	if (!answers) {
		const available = Object.keys(run.answers ?? {})

		throw new Error(
			`Run ${run.run_id} has no recorded arm ${stringifyJSON(arm)}. ` +
				(available.length
					? `It recorded: ${available.join(", ")}.`
					: "It recorded no replayable arms at all — it is stored evidence, not a usable recorded arm.")
		)
	}

	return new Map(answers.map((answer) => [answer.id, answer]))
}

interface StoredRunFile {
	run: StoredRun
	bytes: number
	file: string
}

/**
 * Read a stored run file with its size, or `null` when the file is corrupt or unreadable.
 */
async function readStoredRunFile(dir: PathBuilderLike, file: string): Promise<StoredRunFile | null> {
	return readLocalTextFile(resolvePathBuilder(dir, file))
		.then((raw) => ({ run: parseJSONStrict<StoredRun>(raw), bytes: raw.length, file }))
		.catch(() => null)
}

/**
 * List every stored run, newest first, with an optional fingerprint comparison.
 */
export async function listRuns(
	dir: PathBuilderLike = RUN_STORE_DIR,
	currentFingerprint?: string
): Promise<RunSummary[]> {
	return Globerator.files("json", { cwd: dir, absolute: false, recursive: false, throwIfDirectoryMissing: false })
		.map((file) => readStoredRunFile(dir, file))
		.filter(isPresent)
		.map(({ run, bytes, file }): RunSummary => ({
			file,
			run_id: run.run_id,
			tool: run.tool,
			created_at: run.created_at,
			tree_fingerprint: run.tree_fingerprint,
			engine_id: run.engine_id,
			input_set_id: run.input_set_id,
			bytes,
			replayable_arms: Object.keys(run.answers ?? {}),
			fingerprint_matches_now: currentFingerprint === undefined ? null : run.tree_fingerprint === currentFingerprint,
		}))
		.toSorted((a, b) => b.created_at.localeCompare(a.created_at))
}

/**
 * What one retention pass removed, by name.
 */
export interface PruneReport {
	pruned_by_age: string[]
	pruned_by_count: string[]
	kept: number
}

/**
 * Apply both retention rules and report what went by name; `now` is injected
 * rather than read from the clock so the rule is testable and deterministic.
 */
export async function pruneRuns(
	now: Date,
	dir: PathBuilderLike = RUN_STORE_DIR,
	keep: number = RETENTION_MAX_RUNS
): Promise<PruneReport> {
	const all = await listRuns(dir)
	const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000

	const byAge: string[] = []
	const survivors: typeof all = []

	for (const entry of all) {
		const created = Date.parse(entry.created_at)

		// An unparseable timestamp is treated as old, because a run that cannot say
		// when it happened cannot be trusted to describe a current tree.
		if (!Number.isFinite(created) || created < cutoff) {
			byAge.push(entry.run_id)

			await removePathIfPresent(resolvePathBuilder(dir, entry.file))

			continue
		}

		survivors.push(entry)
	}

	const byCount: string[] = []

	for (const entry of survivors.slice(keep)) {
		byCount.push(entry.run_id)
		await removePathIfPresent(resolvePathBuilder(dir, entry.file))
	}

	return {
		pruned_by_age: byAge,
		pruned_by_count: byCount,
		kept: Math.min(survivors.length, keep),
	}
}
