/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { runAdapter, type RunnerProgress } from "@mailwoman/corpus/runner"
import { AddressRole, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "@mailwoman/corpus/types"
import { JSONSpliterator } from "spliterator"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

function makeAdapter(opts: {
	id?: string
	rows: CanonicalRow[]
	defaultLicense?: string
	addressRole?: AddressRole
	throwAfter?: number
}): CorpusAdapter {
	const id = opts.id ?? "test"
	const license = opts.defaultLicense ?? "CC0-1.0"

	return {
		id,
		defaultLicense: license,
		addressRole: opts.addressRole ?? AddressRole.Premise,
		register: "test-register",
		surface: SurfaceOrigin.Attested,
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

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-corpus-runner-")
})

afterEach(async () => {
	scratch[Symbol.asyncDispose]()
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
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.adapter_id).toBe("syn")
		expect(manifest.yielded).toBe(2)
		expect(manifest.written).toBe(2)
		expect(manifest.deduped).toBe(0)
		expect(manifest.corpus_version).toBe("0.1.0")
		expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)

		const lines = await JSONSpliterator.fromAsync<CanonicalRow>(scratch.resolve("syn", "canonical.jsonl")).toArray()

		expect(lines).toHaveLength(2)
		expect(lines[0]!.corpus_version).toBe("0.1.0")
		expect(lines[0]!.source).toBe("syn")

		const manifestOnDisk = await readLocalJSONFile<{ sha256: string }>(scratch.resolve("syn", "MANIFEST.json"))

		expect(manifestOnDisk.sha256).toBe(manifest.sha256)
	})

	it("stamps the adapter's addressRole on rows that omit one and leaves an explicit role alone", async () => {
		const adapter = makeAdapter({
			id: "syn",
			addressRole: AddressRole.RegisteredOffice,
			rows: [
				baseRow({ source_id: "syn-1", raw: "Paris" }),
				baseRow({ source_id: "syn-2", raw: "Lyon", components: { locality: "Lyon" }, addressRole: "facility" }),
			],
		})

		await runAdapter({
			adapter,
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const lines = await JSONSpliterator.fromAsync<CanonicalRow>(scratch.resolve("syn", "canonical.jsonl")).toArray()

		expect(lines.map((line) => line.addressRole)).toEqual(["registered-office", "facility"])
	})

	it("stamps sourceName over the adapter id, after holding the adapter to emitting its own", async () => {
		// One adapter reads every Overture country, and a config has to weight
		// Brazilian rows apart from European ones.
		// `overture-latam` exists for that and the runner had no way to ask for it.
		const adapter = makeAdapter({ id: "syn", rows: [baseRow({ source_id: "syn-1", raw: "Paris" })] })

		await runAdapter({
			adapter,
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
			sourceName: "syn-latam",
		})

		// The jsonl still lands under the adapter's own directory: the rename is the
		// row's `source`, not the adapter's identity.
		const lines = await JSONSpliterator.fromAsync<CanonicalRow>(scratch.resolve("syn", "canonical.jsonl")).toArray()

		expect(lines.map((line) => line.source)).toEqual(["syn-latam"])
	})

	it("leaves the adapter id in place when sourceName is absent", async () => {
		const adapter = makeAdapter({ id: "syn", rows: [baseRow({ source_id: "syn-1", raw: "Paris" })] })

		await runAdapter({
			adapter,
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const lines = await JSONSpliterator.fromAsync<CanonicalRow>(scratch.resolve("syn", "canonical.jsonl")).toArray()

		expect(lines.map((line) => line.source)).toEqual(["syn"])
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
			outputDir: scratch.path,
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
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
			onProgress: (s) => ticks.push(s),
			progressEvery: 2,
		})

		// Periodic at yielded=2,4 plus the final tick.
		// Some implementations may also emit the final tick coincidentally at a multiple of progressEvery.
		// Check the floor instead.
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
			addressRole: AddressRole.Premise,
			register: "test-register",
			surface: SurfaceOrigin.Attested,
			description: "",
			async *rows() {
				yield { ...baseRow({}), source: "different" }
			},
		}

		await expect(
			runAdapter({
				adapter: bad,
				adapterOptions: { inputPath: "ignored" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/row\.source must equal adapter\.id/)
	})

	it("rejects when adapter emits row.raw empty", async () => {
		const bad: CorpusAdapter = {
			id: "syn",
			defaultLicense: "CC0-1.0",
			addressRole: AddressRole.Premise,
			register: "test-register",
			surface: SurfaceOrigin.Attested,
			description: "",
			async *rows() {
				yield baseRow({ source: "syn", raw: "" })
			},
		}

		await expect(
			runAdapter({
				adapter: bad,
				adapterOptions: { inputPath: "ignored" },
				outputDir: scratch.path,
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
				outputDir: scratch.path,
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
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const firstJsonl = await readLocalTextFile(scratch.resolve("syn", "canonical.jsonl"))
		await removePathIfPresent(scratch.resolve("syn"))

		const second = await runAdapter({
			adapter: make(),
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const secondJsonl = await readLocalTextFile(scratch.resolve("syn", "canonical.jsonl"))

		expect(firstJsonl).toBe(secondJsonl)
		expect(first.sha256).toBe(second.sha256)
	})
})
