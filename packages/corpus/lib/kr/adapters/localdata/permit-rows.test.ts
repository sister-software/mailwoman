/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { expect, test } from "vitest"

import { readPermitFile } from "#kr/adapters/localdata/permit-rows"

const FIXTURE = resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "kr", "permits-fixture.csv.b64")
const COMMA = 0x2c
const NEWLINE = 0x0a

/**
 * The cp949 fixture with its first data row's X coordinate replaced by `replacement`.
 *
 * cp949's trail bytes never take the comma's or the newline's value, so the bytes split on them directly.
 */
async function withFirstX(replacement: string): Promise<Buffer> {
	const bytes = Buffer.from((await readLocalTextFile(FIXTURE)).trim(), "base64")
	const lines: Buffer[] = []

	for (let start = 0; start < bytes.length;) {
		const end = bytes.indexOf(NEWLINE, start)
		const stop = end === -1 ? bytes.length : end + 1

		lines.push(bytes.subarray(start, stop))
		start = stop
	}

	const header = new TextDecoder("euc-kr").decode(lines[0]).split(",")
	const column = header.findIndex((name) => /^좌표정보\(x\)$/iu.test(name.trim()))

	expect(column).toBeGreaterThan(-1)

	const fields: Buffer[] = []
	const row = lines[1]!

	for (let start = 0; start <= row.length;) {
		const end = row.indexOf(COMMA, start)
		const stop = end === -1 ? row.length : end

		fields.push(row.subarray(start, stop))
		start = stop + 1
	}

	fields[column] = Buffer.from(replacement, "latin1")

	const rebuilt = Buffer.concat(fields.flatMap((field, index) => (index ? [Buffer.from([COMMA]), field] : [field])))

	return Buffer.concat([lines[0]!, rebuilt, ...lines.slice(2)])
}

test("a coordinate written with a thousands separator raises, naming the field and file", async () => {
	await using scratch = await temporaryDirectory("mailwoman-kr-permits-")
	const path = scratch.path("일반음식점.csv")

	await writeLocalBuffer(await withFirstX('"198,000"'), path)

	const read = async () => {
		for await (const _ of readPermitFile(path, { statuses: [] })) {
			// The first row raises.
		}
	}

	await expect(read()).rejects.toThrow(/좌표정보\(X\) in .*일반음식점\.csv is "198,000", not a number/u)
})

test("an empty coordinate reads as absent", async () => {
	await using scratch = await temporaryDirectory("mailwoman-kr-permits-")
	const path = scratch.path("일반음식점.csv")

	await writeLocalBuffer(await withFirstX(""), path)

	const first = await readPermitFile(path, { statuses: [] }).next()

	expect(first.value?.x).toBeNull()
})
