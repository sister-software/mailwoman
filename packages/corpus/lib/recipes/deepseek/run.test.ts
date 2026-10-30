/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The shared runner's checkpoint: what it records, what it leaves pending, and what it refuses to read.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { TextSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import {
	CHECKPOINT_EVERY,
	DeepSeekSink,
	loadCheckpoint,
	rejects,
	RETRY_PREFIX,
	runBatches,
} from "#recipes/deepseek/run"

const quiet = () => {}

describe("runBatches", () => {
	it("checkpoints completed ids, leaves a retried id pending, and resumes from the checkpoint", async () => {
		await using scratch = await temporaryDirectory("mailwoman-deepseek-run-")
		const checkpointPath = scratch.path("checkpoint.json").toString()
		const sink = new DeepSeekSink(scratch.path("rows.jsonl").toString(), scratch.path("raw.jsonl").toString())
		const ids = Array.from({ length: CHECKPOINT_EVERY + 2 }, (_, index) => `b-${String(index).padStart(2, "0")}`)
		const asked: string[] = []

		const tally = await runBatches(
			ids,
			async (id) => {
				asked.push(id)
				await sink.writeRows([{ raw: `row ${id}`, synth: { base_source_id: "ü" } }])

				return [
					id === "b-03" ? `${RETRY_PREFIX}${id}` : id,
					new Map([["ok", 1], id === "b-04" ? ["reject:raw-length", 1] : ["expected", 1]]),
				]
			},
			{ done: new Set(), checkpointPath, concurrency: 4, label: "Test", sink, log: quiet }
		)

		expect(asked.toSorted()).toEqual(ids)
		expect(tally.get("ok")).toBe(ids.length)
		expect(rejects(tally)).toBe(1)

		const checkpoint = await readLocalJSONFile<{ done: string[] }>(checkpointPath)

		expect(checkpoint.done).toEqual(ids.filter((id) => id !== "b-03"))

		const rows = await TextSpliterator.fromAsync(scratch.path("rows.jsonl").toString()).toArray()

		expect(rows).toHaveLength(ids.length)
		expect(rows[0]).toMatch(/^\{"raw":"row b-\d\d","synth":\{"base_source_id":"ü"\}\}$/)

		const done = await loadCheckpoint(checkpointPath, quiet)

		expect(ids.filter((id) => !done.has(id))).toEqual(["b-03"])
	})

	it("writes the checkpoint of the batches that completed before a worker failed", async () => {
		await using scratch = await temporaryDirectory("mailwoman-deepseek-run-")
		const checkpointPath = scratch.path("checkpoint.json").toString()
		const sink = new DeepSeekSink(scratch.path("rows.jsonl").toString(), scratch.path("raw.jsonl").toString())

		await expect(
			runBatches(
				["a", "b"],
				async (id) => {
					if (id === "b") throw new Error("defect in the worker")

					return [id, new Map()]
				},
				{ done: new Set(), checkpointPath, concurrency: 1, label: "Test", sink, log: quiet }
			)
		).rejects.toThrow("defect in the worker")

		expect(await readLocalJSONFile(checkpointPath)).toEqual({ done: ["a"] })
	})
})

describe("loadCheckpoint", () => {
	it("starts empty without a checkpoint and refuses one without a done list", async () => {
		await using scratch = await temporaryDirectory("mailwoman-deepseek-run-")
		const path = scratch.path("checkpoint.json").toString()

		expect(await loadCheckpoint(path, quiet)).toEqual(new Set())

		await writeLocalTextFile('{"completed": ["a"]}', path)

		await expect(loadCheckpoint(path, quiet)).rejects.toThrow(`${path} holds no "done" list`)
	})
})
