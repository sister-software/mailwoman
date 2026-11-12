// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The RGY1 section kinds.
 *
 *   Generated from definitions/sections.json by tools/generate-sections.run.ts.
 *   Edit the definition rather than this file.
 */

/**
 * The four ASCII bytes an artifact starts with.
 */
export const RGY1_MAGIC = "RGY1"

/**
 * The envelope version this reader implements.
 */
export const RGY1_VERSION = 1

/**
 * The byte offset of the header JSON, after the fixed envelope fields.
 */
export const RGY1_HEADER_OFFSET = 32

/**
 * The byte length of one directory entry.
 */
export const RGY1_DIRECTORY_ENTRY_BYTES = 24

/**
 * The alignment of the directory and of every section payload.
 */
export const RGY1_ALIGNMENT = 8

/**
 * The section flag bit that marks a section required for interpretation.
 */
export const RGY1_FLAG_REQUIRED = 1

/**
 * Each section kind's identifier, as the directory entry stores it.
 */
export const SectionKind = {
	BITSET: 1,
	ID_TABLE: 2,
	STRING_OFFSETS: 3,
	UTF8: 4,
	COLUMN: 5,
	RELATION_OFFSETS: 6,
	RELATION_TARGETS: 7,
} as const

export type SectionKind = (typeof SectionKind)[keyof typeof SectionKind]

/**
 * The encoding version each kind is written with.
 */
export const SECTION_ENCODING: Readonly<Record<SectionKind, number>> = {
	[SectionKind.BITSET]: 1,
	[SectionKind.ID_TABLE]: 1,
	[SectionKind.STRING_OFFSETS]: 1,
	[SectionKind.UTF8]: 1,
	[SectionKind.COLUMN]: 1,
	[SectionKind.RELATION_OFFSETS]: 1,
	[SectionKind.RELATION_TARGETS]: 1,
}

/**
 * Each kind's name, for diagnostics.
 */
export const SECTION_NAME: Readonly<Record<SectionKind, string>> = {
	[SectionKind.BITSET]: "bitset",
	[SectionKind.ID_TABLE]: "id-table",
	[SectionKind.STRING_OFFSETS]: "string-offsets",
	[SectionKind.UTF8]: "utf8",
	[SectionKind.COLUMN]: "column",
	[SectionKind.RELATION_OFFSETS]: "relation-offsets",
	[SectionKind.RELATION_TARGETS]: "relation-targets",
}
