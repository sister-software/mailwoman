/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The token-embedding lookup for a split release. A split release ships `encoder.onnx`, which takes
 *   `inputs_embeds` in place of `input_ids`, and the quantized embedding table as MWE1 row files written
 *   by `corpus-python/src/mailwoman_train/export/split_embeddings.py`. The lookup reproduces the two
 *   nodes the split removed: a `Gather` of UINT8 rows and one per-tensor `DequantizeLinear`,
 *   `(row - zeroPoint) * scale`.
 *
 *   The module imports no `onnxruntime-*` and no `node:` built-in, so both runners share it.
 */

/**
 * The MWE1 file magic, the bytes `MWE1` read as a little-endian u32.
 */
const MAGIC = 0x31_45_57_4d

/**
 * The status of a response that carries exactly the requested byte range.
 */
const PARTIAL_CONTENT = 206

/**
 * The fixed MWE1 header length in bytes.
 */
export const EMBEDDING_HEADER_BYTES = 32

/**
 * How an MWE1 file lays out its rows.
 */
export const EmbeddingLayout = {
	/**
	 * Every row in id order from the header's end, so row `i` sits at `32 + i * hidden`.
	 */
	Full: 0,
	/**
	 * Ascending u32 ids, then their rows in the same order.
	 */
	Subset: 1,
} as const

export type EmbeddingLayout = (typeof EmbeddingLayout)[keyof typeof EmbeddingLayout]

/**
 * The header fields shared by every row file of one table.
 */
export interface EmbeddingHeader {
	vocabSize: number
	hidden: number
	scale: number
	zeroPoint: number
	rowCount: number
	layout: EmbeddingLayout
}

/**
 * Parses an MWE1 header from at least its first 32 bytes.
 *
 * @throws When the magic, header length or layout does not match the format.
 */
export function parseEmbeddingHeader(bytes: Uint8Array): EmbeddingHeader {
	if (bytes.byteLength < EMBEDDING_HEADER_BYTES) {
		throw new Error(`an MWE1 header is ${EMBEDDING_HEADER_BYTES} bytes; read ${bytes.byteLength}`)
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, EMBEDDING_HEADER_BYTES)

	if (view.getUint32(0, true) !== MAGIC) throw new Error("the embedding row file does not start with MWE1")

	const headerBytes = view.getUint32(4, true)

	if (headerBytes !== EMBEDDING_HEADER_BYTES) {
		throw new Error(`the MWE1 header declares ${headerBytes} bytes; this reader handles ${EMBEDDING_HEADER_BYTES}`)
	}

	const layout = view.getUint32(28, true)

	if (layout !== EmbeddingLayout.Full && layout !== EmbeddingLayout.Subset) {
		throw new Error(`the MWE1 header declares layout ${layout}`)
	}

	return {
		vocabSize: view.getUint32(8, true),
		hidden: view.getUint32(12, true),
		scale: view.getFloat32(16, true),
		zeroPoint: view.getUint32(20, true),
		rowCount: view.getUint32(24, true),
		layout,
	}
}

/**
 * Parses a complete MWE1 file into its header and a map from id to quantized row.
 *
 * @throws When the file is shorter than its header declares.
 */
export function parseEmbeddingRows(bytes: Uint8Array): { header: EmbeddingHeader; rows: Map<number, Uint8Array> } {
	const header = parseEmbeddingHeader(bytes)
	const { rowCount, hidden, layout } = header
	const idBytes = layout === EmbeddingLayout.Subset ? rowCount * 4 : 0
	const expected = EMBEDDING_HEADER_BYTES + idBytes + rowCount * hidden

	if (bytes.byteLength < expected) {
		throw new Error(`the MWE1 file declares ${expected} bytes; read ${bytes.byteLength}`)
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const body = EMBEDDING_HEADER_BYTES + idBytes
	const rows = new Map<number, Uint8Array>()

	for (let k = 0; k < rowCount; k++) {
		const id = layout === EmbeddingLayout.Subset ? view.getUint32(EMBEDDING_HEADER_BYTES + 4 * k, true) : k
		const start = body + k * hidden

		rows.set(id, bytes.subarray(start, start + hidden))
	}

	return { header, rows }
}

/**
 * Reads the bytes `[offset, offset + length)` of the full row file.
 */
export type EmbeddingRangeReader = (offset: number, length: number) => Promise<Uint8Array>

/**
 * Returns a range reader that fetches byte ranges of `url` with HTTP `Range` requests.
 *
 * @throws From the returned reader when the response is not a 206 of exactly the requested length.
 */
export function httpEmbeddingRangeReader(url: string, fetchImpl: typeof fetch = fetch): EmbeddingRangeReader {
	return async (offset, length) => {
		const response = await fetchImpl(url, { headers: { range: `bytes=${offset}-${offset + length - 1}` } })

		if (response.status !== PARTIAL_CONTENT) {
			throw new Error(
				`range ${offset}+${length} of ${url} answered ${response.status}; a row read needs ${PARTIAL_CONTENT}`
			)
		}

		const bytes = new Uint8Array(await response.arrayBuffer())

		if (bytes.byteLength !== length) {
			throw new Error(`range ${offset}+${length} of ${url} returned ${bytes.byteLength} bytes`)
		}

		return bytes
	}
}

/**
 * Looks up dequantized embedding rows from a resident subset and reads each missing row from the full file.
 *
 * A row read from the full file stays resident for later lookups.
 */
export class EmbeddingTable {
	readonly header: EmbeddingHeader
	readonly #rows: Map<number, Uint8Array>
	readonly #readRange: EmbeddingRangeReader | null
	#rangeReads = 0

	constructor(header: EmbeddingHeader, rows: Map<number, Uint8Array>, readRange: EmbeddingRangeReader | null) {
		this.header = header
		this.#rows = rows
		this.#readRange = readRange
	}

	/**
	 * Builds a table from a resident row file and an optional reader over the full file.
	 *
	 * A full resident file needs no reader.
	 * A subset needs one, because an id outside it has no other source.
	 */
	static fromBytes(resident: Uint8Array, readRange: EmbeddingRangeReader | null = null): EmbeddingTable {
		const { header, rows } = parseEmbeddingRows(resident)

		if (header.layout === EmbeddingLayout.Subset && !readRange) {
			throw new Error("a subset embedding file needs a range reader over the full file for the ids it omits")
		}

		return new EmbeddingTable(header, rows, readRange)
	}

	/**
	 * The count of range reads issued so far.
	 */
	get rangeReads(): number {
		return this.#rangeReads
	}

	/**
	 * The count of rows resident in memory.
	 */
	get residentRows(): number {
		return this.#rows.size
	}

	async #ensureRows(ids: Iterable<number>): Promise<void> {
		const missing = [...new Set(ids)].filter((id) => !this.#rows.has(id)).toSorted((a, b) => a - b)

		if (!missing.length) return

		const { vocabSize, hidden } = this.header

		for (const id of missing) {
			if (!Number.isInteger(id) || id < 0 || id >= vocabSize) {
				throw new Error(`token id ${id} lies outside the embedding table's ${vocabSize} rows`)
			}
		}

		if (!this.#readRange) throw new Error(`embedding rows ${missing.join(", ")} are not resident and no reader is set`)

		const runs: Array<[number, number]> = []

		for (const id of missing) {
			const last = runs.at(-1)

			if (last && id === last[1] + 1) {
				last[1] = id
			} else {
				runs.push([id, id])
			}
		}

		const readRange = this.#readRange

		await Promise.all(
			runs.map(async ([first, last]) => {
				this.#rangeReads++
				const count = last - first + 1
				const bytes = await readRange(EMBEDDING_HEADER_BYTES + first * hidden, count * hidden)

				for (let k = 0; k < count; k++) {
					this.#rows.set(first + k, bytes.slice(k * hidden, (k + 1) * hidden))
				}
			})
		)
	}

	/**
	 * Returns the `[1, fixedSeqLen, hidden]` float feed for `tokenIDs`, padded with id 0 like `input_ids`.
	 */
	async embed(tokenIDs: readonly number[], fixedSeqLen: number): Promise<{ data: Float32Array; dims: number[] }> {
		const seqLen = Math.min(tokenIDs.length, fixedSeqLen)
		const ids = Array.from({ length: fixedSeqLen }, (_, i) => (i < seqLen ? tokenIDs[i]! : 0))

		await this.#ensureRows(ids)

		const { hidden, scale, zeroPoint } = this.header
		const fscale = Math.fround(scale)
		const data = new Float32Array(fixedSeqLen * hidden)

		for (let position = 0; position < fixedSeqLen; position++) {
			const row = this.#rows.get(ids[position]!)!
			const base = position * hidden

			for (let k = 0; k < hidden; k++) {
				data[base + k] = (row[k]! - zeroPoint) * fscale
			}
		}

		return { data, dims: [1, fixedSeqLen, hidden] }
	}
}

/**
 * The graph input a split encoder declares in place of `input_ids`.
 */
export const INPUTS_EMBEDS = "inputs_embeds"
