/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file The streaming zip readers' two contracts that nothing else checks: a consumer may stop early, and a member name
 *   the archive never declared an encoding for can still be read.
 *
 *   Both were broken. Stopping early raised `Cannot close while reading in progress` from yauzl, because the archive was
 *   closed while its member stream had not finished tearing down — and `readZipEntry`'s own docstring promised a `take`
 *   and a `break` worked. The recipes that pipe a member into a row-limited spliterator (`locale.ts`, `scaffold.ts`,
 *   `po-box-cedex.ts`) take exactly that path whenever the limit is reached before the member ends.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { listZipEntries, readZipEntry } from "@mailwoman/core/fs/zip"
import { mulberry32 } from "@mailwoman/core/random"
import ADMZip from "adm-zip"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Big and INCOMPRESSIBLE. A member that inflates in one pass is already finished when the consumer breaks, and yauzl
 * has released its read — such a fixture passes whether or not the disposal waits, which is what a 400 KB run of one
 * repeated character did. Random bytes keep the stream genuinely open across the break.
 */
const BIG = incompressibleBytes(12 * 1024 * 1024)

function incompressibleBytes(size: number): Buffer {
	const next = mulberry32(20_260_910)
	const bytes = Buffer.allocUnsafe(size)

	for (let index = 0; index < size; index += 1) {
		bytes[index] = Math.floor(next() * 256)
	}

	return bytes
}

let directory: TemporaryDirectory
let archivePath: string

beforeAll(async () => {
	directory = await temporaryDirectory("zip-reader-")

	const zip = new ADMZip()

	zip.addFile("big.bin", BIG)
	zip.addFile("small.txt", Buffer.from("hello"))
	archivePath = String(directory.resolve("probe.zip"))
	zip.writeZip(archivePath)
})

afterAll(async () => {
	await directory[Symbol.asyncDispose]()
})

describe("readZipEntry", () => {
	it("lets a consumer stop before the member ends", async () => {
		let first = 0

		// oxlint-disable-next-line no-unreachable-loop -- stopping after one chunk IS the case under test.
		for await (const chunk of readZipEntry(archivePath, "big.bin")) {
			first = chunk.length

			break
		}

		expect(first).toBeGreaterThan(0)
	})

	it("reads a member to its end", async () => {
		let total = 0

		for await (const chunk of readZipEntry(archivePath, "big.bin")) {
			total += chunk.length
		}

		expect(total).toBe(BIG.length)
	})

	it("reads a second member after one was abandoned, so the archive was really closed", async () => {
		// oxlint-disable-next-line no-unreachable-loop -- abandoning the first member IS the setup under test.
		for await (const _chunk of readZipEntry(archivePath, "big.bin")) break

		let text = ""

		for await (const chunk of readZipEntry(archivePath, "small.txt")) {
			text += Buffer.from(chunk).toString()
		}

		expect(text).toBe("hello")
	})

	it("raises when no member matches", async () => {
		const read = async () => {
			// oxlint-disable-next-line no-unreachable-loop -- the generator raises before it can yield; the body never runs.
			for await (const _chunk of readZipEntry(archivePath, "absent.txt")) break
		}

		await expect(read()).rejects.toThrow(/absent\.txt/u)
	})
})

describe("listZipEntries", () => {
	it("reports every member without decompressing one", async () => {
		const entries = await listZipEntries(archivePath)

		expect(entries.map((entry) => entry.name).toSorted()).toEqual(["big.bin", "small.txt"])
		expect(entries.find((entry) => entry.name === "big.bin")?.uncompressedSize).toBe(BIG.length)
	})

	it("leaves an ASCII archive's names alone when an encoding is named", async () => {
		const entries = await listZipEntries(archivePath, { filenameEncoding: "euc-kr" })

		expect(entries.map((entry) => entry.name).toSorted()).toEqual(["big.bin", "small.txt"])
	})
})
