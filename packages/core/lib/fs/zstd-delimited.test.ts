/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The reader must return the same rows for compressed and uncompressed delimited files. This lets the corpus be stored as `.zst`.
 *   spliterator decompresses by magic bytes and reads `part.jsonl.zst` when asked for `part.jsonl`, so a path is the
 *   whole source description. These tests pin the behavior the corpus build depends on.
 */

import { resolvePath } from "path-ts"
import { JSONSpliterator, TextSpliterator } from "spliterator"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { unzstd, zstd } from "#fs/compression"
import { temporaryDirectory, type TemporaryDirectory } from "#fs/temporary"
import { writeLocalFile, writeLocalTextFile } from "#fs/writers"
import { stringifyJSON } from "#json"

interface Row {
	street: string
	postcode: string
	locality: string
}

const ROWS: Row[] = Array.from({ length: 5000 }, (_, i) => ({
	street: "AVENIDA URUGUAI",
	postcode: "96255-000",
	locality: i % 2 ? "Chuí" : "Santa Vitória do Palmar",
}))

let scratch: TemporaryDirectory
let plain = ""
let compressed = ""
let onlyCompressed = ""

beforeAll(async () => {
	scratch = await temporaryDirectory("zstd-delimited-")
	plain = resolvePath(scratch.path, "part-0000.jsonl")
	compressed = `${plain}.zst`
	onlyCompressed = resolvePath(scratch.path, "part-0001.jsonl")

	const text = ROWS.map((row) => stringifyJSON(row)).join("\n") + "\n"

	await writeLocalTextFile(text, plain)
	await writeLocalFile(zstd(text), compressed)
	await writeLocalFile(zstd(text), `${onlyCompressed}.zst`)
})

afterAll(async () => {
	await scratch[Symbol.asyncDispose]()
})

const readRows = (path: string, init?: { preferCompressed?: boolean }) =>
	JSONSpliterator.fromAsync<Row>(path, init).toArray()

describe("a compressed corpus part", () => {
	it("reads the same rows compressed as uncompressed", async () => {
		const fromPlain = await readRows(plain, { preferCompressed: false })
		const fromCompressed = await readRows(compressed)

		expect(fromPlain).toHaveLength(ROWS.length)
		expect(fromCompressed).toEqual(fromPlain)
	})

	it("streams text rows from a compressed source too", async () => {
		await expect(TextSpliterator.countAsync(compressed)).resolves.toBe(ROWS.length)
	})

	// A two-pass reader such as `readUnquotedTSVChecked` counts a file and then reads it.
	// Each pass reopens the path, so a compressed file reads in full both times.
	it("survives two sequential passes", async () => {
		await expect(TextSpliterator.countAsync(compressed)).resolves.toBe(ROWS.length)
		await expect(readRows(compressed)).resolves.toHaveLength(ROWS.length)
	})
})

describe("the compressed-sibling lookup", () => {
	it("reads the .zst sibling of a plain name that has not been written", async () => {
		await expect(readRows(onlyCompressed)).resolves.toEqual(ROWS)
	})

	it("prefers the .zst sibling over the plain file", async () => {
		// Both copies hold the same rows here, so the read cannot tell them apart.
		// The opt-out proves the plain file is readable on its own and the default does not depend on it.
		await expect(readRows(plain)).resolves.toEqual(ROWS)
		await expect(readRows(plain, { preferCompressed: false })).resolves.toEqual(ROWS)
	})
})

describe("zstd round-trip", () => {
	it("restores the exact bytes", () => {
		const payload = new TextEncoder().encode(ROWS.map((r) => stringifyJSON(r)).join("\n"))

		expect(unzstd(zstd(payload))).toEqual(payload)
	})

	it("actually compresses repetitive corpus rows", () => {
		const payload = new TextEncoder().encode(ROWS.map((r) => stringifyJSON(r)).join("\n"))

		expect(zstd(payload).byteLength).toBeLessThan(payload.byteLength / 10)
	})
})
