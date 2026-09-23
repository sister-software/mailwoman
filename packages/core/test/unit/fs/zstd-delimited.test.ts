/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reading a delimited file that is compressed at rest must be indistinguishable from reading one
 *   that is not — that equivalence is the whole basis for storing the corpus as `.zst`.
 */

import { unzstd, zstd } from "@mailwoman/core/fs/compression"
import { delimitedSource, preferCompressed, ZSTD_EXTENSION } from "@mailwoman/core/fs/delimited"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePath } from "path-ts"
import { JSONSpliterator, TextSpliterator } from "spliterator"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

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

beforeAll(async () => {
	scratch = await temporaryDirectory("zstd-delimited-")
	plain = String(resolvePath(scratch.path, "part-0000.jsonl"))
	compressed = `${plain}${ZSTD_EXTENSION}`

	const text = ROWS.map((row) => stringifyJSON(row)).join("\n") + "\n"

	await writeLocalTextFile(text, plain)
	await writeLocalFile(zstd(text), compressed)
})

afterAll(async () => {
	await scratch[Symbol.asyncDispose]()
})

describe("delimitedSource", () => {
	it("returns an uncompressed path untouched, so the spliterator does its own segmented open", () => {
		expect(delimitedSource(plain)).toBe(plain)
	})

	it("returns a stream for a .zst path", () => {
		const source = delimitedSource(compressed)

		expect(typeof source).not.toBe("string")
		expect(typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]).toBe("function")
	})

	it("reads the same rows compressed as uncompressed", async () => {
		const read = async (path: string) => {
			const out: Row[] = []

			for await (const row of JSONSpliterator.fromAsync<Row>(delimitedSource(path))) {
				out.push(row)
			}

			return out
		}

		const fromPlain = await read(plain)
		const fromCompressed = await read(compressed)

		expect(fromPlain).toHaveLength(ROWS.length)
		expect(fromCompressed).toEqual(fromPlain)
	})

	it("streams text rows from a compressed source too", async () => {
		let lines = 0

		for await (const _line of TextSpliterator.fromAsync(delimitedSource(compressed))) {
			lines++
		}

		expect(lines).toBe(ROWS.length)
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

describe("the count-then-read shape", () => {
	// `readUnquotedTSVChecked` counts a file and then reads it, passing the same path twice.
	// With a path each pass opens independently; with one hoisted stream the second pass sees
	// an exhausted iterator and reads nothing, which that function reports as swallowed rows.
	it("survives two sequential passes when the source is built per call", async () => {
		const count = async (path: string) => {
			let n = 0

			for await (const _ of TextSpliterator.fromAsync(delimitedSource(path))) {
				n++
			}

			return n
		}

		expect(await count(compressed)).toBe(ROWS.length)
		expect(await count(compressed)).toBe(ROWS.length)
	})

	it("demonstrates why a hoisted stream must not be reused", async () => {
		const hoisted = delimitedSource(compressed)

		let first = 0

		for await (const _ of TextSpliterator.fromAsync(hoisted)) {
			first++
		}

		let second = 0

		for await (const _ of TextSpliterator.fromAsync(hoisted)) {
			second++
		}

		expect(first).toBe(ROWS.length)
		expect(second).toBe(0)
	})
})

describe("preferCompressed", () => {
	it("answers with the .zst sibling when one exists", async () => {
		expect(String(await preferCompressed(plain))).toBe(compressed)
	})

	it("answers with the plain path when no sibling exists", async () => {
		const absent = String(resolvePath(scratch.path, "no-such-part.jsonl"))

		expect(String(await preferCompressed(absent))).toBe(absent)
	})

	it("is idempotent on a path that is already compressed", async () => {
		expect(String(await preferCompressed(compressed))).toBe(compressed)
	})

	it("closes the loop: ask for the plain name, read the compressed rows", async () => {
		const rows: Row[] = []

		for await (const row of JSONSpliterator.fromAsync<Row>(delimitedSource(await preferCompressed(plain)))) {
			rows.push(row)
		}

		expect(rows).toHaveLength(ROWS.length)
	})
})
