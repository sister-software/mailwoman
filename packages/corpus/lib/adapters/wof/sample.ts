/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Chooses the WOF rows a {@link RowSample} keeps, from one pass over every renderable row.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { hashFNV1a } from "@mailwoman/core/coarse-placer/fnv-hash"
import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"

import { canonicalDedupKey } from "#adapters/dedup-key"
import type { CanonicalRow, RowSample } from "#types"
import { locateComponentSpans } from "#utils/align"
import { parseWOFSlotKey } from "#utils/wof-json"

/**
 * The `count` lowest numbers seen, held in a max-heap so each new number costs
 * one comparison once the heap is full.
 *
 * A number added with a `text` value that a held number already contains is skipped,
 * so the held numbers stand for `count` distinct texts.
 * The build drops a row whose text repeats an emitted row, and a floor counted over
 * repeated texts would lose those rows after sampling.
 */
export class LowestValues {
	readonly #count: number
	readonly #heap: number[] = []
	readonly #texts: Array<number | undefined> = []
	readonly #held = new Set<number>()

	constructor(count: number) {
		this.#count = count
	}

	/**
	 * Adds `value`, and returns whether it is now held.
	 */
	add(value: number, text?: number): boolean {
		const heap = this.#heap

		if (typeof text === "number" && this.#held.has(text)) return false

		if (heap.length < this.#count) {
			heap.push(value)
			this.#texts.push(text)
			this.#hold(text)
			this.#siftUp(heap.length - 1)

			return true
		}

		if (!this.#count || value >= heap[0]!) return false

		this.#release(this.#texts[0])
		heap[0] = value
		this.#texts[0] = text
		this.#hold(text)
		this.#siftDown(0)

		return true
	}

	#hold(text: number | undefined): void {
		if (typeof text === "number") {
			this.#held.add(text)
		}
	}

	#release(text: number | undefined): void {
		if (typeof text === "number") {
			this.#held.delete(text)
		}
	}

	#swap(a: number, b: number): void {
		const heap = this.#heap

		const texts = this.#texts

		;[heap[a], heap[b]] = [heap[b]!, heap[a]!]
		;[texts[a], texts[b]] = [texts[b], texts[a]]
	}

	#siftUp(start: number): void {
		const heap = this.#heap

		for (let i = start; i > 0;) {
			const parent = (i - 1) >> 1

			if (heap[parent]! >= heap[i]!) break

			this.#swap(parent, i)
			i = parent
		}
	}

	#siftDown(start: number): void {
		const heap = this.#heap

		for (let i = start; ;) {
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

			this.#swap(largest, i)
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
 * The tags of a rendered row in the order the aligner places them, such as `locality region country`,
 * or `null` when the aligner cannot place a component and would quarantine the row.
 *
 * {@linkcode locateComponentSpans}, the aligner's own span search, determines the order.
 * It orders a region that appears inside its locality's name (`ہیرسبرک، شمالی کیرولائنا`
 * before `شمالی کیرولائنا`) by its own span, matching the training row's span order.
 */
export function renderedTagOrder(raw: string, components: Partial<Record<ComponentTag, string>>): string | null {
	const normalized = Object.fromEntries(
		Object.entries(components).map(([tag, value]) => [tag, value?.normalize("NFC")])
	) as Partial<Record<ComponentTag, string>>

	const located = locateComponentSpans(raw.normalize("NFC"), normalized)

	return "spans" in located ? located.spans.map((span) => span.tag).join(" ") : null
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
 * A row the sampler holds as a candidate, with the cells it was keyed by.
 */
interface Candidate<T> {
	payload: T
	hash: number
	structure: string
	language: string
	country: string
	/**
	 * Hash of the row's case-folded text.
	 *
	 * The held-out and comparison sets check it against the retained rows.
	 */
	raw: number
	/**
	 * The `holdOutCells` or `compareCells` entry the row matched.
	 */
	group?: string
}

/**
 * Picks the rows a {@link RowSample} keeps, and counts every cell it saw, in one pass.
 *
 * Call {@linkcode RowSampler.observe} on every renderable row with the value to
 * emit for it, then read {@linkcode RowSampler.kept}.
 * A row is kept when its hash is at or below the threshold of its structure cell
 * (country, tag order, name-slot kind), of its language cell (country, name-slot language) or of its country.
 *
 * The sampler holds a row while one of its cells' heaps holds its hash.
 * A heap of k values filled in random hash order admits about k ln(n / k) of its n rows
 * over the pass, so the held rows stay a small multiple of the kept ones.
 */
export class RowSampler<T = SampledRow> {
	readonly #sample: RowSample
	readonly #structure = new Map<string, LowestValues>()
	readonly #language = new Map<string, LowestValues>()
	readonly #country = new Map<string, LowestValues>()
	readonly #candidates = new Map<string, Candidate<T>>()
	readonly #holdOut: ReadonlySet<string>
	readonly #heldOut = new Map<string, LowestValues>()
	readonly #heldOutCandidates = new Map<string, Candidate<T>>()
	readonly #compare: ReadonlySet<string>
	readonly #comparison = new Map<string, LowestValues>()
	readonly #comparisonCandidates = new Map<string, Candidate<T> & { order: number }>()
	#keptRaws: Set<number> | null = null
	/**
	 * Renderable rows per full cell, `country|tag order|kind|language`.
	 */
	readonly cellCounts = new Map<string, number>()

	constructor(sample: RowSample) {
		this.#sample = sample
		this.#holdOut = new Set(sample.holdOutCells)
		this.#compare = new Set(sample.compareCells)
	}

	get #perCell(): number {
		return this.#sample.heldOutPerCell ?? 20
	}

	/**
	 * The row's hash and cells, or `null` when the aligner would quarantine the row.
	 * The sampler neither counts nor keeps quarantined rows.
	 */
	#keys(row: SampledRow): { hash: number; structure: string; order: string; language: string; cell: string } | null {
		const { kind, language } = parseWOFSlotKey(row.slotKey)
		const order = renderedTagOrder(row.raw, row.components)

		if (order === null) return null

		return {
			hash: hashFNV1a(row.sourceID, this.#sample.seed ?? 2_166_136_261),
			structure: `${row.country}|${order}|${kind}`,
			order: `${row.country}|${order}`,
			language: `${row.country}|${language}`,
			cell: `${row.country}|${order}|${kind}|${language}`,
		}
	}

	observe(row: SampledRow, payload: T): void {
		const keys = this.#keys(row)

		if (!keys) return

		const { hash, structure, order, language, cell } = keys
		const raw = hashFNV1a(row.raw.normalize("NFC").toLowerCase())
		const floor = this.#sample.cellFloor

		// The runner drops a row whose dedup key repeats an emitted row's, so the floor counts distinct keys.
		const text = hashFNV1a(
			canonicalDedupKey({ raw: row.raw, components: row.components, country: row.country } as CanonicalRow)
		)

		const lowest = (map: Map<string, LowestValues>, key: string, count: number): boolean => {
			let values = map.get(key)

			if (!values) {
				map.set(key, (values = new LowestValues(count)))
			}

			return values.add(hash, text)
		}

		this.cellCounts.set(cell, (this.cellCounts.get(cell) ?? 0) + 1)

		const base = { payload, hash, structure, language, country: row.country, raw }
		const heldOutGroup = [structure, order].find((key) => this.#holdOut.has(key))

		if (heldOutGroup) {
			// Held-out rows are over-collected so that rows whose text matches a kept row can be left out.
			if (lowest(this.#heldOut, heldOutGroup, this.#perCell * 2)) {
				this.#heldOutCandidates.set(row.sourceID, { ...base, group: heldOutGroup })
			}

			return
		}

		const held = [
			lowest(this.#structure, structure, floor),
			lowest(this.#language, language, floor),
			lowest(this.#country, row.country, this.#sample.rowsPerCountry),
		].some(Boolean)

		if (held) {
			this.#candidates.set(row.sourceID, base)
		}

		const compareGroup = [structure, order].find((key) => this.#compare.has(key))

		if (compareGroup) {
			// A second hash orders the comparison rows independently of the keep order, so its lowest rows are mostly unkept.
			const second = hashFNV1a(row.sourceID, (this.#sample.seed ?? 2_166_136_261) ^ 0x9e_37_79_b9)
			let values = this.#comparison.get(compareGroup)

			if (!values) {
				this.#comparison.set(compareGroup, (values = new LowestValues(this.#perCell * 4)))
			}

			if (values.add(second, text)) {
				this.#comparisonCandidates.set(row.sourceID, { ...base, group: compareGroup, order: second })
			}
		}
	}

	#isKept(candidate: Candidate<T>): boolean {
		return (
			candidate.hash <= (this.#structure.get(candidate.structure)?.threshold ?? -1) ||
			candidate.hash <= (this.#language.get(candidate.language)?.threshold ?? -1) ||
			candidate.hash <= (this.#country.get(candidate.country)?.threshold ?? -1)
		)
	}

	/**
	 * Case-folded text hashes of every kept row, computed once the pass is over.
	 */
	#keptRawHashes(): Set<number> {
		this.#keptRaws ??= new Set([...this.#candidates.values()].filter((c) => this.#isKept(c)).map((c) => c.raw))

		return this.#keptRaws
	}

	/**
	 * Up to `heldOutPerCell` payloads per group from the candidates `admit` accepts,
	 * lowest `rank` first, yielded in the order they were observed.
	 */
	*#perGroup<C extends Candidate<T>>(
		candidates: Iterable<C>,
		admit: (candidate: C) => boolean,
		rank: (candidate: C) => number
	): Generator<T> {
		const keptRaws = this.#keptRawHashes()
		const admitted = [...candidates].filter((c) => admit(c) && !keptRaws.has(c.raw))
		const chosen = new Set<C>()
		const byGroup = Map.groupBy(admitted, (c) => c.group!)

		for (const group of byGroup.values()) {
			for (const c of group.toSorted((a, b) => rank(a) - rank(b)).slice(0, this.#perCell)) {
				chosen.add(c)
			}
		}

		for (const c of admitted) {
			if (chosen.has(c)) {
				yield c.payload
			}
		}
	}

	/**
	 * The payloads of the held-out rows, at most `heldOutPerCell` per `holdOutCells` entry,
	 * none with the case-folded text of a kept row, in the order they were observed.
	 */
	heldOut(): Generator<T> {
		return this.#perGroup(
			this.#heldOutCandidates.values(),
			(c) => c.hash <= (this.#heldOut.get(c.group!)?.threshold ?? -1),
			(c) => c.hash
		)
	}

	/**
	 * The payloads of unkept rows from `compareCells`, at most `heldOutPerCell` per entry,
	 * none with the case-folded text of a kept row, in the order they were observed.
	 */
	comparison(): Generator<T> {
		return this.#perGroup(
			this.#comparisonCandidates.values(),
			(c) => !this.#isKept(c) && c.order <= (this.#comparison.get(c.group!)?.threshold ?? -1),
			(c) => c.order
		)
	}

	/**
	 * The payloads of the kept rows, in the order they were observed.
	 */
	*kept(): Generator<T> {
		for (const candidate of this.#candidates.values()) {
			if (this.#isKept(candidate)) {
				yield candidate.payload
			}
		}
	}

	/**
	 * Writes {@linkcode RowSampler.cellCounts} to the sample's `countsFile` and
	 * {@linkcode RowSampler.heldOut} to its `heldOutFile`, and {@linkcode RowSampler.comparison}
	 * to its `comparisonFile`, each when the sample names one.
	 */
	async writeOutputs(): Promise<void> {
		const resolve = (file: string) => (file.startsWith("/") ? file : dataRootPath(file))
		const { countsFile, heldOutFile, comparisonFile } = this.#sample

		if (comparisonFile) {
			await writeLocalJSONLFile([...this.comparison()], resolve(comparisonFile))
		}

		if (countsFile) {
			await writeLocalJSONFile(Object.fromEntries(this.cellCounts), resolve(countsFile))
		}

		if (heldOutFile) {
			await writeLocalJSONLFile([...this.heldOut()], resolve(heldOutFile))
		}
	}
}
