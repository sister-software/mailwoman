// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { RGY1_HEADER_OFFSET, RGY1_MAGIC, RGY1_VERSION, SECTION_ENCODING, SectionKind } from "#rgy1/sections.generated"

interface Definitions {
	envelope: { magic: string; version: number; headerOffset: number }
	kinds: Array<{ id: number; name: string; encoding: number }>
}

describe("section definitions", () => {
	it("match definitions/sections.json in TypeScript", async () => {
		const definitions = await readLocalJSONFile<Definitions>(workspacePath("registry", "definitions", "sections.json"))

		expect(RGY1_MAGIC).toBe(definitions.envelope.magic)
		expect(RGY1_VERSION).toBe(definitions.envelope.version)
		expect(RGY1_HEADER_OFFSET).toBe(definitions.envelope.headerOffset)
		expect(Object.values(SectionKind).toSorted((a, b) => a - b)).toEqual(definitions.kinds.map((kind) => kind.id))

		for (const kind of definitions.kinds) {
			expect(SECTION_ENCODING[kind.id as SectionKind]).toBe(kind.encoding)
		}
	})

	it("match definitions/sections.json in Rust", async () => {
		const definitions = await readLocalJSONFile<Definitions>(workspacePath("registry", "definitions", "sections.json"))
		const rust = await readLocalTextFile(workspacePath("registry", "crates", "registry-core", "src", "sections.rs"))

		for (const kind of definitions.kinds) {
			const constant = kind.name.toUpperCase().replaceAll("-", "_")

			expect(rust).toContain(`pub const KIND_${constant}: u16 = ${kind.id};`)
			expect(rust).toContain(`KIND_${constant} => Some(${kind.encoding}),`)
		}

		expect(rust).toContain(`pub const VERSION: u16 = ${definitions.envelope.version};`)
	})
})
