// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Typed views over an artifact's sections: bitset, id table, column, string pool and relation.
 */

import { encodeForArity, NO_KEY } from "#key"
import { type Artifact, element, RGY1Error, type Section } from "#rgy1/reader"
import { SectionKind } from "#rgy1/sections.generated"

/**
 * The byte width of an IEEE 754 double cell.
 */
const BYTES_PER_DOUBLE = 8

/**
 * A dense bitset over a key space.
 */
export class BitsetView {
	readonly #bits: Uint8Array
	readonly arity: number

	constructor(section: Section) {
		this.#bits = section.payload
		this.arity = section.aux
	}

	static of(artifact: Artifact): BitsetView {
		return new BitsetView(artifact.require(SectionKind.BITSET))
	}

	/**
	 * Whether `key` is a member.
	 * A key outside the space isn't.
	 */
	test(key: number): boolean {
		if (key < 0) return false

		const byte = key >> 3

		return byte < this.#bits.length && (this.#bits[byte]! & (1 << (key & 7))) !== 0
	}

	/**
	 * Whether a code in its canonical spelling is a member.
	 * A code outside the grammar isn't.
	 */
	contains(code: string): boolean {
		return this.test(encodeForArity(this.arity, code))
	}

	/**
	 * The number of set bits.
	 */
	get size(): number {
		let count = 0

		for (const byte of this.#bits) {
			let value = byte

			while (value) {
				count += value & 1
				value >>= 1
			}
		}

		return count
	}
}

/**
 * A direct-address table from key to row id, with zero stored for absent.
 */
export class IDTableView {
	readonly #section: Section

	constructor(section: Section) {
		this.#section = section
	}

	static of(artifact: Artifact, arity: number): IDTableView {
		return new IDTableView(artifact.require(SectionKind.ID_TABLE, arity))
	}

	/**
	 * The row id for a key, or `-1` when absent.
	 */
	get(key: number): number {
		if (key < 0 || key >= this.#section.count) return -1

		return element(this.#section, key) - 1
	}

	/**
	 * The row id for a code in its canonical spelling, or `-1`.
	 */
	lookup(code: string): number {
		return this.get(encodeForArity(this.#section.aux, code))
	}
}

/**
 * A fixed-width record column.
 */
export class ColumnView {
	readonly #section: Section

	constructor(section: Section) {
		this.#section = section
	}

	static of(artifact: Artifact, index: number): ColumnView {
		return new ColumnView(artifact.require(SectionKind.COLUMN, index))
	}

	get rows(): number {
		return this.#section.count
	}

	/**
	 * An unsigned integer cell of width 1, 2 or 4.
	 */
	integer(row: number): number {
		if (row < 0 || row >= this.#section.count || this.#section.elementWidth === BYTES_PER_DOUBLE) return NO_KEY

		return element(this.#section, row)
	}

	/**
	 * A double cell.
	 */
	double(row: number): number {
		if (row < 0 || row >= this.#section.count || this.#section.elementWidth !== BYTES_PER_DOUBLE) return Number.NaN

		return this.#section.view.getFloat64(row * BYTES_PER_DOUBLE, true)
	}
}

const decoder = new TextDecoder("utf-8", { fatal: true })

/**
 * A string pool: offsets into a strict UTF-8 byte section, decoded on read.
 */
export class StringPoolView {
	readonly #offsets: Section
	readonly #bytes: Uint8Array

	constructor(offsets: Section, bytes: Section) {
		if (offsets.count === 0) throw new RGY1Error("offsets", "a string pool needs at least one offset")

		let previous = 0

		for (let index = 0; index < offsets.count; index++) {
			const offset = element(offsets, index)

			if (offset < previous) throw new RGY1Error("offsets", `string offset ${index} goes backwards`)

			previous = offset
		}

		if (previous !== bytes.length)
			throw new RGY1Error("offsets", `string offsets end at ${previous}, bytes are ${bytes.length}`)

		try {
			decoder.decode(bytes.payload)
		} catch {
			throw new RGY1Error("string-utf8", "the pool is not strict UTF-8")
		}

		this.#offsets = offsets
		this.#bytes = bytes.payload
	}

	static of(artifact: Artifact): StringPoolView {
		return new StringPoolView(artifact.require(SectionKind.STRING_OFFSETS), artifact.require(SectionKind.UTF8))
	}

	get size(): number {
		return this.#offsets.count - 1
	}

	/**
	 * The string at `index`, or `null` outside the pool.
	 */
	get(index: number): string | null {
		if (index < 0 || index >= this.size) return null

		return decoder.decode(this.#bytes.subarray(element(this.#offsets, index), element(this.#offsets, index + 1)))
	}
}

/**
 * A relation from each source key to its target rows.
 */
export class RelationView {
	readonly #offsets: Section
	readonly #targets: Section

	constructor(offsets: Section, targets: Section) {
		if (offsets.count === 0) throw new RGY1Error("offsets", "a relation needs at least one offset")

		let previous = 0

		for (let index = 0; index < offsets.count; index++) {
			const offset = element(offsets, index)

			if (offset < previous) throw new RGY1Error("offsets", `relation offset ${index} goes backwards`)

			previous = offset
		}

		if (previous !== targets.count)
			throw new RGY1Error("offsets", `relation offsets end at ${previous}, targets are ${targets.count}`)

		this.#offsets = offsets
		this.#targets = targets
	}

	static of(artifact: Artifact, index: number): RelationView {
		return new RelationView(
			artifact.require(SectionKind.RELATION_OFFSETS, index),
			artifact.require(SectionKind.RELATION_TARGETS, index)
		)
	}

	get sources(): number {
		return this.#offsets.count - 1
	}

	/**
	 * The target rows of one source key, as a fresh array.
	 */
	targets(source: number): number[] {
		if (source < 0 || source >= this.sources) return []

		const start = element(this.#offsets, source)
		const end = element(this.#offsets, source + 1)
		const out = new Array<number>(end - start)

		for (let index = start; index < end; index++) {
			out[index - start] = element(this.#targets, index)
		}

		return out
	}

	/**
	 * Writes the target rows of one source key into `out` and returns the count written,
	 * or `-1` when `out` is too small.
	 */
	targetsInto(source: number, out: Uint32Array): number {
		if (source < 0 || source >= this.sources) return 0

		const start = element(this.#offsets, source)
		const end = element(this.#offsets, source + 1)

		if (end - start > out.length) return -1

		for (let index = start; index < end; index++) {
			out[index - start] = element(this.#targets, index)
		}

		return end - start
	}
}
