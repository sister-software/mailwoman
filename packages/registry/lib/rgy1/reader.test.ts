// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { Artifact, RGY1Error } from "#rgy1/reader"
import { SectionKind } from "#rgy1/sections.generated"
import { BitsetView, StringPoolView } from "#rgy1/views"

async function fixture(name: string): Promise<Uint8Array> {
	return new Uint8Array(
		await readLocalBuffer(workspacePath("registry", "test", "fixtures", "artifacts", `${name}.rgy1`))
	)
}

function corrupted(bytes: Uint8Array, mutate: (copy: Uint8Array, view: DataView) => void): Uint8Array {
	const copy = new Uint8Array(bytes)

	mutate(copy, new DataView(copy.buffer))

	return copy
}

const code = (bytes: Uint8Array): string => {
	try {
		Artifact.parse(bytes)

		return "ok"
	} catch (error) {
		if (error instanceof RGY1Error) return error.code

		throw error
	}
}

describe("Artifact.parse", () => {
	it("accepts the fixture collision artifact and reads its header", async () => {
		const artifact = Artifact.parse(await fixture("country-airport-collision"))

		expect(artifact.header.artifact).toBe("country-airport-collision")
		expect(artifact.header.profile).toBe("fixture-synthetic")
		expect(artifact.sections).toHaveLength(1)
		expect(artifact.sections[0]).toMatchObject({ kind: SectionKind.BITSET, count: 17_576, length: 2197, aux: 3 })
	})

	it("behaves the same over a subarray with a non-zero byteOffset", async () => {
		const bytes = await fixture("country-airport-collision")
		const shifted = new Uint8Array(bytes.byteLength + 5)

		shifted.set(bytes, 5)

		const direct = BitsetView.of(Artifact.parse(bytes))
		const offset = BitsetView.of(Artifact.parse(shifted.subarray(5)))

		expect(offset.contains("AUS")).toBe(true)
		expect(offset.size).toBe(direct.size)
	})

	it.each([
		["magic", (copy: Uint8Array) => void (copy[0] = 0x50)],
		["version", (_: Uint8Array, view: DataView) => view.setUint16(4, 2, true)],
		["flags", (_: Uint8Array, view: DataView) => view.setUint16(6, 1, true)],
		["reserved", (_: Uint8Array, view: DataView) => view.setUint32(28, 1, true)],
		["header-utf8", (copy: Uint8Array) => void (copy[32] = 0xff)],
		["layout", (_: Uint8Array, view: DataView) => view.setUint32(16, view.getUint32(16, true) + 8, true)],
	])("refuses a corrupted envelope with code %s", async (expected, mutate) => {
		expect(code(corrupted(await fixture("country-airport-collision"), mutate))).toBe(expected)
	})

	it("refuses a truncated or padded artifact", async () => {
		const bytes = await fixture("country-airport-collision")

		expect(code(bytes.subarray(0, 16))).toBe("truncated")
		expect(code(bytes.subarray(0, bytes.byteLength - 1))).toBe("length")
	})

	it.each([
		["unknown-required-kind", 0, (view: DataView, at: number) => view.setUint16(at, 99, true)],
		["encoding", 0, (view: DataView, at: number) => view.setUint16(at + 2, 7, true)],
		["count", 0, (view: DataView, at: number) => view.setUint32(at + 16, 0, true)],
		[
			"section-bounds",
			0,
			(view: DataView, at: number) => view.setUint32(at + 8, view.getUint32(at + 8, true) + 1, true),
		],
	])("refuses a corrupted directory with code %s", async (expected, entry, mutate) => {
		const bytes = await fixture("country-airport-collision")
		const directory = new DataView(bytes.buffer, bytes.byteOffset).getUint32(16, true)

		expect(code(corrupted(bytes, (_, view) => mutate(view, directory + entry * 24)))).toBe(expected)
	})

	it("skips an unknown optional kind and refuses it when required", async () => {
		const bytes = await fixture("country-airport-collision")
		const directory = new DataView(bytes.buffer, bytes.byteOffset).getUint32(16, true)

		const optional = corrupted(bytes, (_, view) => {
			view.setUint16(directory, 99, true)
			view.setUint16(directory + 6, 0, true)
		})

		expect(Artifact.parse(optional).sections[0]!.kind).toBe(99)
	})

	it("refuses string offsets that end past the pool", async () => {
		const bytes = await fixture("iso3166-1-records")
		const artifact = Artifact.parse(bytes)
		const offsets = artifact.firstSection(SectionKind.STRING_OFFSETS)!
		const broken = corrupted(bytes, (_, view) => view.setUint32(offsets.offset + (offsets.count - 1) * 4, 1, true))

		expect(() => StringPoolView.of(Artifact.parse(broken))).toThrow(/offsets/)
	})
})
