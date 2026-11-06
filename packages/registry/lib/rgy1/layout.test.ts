/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Walks the committed fixture artifacts with a reader written from docs/rgy1.md and no other source, against
 *   test/fixtures/layout.json, so the writer and `Artifact.parse` agreeing with each other is never the only check.
 */

import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

interface Expectation {
	magic?: string
	version?: number
	flags?: number
	sectionCount: number
	sections?: Array<{
		kind: number
		encoding: number
		elementWidth: number
		flags: number
		length: number
		count: number
		aux: number
	}>
	kinds?: number[]
	idTables?: Array<{ aux: number; elementWidth: number; count: number }>
	bitsSet?: number[]
	bitsClear?: number[]
	popcount?: number
	rows?: number
	firstString?: string
	relationOffsetsCount?: number
	relationTargets?: number
}

const align8 = (value: number): number => Math.ceil(value / 8) * 8

/**
 * The spec's envelope and directory, read by byte position from the layout document's tables.
 */
function walk(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const headerLength = view.getUint32(8, true)
	const sectionCount = view.getUint32(12, true)
	const directory = view.getUint32(16, true)
	const firstPayload = view.getUint32(24, true)

	const sections = Array.from({ length: sectionCount }, (_, index) => {
		const at = directory + index * 24

		return {
			kind: view.getUint16(at, true),
			encoding: view.getUint16(at + 2, true),
			elementWidth: view.getUint16(at + 4, true),
			flags: view.getUint16(at + 6, true),
			offset: view.getUint32(at + 8, true),
			length: view.getUint32(at + 12, true),
			count: view.getUint32(at + 16, true),
			aux: view.getUint32(at + 20, true),
		}
	})

	return {
		magic: String.fromCharCode(...bytes.subarray(0, 4)),
		version: view.getUint16(4, true),
		flags: view.getUint16(6, true),
		headerLength,
		sectionCount,
		directory,
		total: view.getUint32(20, true),
		firstPayload,
		reserved: view.getUint32(28, true),
		header: parseJSONStrict<Record<string, unknown>>(new TextDecoder().decode(bytes.subarray(32, 32 + headerLength))),
		sections,
		view,
	}
}

const expectations = await readLocalJSONFile<Record<string, Expectation>>(
	workspacePath("registry", "test", "fixtures", "layout.json")
)

describe("RGY1 layout", () => {
	for (const [name, expected] of Object.entries(expectations)) {
		if (name.startsWith("$")) continue

		it(`${name} follows the layout document`, async () => {
			const bytes = new Uint8Array(
				await readLocalBuffer(workspacePath("registry", "test", "fixtures", "artifacts", `${name}.rgy1`))
			)
			const walked = walk(bytes)

			expect(walked.magic).toBe(expected.magic ?? "RGY1")
			expect(walked.version).toBe(expected.version ?? 1)
			expect(walked.flags).toBe(expected.flags ?? 0)
			expect(walked.reserved).toBe(0)
			expect(walked.total).toBe(bytes.byteLength)
			expect(walked.total % 8).toBe(0)
			expect(walked.directory).toBe(align8(32 + walked.headerLength))
			expect(walked.firstPayload).toBe(align8(walked.directory + walked.sectionCount * 24))
			expect(walked.sectionCount).toBe(expected.sectionCount)
			expect(walked.header["artifact"]).toBe(name)
			expect(walked.header["profile"]).toBe("fixture-synthetic")
			expect(Object.keys(walked.header)).toEqual(Object.keys(walked.header).toSorted())

			let cursor = walked.firstPayload

			for (const section of walked.sections) {
				expect(section.offset % 8).toBe(0)
				expect(section.offset).toBeGreaterThanOrEqual(cursor)
				cursor = section.offset + section.length
			}

			expect(bytes.byteLength - cursor).toBeLessThan(8)

			if (expected.sections) {
				expect(walked.sections.map(({ offset: _offset, ...rest }) => rest)).toEqual(expected.sections)
			}

			if (expected.kinds) {
				expect(walked.sections.map((section) => section.kind)).toEqual(expected.kinds)
			}

			if (expected.idTables) {
				const tables = walked.sections.filter((section) => section.kind === 2)

				expect(tables.map(({ aux, elementWidth, count }) => ({ aux, elementWidth, count }))).toEqual(expected.idTables)
			}

			const bitset = walked.sections.find((section) => section.kind === 1)

			if (bitset) {
				const bit = (key: number): number => (bytes[bitset.offset + (key >> 3)]! >> (key & 7)) & 1

				for (const key of expected.bitsSet ?? []) {
					expect(bit(key), `bit ${key} set`).toBe(1)
				}

				for (const key of expected.bitsClear ?? []) {
					expect(bit(key), `bit ${key} clear`).toBe(0)
				}

				if (expected.popcount != null) {
					let count = 0

					for (let at = bitset.offset; at < bitset.offset + bitset.length; at++) {
						for (let value = bytes[at]!; value; value >>= 1) {
							count += value & 1
						}
					}

					expect(count).toBe(expected.popcount)
				}
			}

			if (expected.rows != null) {
				for (const column of walked.sections.filter((section) => section.kind === 5)) {
					expect(column.count).toBe(expected.rows)
				}

				expect(walked.header["rows"]).toBe(expected.rows)
			}

			if (expected.firstString != null) {
				const offsets = walked.sections.find((section) => section.kind === 3)!
				const utf8 = walked.sections.find((section) => section.kind === 4)!
				const start = walked.view.getUint32(offsets.offset, true)
				const end = walked.view.getUint32(offsets.offset + 4, true)

				expect(new TextDecoder().decode(bytes.subarray(utf8.offset + start, utf8.offset + end))).toBe(
					expected.firstString
				)
				expect(walked.view.getUint32(offsets.offset + (offsets.count - 1) * 4, true)).toBe(utf8.length)
			}

			if (expected.relationOffsetsCount != null) {
				const offsets = walked.sections.find((section) => section.kind === 6)!
				const targets = walked.sections.find((section) => section.kind === 7)!

				expect(offsets.count).toBe(expected.relationOffsetsCount)
				expect(targets.count).toBe(expected.relationTargets)
				expect(walked.view.getUint32(offsets.offset + (offsets.count - 1) * 4, true)).toBe(targets.count)
			}
		})
	}
})
