/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import {
	type CountryHoldout,
	defaultHoldouts,
	hashBucket,
	type HoldoutPolicy,
	splitForRow,
	splitRows,
	writeSplitManifests,
	writeSplitManifestsFromLabeledFiles,
} from "@mailwoman/corpus/utils/split"
import { TextSpliterator } from "spliterator"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

interface MinRow {
	source_id: string
	country: string
	corpus_version: string
	components: { region?: string; postcode?: string; locality?: string; street?: string; house_number?: string }
}

/**
 * A country's holdout as a policy object, with a bare array read as its region list — the same
 * reading `splitForRow` makes, so these assertions hold whichever form `defaultHoldouts` returns.
 */
const policyOf = (holdout: CountryHoldout | undefined): HoldoutPolicy =>
	Array.isArray(holdout) ? { regions: holdout } : ((holdout ?? {}) as HoldoutPolicy)

const regionsOf = (holdout: CountryHoldout | undefined): readonly string[] => policyOf(holdout).regions ?? []

/**
 * The fields these assertions read off a written `SPLIT_MANIFEST.json`.
 */
interface SplitManifestOnDisk {
	corpus_version: string
	counts: Record<string, number>
	holdouts: Record<string, string[]>
}

const row = (id: string, country: string, region?: string): MinRow => ({
	source_id: id,
	country,
	corpus_version: "0.1.0",
	components: region ? { region } : {},
})

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-split-")
})

afterEach(async () => {
	scratch[Symbol.asyncDispose]()
})

function splitTextIntoArray(text: string): string[] {
	return Array.from(TextSpliterator.from(text.trim()))
}

describe("hashBucket", () => {
	it("is deterministic", () => {
		expect(hashBucket("source-1", 2)).toBe(hashBucket("source-1", 2))
		expect(hashBucket("source-1", 10)).toBe(hashBucket("source-1", 10))
	})

	it("returns values in [0, n)", () => {
		for (let i = 0; i < 100; i++) {
			const b = hashBucket(`id-${i}`, 5)
			expect(b).toBeGreaterThanOrEqual(0)
			expect(b).toBeLessThan(5)
		}
	})

	it("distributes roughly evenly across buckets", () => {
		const counts = [0, 0, 0]

		for (let i = 0; i < 3000; i++) {
			counts[hashBucket(`id-${i}`, 3)]!++
		}

		for (const c of counts) {
			expect(c).toBeGreaterThan(800)
			expect(c).toBeLessThan(1200)
		}
	})
})

describe("splitRows — locality holdout", () => {
	it("Vermont rows go to val/test, others to train (US)", () => {
		const rows: MinRow[] = [
			row("us-1", "US", "Oregon"),
			row("us-2", "US", "Vermont"),
			row("us-3", "US", "Wyoming"),
			row("us-4", "US", "California"),
			row("us-5", "US", "North Dakota"),
			row("us-6", "US", "Texas"),
		]

		const m = splitRows(rows)
		expect(m.train).toEqual(expect.arrayContaining(["us-1", "us-4", "us-6"]))
		expect(m.train).not.toContain("us-2")
		expect(m.train).not.toContain("us-3")
		expect(m.train).not.toContain("us-5")
		const heldOut = [...m.val, ...m.test].toSorted()
		expect(heldOut).toEqual(["us-2", "us-3", "us-5"])
		expect(m.counts.total).toBe(6)
	})

	it("Corse / Lozère / Creuse rows go to val/test (FR)", () => {
		const rows: MinRow[] = [
			row("fr-1", "FR", "Île-de-France"),
			row("fr-2", "FR", "Corse"),
			row("fr-3", "FR", "Lozère"),
			row("fr-4", "FR", "Creuse"),
			row("fr-5", "FR", "Auvergne-Rhône-Alpes"),
		]

		const m = splitRows(rows)
		const heldOut = [...m.val, ...m.test].toSorted()
		expect(heldOut).toEqual(["fr-2", "fr-3", "fr-4"])
		expect(m.train).toEqual(expect.arrayContaining(["fr-1", "fr-5"]))
	})

	it("recognizes alpha-2 region codes in holdouts (VT / WY / ND)", () => {
		const rows: MinRow[] = [row("us-1", "US", "VT"), row("us-2", "US", "OR")]
		const m = splitRows(rows)
		expect([...m.val, ...m.test]).toEqual(["us-1"])
		expect(m.train).toEqual(["us-2"])
	})

	it("rows without a region land in train (no holdout match)", () => {
		const rows: MinRow[] = [row("us-1", "US")]
		const m = splitRows(rows)
		expect(m.train).toEqual(["us-1"])
	})

	it("custom holdouts override defaults", () => {
		const rows: MinRow[] = [row("us-1", "US", "Vermont"), row("us-2", "US", "California")]
		const m = splitRows(rows, { holdouts: { US: ["California"] } })
		expect(m.train).toEqual(["us-1"])
		expect([...m.val, ...m.test]).toEqual(["us-2"])
	})

	it("a held-out row's bucket is stable across reruns", () => {
		const rows: MinRow[] = [row("us-1", "US", "Vermont"), row("us-2", "US", "Vermont"), row("us-3", "US", "Wyoming")]
		const m1 = splitRows(rows)
		const m2 = splitRows(rows)

		expect(m1.val).toEqual(m2.val)
		expect(m1.test).toEqual(m2.test)
	})
})

describe("defaultHoldouts", () => {
	it("returns US + FR sets at minimum", () => {
		const d = defaultHoldouts()

		expect(d.US).toContain("Vermont")
		expect(d.US).toContain("Wyoming")
		expect(d.US).toContain("North Dakota")
		expect(regionsOf(d.FR)).toContain("Corse")
		expect(regionsOf(d.FR)).toContain("Creuse")
	})

	it("names the three French departments by postcode prefix as well as by region", () => {
		// The same three places, in the component BAN emits.
		// Corse 20, Creuse 23, Lozère 48.
		expect(policyOf(defaultHoldouts().FR).postcodePrefixes).toEqual(["20", "23", "48"])
	})

	it("names GB by postcode area, since 93.6% of its street rows carry no region", () => {
		// Measured on `v0.17.0-batch`: 825,083 GB street rows, 771,987 of them with no `region` component.
		// GB carried no entry at all before this, so both its splits held zero rows.
		const gb = policyOf(defaultHoldouts().GB)

		expect(gb.postcodePrefixes).toEqual(["TR", "LL", "HX"])
		expect(gb.regions).toEqual(["Cornwall"])
	})

	it("gives every GB prefix two letters, so one area cannot swallow another", () => {
		// `L` is Liverpool and `LL` is Llandudno.
		// A one-letter prefix matches by `startsWith`, so it would hold out both,
		// and the holdout would be larger than the one anybody reviewed.
		const prefixes = policyOf(defaultHoldouts().GB).postcodePrefixes ?? []

		for (const prefix of prefixes) {
			expect(prefix).toHaveLength(2)
		}

		for (const prefix of prefixes) {
			expect(prefixes.filter((other) => other !== prefix && prefix.startsWith(other))).toEqual([])
		}
	})
})

describe("the holdout predicate reaches a row whose source emits no region (#2353)", () => {
	/**
	 * BAN's shape: a street row carrying a postcode and a locality, and no region at
	 * all. 96.9% of FR train rows are this, and a region-only predicate holds out
	 * none of them however many departments it names.
	 */
	const banRow = (id: string, postcode: string): MinRow => ({
		source_id: id,
		country: "FR",
		corpus_version: "0.1.0",
		components: { postcode, locality: "Ajaccio", street: "Cours Napoléon", house_number: "12" },
	})

	it("holds out a BAN row whose postcode names a held-out department", () => {
		expect(splitForRow(banRow("ban-corse", "20000"))).not.toBe("train")
		expect(splitForRow(banRow("ban-creuse", "23000"))).not.toBe("train")
		expect(splitForRow(banRow("ban-lozere", "48000"))).not.toBe("train")
	})

	it("trains on a BAN row from any other department", () => {
		expect(splitForRow(banRow("ban-paris", "75001"))).toBe("train")
		expect(splitForRow(banRow("ban-lyon", "69001"))).toBe("train")
		// 02 is Aisne.
		// A prefix match reads the first two digits, so a leading zero stays distinct from 20.
		expect(splitForRow(banRow("ban-aisne", "02000"))).toBe("train")
	})

	it("still holds out a wof-admin row by its region, with no postcode present", () => {
		expect(splitForRow(row("wof-corse", "FR", "Corse"))).not.toBe("train")
	})

	it("reads a bare array as a region list, which is what every manifest built before this carries", () => {
		expect(splitForRow(row("us-vt", "US", "Vermont"), { US: ["Vermont"] })).not.toBe("train")
		expect(splitForRow(row("us-or", "US", "Oregon"), { US: ["Vermont"] })).toBe("train")
	})

	it("holds out a GB street row by its postcode area, and trains on every other area", () => {
		// The same shape as BAN's, in GB's components: a street row with a postcode and no region.
		const gbRow = (id: string, postcode: string): MinRow => ({
			source_id: id,
			country: "GB",
			corpus_version: "0.1.0",
			components: { postcode, locality: "Truro", street: "Lemon Street", house_number: "12" },
		})

		expect(splitForRow(gbRow("gb-truro", "TR1 2LS"))).not.toBe("train")
		expect(splitForRow(gbRow("gb-llandudno", "LL30 2NB"))).not.toBe("train")
		expect(splitForRow(gbRow("gb-halifax", "HX1 1UG"))).not.toBe("train")

		expect(splitForRow(gbRow("gb-london", "SW1A 1AA"))).toBe("train")
		expect(splitForRow(gbRow("gb-manchester", "M1 1AE"))).toBe("train")
		// Liverpool, which a one-letter `L` prefix would have taken along with Llandudno.
		expect(splitForRow(gbRow("gb-liverpool", "L1 8JQ"))).toBe("train")
	})

	it("holds out nothing for a country whose policy declares no matcher", () => {
		expect(splitForRow(banRow("ban-corse", "20000"), { FR: {} })).toBe("train")
	})

	it("matches a locality when one is declared", () => {
		expect(splitForRow(banRow("ban-ajaccio", "75001"), { FR: { localities: ["Ajaccio"] } })).not.toBe("train")
	})
})

describe("writeSplitManifests", () => {
	it("writes train/val/test txt files + SPLIT_MANIFEST.json", async () => {
		const m = splitRows([row("us-1", "US", "Vermont"), row("us-2", "US", "Oregon"), row("fr-1", "FR", "Corse")])
		await writeSplitManifests(m, scratch.path)

		const train = await readLocalTextFile(scratch.resolve("train.txt"))

		const summary = await readLocalJSONFile<SplitManifestOnDisk>(scratch.resolve("SPLIT_MANIFEST.json"))
		expect(train.trim()).toBe("us-2")
		expect(summary.counts.total).toBe(3)
		expect(summary.corpus_version).toBe("0.1.0")
		expect(summary.holdouts.US).toContain("Vermont")
	})

	it("manifests are sorted (diff-friendly) and reproducible", async () => {
		const rows: MinRow[] = [row("a", "US", "Oregon"), row("c", "US", "Oregon"), row("b", "US", "Oregon")]
		await writeSplitManifests(splitRows(rows), scratch.path)

		const first = await readLocalTextFile(scratch.resolve("train.txt"))

		await writeSplitManifests(splitRows(rows), scratch.path)

		const second = await readLocalTextFile(scratch.resolve("train.txt"))

		expect(first).toBe(second)
		expect(splitTextIntoArray(first)).toEqual(["a", "b", "c"])
	})
})

describe("splitForRow (pure per-row decision)", () => {
	it("matches splitRows for the same inputs", () => {
		const rows: MinRow[] = [
			row("us-1", "US", "Vermont"),
			row("us-2", "US", "Oregon"),
			row("us-3", "US", "Wyoming"),
			row("fr-1", "FR", "Corse"),
			row("fr-2", "FR", "Île-de-France"),
		]

		const manifest = splitRows(rows)

		for (const r of rows) {
			const split = splitForRow(r)

			if (split === "train") {
				expect(manifest.train).toContain(r.source_id)
			} else if (split === "val") {
				expect(manifest.val).toContain(r.source_id)
			} else {
				expect(manifest.test).toContain(r.source_id)
			}
		}
	})

	it("rows without a region land in train", () => {
		expect(splitForRow(row("us-1", "US"))).toBe("train")
	})

	it("custom holdouts override defaults", () => {
		expect(splitForRow(row("us-1", "US", "California"), { US: ["California"] })).not.toBe("train")
		expect(splitForRow(row("us-1", "US", "Vermont"), { US: ["California"] })).toBe("train")
	})
})

describe("writeSplitManifestsFromLabeledFiles (streaming)", () => {
	it("writes sorted train/val/test.txt + SPLIT_MANIFEST.json from per-split labeled JSONL", async () => {
		const labeledPaths = {
			train: scratch.resolve("labeled-train.jsonl"),
			val: scratch.resolve("labeled-val.jsonl"),
			test: scratch.resolve("labeled-test.jsonl"),
		}

		// Write per-split labeled files in non-sorted order to exercise the external sort.
		await writeLocalTextFile(
			['{"source_id":"us-c"}', '{"source_id":"us-a"}', '{"source_id":"us-b"}', ""].join("\n"),
			labeledPaths.train
		)

		await writeLocalTextFile(['{"source_id":"vt-2"}', '{"source_id":"vt-1"}', ""].join("\n"), labeledPaths.val)
		await writeLocalTextFile(['{"source_id":"wy-1"}', ""].join("\n"), labeledPaths.test)

		const counts = { train: 3, val: 2, test: 1 }

		const result = await writeSplitManifestsFromLabeledFiles({
			labeledPaths,
			outputDir: scratch.path,
			corpusVersion: "0.1.1",
			counts,
		})

		expect(result).toEqual({ train: 3, val: 2, test: 1, total: 6 })

		const train = await readLocalTextFile(scratch.resolve("train.txt"))

		expect(splitTextIntoArray(train)).toEqual(["us-a", "us-b", "us-c"])

		const val = await readLocalTextFile(scratch.resolve("val.txt"))

		expect(splitTextIntoArray(val)).toEqual(["vt-1", "vt-2"])

		const test = await readLocalTextFile(scratch.resolve("test.txt"))

		expect(test.trim()).toBe("wy-1")

		const summary = await readLocalJSONFile<SplitManifestOnDisk>(scratch.resolve("SPLIT_MANIFEST.json"))

		expect(summary).toMatchObject({
			corpus_version: "0.1.1",
			counts: { train: 3, val: 2, test: 1, total: 6 },
		})

		expect(summary.holdouts.US).toContain("Vermont")
	})

	it("handles an empty per-split file (no source_ids → empty .txt)", async () => {
		const labeledPaths = {
			train: scratch.resolve("labeled-train.jsonl"),
			val: scratch.resolve("labeled-val.jsonl"),
			test: scratch.resolve("labeled-test.jsonl"),
		}

		await writeLocalTextFile('{"source_id":"only-train"}\n', labeledPaths.train)
		await writeLocalTextFile("", labeledPaths.val)
		await writeLocalTextFile("", labeledPaths.test)

		await writeSplitManifestsFromLabeledFiles({
			labeledPaths,
			outputDir: scratch.path,
			corpusVersion: "0.1.1",
			counts: { train: 1, val: 0, test: 0 },
		})

		expect((await readLocalTextFile(scratch.resolve("val.txt"))).trim()).toBe("")
		expect((await readLocalTextFile(scratch.resolve("test.txt"))).trim()).toBe("")
		expect((await readLocalTextFile(scratch.resolve("train.txt"))).trim()).toBe("only-train")
	})
})
