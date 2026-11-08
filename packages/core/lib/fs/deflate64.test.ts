// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Inflates the method 9 member of `test/fixtures/zip/deflate64.zip` and compares it byte for byte with
 *   the source it was written from. The raw bytes come from yauzl with `decompress: false`, as the zip reader reads them.
 */

import { crc32 } from "node:zlib"

import { describe, expect, it } from "vitest"
import { open as openArchive } from "yauzl-promise"

import { inflateDeflate64 } from "#fs/deflate64"
import { resolvePackagePath } from "#module/resolvers"
import { DEFLATE64_FIXTURE_MEMBER, deflate64MemberBytes } from "#test/deflate64-fixture"

const ARCHIVE = resolvePackagePath("@mailwoman/core", "test", "fixtures", "zip", "deflate64.zip")

interface RawMember {
	method: number
	crc: number
	bytes: Buffer
}

async function readRawMember(): Promise<RawMember> {
	const archive = await openArchive(ARCHIVE)

	try {
		for await (const entry of archive) {
			if (entry.filename !== DEFLATE64_FIXTURE_MEMBER) continue

			const stream = await entry.openReadStream({ decompress: false })
			const parts: Buffer[] = []

			for await (const part of stream) {
				parts.push(part as Buffer)
			}

			return { method: entry.compressionMethod, crc: entry.crc32, bytes: Buffer.concat(parts) }
		}
	} finally {
		await archive.close()
	}

	throw new Error(`${DEFLATE64_FIXTURE_MEMBER} is missing from ${ARCHIVE}`)
}

async function* streamInSpans(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
	for (let offset = 0; offset < bytes.length; offset += size) {
		yield bytes.subarray(offset, offset + size)
	}
}

async function inflateAll(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
	const parts: Uint8Array[] = []

	for await (const part of inflateDeflate64(source)) {
		parts.push(part)
	}

	return Buffer.concat(parts)
}

describe("inflateDeflate64", () => {
	it("reads a fixture member that is compressed with Deflate64", async () => {
		const { method } = await readRawMember()

		expect(method).toBe(9)
	})

	it.each([1 << 20, 65_536, 4096, 7])("inflates the member byte for byte from %i-byte chunks", async (size) => {
		const { bytes, crc } = await readRawMember()
		const inflated = await inflateAll(streamInSpans(bytes, size))

		expect(Buffer.compare(inflated, Buffer.from(deflate64MemberBytes()))).toBe(0)
		expect(crc32(inflated)).toBe(crc)
	})

	it("refuses a stream that ends before its final block", async () => {
		const { bytes } = await readRawMember()

		await expect(inflateAll(streamInSpans(bytes.subarray(0, bytes.length >> 1), 4096))).rejects.toThrow(
			/before its final block/
		)
	})

	it("refuses a block type the format reserves", async () => {
		// BFINAL = 1 and BTYPE = 3.
		await expect(inflateAll(streamInSpans(Uint8Array.of(0b0000_0111, 0, 0, 0), 4))).rejects.toThrow(/invalid/)
	})

	it("lets a consumer stop after the first chunk", async () => {
		const { bytes } = await readRawMember()
		let first = 0

		// oxlint-disable-next-line no-unreachable-loop -- stopping after one chunk is the case under test.
		for await (const part of inflateDeflate64(streamInSpans(bytes, 4096))) {
			first = part.length

			break
		}

		expect(first).toBeGreaterThan(0)
	})
})
