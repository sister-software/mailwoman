/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synchronous RGY1 reader: validate an artifact once, then probe its tables in place.
 *
 *   The reader mirrors `crates/registry-core/src/artifact.rs` and follows `docs/rgy1.md`. It reads through a
 *   `DataView` over the caller's bytes, honoring `byteOffset`, so an artifact handed over as a subarray behaves as the
 *   same bytes would in their own buffer. No `Map` is rebuilt: a probe is an arithmetic index into the section's payload.
 */

import {
	RGY1_ALIGNMENT,
	RGY1_DIRECTORY_ENTRY_BYTES,
	RGY1_FLAG_REQUIRED,
	RGY1_HEADER_OFFSET,
	RGY1_MAGIC,
	RGY1_VERSION,
	SECTION_ENCODING,
	SectionKind,
} from "#rgy1/sections.generated"

/**
 * Why bytes are not an RGY1 artifact this reader accepts.
 */
export class RGY1Error extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(`RGY1 ${code}: ${message}`)
		this.name = "RGY1Error"
		this.code = code
	}
}

/**
 * One directory entry with its payload view.
 */
export interface Section {
	kind: number
	encoding: number
	elementWidth: number
	flags: number
	offset: number
	length: number
	count: number
	aux: number
	payload: Uint8Array
	view: DataView
}

/**
 * The header fields every artifact holds.
 * A records artifact adds `columns`, `rows` and `relations`.
 */
export interface ArtifactHeader {
	artifact: string
	profile: string
	namespaces: string[]
	sources: Array<{ id: string; sha256: string; publication: string }>
	coverage: Record<string, number>
	schemaVersion: number
	normalizationVersion: number
	envelopeVersion: number
	encodings: Record<string, number>
	generator: string
	status?: string
	kinds?: string[]
	meaning?: string
	rows?: number
	columns?: Array<{ name: string; type: string; width: number; values?: string[]; absent?: number }>
	relations?: Array<{ name: string; source: string; targets: string }>
}

const KEY_SPACES: Readonly<Record<number, number>> = { 0: 1000, 2: 676, 3: 17_576 }

/**
 * The byte width of a `u32` cell.
 */
const BYTES_PER_U32 = 4

/**
 * Rounds up to the section alignment.
 */
export function align(value: number): number {
	return Math.ceil(value / RGY1_ALIGNMENT) * RGY1_ALIGNMENT
}

const decoder = new TextDecoder("utf-8", { fatal: true })

/**
 * A validated artifact over the caller's bytes.
 */
export class Artifact {
	readonly bytes: Uint8Array
	readonly header: ArtifactHeader
	readonly sections: readonly Section[]

	private constructor(bytes: Uint8Array, header: ArtifactHeader, sections: readonly Section[]) {
		this.bytes = bytes
		this.header = header
		this.sections = sections
	}

	/**
	 * Parses and validates the envelope, directory and every section's framing.
	 */
	static parse(bytes: Uint8Array): Artifact {
		if (bytes.byteLength < RGY1_HEADER_OFFSET) throw new RGY1Error("truncated", `${bytes.byteLength} bytes`)

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

		for (let index = 0; index < RGY1_MAGIC.length; index++) {
			if (bytes[index] !== RGY1_MAGIC.charCodeAt(index)) throw new RGY1Error("magic", "the first bytes are not RGY1")
		}

		const version = view.getUint16(4, true)

		if (version !== RGY1_VERSION) throw new RGY1Error("version", `envelope version ${version}`)

		const flags = view.getUint16(6, true)

		if (flags !== 0) throw new RGY1Error("flags", `envelope flags ${flags}`)

		const headerLength = view.getUint32(8, true)
		const sectionCount = view.getUint32(12, true)
		const directoryOffset = view.getUint32(16, true)
		const totalLength = view.getUint32(20, true)
		const firstPayload = view.getUint32(24, true)

		if (view.getUint32(28, true) !== 0) throw new RGY1Error("reserved", "the reserved field is set")

		if (totalLength !== bytes.byteLength) {
			throw new RGY1Error("length", `stated ${totalLength} bytes, given ${bytes.byteLength}`)
		}

		const headerEnd = RGY1_HEADER_OFFSET + headerLength

		if (headerEnd > bytes.byteLength || directoryOffset !== align(headerEnd)) {
			throw new RGY1Error("layout", `directory at ${directoryOffset}, header ends at ${headerEnd}`)
		}

		const directoryEnd = directoryOffset + sectionCount * RGY1_DIRECTORY_ENTRY_BYTES

		if (directoryEnd > bytes.byteLength || firstPayload !== align(directoryEnd) || firstPayload > bytes.byteLength) {
			throw new RGY1Error("layout", `first payload at ${firstPayload}, directory ends at ${directoryEnd}`)
		}

		let headerText: string

		try {
			headerText = decoder.decode(bytes.subarray(RGY1_HEADER_OFFSET, headerEnd))
		} catch {
			throw new RGY1Error("header-utf8", "the header is not strict UTF-8")
		}

		for (let at = headerEnd; at < directoryOffset; at++) {
			if (bytes[at] !== 0) throw new RGY1Error("layout", `byte ${at} between header and directory is not zero`)
		}

		// oxlint-disable-next-line eslint/no-restricted-properties -- the library has no dependency on @mailwoman/core, so it reads the header with the platform parser
		const header = JSON.parse(headerText) as ArtifactHeader
		const sections: Section[] = []
		let cursor = firstPayload

		for (let index = 0; index < sectionCount; index++) {
			const at = directoryOffset + index * RGY1_DIRECTORY_ENTRY_BYTES
			const kind = view.getUint16(at, true)
			const encoding = view.getUint16(at + 2, true)
			const elementWidth = view.getUint16(at + 4, true)
			const sectionFlags = view.getUint16(at + 6, true)
			const offset = view.getUint32(at + 8, true)
			const length = view.getUint32(at + 12, true)
			const count = view.getUint32(at + 16, true)
			const aux = view.getUint32(at + 20, true)
			const known = (SECTION_ENCODING as Record<number, number | undefined>)[kind]

			if (known == null) {
				if (sectionFlags & RGY1_FLAG_REQUIRED)
					throw new RGY1Error("unknown-required-kind", `section ${index} kind ${kind}`)
			} else if (known !== encoding) {
				throw new RGY1Error("encoding", `kind ${kind} encoding ${encoding}`)
			}

			const end = offset + length

			if (offset % RGY1_ALIGNMENT !== 0 || offset < cursor || end > bytes.byteLength) {
				throw new RGY1Error("section-bounds", `section ${index} at ${offset}..${end}`)
			}

			for (let gap = cursor; gap < offset; gap++) {
				if (bytes[gap] !== 0) throw new RGY1Error("section-bounds", `byte ${gap} before section ${index} is not zero`)
			}

			const payload = bytes.subarray(offset, end)

			const section: Section = {
				kind,
				encoding,
				elementWidth,
				flags: sectionFlags,
				offset,
				length,
				count,
				aux,
				payload,
				view: new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
			}

			checkShape(section)
			sections.push(section)
			cursor = end
		}

		if (bytes.byteLength - cursor >= RGY1_ALIGNMENT)
			throw new RGY1Error("layout", "trailing bytes after the last section")

		for (let at = cursor; at < bytes.byteLength; at++) {
			if (bytes[at] !== 0) throw new RGY1Error("layout", `trailing byte ${at} is not zero`)
		}

		return new Artifact(bytes, header, sections)
	}

	/**
	 * The first section of a kind with the given `aux`, or `null`.
	 */
	section(kind: number, aux: number): Section | null {
		return this.sections.find((section) => section.kind === kind && section.aux === aux) ?? null
	}

	/**
	 * The first section of a kind, whatever its `aux`, or `null`.
	 */
	firstSection(kind: number): Section | null {
		return this.sections.find((section) => section.kind === kind) ?? null
	}

	/**
	 * The section a lookup needs, or an error naming it.
	 */
	require(kind: number, aux?: number): Section {
		const section = aux == null ? this.firstSection(kind) : this.section(kind, aux)

		if (!section) throw new RGY1Error("missing-section", `kind ${kind}${aux == null ? "" : ` aux ${aux}`}`)

		return section
	}
}

function checkShape(section: Section): void {
	const { kind, elementWidth, length, count, aux } = section

	switch (kind) {
		case SectionKind.BITSET: {
			if (elementWidth !== 0) throw new RGY1Error("element-width", `bitset width ${elementWidth}`)

			const space = KEY_SPACES[aux]

			if (space == null) throw new RGY1Error("key-space", `arity ${aux}`)

			if (count !== space || length !== Math.ceil(count / 8))
				throw new RGY1Error("count", `bitset ${count} keys in ${length} bytes`)

			break
		}
		case SectionKind.ID_TABLE: {
			if (![1, 2, 4].includes(elementWidth)) throw new RGY1Error("element-width", `id-table width ${elementWidth}`)

			const space = KEY_SPACES[aux]

			if (space == null) throw new RGY1Error("key-space", `arity ${aux}`)

			if (count !== space || length !== count * elementWidth)
				throw new RGY1Error("count", `id-table ${count} × ${elementWidth}`)

			break
		}
		case SectionKind.STRING_OFFSETS:
		case SectionKind.RELATION_OFFSETS:
		case SectionKind.RELATION_TARGETS:
			if (elementWidth !== BYTES_PER_U32) throw new RGY1Error("element-width", `kind ${kind} width ${elementWidth}`)

			if (length !== count * BYTES_PER_U32) throw new RGY1Error("count", `kind ${kind} ${count} × ${BYTES_PER_U32}`)

			break
		case SectionKind.UTF8:
			if (elementWidth !== 0) throw new RGY1Error("element-width", `utf8 width ${elementWidth}`)

			if (length !== count) throw new RGY1Error("count", `utf8 ${count} in ${length}`)

			break
		case SectionKind.COLUMN:
			if (![1, 2, 4, 8].includes(elementWidth)) throw new RGY1Error("element-width", `column width ${elementWidth}`)

			if (length !== count * elementWidth) throw new RGY1Error("count", `column ${count} × ${elementWidth}`)

			break
		default:
	}
}

/**
 * Reads the unsigned element at `index` of a section of width 1, 2 or 4.
 */
export function element(section: Section, index: number): number {
	switch (section.elementWidth) {
		case 1:
			return section.payload[index]!
		case 2:
			return section.view.getUint16(index * 2, true)
		default:
			return section.view.getUint32(index * BYTES_PER_U32, true)
	}
}
