/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Chooses the WOF rows a {@link RowSample} keeps, from one pass over every renderable row.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { hashFNV1a } from "@mailwoman/core/coarse-placer/fnv-hash"
import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"

import type { RowSample } from "#types"
import { parseWOFSlotKey } from "#utils/wof-json"

/**
 * The `count` lowest numbers seen, held in a max-heap so each new number costs
 * one comparison once the heap is full.
 */
export class LowestValues {
	readonly #count: number
	readonly #heap: number[] = []

	constructor(count: number) {
		this.#count = count
	}

	add(value: number): void {
		const heap = this.#heap

		if (heap.length < this.#count) {
			heap.push(value)

			for (let i = heap.length - 1; i > 0;) {
				const parent = (i - 1) >> 1

				if (heap[parent]! >= heap[i]!) break
				;[heap[parent], heap[i]] = [heap[i]!, heap[parent]!]
				i = parent
			}

			return
		}

		if (!this.#count || value >= heap[0]!) return

		heap[0] = value

		for (let i = 0; ;) {
			const left = 2 * i + 1
			const right = left + 1
			let largest = i

			if (left < heap.length && heap[left]! > heap[largest]!) {
				largest = left
			}

			if (right < heap.length && heap[right]! > heap[largest]!) {
				largest = right
			}

			if (largest === i) break
			;[heap[largest], heap[i]] = [heap[i]!, heap[largest]!]
			i = largest
		}
	}

	/**
	 * The highest number a kept value may have: the largest held when the heap is full,
	 * otherwise every value passes.
	 */
	get threshold(): number {
		if (!this.#count) return Number.NEGATIVE_INFINITY

		return this.#heap.length < this.#count ? Number.POSITIVE_INFINITY : this.#heap[0]!
	}
}

/**
 * The tags of a rendered row in the order its text shows them, such as `locality region country`.
 *
 * The training rows' label-start order is the same sequence, so the sampler's structure
 * cell matches the cell the coverage ledger reads from the labels.
 */
export function renderedTagOrder(raw: string, components: Partial<Record<ComponentTag, string>>): string {
	return (Object.entries(components) as Array<[ComponentTag, string]>)
		.map(([tag, value]) => ({ tag, at: raw.indexOf(value) }))
		.toSorted((a, b) => a.at - b.at)
		.map(({ tag }) => tag)
		.join(" ")
}

/**
 * One renderable row, as the sampler sees it.
 */
export interface SampledRow {
	sourceID: string
	country: string
	slotKey: string
	raw: string
	components: Partial<Record<ComponentTag, string>>
}

/**
 * Picks the rows a {@link RowSample} keeps, and counts every cell it saw.
 *
 * Call {@linkcode RowSampler.observe} on every renderable row, then
 * {@linkcode RowSampler.keeps} on each row again.
 * A row is kept when its hash is at or below the threshold of its structure cell
 * (country, tag order, name-slot kind), of its language cell (country, name-slot language) or of its country.
 */
export class RowSampler {
	readonly #sample: RowSample
	readonly #structure = new Map<string, LowestValues>()
	readonly #language = new Map<string, LowestValues>()
	readonly #country = new Map<string, LowestValues>()
	/**
	 * Renderable rows per full cell, `country|tag order|kind|language`.
	 */
	readonly cellCounts = new Map<string, number>()

	constructor(sample: RowSample) {
		this.#sample = sample
	}

	#keys(row: SampledRow): { hash: number; structure: string; language: string; cell: string } {
		const { kind, language } = parseWOFSlotKey(row.slotKey)
		const order = renderedTagOrder(row.raw, row.components)

		return {
			hash: hashFNV1a(row.sourceID, this.#sample.seed ?? 2_166_136_261),
			structure: `${row.country}|${order}|${kind}`,
			language: `${row.country}|${language}`,
			cell: `${row.country}|${order}|${kind}|${language}`,
		}
	}

	observe(row: SampledRow): void {
		const { hash, structure, language, cell } = this.#keys(row)
		const floor = this.#sample.cellFloor

		const lowest = (map: Map<string, LowestValues>, key: string, count: number) => {
			let values = map.get(key)

			if (!values) {
				map.set(key, (values = new LowestValues(count)))
			}

			values.add(hash)
		}

		lowest(this.#structure, structure, floor)
		lowest(this.#language, language, floor)
		lowest(this.#country, row.country, this.#sample.rowsPerCountry)
		this.cellCounts.set(cell, (this.cellCounts.get(cell) ?? 0) + 1)
	}

	/**
	 * Writes {@linkcode RowSampler.cellCounts} to the sample's `countsFile`, when it names one.
	 */
	async writeCounts(): Promise<void> {
		const file = this.#sample.countsFile

		if (!file) return

		await writeLocalJSONFile(Object.fromEntries(this.cellCounts), file.startsWith("/") ? file : dataRootPath(file))
	}

	keeps(row: SampledRow): boolean {
		const { hash, structure, language } = this.#keys(row)

		return (
			hash <= (this.#structure.get(structure)?.threshold ?? -1) ||
			hash <= (this.#language.get(language)?.threshold ?? -1) ||
			hash <= (this.#country.get(row.country)?.threshold ?? -1)
		)
	}
}
