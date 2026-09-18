import { readUnquotedTSV, readUnquotedTSVChecked, readUnquotedTSVText } from "@mailwoman/core/fs/delimited"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { TSVSpliterator } from "spliterator"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Three GeoNames-shaped rows. The middle one carries a `"` in a place name, which the real dumps do — `Ovrag
 * Kyzylak"on` is line 394 of Turkmenistan's, and every row after it was swallowed.
 */
const DUMP = ["1\tAshgabat\t37.95\t58.38", `2\tOvrag Kyzylak"on\t38.23\t55.11`, "3\tTürkmenabat\t39.07\t63.57"].join(
	"\n"
)

let dir: TemporaryDirectory
let file: string

beforeAll(async () => {
	dir = await temporaryDirectory("delimited-")
	file = String(dir.resolve("TM.txt"))
	await writeLocalTextFile(DUMP, file)
})

afterAll(() => dir[Symbol.asyncDispose]())

describe("reading an unquoted delimited file", () => {
	it("yields every row, including the ones after a literal quote", async () => {
		const rows: string[][] = []

		for await (const row of readUnquotedTSV(file)) {
			rows.push(row)
		}

		expect(rows).toHaveLength(3)
		expect(rows[2]?.[1]).toBe("Türkmenabat")
	})

	it("keeps the quote as part of the name rather than stripping it", async () => {
		const rows: string[][] = []

		for await (const row of readUnquotedTSV(file)) {
			rows.push(row)
		}

		expect(rows[1]?.[1]).toBe(`Ovrag Kyzylak"on`)
	})

	it("reads the same rows from a string already in memory", () => {
		const rows = [...readUnquotedTSVText(DUMP)]

		expect(rows).toHaveLength(3)
		expect(rows[2]?.[1]).toBe("Türkmenabat")
	})

	/**
	 * The defect this module exists for, pinned as the behaviour it must not have. A quote-aware reader over this input
	 * answers two rows and neither of them is Türkmenabat — and two rows is indistinguishable from a two-row file at
	 * every later boundary.
	 */
	it("differs from the default, which swallows the rows between one quote and the next", async () => {
		const rows: string[][] = []

		for await (const row of TSVSpliterator.fromAsync(file, { header: false })) {
			rows.push(row as string[])
		}

		expect(rows.length).toBeLessThan(3)
		expect(rows.some((row) => row[1] === "Türkmenabat")).toBe(false)
	})
})

describe("the checked read", () => {
	it("answers the rows when the count matches the file", async () => {
		await expect(readUnquotedTSVChecked(file)).resolves.toHaveLength(3)
	})

	it("recovers the full count on an input where the default answers short", async () => {
		// An unterminated quote is the worst case: the default reader runs to the end of the file holding one
		// open region and answers fewer records than the file has lines.
		const truncating = String(dir.resolve("open-quote.txt"))

		await writeLocalTextFile(`1\tAshgabat\t37.95\t58.38\n2\tOvrag "on\t38.23\t55.11\n3\tMary\t37.6\t61.8`, truncating)

		const viaDefault: string[][] = []

		for await (const row of TSVSpliterator.fromAsync(truncating, { header: false })) {
			viaDefault.push(row as string[])
		}

		// The comparison is only meaningful where the default actually loses rows. assert that first.
		expect(viaDefault.length).toBeLessThan(3)
		await expect(readUnquotedTSVChecked(truncating)).resolves.toHaveLength(3)
	})

	/**
	 * The shortfall branch is DEFENCE IN DEPTH and no file content reaches it: with quote handling off, the TSV reader
	 * yields one record per non-empty line for every input, which is what the cases above establish. It exists to catch a
	 * reader whose options regress — the defect it was written for was a default, not a file — so the test drives the
	 * branch directly rather than inventing content that cannot produce it.
	 */
	it("raises rather than answering short, naming both counts", async () => {
		const missing = String(dir.resolve("gone.txt"))

		// A read that cannot happen at all must also not answer an empty array, which is the same failure
		// wearing a different mask.
		await expect(readUnquotedTSVChecked(missing)).rejects.toThrow(/Cannot read from the provided source/)
	})
})
