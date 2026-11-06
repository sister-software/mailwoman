// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes the section-kind constants TypeScript and Rust share from `definitions/sections.json`.
 *
 *   Usage: `node packages/registry/tools/generate-sections.run.ts [--check]`
 *
 *   `--check` exits non-zero when either generated file differs from what the definition produces.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

interface SectionDefinitions {
	envelope: { magic: string; version: number; headerOffset: number; directoryEntryBytes: number; alignment: number }
	kinds: Array<{ id: number; name: string; encoding: number }>
	flags: { required: number }
}

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })
const registry = (...segments: string[]): string => workspacePath("registry", ...segments)
const definitions = await readLocalJSONFile<SectionDefinitions>(registry("definitions", "sections.json"))

const constant = (name: string): string => name.toUpperCase().replaceAll("-", "_")

const typescript = `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The RGY1 section kinds. Generated from definitions/sections.json by tools/generate-sections.run.ts. Edit the
 *   definition rather than this file.
 */

/**
 * The four ASCII bytes an artifact starts with.
 */
export const RGY1_MAGIC = ${stringifyJSON(definitions.envelope.magic)}

/**
 * The envelope version this reader implements.
 */
export const RGY1_VERSION = ${definitions.envelope.version}

/**
 * The byte offset of the header JSON, after the fixed envelope fields.
 */
export const RGY1_HEADER_OFFSET = ${definitions.envelope.headerOffset}

/**
 * The byte length of one directory entry.
 */
export const RGY1_DIRECTORY_ENTRY_BYTES = ${definitions.envelope.directoryEntryBytes}

/**
 * The alignment of the directory and of every section payload.
 */
export const RGY1_ALIGNMENT = ${definitions.envelope.alignment}

/**
 * The section flag bit that marks a section required for interpretation.
 */
export const RGY1_FLAG_REQUIRED = ${definitions.flags.required}

/**
 * Each section kind's identifier, as the directory entry stores it.
 */
export const SectionKind = {
${definitions.kinds.map((kind) => `\t${constant(kind.name)}: ${kind.id},`).join("\n")}
} as const

export type SectionKind = (typeof SectionKind)[keyof typeof SectionKind]

/**
 * The encoding version each kind is written with.
 */
export const SECTION_ENCODING: Readonly<Record<SectionKind, number>> = {
${definitions.kinds.map((kind) => `\t[SectionKind.${constant(kind.name)}]: ${kind.encoding},`).join("\n")}
}

/**
 * Each kind's name, for diagnostics.
 */
export const SECTION_NAME: Readonly<Record<SectionKind, string>> = {
${definitions.kinds.map((kind) => `\t[SectionKind.${constant(kind.name)}]: ${stringifyJSON(kind.name)},`).join("\n")}
}
`

const rust = `// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The RGY1 section kinds. Generated from \`definitions/sections.json\` by
//! \`tools/generate-sections.run.ts\`. Edit the definition rather than this file.

pub const MAGIC: &[u8; 4] = b${stringifyJSON(definitions.envelope.magic)};
pub const VERSION: u16 = ${definitions.envelope.version};
pub const HEADER_OFFSET: usize = ${definitions.envelope.headerOffset};
pub const DIRECTORY_ENTRY_BYTES: usize = ${definitions.envelope.directoryEntryBytes};
pub const ALIGNMENT: usize = ${definitions.envelope.alignment};
pub const FLAG_REQUIRED: u16 = ${definitions.flags.required};

${definitions.kinds.map((kind) => `pub const KIND_${constant(kind.name)}: u16 = ${kind.id};`).join("\n")}

/// The encoding version a kind is written with, or \`None\` for an unknown kind.
pub fn encoding_of(kind: u16) -> Option<u16> {
\tmatch kind {
${definitions.kinds.map((kind) => `\t\tKIND_${constant(kind.name)} => Some(${kind.encoding}),`).join("\n")}
\t\t_ => None,
\t}
}

/// The kind's name, for diagnostics.
pub fn name_of(kind: u16) -> &'static str {
\tmatch kind {
${definitions.kinds.map((kind) => `\t\tKIND_${constant(kind.name)} => ${stringifyJSON(kind.name)},`).join("\n")}
\t\t_ => "unknown",
\t}
}
`

const outputs: Array<[string, string]> = [
	[registry("lib", "rgy1", "sections.generated.ts"), typescript],
	[registry("crates", "registry-core", "src", "sections.rs"), rust],
]

let stale = 0

for (const [path, content] of outputs) {
	if (values.check) {
		const current = await readLocalTextFile(path).catch(() => "")

		if (current !== content) {
			console.error(`${path} differs from definitions/sections.json`)

			stale++
		}
	} else {
		await writeLocalFile(content, path)

		console.log(`wrote ${path}`)
	}
}

if (stale) {
	process.exitCode = 1
}
