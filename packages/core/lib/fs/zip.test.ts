/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file Tests two streaming zip reader behaviors. A consumer may stop early. A member name remains readable when the archive declares no encoding. Recipes that pipe members into row-limited spliterators (`locale.ts`, `scaffold.ts`, `po-box-cedex.ts`) use this path when the limit is reached first.
 */

import ADMZip from "adm-zip"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { readLocalBuffer, readLocalTextFile } from "#fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "#fs/temporary"
import { writeLocalFile } from "#fs/writers"
import { extractZipEntries, listZipEntries, memberPath, readZipEntry } from "#fs/zip"
import { mulberry32 } from "#random"

/**
 * Big and incompressible: a member that inflates in one pass is already finished
 * when the consumer breaks, so random bytes keep the stream open across the break.
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
let archivePath: PathBuilder

beforeAll(async () => {
	directory = await temporaryDirectory("zip-reader-")

	const zip = new ADMZip()

	zip.addFile("big.bin", BIG)
	zip.addFile("small.txt", Buffer.from("hello"))
	archivePath = directory.path("probe.zip")
	// adm-zip writes to a string path.
	zip.writeZip(archivePath.toString())
})

afterAll(async () => {
	await directory[Symbol.asyncDispose]()
})

describe("readZipEntry", () => {
	it("lets a consumer stop before the member ends", async () => {
		let first = 0

		// oxlint-disable-next-line no-unreachable-loop -- stopping after one chunk is the case under test.
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
		// oxlint-disable-next-line no-unreachable-loop -- abandoning the first member is the setup under test.
		for await (const _chunk of readZipEntry(archivePath, "big.bin")) break

		let text = ""

		for await (const chunk of readZipEntry(archivePath, "small.txt")) {
			text += Buffer.from(chunk).toString()
		}

		expect(text).toBe("hello")
	})

	it("raises when no member matches", async () => {
		const read = async () => {
			// oxlint-disable-next-line no-unreachable-loop -- the generator raises before it can yield. the body never runs.
			for await (const _chunk of readZipEntry(archivePath, "absent.txt")) break
		}

		await expect(read()).rejects.toThrow(/absent\.txt/u)
	})
})

/**
 * Writes an archive whose member names begin with `/`, the shape of OS Open Roads' GML archive.
 *
 * adm-zip strips a leading slash when it writes.
 * Each name is therefore written with a placeholder first byte, and the placeholder is
 * then replaced in the local and central headers.
 *
 * The name length is unchanged, so every offset in the archive still holds.
 */
async function writeArchiveWithNames(path: PathBuilder, members: Record<string, string>): Promise<void> {
	const zip = new ADMZip()

	for (const [name, content] of Object.entries(members)) {
		zip.addFile(name.replace(/^[/.]/u, "X"), Buffer.from(content))
	}

	let bytes = zip.toBuffer().toString("latin1")

	for (const name of Object.keys(members)) {
		bytes = bytes.replaceAll(name.replace(/^[/.]/u, "X"), name)
	}

	await writeLocalFile(Buffer.from(bytes, "latin1"), path)
}

describe("memberPath", () => {
	it("removes leading slashes and turns backslashes into slashes", () => {
		expect(memberPath("/data/OSOpenRoads_HP.gml")).toBe("data/OSOpenRoads_HP.gml")
		expect(memberPath("//readme.txt")).toBe("readme.txt")
		expect(memberPath("doc\\licence.txt")).toBe("doc/licence.txt")
	})

	it("refuses a name that would leave the extraction directory", () => {
		expect(() => memberPath("../evil.txt")).toThrow(/\.\. segment/u)
		expect(() => memberPath("/data/../../evil.txt")).toThrow(/\.\. segment/u)
		expect(() => memberPath("C:/evil.txt")).toThrow(/names a drive/u)
	})
})

describe("extractZipEntries", () => {
	it("extracts members named from the archive root, as OS Open Roads names them", async () => {
		const archive = directory.path("rooted.zip")
		const destination = directory.path("rooted")

		await writeArchiveWithNames(archive, {
			"/readme.txt": "readme",
			"/doc/licence.txt": "ogl",
			"data/OSOpenRoads_HP.gml": "<gml/>",
		})

		const written = await extractZipEntries(archive, destination)

		expect(written.toSorted()).toEqual(["data/OSOpenRoads_HP.gml", "doc/licence.txt", "readme.txt"])
		await expect(readLocalTextFile(destination("readme.txt"))).resolves.toBe("readme")
		await expect(readLocalTextFile(destination("doc", "licence.txt"))).resolves.toBe("ogl")
		await expect(readLocalTextFile(destination("data", "OSOpenRoads_HP.gml"))).resolves.toBe("<gml/>")
	})

	it("refuses a member with a .. segment and writes nothing outside the destination", async () => {
		const archive = directory.path("escape.zip")
		const destination = directory.path("escape", "inner")

		await writeArchiveWithNames(archive, { "../evil.txt": "evil" })

		const bytes = await readLocalBuffer(archive)

		expect(bytes.indexOf("../evil.txt")).toBeGreaterThanOrEqual(0)
		await expect(extractZipEntries(archive, destination)).rejects.toThrow(/\.\. segment/u)
		await expect(readLocalTextFile(directory.path("escape", "evil.txt"))).rejects.toThrow(/ENOENT/u)
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
