/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Splice the diacritic pieces of a locale tokenizer into a frozen unigram vocabulary, and grow an exported model's
 *   embedding table to match.
 *
 *   An appended piece contains a code point outside ASCII, so it cannot match any span of an ASCII string, and ASCII
 *   text tokenizes exactly as before. `verifySourceIdentical` checks that on a probe rather than assuming it. A
 *   trained locale that shares a code point with the new pieces can re-tokenize, which `checkCodepointOverlap`
 *   reports and refuses unless the locale is accepted. The method does not scale to CJK.
 */

import { readFileRange, readLocalBuffer, readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { isDirectory, isFile } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalBuffer, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { codePointLength } from "@mailwoman/core/strings/code-points"
import { pythonSplitLines, pythonStrip } from "@mailwoman/core/strings/python-text"
import { CSVSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { runMTFTokenizer } from "./binary.ts"
import { editModel, loadEncoder, PieceType, readModelPieces, type VocabularyPiece } from "./model.ts"
import { trainSentencePiece } from "./sentencepiece.ts"

/**
 * The corpus sample size and the seed of its shuffle.
 */
const CORPUS_SAMPLE = 350_000
const CORPUS_SEED = 42

/**
 * ASCII address lines, the default probe of the English-identity check.
 */
export const ENGLISH_PROBE: readonly string[] = [
	"109 Seminary Dr, Mill Valley, CA 94941",
	"5210 South Ingleside Avenue, Chicago, IL 60615",
	"1600 Pennsylvania Ave NW, Washington, DC 20500",
	"350 Fifth Avenue, New York, NY 10118",
	"1 Infinite Loop, Cupertino, CA 95014",
]

/**
 * The piece text without SentencePiece's word-boundary marker.
 */
function core(piece: string): string {
	return piece.replaceAll("▁", "")
}

/**
 * The first code point outside ASCII.
 */
const NON_ASCII = 0x80

/**
 * Corpus lines this long or longer, in code points, are left out: they are run-on records rather than names.
 */
const MAX_LINE_CODE_POINTS = 80

/**
 * The int8 check accepts at most one mismatched value per this many in the reconstructed row.
 */
const QUANTIZE_MISMATCH_DIVISOR = 20

function isNonASCII(c: string): boolean {
	return c.codePointAt(0)! >= NON_ASCII
}

function isASCII(text: string): boolean {
	return ![...text].some(isNonASCII)
}

export interface SlavicCorpusOptions {
	oaRoot: string
	locales: readonly string[]
	outPath: string
	/**
	 * Rows read per OpenAddresses CSV.
	 *
	 * The read admits two rows past the cap, as the Python reader did.
	 */
	perFileCap?: number
	/**
	 * Extra corpus lines, such as gazetteer alias names, appended after the sample.
	 */
	extraText?: string | null
	/**
	 * How many times the extra lines repeat, so a list of single names has enough
	 * unigram mass to win vocabulary slots.
	 */
	extraRepeat?: number
}

/**
 * The distinct `STREET`, `CITY` and `STREET CITY` lines of each locale's OpenAddresses CSVs,
 * under 80 code points, shuffled and capped at 350,000, then the extra lines.
 * Returns the number of lines written.
 *
 * The files of a locale are read in name order and the lines kept in first-seen order,
 * so the corpus is the same on every run.
 */
export async function buildSlavicCorpus(options: SlavicCorpusOptions): Promise<number> {
	const perFileCap = options.perFileCap ?? 400_000
	const lines = new Set<string>()

	for (const locale of options.locales) {
		const directory = `${options.oaRoot}/${locale}`

		if (!(await isDirectory(directory))) continue
		const names = await Globerator.from("*.csv", { cwd: directory, absolute: false }).toSorted()

		for (const name of names) {
			try {
				const rows = CSVSpliterator.fromAsync<Record<string, string>>(`${directory}/${name}`, {
					normalizeKeys: false,
					take: perFileCap + 2,
				})

				for await (const row of rows) {
					const street = row["STREET"] || ""
					const city = row["CITY"] || ""

					if (street) {
						lines.add(street)
					}

					if (city) {
						lines.add(city)
					}

					if (street && city) {
						lines.add(`${street} ${city}`)
					}
				}
			} catch (error) {
				console.warn(`skipped the rest of ${directory}/${name}: ${(error as Error).message}`)
			}
		}
	}

	await using scratch = await temporaryDirectory("mtf-slavic-")
	const unshuffled = scratch.path("lines.json").toString()
	const shuffled = scratch.path("shuffled.json").toString()

	await writeLocalJSONFile(
		[...lines].filter((line) => line && codePointLength(line) < MAX_LINE_CODE_POINTS),
		unshuffled
	)

	await runMTFTokenizer(["shuffle", "--seed", String(CORPUS_SEED), "--input", unshuffled, "--out", shuffled])
	const corpus = (await readLocalJSONFile<string[]>(shuffled)).slice(0, CORPUS_SAMPLE)

	if (options.extraText && (await isFile(options.extraText))) {
		const extra = pythonSplitLines(await readLocalTextFile(options.extraText))
			.map(pythonStrip)
			.filter((line) => line && codePointLength(line) < MAX_LINE_CODE_POINTS)

		for (let i = 0; i < Math.max(1, options.extraRepeat ?? 10); i++) {
			corpus.push(...extra)
		}
	}

	await writeLocalTextFile(corpus.join("\n"), options.outPath)

	return corpus.length
}

/**
 * Train the locale unigram model the splice draws its pieces from, and return its `.model` path.
 */
export async function trainDiacriticSentencePiece(
	corpusPath: string,
	outPrefix: string,
	options: { spmTrain: string; vocabSize?: number }
): Promise<string> {
	await using scratch = await temporaryDirectory("mtf-diacritic-")

	const trained = await trainSentencePiece(
		{
			input: corpusPath,
			model_prefix: outPrefix,
			vocab_size: options.vocabSize ?? 24_000,
			model_type: "unigram",
			character_coverage: 1,
			normalization_rule_name: "identity",
			num_threads: 8,
		},
		{ spmTrain: options.spmTrain, workDirectory: scratch.path.toString() }
	)

	return trained.model
}

/**
 * Raise when `probe` tokenizes differently under the spliced vocabulary than under the base one.
 */
export async function verifySourceIdentical(
	baseTokenizer: string,
	splicedTokenizer: string,
	probe: readonly string[] = ENGLISH_PROBE
): Promise<void> {
	using base = await loadEncoder(baseTokenizer)
	using spliced = await loadEncoder(splicedTokenizer)

	const differing = probe.filter(
		(text) => base.encode(text).pieces.join("\0") !== spliced.encode(text).pieces.join("\0")
	)

	if (differing.length) {
		throw new Error(
			`source tokenization changed on ${differing.length}/${probe.length} probe strings: a piece containing ASCII ` +
				`was spliced in. First: ${stringifyJSON(differing[0])}`
		)
	}
}

/**
 * Append the pieces of `donor` whose core holds a code point outside ASCII and that `base`
 * lacks, with their scores, as normal pieces, then check the English identity.
 * Returns the appended pieces.
 */
export async function spliceVocabulary(base: string, donor: string, out: string): Promise<string[]> {
	const basePieces = new Set((await readModelPieces(base)).map(([piece]) => piece))

	const appended: VocabularyPiece[] = (await readModelPieces(donor))
		.filter(([piece]) => {
			const text = core(piece)

			return text && !isASCII(text) && !basePieces.has(piece)
		})
		.map(([piece, score]) => [piece, score, PieceType.Normal] as const)

	await makeDirectories(out.slice(0, out.lastIndexOf("/")) || ".")
	await editModel(base, out, { append: appended })
	await verifySourceIdentical(base, out)

	return appended.map(([piece]) => piece)
}

function byCodePoint(a: string, b: string): number {
	return a.codePointAt(0)! - b.codePointAt(0)!
}

const REPLACEMENT_CHARACTER = "�"

/**
 * The code points outside ASCII in the first `capBytes` of a locale sample,
 * read as UTF-8 with undecodable bytes ignored.
 * A character split by the byte cap is left out.
 *
 * The sample is read as raw text rather than parsed, because the check needs a locale's
 * character inventory and not its records, and any sample format then works.
 */
export async function collectSampleCodepoints(samplePath: string, capBytes = 4_000_000): Promise<Set<string>> {
	const bytes = await readFileRange(samplePath, 0, capBytes)
	// A streaming decode holds back an incomplete final sequence instead of replacing it.
	const text = new TextDecoder("utf-8").decode(bytes, { stream: true })
	const out = new Set<string>()

	for (const c of text) {
		if (isNonASCII(c)) {
			out.add(c)
		}
	}

	// The decoder replaces an invalid byte with U+FFFD, where Python's `errors="ignore"` drops it.
	if (!bytes.includes(Buffer.from(REPLACEMENT_CHARACTER))) {
		out.delete(REPLACEMENT_CHARACTER)
	}

	return out
}

export interface OverlapReport {
	new_piece_codepoints: string[]
	per_locale_overlap: Record<string, string[]>
	accepted_overlap: string[]
}

/**
 * Report the code points outside ASCII that the new pieces share with each trained locale's
 * sample, write the report, and raise when an overlapping locale is not in `acceptedOverlap`.
 *
 * Accepting a locale commits the evaluation to a registered per-locale non-inferiority
 * comparison for it before the first measurement.
 */
export async function checkCodepointOverlap(
	newPieces: readonly string[],
	localeSamples: Readonly<Record<string, string>>,
	reportPath: string,
	acceptedOverlap: ReadonlySet<string> = new Set()
): Promise<Record<string, string[]>> {
	const newCodepoints = new Set<string>()

	for (const piece of newPieces) {
		for (const c of core(piece)) {
			if (isNonASCII(c)) {
				newCodepoints.add(c)
			}
		}
	}

	const report: Record<string, string[]> = {}

	for (const locale of Object.keys(localeSamples).toSorted()) {
		const sample = await collectSampleCodepoints(localeSamples[locale]!)

		report[locale] = [...newCodepoints].filter((c) => sample.has(c)).toSorted(byCodePoint)
	}

	const written: OverlapReport = {
		new_piece_codepoints: [...newCodepoints].toSorted(byCodePoint),
		per_locale_overlap: report,
		accepted_overlap: [...acceptedOverlap].toSorted(),
	}

	await writeLocalTextFile(prettyJSON(written, true, 2), reportPath)

	const offending = Object.entries(report)
		.filter(([locale, codepoints]) => codepoints.length > 0 && !acceptedOverlap.has(locale))
		.map(([locale]) => locale)

	if (offending.length) {
		const detail = offending.map((locale) => `${locale}: ${report[locale]!.slice(0, 12).join("")}`).join("; ")

		throw new Error(
			`splice check: code point overlap with trained locale(s) ${offending.join(", ")} (${detail}). Either the ` +
				`overlap is a defect, or register a per-locale non-inferiority comparison for each and pass ` +
				`--accept-overlap ${offending.join(",")}. Report: ${reportPath}`
		)
	}

	return report
}

/**
 * The ONNX element type codes this module reads.
 */
const ONNX_FLOAT = 1
const ONNX_UINT8 = 2

interface Initializer {
	dims: number[]
	data_type: number
	bytes: Buffer
}

/**
 * Refuses a table initializer whose dims or byte length differ from `[rows, columns]` at `bytesPerValue`.
 *
 * @throws Naming the initializer, its dims and byte length, and the shape it was expected to have.
 */
export function assertTableShape(
	label: string,
	tensor: { dims: readonly number[]; bytes: Uint8Array },
	[rows, columns]: readonly [number, number],
	bytesPerValue: number
): void {
	const expectedBytes = rows * columns * bytesPerValue

	if (
		tensor.dims.length !== 2 ||
		tensor.dims[0] !== rows ||
		tensor.dims[1] !== columns ||
		tensor.bytes.length !== expectedBytes
	) {
		throw new Error(
			`${label} has dims [${tensor.dims.join(", ")}] and ${tensor.bytes.length} bytes; ` +
				`expected [${rows}, ${columns}] in ${expectedBytes} bytes`
		)
	}
}

async function readInitializer(model: string, name: string, directory: string): Promise<Initializer> {
	const raw = `${directory}/${name.replaceAll("/", "_")}.bin`

	const meta = await runMTFTokenizer<{ dims: number[]; data_type: number }>([
		"onnx-read",
		"--model",
		model,
		"--name",
		name,
		"--raw-out",
		raw,
	])

	return { ...meta, bytes: await readLocalBuffer(raw) }
}

async function writeInitializer(
	model: string,
	out: string,
	name: string,
	tensor: { dims: readonly number[]; data_type: number; bytes: Uint8Array },
	directory: string
): Promise<void> {
	const raw = `${directory}/${name.replaceAll("/", "_")}.out.bin`

	await writeLocalBuffer(tensor.bytes, raw)
	await makeDirectories(out.slice(0, out.lastIndexOf("/")) || ".")

	await runMTFTokenizer([
		"onnx-write",
		"--model",
		model,
		"--name",
		name,
		"--dims",
		tensor.dims.join(","),
		"--data-type",
		String(tensor.data_type),
		"--raw",
		raw,
		"--out",
		out,
	])
}

/**
 * The mean, in `float32`, of the rows of `table` at `rows`: each column summed row by row in
 * `float32`, then divided by the row count, which is how NumPy reduces `table[rows].mean(0)`.
 */
function meanRow(table: Float32Array, hidden: number, rows: readonly number[]): Float32Array {
	const out = new Float32Array(hidden)

	for (let j = 0; j < hidden; j++) {
		let sum = table[rows[0]! * hidden + j]!

		for (let r = 1; r < rows.length; r++) {
			sum = Math.fround(sum + table[rows[r]! * hidden + j]!)
		}

		out[j] = Math.fround(sum / rows.length)
	}

	return out
}

/**
 * NumPy's `np.round` for one value: to the nearest integer, ties to even.
 */
function roundHalfEven(value: number): number {
	const floor = Math.floor(value)
	const fraction = value - floor

	if (fraction > 0.5) return floor + 1

	if (fraction < 0.5) return floor

	return floor % 2 === 0 ? floor : floor + 1
}

function quantize(value: number, scale: number, zeroPoint: number): number {
	const scaled = Math.fround(value / scale)

	return Math.min(255, Math.max(0, Math.fround(roundHalfEven(scaled) + zeroPoint)))
}

export interface ONNXMeanInitOptions {
	fp32ONNX: string
	baseTokenizer: string
	splicedTokenizer: string
	outFp32: string
	int8ONNX?: string | null
	outInt8?: string | null
	embeddingName?: string
}

/**
 * Grow an exported model's token embedding table to the spliced vocabulary.
 *
 * Each new row is the mean of the base tokenizer's pieces for the new piece's surface (FVT),
 * or the mean of every row when the surface has no piece inside the old vocabulary.
 * The embedding is the only vocabulary-sized tensor of the token classifier,
 * so the rest of the graph is unchanged.
 *
 * For an int8 twin the new rows are quantized with the table's own scale and zero point,
 * after checking that those parameters reproduce the table's last row.
 */
export async function meanInitONNXEmbeddings(options: ONNXMeanInitOptions): Promise<[number, number]> {
	const name = options.embeddingName ?? "inner.token_embeddings.weight"

	await using scratch = await temporaryDirectory("mtf-mean-init-")
	const directory = scratch.path.toString()
	const embedding = await readInitializer(options.fp32ONNX, name, directory)

	if (embedding.data_type !== ONNX_FLOAT || embedding.dims.length !== 2) {
		throw new Error(`${name} in ${options.fp32ONNX} is not a float32 matrix`)
	}

	const [oldVocab, hidden] = embedding.dims as [number, number]

	// A short `raw_data` would read as a table of zeros past its end, and every spliced row would average them in.
	assertTableShape(`${name} in ${options.fp32ONNX}`, embedding, [oldVocab, hidden], Float32Array.BYTES_PER_ELEMENT)

	// A copy, because a `Float32Array` view needs a 4-byte-aligned offset that a read buffer need not have.
	const table = new Float32Array(new Uint8Array(embedding.bytes).buffer, 0, oldVocab * hidden)
	const spliced = await readModelPieces(options.splicedTokenizer)
	const newVocab = spliced.length

	if (newVocab < oldVocab) {
		throw new Error(`spliced vocab ${newVocab} < embedding vocab ${oldVocab}: wrong tokenizer?`)
	}

	const globalMean = meanRow(
		table,
		hidden,
		Array.from({ length: oldVocab }, (_, i) => i)
	)

	const newRows = new Float32Array((newVocab - oldVocab) * hidden)

	{
		using base = await loadEncoder(options.baseTokenizer)

		for (let id = oldVocab; id < newVocab; id++) {
			const surface = spliced[id]![0].replaceAll("▁", " ")
			const constituents = base.encode(surface).ids.filter((i) => i < oldVocab)

			newRows.set(constituents.length ? meanRow(table, hidden, constituents) : globalMean, (id - oldVocab) * hidden)
		}
	}

	const grown = new Float32Array(newVocab * hidden)

	grown.set(table)
	grown.set(newRows, oldVocab * hidden)

	await writeInitializer(
		options.fp32ONNX,
		options.outFp32,
		name,
		{ dims: [newVocab, hidden], data_type: ONNX_FLOAT, bytes: new Uint8Array(grown.buffer) },
		directory
	)

	if (options.int8ONNX && options.outInt8) {
		const quantized = await readInitializer(options.int8ONNX, `${name}_quantized`, directory)
		const scaleTensor = await readInitializer(options.int8ONNX, `${name}_scale`, directory)
		const zeroTensor = await readInitializer(options.int8ONNX, `${name}_zero_point`, directory)

		if (quantized.data_type !== ONNX_UINT8) throw new Error(`${name}_quantized is not a uint8 table`)

		// The int8 table must describe the same vocabulary and width as the fp32 one, or the grown table mixes rows.
		assertTableShape(`${name}_quantized in ${options.int8ONNX}`, quantized, [oldVocab, hidden], 1)

		if (scaleTensor.bytes.length < Float32Array.BYTES_PER_ELEMENT || !zeroTensor.bytes.length) {
			throw new Error(`${name}_scale or ${name}_zero_point in ${options.int8ONNX} holds no value`)
		}

		const scale = scaleTensor.bytes.readFloatLE(0)
		const zeroPoint = zeroTensor.bytes[0]!
		const lastRow = oldVocab - 1
		let mismatched = 0

		for (let j = 0; j < hidden; j++) {
			if (quantize(table[lastRow * hidden + j]!, scale, zeroPoint) !== quantized.bytes[lastRow * hidden + j]) {
				mismatched++
			}
		}

		// Up to one value in twenty may sit on the other side of a rounding boundary.
		// More means the wrong scale or zero point.
		if (mismatched > Math.floor(hidden / QUANTIZE_MISMATCH_DIVISOR)) {
			throw new Error(`int8 inverse mismatch on row ${lastRow}: ${mismatched}/${hidden}; scale or zero point wrong?`)
		}

		const grownQuantized = new Uint8Array(newVocab * hidden)

		grownQuantized.set(quantized.bytes.subarray(0, oldVocab * hidden))

		for (let i = 0; i < newRows.length; i++) {
			grownQuantized[oldVocab * hidden + i] = quantize(newRows[i]!, scale, zeroPoint)
		}

		await writeInitializer(
			options.int8ONNX,
			options.outInt8,
			`${name}_quantized`,
			{ dims: [newVocab, hidden], data_type: quantized.data_type, bytes: grownQuantized },
			directory
		)
	}

	return [oldVocab, newVocab]
}
