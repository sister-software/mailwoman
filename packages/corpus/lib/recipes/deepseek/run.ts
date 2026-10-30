/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The checkpointed concurrent runner both DeepSeek generation modes share, and the two files a run appends to.
 *
 *   A mode supplies a worker. The worker answers a batch id and its own tally. The {@linkcode RETRY_PREFIX} on that id
 *   keeps the batch pending after the sink has written whatever rows it parsed, so the next run asks for the batch
 *   again. Deterministic row source ids keep a row the second request repeats from becoming a duplicate downstream.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { appendLocalTextFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"

/**
 * The prefix a worker puts on a batch id to leave the batch pending.
 */
export const RETRY_PREFIX = "!RETRY:"

/**
 * The tally keys that count against a batch rather than toward it, beside every `reject:` key.
 */
export const REJECT_KEYS: readonly string[] = ["api_error", "bad-shape", "index-out-of-range"]

/**
 * The number of completed batches between two checkpoint writes during a run.
 */
export const CHECKPOINT_EVERY = 25

/**
 * A tally of outcomes by key, as Python's `Counter`.
 */
export type Tally = Map<string, number>

/**
 * Adds `amount` to `key`.
 */
export function tallyOutcome(tally: Tally, key: string, amount = 1): void {
	tally.set(key, (tally.get(key) ?? 0) + amount)
}

/**
 * Whether a tally key counts against the batch.
 */
function isRejectKey(key: string): boolean {
	return key.startsWith("reject") || REJECT_KEYS.includes(key)
}

/**
 * The rows a run asked for and did not get, by every way it can fail to get one.
 */
export function rejects(tally: Tally): number {
	let total = 0

	for (const [key, value] of tally) {
		if (isRejectKey(key)) {
			total += value
		}
	}

	return total
}

/**
 * The two append-only files of a run: the canonical rows, and one raw response entry per request.
 *
 * Appends are queued in call order, so two workers finishing together never interleave their lines.
 * A resumed run appends to the earlier run's files.
 */
export class DeepSeekSink {
	readonly canonicalPath: string
	readonly rawLogPath: string
	#queue: Promise<void> = Promise.resolve()

	constructor(canonicalPath: string, rawLogPath: string) {
		this.canonicalPath = canonicalPath
		this.rawLogPath = rawLogPath
	}

	#append(path: string, text: string): Promise<void> {
		this.#queue = this.#queue.then(() => appendLocalTextFile(text, path))

		return this.#queue
	}

	/**
	 * Appends canonical rows, one `json.dumps(row, ensure_ascii=False)` line each.
	 */
	writeRows(rows: readonly unknown[]): Promise<void> {
		return this.#append(
			this.canonicalPath,
			rows.map((row) => pythonJSONDumps(row, { ensureASCII: false }) + "\n").join("")
		)
	}

	/**
	 * Appends the raw response entry of one request, so a row can be traced to the call that produced it.
	 */
	writeResponse(entry: Record<string, unknown>): Promise<void> {
		return this.#append(this.rawLogPath, pythonJSONDumps(entry, { ensureASCII: false }) + "\n")
	}

	/**
	 * Waits for every queued append.
	 */
	flush(): Promise<void> {
		return this.#queue
	}
}

/**
 * The batch ids a previous run completed, or an empty set on the first run.
 *
 * @throws When the checkpoint exists without a `done` list, because a run that
 * read it as empty would pay for every batch again.
 */
export async function loadCheckpoint(path: string, log: (line: string) => void = console.log): Promise<Set<string>> {
	if (!(await pathExists(path))) return new Set()

	const checkpoint = await readLocalJSONFile<{ done?: unknown }>(path)

	if (!Array.isArray(checkpoint.done) || !checkpoint.done.every((id) => typeof id === "string")) {
		throw new Error(`${path} holds no "done" list of batch ids`)
	}

	log(`resuming: ${checkpoint.done.length} batches already complete`)

	return new Set(checkpoint.done)
}

/**
 * Writes the checkpoint as `json.dumps({"done": sorted(done)})`.
 */
async function writeCheckpoint(path: string, done: ReadonlySet<string>): Promise<void> {
	// Batch ids are ASCII, so the default sort is Python's `sorted`.
	await writeLocalTextFile(pythonJSONDumps({ done: [...done].toSorted() }), path)
}

/**
 * A mode's worker: requests one batch, writes its rows, and answers the batch id and its tally.
 */
export type DeepSeekWorker<Batch> = (batch: Batch) => Promise<readonly [batchID: string, tally: Tally]>

/**
 * Options for {@linkcode runBatches}.
 */
export interface RunBatchesOptions {
	/**
	 * The ids already complete.
	 * Each batch that completes is added.
	 */
	done: Set<string>
	checkpointPath: string
	concurrency: number
	/**
	 * Names the mode in the closing summary.
	 */
	label: string
	sink: DeepSeekSink
	log?: (line: string) => void
	/**
	 * Milliseconds since an arbitrary origin, for the rate in the progress line.
	 */
	now?: () => number
}

function formatRejects(tally: Tally): string {
	const parts = [...tally].filter(([key]) => isRejectKey(key)).map(([key, value]) => `'${key}': ${value}`)

	return `{${parts.join(", ")}}`
}

/**
 * Runs every pending batch with at most `concurrency` requests in flight, checkpointing completed
 * ids every {@linkcode CHECKPOINT_EVERY} completions and once at the end, and prints the summary.
 *
 * A worker's rejection is not caught: a worker answers an API failure as a tally,
 * so a rejection is a defect in the run, and the checkpoint keeps the ids completed before it.
 */
export async function runBatches<Batch>(
	pending: readonly Batch[],
	worker: DeepSeekWorker<Batch>,
	options: RunBatchesOptions
): Promise<Tally> {
	const { done, checkpointPath, sink } = options
	const log = options.log ?? console.log
	const now = options.now ?? (() => performance.now())
	const tally: Tally = new Map()
	const started = now()
	let processed = 0
	let next = 0
	let checkpointWrite: Promise<void> = Promise.resolve()

	const commit = (batchID: string): void => {
		if (batchID.startsWith(RETRY_PREFIX)) return

		done.add(batchID)

		if (done.size % CHECKPOINT_EVERY === 0) {
			const snapshot = new Set(done)

			checkpointWrite = checkpointWrite.then(() => writeCheckpoint(checkpointPath, snapshot))
		}
	}

	const lane = async (): Promise<void> => {
		while (next < pending.length) {
			const batch = pending[next++]!
			const [batchID, batchTally] = await worker(batch)

			for (const [key, value] of batchTally) {
				tallyOutcome(tally, key, value)
			}

			commit(batchID)

			processed++

			if (processed % 5 === 0 || processed === pending.length) {
				const elapsed = (now() - started) / 1000

				log(
					`  [${processed}/${pending.length}] ok=${tally.get("ok") ?? 0} reject=${rejects(tally)} ` +
						`truncated=${tally.get("finish:length") ?? 0} ` +
						`elapsed=${elapsed.toFixed(0)}s  rps=${((tally.get("ok") ?? 0) / Math.max(elapsed, 1)).toFixed(1)}`
				)
			}
		}
	}

	try {
		await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, pending.length)) }, lane))
	} finally {
		await checkpointWrite
		await writeCheckpoint(checkpointPath, done)
		await sink.flush()
	}

	log(`\n${options.label} generation complete.`)
	log(`  ok rows: ${tally.get("ok") ?? 0}`)
	log(`  rejects: ${formatRejects(tally)}`)
	log(`  output: ${sink.canonicalPath}`)

	return tally
}
