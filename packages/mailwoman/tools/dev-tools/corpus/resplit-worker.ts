// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `parallelMapWorkers` handler behind `resplit.run.ts`.
 *
 *   Each worker thread reads the retention table at the path in its `userData` once.
 *   It then splits every file dispatched to it with `splitOverlaySlice`, its DuckDB
 *   instance held to the threads and memory the coordinator gave each worker.
 */

import { sha256File } from "@mailwoman/core/hash"
import { workerUserData } from "@mailwoman/core/workers"
import { readSplitRetention } from "@mailwoman/corpus/tools/overlay/split/attribute"
import { splitOverlaySlice } from "@mailwoman/corpus/tools/overlay/split/overlay"

/**
 * What the coordinator passes every worker.
 */
export interface ResplitWorkerData {
	retentionPath: string | null
	duckdbThreads: number
	duckdbMemoryBytes: number
}

/**
 * One file to split: its index in the manifest, its parquet path and the
 * directory its attribute is written to.
 */
export interface ResplitItem {
	index: number
	input: string
	outputDir: string
}

/**
 * A worker returns this record for each file it splits: where the attribute
 * was written, its policy hash and counts.
 */
export interface ResplitResult {
	index: number
	attribute: string
	/**
	 * The attribute file's sha256.
	 * A corpus manifest records it beside the attribute's path.
	 */
	attributeSHA256: string
	policyHash: string
	rows: number
	counts: Record<string, number>
	seconds: number
}

const { retentionPath, duckdbThreads, duckdbMemoryBytes } = workerUserData<ResplitWorkerData>()
const retention = retentionPath ? await readSplitRetention(retentionPath) : undefined

/**
 * Splits one file and returns its decision.
 */
export async function handleItem(item: ResplitItem): Promise<ResplitResult> {
	const started = performance.now()

	const result = await splitOverlaySlice({
		input: item.input,
		outputDir: item.outputDir,
		limits: { threads: duckdbThreads, memoryLimitBytes: duckdbMemoryBytes },
		...(retention ? { retention } : {}),
	})

	return {
		index: item.index,
		attribute: result.attribute.toString(),
		attributeSHA256: await sha256File(result.attribute),
		policyHash: result.policyHash,
		rows: result.rows,
		counts: result.counts,
		seconds: (performance.now() - started) / 1000,
	}
}
