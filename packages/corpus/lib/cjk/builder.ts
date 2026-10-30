/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The pieces every CJK corpus assembler shares, ported from the Python builders' `corpora/builder.py`: the
 *   corpus schema and writer, the row renderer, the hold-out bucket, the exact selector, the water-fill quota, the
 *   record check, the coverage report and the character vocabulary.
 *
 *   Every offset is a code-point offset, as the Python builders wrote them. A CJK row can hold a character outside
 *   the Basic Multilingual Plane, which JavaScript counts as two code units.
 */

import { readLocalJSONFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { md5Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { pyRound, pySum } from "@mailwoman/core/numeric"
import { repoRootPath } from "@mailwoman/core/paths"
import type { SeededRandom } from "@mailwoman/core/random"
import { countInto, mostCommon } from "@mailwoman/core/stats"
import { codePointLength } from "@mailwoman/core/strings/code-points"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"
import { isWhitespaceCharacter, splitWhitespace } from "@mailwoman/core/strings/unicode"
import { type PathBuilderLike, resolvePath } from "path-ts"

import { normalizeCJKText } from "#cjk/text"
import { readParquetRows } from "#parquet/readers"
import { ParquetColumnKind, type ParquetColumns, writeColumnParquetFile } from "#parquet/writers"
import { stampRowLicenses } from "#source-register/row-license"
import { pythonRepr } from "#training/config/python-yaml"

/**
 * The columns of a CJK corpus parquet file, in file order.
 */
export const CJK_CORPUS_COLUMNS: ParquetColumns = [
	["raw", ParquetColumnKind.String],
	["tokens", ParquetColumnKind.StringList],
	["labels", ParquetColumnKind.StringList],
	["span_starts", ParquetColumnKind.Int32List],
	["span_ends", ParquetColumnKind.Int32List],
	["span_tags", ParquetColumnKind.StringList],
	["country", ParquetColumnKind.String],
	["source", ParquetColumnKind.String],
	["license", ParquetColumnKind.String],
	["register", ParquetColumnKind.String],
]

/**
 * One labeled CJK corpus row.
 */
export interface CJKRecord {
	raw: string
	tokens: string[]
	labels: string[]
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	country: string
	source: string
	register: string
}

/**
 * Writes rows as one corpus parquet file, each `license` set to its source's register license id.
 *
 * @throws Before writing, when a row's source has no license id.
 */
export async function writeCJKCorpusParquet(
	rows: readonly CJKRecord[],
	path: PathBuilderLike,
	context: string,
	columns: ParquetColumns = CJK_CORPUS_COLUMNS
): Promise<void> {
	await writeColumnParquetFile(await stampRowLicenses(rows, context), columns, path)
}

/**
 * Which rows of a split {@linkcode writeCJKSplit} counts coverage over.
 */
export const CJKStatsSample = {
	/**
	 * The first `n` records of every part, as the label corpora count them.
	 */
	FirstOfEachPart: "first-of-each-part",
	/**
	 * The first `n` records of the split, as the KR registry corpus counts them.
	 */
	FirstOfSplit: "first-of-split",
} as const

export type CJKStatsSample = (typeof CJKStatsSample)[keyof typeof CJKStatsSample]

/**
 * Options for {@linkcode writeCJKSplit}.
 */
export interface WriteCJKSplitOptions<T> {
	/**
	 * The split's directory, created when absent.
	 */
	directory: PathBuilderLike
	rows: readonly T[]
	rowsPerPart: number
	/**
	 * Encodes one part's rows, in order.
	 *
	 * A builder whose encoder draws from a generator encodes the part in one call,
	 * so the draws follow the part order.
	 */
	encodePart: (rows: readonly T[]) => CJKRecord[]
	/**
	 * The part file name's prefix: `part` writes `part-0000.parquet`.
	 */
	partPrefix: string
	/**
	 * The context named in a refused license stamp.
	 */
	context: string
	statsSample: { kind: CJKStatsSample; rows: number }
}

/**
 * One written split's row and part counts and the coverage over its sampled records.
 */
export interface CJKSplitReport {
	rows: number
	parts: number
	coverage: CoverageStats
}

/**
 * Writes one split as parquet parts of `rowsPerPart` rows each, and counts its coverage.
 */
export async function writeCJKSplit<T>(options: WriteCJKSplitOptions<T>): Promise<CJKSplitReport> {
	if (!Number.isInteger(options.rowsPerPart) || options.rowsPerPart < 1) {
		throw new Error(`rowsPerPart must be a positive integer, got ${options.rowsPerPart}`)
	}

	await makeDirectories(options.directory)

	const sampled: CJKRecord[] = []
	let parts = 0
	let rows = 0

	for (let start = 0; start < options.rows.length; start += options.rowsPerPart) {
		const records = options.encodePart(options.rows.slice(start, start + options.rowsPerPart))
		const name = `${options.partPrefix}-${String(parts).padStart(4, "0")}.parquet`

		await writeCJKCorpusParquet(records, resolvePath(options.directory, name), options.context)

		parts++
		rows += records.length

		if (options.statsSample.kind === CJKStatsSample.FirstOfEachPart) {
			sampled.push(...records.slice(0, options.statsSample.rows))
		} else if (sampled.length < options.statsSample.rows) {
			sampled.push(...records.slice(0, options.statsSample.rows - sampled.length))
		}
	}

	return { rows, parts, coverage: coverageStats(sampled) }
}

/**
 * The longest field value a renderer keeps.
 */
export const MAX_FIELD_CHARS = 64

/**
 * The longest rendered row, in code points, the character model reads without truncation.
 */
export const MAX_RENDERED_CHARS = 96

/**
 * Builds a row's raw text and its spans, one tagged field or untagged glue at a time.
 */
export class RowRenderer {
	raw = ""
	starts: number[] = []
	ends: number[] = []
	tags: string[] = []
	#length = 0

	/**
	 * Appends a tagged field.
	 * An empty field leaves the row unchanged.
	 */
	put(tag: string, text: string): void {
		if (!text) return

		this.starts.push(this.#length)
		this.glue(text)
		this.ends.push(this.#length)
		this.tags.push(tag)
	}

	/**
	 * Appends untagged text.
	 */
	glue(text: string): void {
		this.raw += text
		this.#length += codePointLength(text)
	}

	/**
	 * The code-point length of the text so far.
	 */
	get length(): number {
		return this.#length
	}
}

/**
 * The legacy token columns of a span-labeled row: each whitespace token of `raw`,
 * labeled `B-<tag>` with the span its first character falls in, or `O` when none covers it.
 *
 * The character path ignores them, and the corpus schema requires them.
 */
export function labelTokensByFirstSpan(
	raw: string,
	starts: readonly number[],
	ends: readonly number[],
	tags: readonly string[]
): { tokens: string[]; labels: string[] } {
	const tokens: string[] = []
	const labels: string[] = []
	let cursor = 0

	for (const token of splitWhitespace(raw)) {
		const found = raw.indexOf(token, cursor)
		const index = codePointLength(raw.slice(0, found))

		cursor = found + token.length

		const span = starts.findIndex((start, i) => start <= index && index < ends[i]!)

		tokens.push(token)
		labels.push(span === -1 ? "O" : `B-${tags[span]}`)
	}

	return { tokens, labels }
}

/**
 * The separator between the parts of a composite key, written as an escape
 * so no NUL byte enters the source.
 *
 * A space cannot serve, because a 시군구 is written with one (`수원시 장안구`),
 * and `unitKey("A", "B C")` would collide with `unitKey("A B", "C")`.
 */
export const UNIT_SEPARATOR = "\0"

/**
 * The parts of a composite key, joined so no two different part lists produce the same key.
 */
export function unitKey(...parts: readonly string[]): string {
	return parts.join(UNIT_SEPARATOR)
}

/**
 * Adds `value` to the set a key set holds under `key`, starting the set when the key is new.
 */
export function addToKeySet(map: Map<string, Set<string>>, key: string, value: string): void {
	const set = map.get(key)

	if (set) {
		set.add(value)
	} else {
		map.set(key, new Set([value]))
	}
}

const BUCKETS = 100n

/**
 * A unit's hold-out bucket in [0, 100): its normalized name's MD5, read as an integer, modulo 100.
 */
export function muniBucket(unit: string): number {
	return Number(BigInt(`0x${md5Hex(normalizeCJKText(unit))}`) % BUCKETS)
}

/**
 * Yields one decision per item of a pass over `count` items, taking exactly `min(quota, count)` of them.
 *
 * Each item is taken with probability `remaining quota / remaining items`, drawn from `rng`.
 * No draw is made once the quota is filled, so the draw count depends on where the quota fills.
 */
export function* selectExact(count: number, quota: number, rng: SeededRandom): Generator<boolean, void, undefined> {
	let remainingQuota = Math.min(quota, count)
	let remaining = count

	for (let index = 0; index < count; index++) {
		const take = remainingQuota > 0 && rng.random() < remainingQuota / remaining

		if (take) {
			remainingQuota--
		}

		remaining--

		yield take
	}
}

/**
 * Takes the next decision from a selector.
 *
 * @throws When the selector is exhausted, because a second pass met more items than the first counted.
 */
export function nextSelection(selector: Iterator<boolean>): boolean {
	const step = selector.next()

	if (step.done) throw new Error("the selection pass met more rows than the census counted")

	return step.value
}

/**
 * The largest per-group cap whose capped total stays within `target`.
 */
export function waterFill(counts: ReadonlyMap<string, number>, target: number): number {
	if (!counts.size) return 0

	let low = 0
	let high = Math.max(...counts.values())

	while (low < high) {
		const mid = Math.floor((low + high + 1) / 2)
		let total = 0

		for (const n of counts.values()) {
			total += Math.min(mid, n)
		}

		if (total <= target) {
			low = mid
		} else {
			high = mid - 1
		}
	}

	return low
}

/**
 * Each group's quota under a water-filled cap, with the remainder up to `target` granted to the groups
 * with the most headroom first, so the quotas total `target` whenever the pool holds that many.
 */
export function waterFillQuotas(
	poolCounts: ReadonlyMap<string, number>,
	target: number
): { cap: number; quotas: Map<string, number> } {
	const cap = waterFill(poolCounts, target)
	const quotas = new Map([...poolCounts].map(([group, count]) => [group, Math.min(cap, count)]))
	let shortfall = target - pySum(quotas.values())

	if (shortfall > 0) {
		const headroom = (group: string) => poolCounts.get(group)! - quotas.get(group)!

		for (const group of [...poolCounts.keys()].toSorted((a, b) => headroom(b) - headroom(a))) {
			const grant = Math.min(headroom(group), shortfall)

			quotas.set(group, quotas.get(group)! + grant)
			shortfall -= grant

			if (shortfall <= 0) break
		}
	}

	return { cap, quotas }
}

/**
 * The per-character BIO array of `raw` from code-point spans.
 *
 * @throws When the span arrays differ in length, or a span is out of bounds, unsorted or overlapping.
 */
export function charLabelArrayFromSpans(
	raw: string,
	starts: readonly number[],
	ends: readonly number[],
	tags: readonly string[]
): string[] {
	if (ends.length !== starts.length || tags.length !== starts.length) {
		throw new Error(`span arrays length mismatch: starts=${starts.length} ends=${ends.length} tags=${tags.length}`)
	}

	const length = codePointLength(raw)
	const out = Array.from({ length }, () => "O")
	let previousStart = -1
	let previousEnd = 0

	for (const [index, start] of starts.entries()) {
		const end = ends[index]!
		const tag = tags[index]!

		if (!(start >= 0 && start < end && end <= length)) {
			throw new Error(
				`span out of bounds: ${tag}@[${start}, ${end}) over raw of length ${length}: ${stringifyJSON(raw)}`
			)
		}

		if (start < previousStart) {
			throw new Error(`spans not sorted: ${tag}@[${start}, ${end}) after [${previousStart}, ${previousEnd})`)
		}

		if (start < previousEnd) {
			throw new Error(`spans overlap: ${tag}@[${start}, ${end}) overlaps [${previousStart}, ${previousEnd})`)
		}

		out[start] = `B-${tag}`

		for (let position = start + 1; position < end; position++) {
			out[position] = `I-${tag}`
		}

		previousStart = start
		previousEnd = end
	}

	return out
}

/**
 * Options for {@linkcode verifyRecord}.
 */
export interface VerifyRecordOptions {
	labelSetName: string
	/**
	 * @defaultValue {@linkcode MAX_RENDERED_CHARS}
	 */
	maxRenderedChars?: number
	/**
	 * @defaultValue true
	 */
	forbidWhitespace?: boolean
}

/**
 * A record {@linkcode verifyRecord} refuses for one of its own checks.
 *
 * Its message begins with the defect's kind, before the first colon, so a builder
 * that counts refusals groups them by that prefix.
 * Spans the label array refuses throw a plain `Error` instead.
 */
export class RecordCheckError extends Error {
	override name = "RecordCheckError"
}

/**
 * Refuses a record that would train badly: no span, too long to read whole, a tag outside the label set,
 * an empty span, whitespace inside a span when forbidden, or spans the label array refuses.
 *
 * Each message quotes text as Python's `repr` does, the messages the Python builders wrote.
 *
 * @throws {@linkcode RecordCheckError} On the first such defect, naming it.
 */
export function verifyRecord(
	record: Pick<CJKRecord, "raw" | "span_starts" | "span_ends" | "span_tags">,
	tagSet: ReadonlySet<string>,
	options: VerifyRecordOptions
): void {
	const { raw } = record
	const characters = [...raw]
	const max = options.maxRenderedChars ?? MAX_RENDERED_CHARS
	const quoted = pythonRepr(raw)

	if (!record.span_tags.length) throw new RecordCheckError(`all-O row: ${quoted}`)

	if (characters.length > max) {
		throw new RecordCheckError(`row of ${characters.length} chars exceeds S=${max} and would truncate: ${quoted}`)
	}

	for (const [index, tag] of record.span_tags.entries()) {
		const start = record.span_starts[index]!
		const end = record.span_ends[index]!

		if (!tagSet.has(tag)) {
			throw new RecordCheckError(
				`tag ${pythonRepr(tag)} is outside ${options.labelSetName} — it would collapse to O at load`
			)
		}

		const text = characters.slice(start, end)

		if (!text.length) throw new RecordCheckError(`empty span ${tag}@[${start},${end}) in ${quoted}`)

		if ((options.forbidWhitespace ?? true) && text.some(isWhitespaceCharacter)) {
			throw new RecordCheckError(`whitespace inside span ${tag}@[${start},${end}): ${pythonRepr(text.join(""))}`)
		}
	}

	charLabelArrayFromSpans(raw, record.span_starts, record.span_ends, record.span_tags)
}

/**
 * The label set every Korean, Taiwanese and CJK-overlay row is checked against.
 */
export const CJK_LABEL_SET_NAME = "stage3-cjk"

/**
 * {@linkcode verifyRecord} under {@linkcode CJK_LABEL_SET_NAME}, with whitespace allowed inside a span.
 */
export function verifyCJKRecord(
	record: Pick<CJKRecord, "raw" | "span_starts" | "span_ends" | "span_tags">,
	tagSet: ReadonlySet<string>
): void {
	verifyRecord(record, tagSet, { labelSetName: CJK_LABEL_SET_NAME, forbidWhitespace: false })
}

/**
 * The tags of a label set, read from the label schema `@mailwoman/neural` emits.
 *
 * The schema is read as data, because `@mailwoman/neural` depends on `@mailwoman/gazetteer`,
 * which depends on this package.
 *
 * @throws When the schema names no such label set.
 */
export async function readLabelSetTags(name: string): Promise<Set<string>> {
	const path = repoRootPath("packages", "neural", "data", "label-schema.v1.json")
	const schema = await readLocalJSONFile<{ label_sets: Record<string, { tags: string[] }> }>(path)
	const set = schema.label_sets[name]

	if (!set) {
		throw new Error(
			`unknown label_set ${stringifyJSON(name)} in ${path.toString()} (expected one of ${Object.keys(schema.label_sets).toSorted().join(", ")})`
		)
	}

	return new Set(set.tags)
}

const ranked = (counts: ReadonlyMap<string, number>): Map<string, number> => new Map(mostCommon(counts))

/**
 * A corpus split's coverage report, in the key order the Python builders wrote.
 */
export interface CoverageStats {
	rows: number
	bio_char_coverage_all: number
	bio_char_coverage_significant: number
	raw_len_min_median_max: [number, number, number] | null
	registers: Map<string, number>
	per_tag_rows: Map<string, number>
	per_tag_spans: Map<string, number>
	per_tag_chars: Map<string, number>
	per_label_chars: Map<string, number>
}

const COVERAGE_DIGITS = 6

/**
 * Rows, labeled-character coverage, lengths and per-tag and per-label counts over `records`.
 *
 * `per_tag_rows` counts each tag once per row, in the order the tag first appears in the row.
 * The Python report counted from a set, so its tie order followed `PYTHONHASHSEED`.
 */
export function coverageStats(
	records: Iterable<Pick<CJKRecord, "raw" | "span_starts" | "span_ends" | "span_tags" | "register">>
): CoverageStats {
	const perTagRows = new Map<string, number>()
	const perTagSpans = new Map<string, number>()
	const perTagChars = new Map<string, number>()
	const perLabel = new Map<string, number>()
	const registers = new Map<string, number>()
	const lengths: number[] = []
	let labeled = 0
	let total = 0
	let significant = 0
	let rows = 0

	for (const record of records) {
		rows++
		countInto(registers, record.register)

		const characters = [...record.raw]
		const array = charLabelArrayFromSpans(record.raw, record.span_starts, record.span_ends, record.span_tags)

		lengths.push(characters.length)

		for (const label of array) {
			countInto(perLabel, label)
		}

		total += characters.length
		significant += characters.filter((character) => !isWhitespaceCharacter(character) && character !== "〒").length
		labeled += array.filter((label) => label !== "O").length

		for (const tag of new Set(record.span_tags)) {
			countInto(perTagRows, tag)
		}

		for (const [index, tag] of record.span_tags.entries()) {
			countInto(perTagSpans, tag)
			countInto(perTagChars, tag, record.span_ends[index]! - record.span_starts[index]!)
		}
	}

	lengths.sort((a, b) => a - b)

	return {
		rows,
		bio_char_coverage_all: total ? pyRound(labeled / total, COVERAGE_DIGITS) : 0,
		bio_char_coverage_significant: significant ? pyRound(labeled / significant, COVERAGE_DIGITS) : 0,
		raw_len_min_median_max: lengths.length
			? [lengths[0]!, lengths[Math.floor(lengths.length / 2)]!, lengths.at(-1)!]
			: null,
		registers: ranked(registers),
		per_tag_rows: ranked(perTagRows),
		per_tag_spans: ranked(perTagSpans),
		per_tag_chars: ranked(perTagChars),
		per_label_chars: ranked(perLabel),
	}
}

/**
 * The id of the padding character.
 */
export const PAD_CHAR_ID = 0

/**
 * The id of an unknown character.
 */
export const UNK_CHAR_ID = 1

/**
 * A character vocabulary: `<pad>` and `<unk>`, then every character seen at least
 * `minCount` times in code-point order, numbered from 2.
 */
export function buildCharVocab(texts: Iterable<string>, minCount = 1): Map<string, number> {
	const counts = new Map<string, number>()

	for (const text of texts) {
		for (const character of text) {
			countInto(counts, character)
		}
	}

	return sealCharacters([...counts].filter(([, n]) => n >= minCount).map(([character]) => character))
}

/**
 * The vocabulary of characters seen at least twice in a corpus's train split, written as `name` beside it.
 *
 * Each corpus seals its own from its own train parts, read in code-point order of their paths.
 */
export async function sealCharVocab(corpusDirectory: PathBuilderLike, name: string): Promise<Map<string, number>> {
	const raws: string[] = []

	for (const path of await sortedGlob(resolvePath(corpusDirectory, "train"), "*.parquet")) {
		for (const row of await readParquetRows<{ raw: string }>(path, { columns: ["raw"] })) {
			raws.push(row.raw)
		}
	}

	const vocab = buildCharVocab(raws, 2)

	await saveCharVocab(vocab, resolvePath(corpusDirectory, name))

	return vocab
}

/**
 * Reads a character vocabulary a builder wrote.
 *
 * The object's key order is not the vocabulary's order, because JSON parsing
 * lists integer-like keys such as `"1"` first.
 * A caller reads its characters and size, and orders them itself.
 *
 * @throws When the file is missing, or holds anything other than an object of integer ids.
 */
export async function loadCharVocab(path: PathBuilderLike): Promise<Record<string, number>> {
	const loaded = await readLocalJSONFile<unknown>(path)

	if (
		typeof loaded !== "object" ||
		loaded === null ||
		Array.isArray(loaded) ||
		!Object.values(loaded).every((id) => Number.isSafeInteger(id))
	) {
		throw new TypeError(`char vocab ${path.toString()} is not an object of integer ids`)
	}

	return loaded as Record<string, number>
}

/**
 * A vocabulary of `<pad>`, `<unk>` and `characters` in code-point order,
 * numbered from 2, the seal {@linkcode buildCharVocab} writes.
 */
export function sealCharacters(characters: Iterable<string>): Map<string, number> {
	const vocab = new Map<string, number>([
		["<pad>", PAD_CHAR_ID],
		["<unk>", UNK_CHAR_ID],
	])

	let next = 2

	for (const character of new Set(characters)
		.difference(new Set(["<pad>", "<unk>"]))
		.values()
		.toArray()
		.toSorted(compareByScalarValue)) {
		vocab.set(character, next++)
	}

	return vocab
}

/**
 * Writes a vocabulary as tab-indented JSON with one entry per line and a trailing newline,
 * the bytes the Python builders wrote and the model card pins.
 */
export async function saveCharVocab(vocab: ReadonlyMap<string, number>, path: PathBuilderLike): Promise<void> {
	const lines = [...vocab].map(([character, id]) => `\t${stringifyJSON(character)}: ${id}`)

	await writeLocalTextFile(`{\n${lines.join(",\n")}\n}\n`, path)
}
