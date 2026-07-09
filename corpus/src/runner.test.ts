/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runAdapter, type RunnerProgress } from "./runner.ts"
import type { CanonicalRow, CorpusAdapter } from "./types.ts"

function makeAdapter(opts: {
	id?: string
	rows: CanonicalRow[]
	defaultLicense?: string
	throwAfter?: number
}): CorpusAdapter {
	const id = opts.id ?? "test"
	const license = opts.defaultLicense ?? "CC0-1.0"

	return {
		id,
		defaultLicense: license,
		description: `synthetic adapter ${id}`,
		async *rows() {
			let i = 0

			for (const row of opts.rows) {
				if (opts.throwAfter !== undefined && i >= opts.throwAfter) {
					throw new Error("adapter exploded")
				}
				yield { ...row, source: id, license: row.license || license }
				i++
			}
		},
	}
}

let scratch: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-corpus-runner-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("runAdapter", () => {
	const baseRow = (over: Partial<CanonicalRow>): CanonicalRow => ({
		raw: "Paris",
		components: { locality: "Paris" },
		country: "FR",
		source: "test",
		source_id: "t-1",
		corpus_version: "",
		license: "CC0-1.0",
		...over,
	})

	it("writes JSONL + MANIFEST with row-stamped corpus_version and stable sha256", async () => {
		const adapter = makeAdapter({
			id: "syn",
			rows: [
				baseRow({ source_id: "syn-1", raw: "Paris" }),
				baseRow({ source_id: "syn-2", raw: "Lyon", components: { locality: "Lyon" } }),
			],
		})

		const manifest = await runAdapter({
			adapter,
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})

		expect(manifest.adapter_id).toBe("syn")
		expect(manifest.yielded).toBe(2)
		expect(manifest.written).toBe(2)
		expect(manifest.deduped).toBe(0)
		expect(manifest.corpus_version).toBe("0.1.0")
		expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)

		const jsonl = await readFile(join(scratch, "syn", "canonical.jsonl"), "utf8")
		const lines = jsonl
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as CanonicalRow)
		expect(lines).toHaveLength(2)
		expect(lines[0]!.corpus_version).toBe("0.1.0")
		expect(lines[0]!.source).toBe("syn")

		const manifestOnDisk = JSON.parse(await readFile(join(scratch, "syn", "MANIFEST.json"), "utf8"))
		expect(manifestOnDisk.sha256).toBe(manifest.sha256)
	})

	it("dedupes by canonical key (count visible in manifest)", async () => {
		const adapter = makeAdapter({
			id: "syn",
			rows: [
				baseRow({ source_id: "syn-1", raw: "Paris" }),
				baseRow({ source_id: "syn-1b", raw: "PARIS" }), // case-only dup
				baseRow({ source_id: "syn-2", raw: "Lyon", components: { locality: "Lyon" } }),
			],
		})

		const manifest = await runAdapter({
			adapter,
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(3)
		expect(manifest.written).toBe(2)
		expect(manifest.deduped).toBe(1)
	})

	it("calls onProgress every `progressEvery` rows + one final tick", async () => {
		const adapter = makeAdapter({
			id: "syn",
			rows: Array.from({ length: 5 }, (_, i) =>
				baseRow({ source_id: `syn-${i}`, raw: `row ${i}`, components: { locality: `Place${i}` } })
			),
		})

		const ticks: RunnerProgress[] = []
		await runAdapter({
			adapter,
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
			onProgress: (s) => ticks.push(s),
			progressEvery: 2,
		})

		// Periodic at yielded=2,4 plus the final tick. Some implementations may also emit the
		// final tick coincidentally at a multiple of progressEvery; check the floor instead.
		expect(ticks.length).toBeGreaterThanOrEqual(3)
		const final = ticks.at(-1)!
		expect(final.yielded).toBe(5)
		expect(final.written).toBe(5)
		expect(final.bytes).toBeGreaterThan(0)
		expect(final.elapsed_ms).toBeGreaterThanOrEqual(0)
	})

	it("rejects when adapter emits row.source != adapter.id", async () => {
		const bad: CorpusAdapter = {
			id: "syn",
			defaultLicense: "CC0-1.0",
			description: "",
			async *rows() {
				yield { ...baseRow({}), source: "different" }
			},
		}
		await expect(
			runAdapter({
				adapter: bad,
				adapterOptions: { inputPath: "ignored" },
				outputDir: scratch,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/row\.source must equal adapter\.id/)
	})

	it("rejects when adapter emits row.raw empty", async () => {
		const bad: CorpusAdapter = {
			id: "syn",
			defaultLicense: "CC0-1.0",
			description: "",
			async *rows() {
				yield baseRow({ source: "syn", raw: "" })
			},
		}
		await expect(
			runAdapter({
				adapter: bad,
				adapterOptions: { inputPath: "ignored" },
				outputDir: scratch,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/row\.raw is empty/)
	})

	it("honors AbortSignal raised mid-run", async () => {
		const adapter = makeAdapter({
			id: "syn",
			rows: Array.from({ length: 100 }, (_, i) =>
				baseRow({ source_id: `syn-${i}`, raw: `r${i}`, components: { locality: `L${i}` } })
			),
		})
		const ac = new AbortController()
		queueMicrotask(() => ac.abort())
		await expect(
			runAdapter({
				adapter,
				adapterOptions: { inputPath: "ignored", signal: ac.signal },
				outputDir: scratch,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/aborted/i)
	})

	it("two runs over the same fixture produce byte-identical JSONL", async () => {
		const make = () =>
			makeAdapter({
				id: "syn",
				rows: [
					baseRow({ source_id: "syn-1", raw: "Paris" }),
					baseRow({
						source_id: "syn-2",
						raw: "Lyon",
						components: { locality: "Lyon" },
					}),
				],
			})

		const first = await runAdapter({
			adapter: make(),
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const firstJsonl = await readFile(join(scratch, "syn", "canonical.jsonl"), "utf8")
		await rm(join(scratch, "syn"), { recursive: true, force: true })

		const second = await runAdapter({
			adapter: make(),
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const secondJsonl = await readFile(join(scratch, "syn", "canonical.jsonl"), "utf8")

		expect(firstJsonl).toBe(secondJsonl)
		expect(first.sha256).toBe(second.sha256)
	})
})
