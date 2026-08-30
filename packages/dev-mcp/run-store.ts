/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Past runs on disk, so an arm can be compared against one that already happened.
 *
 *   This exists for `{kind: "recorded"}` arms: re-running the incumbent to compare against it costs the same wall-clock
 *   as running it the first time, and on a 420-row panel with an external arm it also costs the external service 420
 *   requests it has already answered. A stored run makes the second comparison free.
 *
 *   **It is a CACHE, not a record.** `evals/scores-by-version.json` and `docs/records/evals/` are the record, written by
 *   humans and by `eval ledger-append`. Nothing here is authoritative, nothing here is committed, and a pruned run is
 *   not a lost result — it is a result that has to be re-measured, which is the correct cost for something nobody wrote
 *   down. Storing it under the data root rather than the repo is what keeps that distinction physical.
 *
 *   RETENTION, which spec §9.8 left open. Two rules, both cheap to reason about:
 *
 *   1. **Age.** Runs older than {@link RETENTION_DAYS} are pruned. A stored run is only meaningful against the tree that
 *      produced it, and after a fortnight of commits it is describing a system that no longer exists.
 *   2. **Count.** At most {@link RETENTION_MAX_RUNS} are kept, newest first, regardless of age. This is the backstop for
 *      a busy day — the age rule alone permits an unbounded number of runs inside the window.
 *
 *   A run whose `tree_fingerprint` no longer matches the working tree is NOT pruned automatically. It is still evidence
 *   about that tree, and deleting it silently would be worse than keeping it: `{kind:"recorded"}` refuses to compare
 *   across fingerprints anyway, and says which two it saw.
 */

import { pathExists, readDirectory, readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"
import { join } from "@mailwoman/platform/path"

/**
 * Where runs land. Under the data root, never the repo — see the module docstring on cache-versus-record.
 */
export const RUN_STORE_DIR = String(dataRootPath("dev-mcp", "runs"))

/**
 * Age ceiling in days. A stored run describes the tree that produced it, and after two weeks of commits that tree is
 * gone.
 */
export const RETENTION_DAYS = 14

/**
 * Hard ceiling on stored runs, newest first. The backstop the age rule cannot provide: a busy day can produce hundreds
 * of runs well inside the window.
 */
export const RETENTION_MAX_RUNS = 200

/**
 * What one arm answered for one row, kept in a shape a later run can replay without re-deriving it.
 *
 * Deliberately the SAME shape a live arm produces (`ExternalAnswer`), so a recorded arm and a live one are
 * indistinguishable downstream. A replay that had its own row type would need its own grading path, and a second
 * grading path is how the two stop agreeing.
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
 * One stored run.
 *
 * `payload` is whatever the producing tool returned, opaque here — this module owns storage and retention, not the
 * shape of a result. `answers` is the one exception, and it is explicit rather than dug out of the payload: it is the
 * replay index `{kind:"recorded"}` reads, and a store that had to know a result's internals to find it would break
 * every time a result grew a field.
 */
export interface StoredRun {
	run_id: string
	tool: string
	/**
	 * ISO-8601, supplied by the caller. Not generated here so a workflow that has to be deterministic can stamp its own.
	 */
	created_at: string
	tree_fingerprint: string
	engine_id: string | null
	input_set_id: string | null
	/**
	 * Per-arm replay indices, keyed by the arm's label. Absent for a run nothing can replay — `mwdev_gate`, say, which
	 * answers about a battery rather than about rows.
	 */
	answers?: Record<string, RecordedAnswer[]>
	payload: unknown
}

export interface RunSummary {
	run_id: string
	tool: string
	created_at: string
	tree_fingerprint: string
	engine_id: string | null
	input_set_id: string | null
	bytes: number
	/**
	 * Arm labels this run can be replayed as. Empty means it is stored evidence but not a usable `{kind:"recorded"}` arm
	 * — reported rather than omitted, so a caller learns that before writing the call rather than from its refusal.
	 */
	replayable_arms: string[]
	/**
	 * Whether this run's tree still matches the caller's. `null` when the caller did not supply one to compare against.
	 */
	fingerprint_matches_now: boolean | null
}

function runPath(runID: string, dir: string): string {
	return join(dir, `${runID}.json`)
}

/**
 * Persist a run and return its id.
 */
export async function putRun(run: StoredRun, dir: string = RUN_STORE_DIR): Promise<string> {
	await makeDirectories(dir)
	await writeLocalJSONFile(run, runPath(run.run_id, dir))

	return run.run_id
}

/**
 * Persist a run and apply retention, or say why it could not be done.
 *
 * A failure here must not fail the measurement that produced it. The store is a cache; the queries have already been
 * issued, and for a billed arm already paid for, so throwing away a completed comparison because a disk was full would
 * cost more than the cache is worth. The caller carries the returned sentence into its warnings, so the loss is
 * reported rather than discovered later as a run_id that "was pruned".
 */
export async function tryPutRun(run: StoredRun, dir: string, now: Date): Promise<string | null> {
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
 * Read one run back, or `undefined` when it is not there.
 *
 * `undefined` here means pruned or never stored, and those are not distinguishable after the fact — which is why
 * {@link RETENTION_DAYS} is documented rather than silent. A caller that finds nothing has to re-measure.
 */
export async function getRun(runID: string, dir: string = RUN_STORE_DIR): Promise<StoredRun | undefined> {
	const path = runPath(runID, dir)

	if (!(await pathExists(path))) return undefined

	try {
		return await readLocalJSONFile<StoredRun>(path)
	} catch {
		return undefined
	}
}

/**
 * The replay index for one arm of a stored run, keyed by row id.
 *
 * @throws When that arm was not recorded. Naming what WAS recorded is the useful half of the error: the common mistake
 *   is asking for `mailwoman` on a run whose two arms were `mailwoman` and `photon` under different labels, and a bare
 *   "not found" sends the caller looking for the wrong thing.
 */
export function replayIndex(run: StoredRun, arm: string): Map<string, RecordedAnswer> {
	const answers = run.answers?.[arm]

	if (!answers) {
		const available = Object.keys(run.answers ?? {})

		throw new Error(
			`Run ${run.run_id} has no recorded arm ${JSON.stringify(arm)}. ` +
				(available.length
					? `It recorded: ${available.join(", ")}.`
					: "It recorded no replayable arms at all — it is stored evidence, not a usable recorded arm.")
		)
	}

	return new Map(answers.map((answer) => [answer.id, answer]))
}

async function readAll(dir: string): Promise<Array<{ run: StoredRun; bytes: number; file: string }>> {
	if (!(await pathExists(dir))) return []

	const out: Array<{ run: StoredRun; bytes: number; file: string }> = []

	for (const file of await readDirectory(dir)) {
		if (!file.endsWith(".json")) continue

		try {
			const raw = await readLocalTextFile(join(dir, file))

			out.push({ run: parseJSONStrict<StoredRun>(raw), bytes: raw.length, file })
		} catch {
			// A half-written or corrupt run is skipped rather than throwing: one bad file must not make the whole store
			// unreadable, and `prune` will take it on age.
		}
	}

	return out.toSorted((a, b) => b.run.created_at.localeCompare(a.run.created_at))
}

export async function listRuns(dir: string = RUN_STORE_DIR, currentFingerprint?: string): Promise<RunSummary[]> {
	return (await readAll(dir)).map(({ run, bytes }) => ({
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
}

export interface PruneReport {
	pruned_by_age: string[]
	pruned_by_count: string[]
	kept: number
}

/**
 * Apply both retention rules and report what went, by name.
 *
 * `now` is injected rather than read from the clock so the rule is testable without sleeping, and so a caller that has
 * to be deterministic can pass its own.
 */
export async function pruneRuns(
	now: Date,
	dir: string = RUN_STORE_DIR,
	keep: number = RETENTION_MAX_RUNS
): Promise<PruneReport> {
	const all = await readAll(dir)
	const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000

	const byAge: string[] = []
	const survivors: typeof all = []

	for (const entry of all) {
		const created = Date.parse(entry.run.created_at)

		// An unparseable timestamp is treated as OLD. A run that cannot say when it happened cannot be trusted to
		// describe a current tree, and keeping it forever is the worse failure.
		if (!Number.isFinite(created) || created < cutoff) {
			byAge.push(entry.run.run_id)
			await removePathIfPresent(join(dir, entry.file))

			continue
		}

		survivors.push(entry)
	}

	const byCount: string[] = []

	for (const entry of survivors.slice(keep)) {
		byCount.push(entry.run.run_id)
		await removePathIfPresent(join(dir, entry.file))
	}

	return { pruned_by_age: byAge, pruned_by_count: byCount, kept: Math.min(survivors.length, keep) }
}
