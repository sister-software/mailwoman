/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { JSONSpliterator } from "spliterator"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { FingerprintSet } from "#fingerprints"
import { DedupStore, runAdapter, type RunnerProgress } from "#runner"
import { AddressRole, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

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
	await scratch[Symbol.asyncDispose]()
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

		const lines = await JSONSpliterator.fromAsync<CanonicalRow>(scratch.path("syn", "canonical.jsonl")).toArray()

		expect(lines).toHaveLength(2)
		expect(lines[0]!.corpus_version).toBe("0.1.0")
		expect(lines[0]!.source).toBe("syn")

		const manifestOnDisk = await readLocalJSONFile<{ sha256: string }>(scratch.path("syn", "MANIFEST.json"))

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

		const lines = await JSONSpliterator.fromAsync<CanonicalRow>(scratch.path("syn", "canonical.jsonl")).toArray()

		expect(lines.map((line) => line.addressRole)).toEqual(["registered-office", "facility"])
	})

	it("stamps sourceName over the adapter id, after holding the adapter to emitting its own", async () => {
		// One adapter reads every Overture country.
		// A config must weight Brazilian rows separately from European rows.
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
		const lines = await JSONSpliterator.fromAsync<CanonicalRow>(scratch.path("syn", "canonical.jsonl")).toArray()

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

		const lines = await JSONSpliterator.fromAsync<CanonicalRow>(scratch.path("syn", "canonical.jsonl")).toArray()

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

	it("rejects a country code outside the ISO 3166-1 alpha-2 shape", async () => {
		// WOF record 1141959953 publishes `Nl`.
		// In corpus version `v0.6.0-register-surface`, 431 rows used that code.
		// Those rows bypassed `country_weights` and country filters.
		// The runner counted them like rows from an ordinary country.
		const emitting = (country: string): CorpusAdapter => ({
			id: "syn",
			defaultLicense: "CC0-1.0",
			addressRole: AddressRole.Premise,
			register: "test-register",
			surface: SurfaceOrigin.Attested,
			description: "",
			async *rows() {
				yield baseRow({ source: "syn", country })
			},
		})

		const run = (country: string) =>
			runAdapter({
				adapter: emitting(country),
				adapterOptions: { inputPath: "ignored" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})

		await expect(run("Nl")).rejects.toThrow(/is not two upper-case letters/)
		await expect(run("nl")).rejects.toThrow(/is not two upper-case letters/)
		await expect(run("NLD")).rejects.toThrow(/is not two upper-case letters/)

		// `ZZ` marks the row's country as undetermined.
		// The fragment recipes use this value.
		await expect(run("ZZ")).resolves.toBeDefined()
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

	it("refuses to write a manifest when the adapter honored the signal by returning", async () => {
		// The test above aborts an adapter that ignores `signal` and keeps yielding.
		// The in-loop check catches that behavior.
		// Other adapters in the tree return when signaled.
		const ac = new AbortController()

		const honorsSignal: CorpusAdapter = {
			id: "syn",
			defaultLicense: "CC0-1.0",
			addressRole: AddressRole.Premise,
			register: "test-register",
			surface: SurfaceOrigin.Attested,
			description: "",
			async *rows(options) {
				for (let i = 0; i < 100; i++) {
					if (options.signal?.aborted) return

					yield baseRow({ source: "syn", source_id: `syn-${i}`, raw: `r${i}`, components: { locality: `L${i}` } })

					if (i === 2) {
						ac.abort()
					}
				}
			},
		}

		await expect(
			runAdapter({
				adapter: honorsSignal,
				adapterOptions: { inputPath: "ignored", signal: ac.signal },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/abort/i)

		// And it left no manifest for a resume to find.
		expect(await pathExists(scratch.path("syn", "MANIFEST.json"))).toBe(false)
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

		const firstJsonl = await readLocalTextFile(scratch.path("syn", "canonical.jsonl"))
		await removePathIfPresent(scratch.path("syn"))

		const second = await runAdapter({
			adapter: make(),
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const secondJsonl = await readLocalTextFile(scratch.path("syn", "canonical.jsonl"))

		expect(firstJsonl).toBe(secondJsonl)
		expect(first.sha256).toBe(second.sha256)
	})

	it("keeps rejecting a duplicate of a held key after the dedup set stops growing", async () => {
		// The defect this pins: the membership test used to sit inside the not-exhausted branch,
		// so a row duplicating one of the first `dedupMaxSize` keys was written once the cap was reached.
		// A cap of 2 reaches exhaustion on the third distinct key.
		const adapter = makeAdapter({
			id: "cap",
			rows: [
				baseRow({ source_id: "cap-1", raw: "Paris" }),
				baseRow({ source_id: "cap-2", raw: "Lyon", components: { locality: "Lyon" } }),
				// The set reaches its limit with two keys.
				// It cannot add this third key.
				baseRow({ source_id: "cap-3", raw: "Nice", components: { locality: "Nice" } }),
				// A duplicate of a key the set holds.
				// It is still dropped.
				baseRow({ source_id: "cap-4", raw: "Paris" }),
				// A duplicate of the key first seen once the set had stopped growing.
				// The set never held it, so it is written.
				baseRow({ source_id: "cap-5", raw: "Nice", components: { locality: "Nice" } }),
			],
		})

		const manifest = await runAdapter({
			adapter,
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
			dedupMaxSize: 2,
		})

		expect(manifest.yielded).toBe(5)
		// The retained rows include Paris and Lyon.
		// Both Nice rows are also retained.
		// The duplicate Paris row is dropped.
		expect(manifest.written).toBe(4)
		expect(manifest.deduped).toBe(1)
		expect(manifest.dedup_exhausted_at_yielded).toBe(3)

		const rows = await Array.fromAsync(JSONSpliterator.fromAsync<CanonicalRow>(scratch.path("cap", "canonical.jsonl")))

		expect(rows.map((row) => row.source_id)).toEqual(["cap-1", "cap-2", "cap-3", "cap-5"])
	})

	it("records no exhaustion point for a run that stays under the cap", async () => {
		const adapter = makeAdapter({
			id: "under",
			rows: [baseRow({ source_id: "under-1", raw: "Paris" })],
		})

		const manifest = await runAdapter({
			adapter,
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.dedup_exhausted_at_yielded).toBeNull()
	})

	it("refuses a duplicate whose key arrives after the capped set would have filled", async () => {
		// The same five rows as the capped test.
		// The fingerprint table holds every key, so the second Nice is refused where the capped set wrote it.
		// Over `v0.7.0-de-holdout` that difference is 1,490,992 rows across `usgov-nad`, `ban` and `wof-admin`.
		const adapter = makeAdapter({
			id: "table",
			rows: [
				baseRow({ source_id: "t-1", raw: "Paris" }),
				baseRow({ source_id: "t-2", raw: "Lyon", components: { locality: "Lyon" } }),
				baseRow({ source_id: "t-3", raw: "Nice", components: { locality: "Nice" } }),
				baseRow({ source_id: "t-4", raw: "Paris" }),
				baseRow({ source_id: "t-5", raw: "Nice", components: { locality: "Nice" } }),
			],
		})

		const manifest = await runAdapter({
			adapter,
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
			// 2^10 slots, so the test allocates 16 KiB rather than the default 2.0 GiB.
			dedupSlotsLog2: 10,
		})

		expect(manifest.yielded).toBe(5)
		expect(manifest.written).toBe(3)
		expect(manifest.deduped).toBe(2)
		expect(manifest.dedup_store).toBe(DedupStore.FingerprintTable)
		expect(manifest.dedup_keys).toBe(3)
		// A table run never reaches a cap, so it records no exhaustion point.
		expect(manifest.dedup_exhausted_at_yielded).toBeNull()

		const rows = await Array.fromAsync(
			JSONSpliterator.fromAsync<CanonicalRow>(scratch.path("table", "canonical.jsonl"))
		)

		expect(rows.map((row) => row.source_id)).toEqual(["t-1", "t-2", "t-3"])
	})

	it("records which store held the keys, so two builds' duplicate counts are comparable", async () => {
		const rows = [baseRow({ source_id: "s-1", raw: "Paris" })]

		const table = await runAdapter({
			adapter: makeAdapter({ id: "store-table", rows }),
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
			dedupSlotsLog2: 10,
		})

		const set = await runAdapter({
			adapter: makeAdapter({ id: "store-set", rows }),
			adapterOptions: { inputPath: "ignored" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
			dedupMaxSize: 1000,
		})

		expect(table.dedup_store).toBe(DedupStore.FingerprintTable)
		expect(set.dedup_store).toBe(DedupStore.CappedSet)
		expect(table.dedup_keys).toBe(1)
		expect(set.dedup_keys).toBe(1)
	})
})

describe("FingerprintSet", () => {
	it("reports a key as new once and as held afterwards", () => {
		const set = new FingerprintSet(8)

		expect(set.add("Paris")).toBe(true)
		expect(set.add("Paris")).toBe(false)
		expect(set.add("Lyon")).toBe(true)
		expect(set.size).toBe(2)
	})

	it("holds more keys than a V8 Set accepts, which is why it exists", () => {
		const set = new FingerprintSet(18)

		for (let index = 0; index < 100_000; index++) {
			expect(set.add(`key-${index}`)).toBe(true)
		}

		expect(set.size).toBe(100_000)

		for (let index = 0; index < 100_000; index++) {
			expect(set.add(`key-${index}`)).toBe(false)
		}

		expect(set.size).toBe(100_000)
	})

	it("throws at the load limit rather than degrading into a long probe", () => {
		// 2^4 slots hold 11 keys at a load factor of 0.7.
		const set = new FingerprintSet(4)

		let added = 0

		expect(() => {
			for (let index = 0; index < 100; index++) {
				set.add(`key-${index}`)

				added++
			}
		}).toThrow(/reached the load limit/)

		expect(added).toBe(set.limit)
	})

	it("refuses a slot count outside 1..30 rather than allocating what the caller meant", () => {
		expect(() => new FingerprintSet(0)).toThrow(RangeError)
		expect(() => new FingerprintSet(31)).toThrow(RangeError)
		expect(() => new FingerprintSet(8.5)).toThrow(RangeError)
	})

	it("sizes its allocation from the slot count, outside the V8 heap", () => {
		expect(new FingerprintSet(10).bytes).toBe(2 ** 10 * 16)
		expect(new FingerprintSet(10).slots).toBe(1024)
	})
})
