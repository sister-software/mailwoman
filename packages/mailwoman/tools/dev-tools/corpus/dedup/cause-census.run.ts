/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reports which fields distinguish the rows an adapter's dedup key collapses onto one another.
 *
 *   A build's `MANIFEST.json` reports `deduped` per adapter and never says what the key dropped.
 *   `canonicalDedupKey` keys a row on `country`, the normalized `raw` line and the `components`
 *   dictionary, so two records that render the same line collapse however much else the publisher
 *   distinguished them by. This census names that else.
 *
 *   It complements `dedup-census.run.ts`, which reads a built `canonical.jsonl` and splits the
 *   duplicates still in that file by whether the runner's capped dedup set held their key. That
 *   question is about the runner's key capacity. This one is about the key's resolution, and it needs
 *   the rows the runner refused, which a `canonical.jsonl` written by a run that deduplicated
 *   completely no longer holds. So the default row source is the adapter itself, re-run over the same
 *   input the build read.
 *
 *   Two reports come out of it.
 *
 *   The canonical-field report covers every row source. It groups the rows by `canonicalDedupKey` and
 *   counts, per `CanonicalRow` field outside the key, how many collapsed groups hold more than one
 *   value of that field. The fields the runner stamps after the adapter yields — `addressRole`,
 *   `register`, `surface`, `corpus_version` — are the adapter's constants under `--adapter`, so they
 *   read as identical whatever the build wrote.
 *
 *   The source-column report needs `--source-csv` and `--id-column`. It joins each collapsed group
 *   back to the publisher's own records and counts, per source column, how many groups hold more than
 *   one value of that column. The join is on `source_id`: the tool hashes `<id-prefix><id-column
 *   value>` and looks for that hash among the `source_id` values of the rows in collapsed groups,
 *   where `--id-prefix` defaults to `<adapter>-`. An adapter that composes `source_id` some other way
 *   needs its own prefix. The tool reports how many source records joined and refuses a run where
 *   none did, so a wrong prefix shows up as an error rather than as an empty answer. Beside each
 *   column's group count it reports how many records of the whole file carry a non-empty value there,
 *   because a column that differs in no group may be constant within every group or empty throughout.
 *
 *   **Hashes rather than keys.** The distinct-key count of a national register exceeds what a V8
 *   `Set` holds, so group identity is the low 64 bits of the dedup key's MD5 digest and a field's
 *   identity within a group is a 32-bit FNV-1a hash of its value. A 64-bit collision merges two
 *   unrelated groups, and over 10 million keys its probability is about 2.7e-12. A 32-bit collision
 *   hides a real difference in one field of one group, at about 2.3e-10 per comparison. Neither rate
 *   changes a per-column group count that runs to the thousands, and a reader checking one group
 *   should read the printed example records rather than the counts.
 *
 *   Usage:
 *
 *       node --max-old-space-size=8192 \
 *         packages/mailwoman/tools/dev-tools/corpus/dedup/cause-census.run.ts \
 *         --adapter ryhti --input /mnt/mw/corpus/sources/ryhti/open_address.csv \
 *         --source-csv /mnt/mw/corpus/sources/ryhti/open_address.csv --id-column address_key
 *
 *       node --max-old-space-size=8192 \
 *         packages/mailwoman/tools/dev-tools/corpus/dedup/cause-census.run.ts \
 *         --canonical <build>/intermediate/<adapter>/canonical.jsonl
 *
 *   `--limit` caps the rows the adapter emits, which makes the run a prefix of the file rather than a
 *   sample of it: a group whose members straddle the cap is reported with the members below it.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { md5Bytes } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { defaultAdapterRegistry } from "@mailwoman/corpus"
import { canonicalDedupKey } from "@mailwoman/corpus/adapters/dedup-key"
import type { CanonicalRow } from "@mailwoman/corpus/types"
import { PathBuilder } from "path-ts"
import { CSVSpliterator, JSONSpliterator } from "spliterator"

/**
 * The `CanonicalRow` fields that sit outside the dedup key.
 *
 * `raw`, `components`, `country` and `recipe` are the key, so they are identical across a
 * collapsed group by construction and reporting them would state the definition back.
 */
const TRACKED_FIELDS = [
	"source",
	"source_id",
	"license",
	"locale",
	"addressRole",
	"register",
	"surface",
	"corpus_version",
] as const

/**
 * How many group sizes the size table prints before summarizing the tail.
 */
const SIZE_ROWS = 15

const { values } = parseArguments({
	options: {
		adapter: { type: "string", description: "Adapter id to re-run, resolved against the default registry" },
		input: { type: "string", description: "The adapter's input, the same path the build read" },
		canonical: { type: "string", description: "A built `canonical.jsonl` to read instead of re-running an adapter" },
		country: { type: "string", description: "An ISO 3166-1 alpha-2 filter passed to the adapter" },
		limit: { type: "string", description: "Cap on rows the adapter emits" },
		"source-csv": { type: "string", description: "The publisher's CSV, joined to each collapsed group" },
		"column-delimiter": { type: "string", description: "The source CSV's column delimiter (default `,`)" },
		"id-column": { type: "string", description: "The source column whose value the adapter put in `source_id`" },
		"id-prefix": { type: "string", description: "What `source_id` prefixes that value with (default `<adapter>-`)" },
		examples: { type: "string", description: "How many collapsed groups to print in full (default 3)" },
	},
})

/**
 * The low 64 bits of a value's MD5 digest, used for group identity and for the `source_id` join.
 *
 * The digest comes from `md5Bytes`, the same hash `FingerprintSet` fingerprints a dedup
 * key with, so the census and the runner agree on what makes two keys the same value.
 * A per-character FNV-1a in `BigInt` arithmetic allocates a `BigInt` per character
 * of every key, which dominates the pass.
 * This allocates two per key.
 */
function hash64(value: string): bigint {
	const digest = md5Bytes(value)

	return (BigInt(digest.readUInt32LE(0)) << 32n) | BigInt(digest.readUInt32LE(4))
}

/**
 * A 32-bit FNV-1a hash, used to compare one field's value across a group's rows.
 *
 * The returned value is never 0, so an unfilled slot stays distinguishable from a hashed value.
 */
function hash32(value: string): number {
	let hash = 0x81_1c_9d_c5

	for (let index = 0; index < value.length; index++) {
		hash = (hash ^ value.charCodeAt(index)) >>> 0
		hash = Math.imul(hash, 0x01_00_01_93) >>> 0
	}

	return hash === 0 ? 1 : hash
}

/**
 * A growable array of 64-bit values.
 *
 * `BigUint64Array` has a fixed length and the row count is unknown before the first pass.
 */
class HashList {
	#data = new BigUint64Array(1 << 20)
	#length = 0

	push(value: bigint): void {
		if (this.#length === this.#data.length) {
			const grown = new BigUint64Array(this.#data.length * 2)

			grown.set(this.#data)
			this.#data = grown
		}

		this.#data[this.#length++] = value
	}

	get length(): number {
		return this.#length
	}

	filled(): BigUint64Array {
		return this.#data.subarray(0, this.#length)
	}
}

/**
 * A growable array of 32-bit values, kept parallel to a {@linkcode HashList}.
 */
class SlotList {
	#data = new Uint32Array(1 << 20)
	#length = 0

	push(value: number): void {
		if (this.#length === this.#data.length) {
			const grown = new Uint32Array(this.#data.length * 2)

			grown.set(this.#data)
			this.#data = grown
		}

		this.#data[this.#length++] = value
	}

	get length(): number {
		return this.#length
	}

	filled(): Uint32Array {
		return this.#data.subarray(0, this.#length)
	}
}

/**
 * The index of `value` in an ascending array, or -1.
 */
function indexOfSorted(sorted: BigUint64Array, value: bigint): number {
	let low = 0
	let high = sorted.length - 1

	while (low <= high) {
		const middle = (low + high) >>> 1
		const at = sorted[middle]!

		if (at === value) return middle

		if (at < value) {
			low = middle + 1
		} else {
			high = middle - 1
		}
	}

	return -1
}

/**
 * The lowest index in an ascending array whose value equals `value`, or -1.
 *
 * The join array holds one entry per row in a collapsed group, so one `source_id` hash
 * can appear more than once and a caller needs the first of them.
 */
function lowerBoundOfSorted(sorted: BigUint64Array, value: bigint): number {
	const found = indexOfSorted(sorted, value)

	if (found < 0) return -1

	let at = found

	while (at > 0 && sorted[at - 1] === value) {
		at--
	}

	return at
}

/**
 * One census run's configuration, after the flags have been checked against each other.
 */
interface CensusPlan {
	adapterID?: string
	inputPath?: string
	canonicalPath?: string
	country?: string
	limit?: number
	sourceCSVPath?: string
	idColumn?: string
	idPrefix: string
	columnDelimiter: string
	exampleBudget: number
	described: string
}

function planFromArguments(): CensusPlan {
	const adapterID = values.adapter
	const canonicalPath = values.canonical

	if (!adapterID && !canonicalPath) {
		throw new Error("dedup-cause-census: pass --adapter with --input, or --canonical")
	}

	if (adapterID && !values.input) {
		throw new Error("dedup-cause-census: --adapter needs --input, the path the build read")
	}

	if (values["source-csv"] && !values["id-column"]) {
		throw new Error("dedup-cause-census: --source-csv needs --id-column, the column `source_id` carries")
	}

	return {
		adapterID,
		inputPath: values.input,
		canonicalPath,
		country: values.country,
		limit: values.limit ? Number(values.limit) : undefined,
		sourceCSVPath: values["source-csv"],
		idColumn: values["id-column"],
		idPrefix: values["id-prefix"] ?? (adapterID ? `${adapterID}-` : ""),
		columnDelimiter: values["column-delimiter"] ?? ",",
		exampleBudget: Number(values.examples ?? 3),
		described: canonicalPath ?? `${adapterID} over ${values.input}`,
	}
}

/**
 * The rows to census, either from the adapter or from a built `canonical.jsonl`.
 *
 * Both passes call this, so the second pass sees the rows the first pass counted.
 */
function rowSource(plan: CensusPlan): AsyncIterable<CanonicalRow> {
	if (plan.canonicalPath) {
		return JSONSpliterator.fromAsync<CanonicalRow>(PathBuilder.from(plan.canonicalPath))
	}

	const adapter = defaultAdapterRegistry.get(plan.adapterID!)

	if (!adapter) {
		throw new Error(
			`dedup-cause-census: unknown adapter ${plan.adapterID}; registered: ${defaultAdapterRegistry.ids().join(", ")}`
		)
	}

	return adapter.rows({
		inputPath: PathBuilder.from(plan.inputPath!),
		country: plan.country,
		limit: plan.limit,
	})
}

/**
 * The collapsed groups found in one pass over the rows.
 *
 * `hashes` holds each group's 64-bit key hash in ascending order, so a later pass finds
 * a row's group by binary search rather than by holding a map of every key.
 */
interface GroupIndex {
	rows: number
	distinct: number
	collapsed: number
	hashes: BigUint64Array
}

async function indexGroups(plan: CensusPlan): Promise<GroupIndex> {
	const keyHashes = new HashList()

	for await (const row of rowSource(plan)) {
		keyHashes.push(hash64(canonicalDedupKey(row)))

		if (keyHashes.length % 1_000_000 === 0) {
			console.error(`    hashing ${keyHashes.length.toLocaleString()} rows…`)
		}
	}

	const rows = keyHashes.length
	const sorted = keyHashes.filled().toSorted()
	let distinct = 0

	for (let index = 0; index < sorted.length; index++) {
		if (index === 0 || sorted[index] !== sorted[index - 1]) {
			distinct++
		}
	}

	const repeated = new BigUint64Array(sorted.length - distinct)
	let groups = 0

	for (let index = 1; index < sorted.length; index++) {
		if (sorted[index] !== sorted[index - 1]) continue

		if (groups > 0 && repeated[groups - 1] === sorted[index]) continue

		repeated[groups++] = sorted[index]!
	}

	return { rows, distinct, collapsed: rows - distinct, hashes: repeated.subarray(0, groups) }
}

/**
 * What the second pass over the rows established about each collapsed group.
 */
interface FieldCensus {
	groupSize: Uint32Array
	fieldDiffered: Uint8Array
	joinIDs: BigUint64Array
	joinSlots: Uint32Array
	joinableRows: number
}

async function censusCanonicalFields(plan: CensusPlan, index: GroupIndex): Promise<FieldCensus> {
	const groups = index.hashes.length
	const fieldHashes = new Uint32Array(groups * TRACKED_FIELDS.length)
	const fieldDiffered = new Uint8Array(groups * TRACKED_FIELDS.length)
	const groupSize = new Uint32Array(groups)
	const joinIDs = new HashList()
	const joinSlots = new SlotList()
	let joinableRows = 0
	let seen = 0

	for await (const row of rowSource(plan)) {
		seen++

		if (seen % 1_000_000 === 0) {
			console.error(`    attributing ${seen.toLocaleString()} rows…`)
		}

		const slot = indexOfSorted(index.hashes, hash64(canonicalDedupKey(row)))

		if (slot < 0) continue

		const first = groupSize[slot] === 0

		groupSize[slot]!++

		for (let field = 0; field < TRACKED_FIELDS.length; field++) {
			const at = slot * TRACKED_FIELDS.length + field
			const value = row[TRACKED_FIELDS[field]!]
			const valueHash = hash32(value === undefined || value === null ? "\u0000absent" : String(value))

			if (first) {
				fieldHashes[at] = valueHash
			} else if (fieldHashes[at] !== valueHash) {
				fieldDiffered[at] = 1
			}
		}

		if (plan.idColumn && row.source_id) {
			joinIDs.push(hash64(row.source_id))
			joinSlots.push(slot)

			joinableRows++
		}
	}

	return {
		groupSize,
		fieldDiffered,
		joinIDs: joinIDs.filled(),
		joinSlots: joinSlots.filled(),
		joinableRows,
	}
}

function reportCanonicalFields(groups: number, census: FieldCensus): void {
	console.log("\n  CanonicalRow fields outside the key, by the collapsed groups holding more than one value:")
	console.log(
		`    ${"field".padEnd(20)} ${"groups differing".padStart(18)}  share of ${groups.toLocaleString()} groups`
	)

	for (let field = 0; field < TRACKED_FIELDS.length; field++) {
		let differing = 0

		for (let slot = 0; slot < groups; slot++) {
			if (census.fieldDiffered[slot * TRACKED_FIELDS.length + field]) {
				differing++
			}
		}

		console.log(
			`    ${TRACKED_FIELDS[field]!.padEnd(20)} ${differing.toLocaleString().padStart(18)}  ` +
				`${((100 * differing) / groups).toFixed(3)}%`
		)
	}
}

function reportGroupSizes(groups: number, census: FieldCensus): void {
	const sizes = new Map<number, number>()

	for (let slot = 0; slot < groups; slot++) {
		const size = census.groupSize[slot]!

		sizes.set(size, (sizes.get(size) ?? 0) + 1)
	}

	const ordered = [...sizes.entries()].toSorted((left, right) => left[0] - right[0])

	console.log("\n  collapsed-group size, rows per group:")

	for (const [size, count] of ordered.slice(0, SIZE_ROWS)) {
		console.log(`    ${String(size).padStart(6)} rows  ${count.toLocaleString().padStart(12)} groups`)
	}

	if (ordered.length > SIZE_ROWS) {
		console.log(`    … ${ordered.length - SIZE_ROWS} further sizes, the largest ${ordered.at(-1)![0]} rows`)
	}
}

/**
 * The `source_id` join, sorted by hash so a source record finds its group by binary search.
 */
interface JoinIndex {
	ids: BigUint64Array
	slots: Uint32Array
	ambiguous: number
}

function buildJoinIndex(census: FieldCensus): JoinIndex {
	const order = Array.from({ length: census.joinIDs.length }, (_unused, at) => at).toSorted((left, right) => {
		const difference = census.joinIDs[left]! - census.joinIDs[right]!

		return difference < 0n ? -1 : difference > 0n ? 1 : 0
	})

	const ids = new BigUint64Array(order.length)
	const slots = new Uint32Array(order.length)

	for (let at = 0; at < order.length; at++) {
		ids[at] = census.joinIDs[order[at]!]!
		slots[at] = census.joinSlots[order[at]!]!
	}

	let ambiguous = 0

	for (let at = 1; at < ids.length; at++) {
		if (ids[at] === ids[at - 1]) {
			ambiguous++
		}
	}

	return { ids, slots, ambiguous }
}

function csvRecords(plan: CensusPlan): AsyncIterable<Record<string, string>> {
	// `normalizeKeys: false` keeps the publisher's own column spelling, which is what
	// `--id-column` names, and is the setting every CSV adapter reads its source under.
	return CSVSpliterator.fromAsync<Record<string, string>>(PathBuilder.from(plan.sourceCSVPath!), {
		normalizeKeys: false,
		columnDelimiter: plan.columnDelimiter,
	})
}

async function readColumns(plan: CensusPlan): Promise<readonly string[]> {
	// Every record carries the header's columns, so the first one answers this and the rest are left unread.
	// The iterator is taken directly rather than through a loop that returns on its
	// first pass, which reads as an iteration and is not one.
	const records = csvRecords(plan)[Symbol.asyncIterator]()
	const first = await records.next()

	await records.return?.()

	if (first.done) {
		throw new Error(
			`dedup-cause-census: ${plan.sourceCSVPath} yielded no records under column delimiter ` +
				`${stringifyJSON(plan.columnDelimiter)}`
		)
	}

	return Object.keys(first.value)
}

async function reportSourceColumns(plan: CensusPlan, index: GroupIndex, census: FieldCensus): Promise<void> {
	const groups = index.hashes.length
	const join = buildJoinIndex(census)
	const columns = await readColumns(plan)

	if (!columns.includes(plan.idColumn!)) {
		throw new Error(
			`dedup-cause-census: ${plan.sourceCSVPath} has no column ${plan.idColumn}; ` +
				`its columns are ${columns.join(", ")}`
		)
	}

	console.log(
		`\n  joining ${plan.sourceCSVPath} on ${plan.idColumn}, ` + `with source_id = ${plan.idPrefix}<${plan.idColumn}>`
	)
	console.log(`  rows in a collapsed group carrying a source_id       ${census.joinableRows.toLocaleString()}`)
	console.log(`  source_id hashes carried by more than one such row   ${join.ambiguous.toLocaleString()}`)

	const columnWords = Math.ceil(columns.length / 32)
	const columnHashes = new Uint32Array(groups * columns.length)
	const columnDiffered = new Uint32Array(groups * columnWords)
	// A column that differs in no group is either constant within every group or empty throughout the file,
	// and those are different findings, so the population count is read beside the difference count.
	const columnPopulated = new Float64Array(columns.length)
	const joinedPerSlot = new Uint32Array(groups)
	const exampleSlots: number[] = []
	let sourceRecords = 0
	let joinedRecords = 0

	for await (const record of csvRecords(plan)) {
		sourceRecords++

		if (sourceRecords % 1_000_000 === 0) {
			console.error(`    joining ${sourceRecords.toLocaleString()} source records…`)
		}

		for (let column = 0; column < columns.length; column++) {
			if (record[columns[column]!]) {
				columnPopulated[column]!++
			}
		}

		const at = lowerBoundOfSorted(join.ids, hash64(`${plan.idPrefix}${record[plan.idColumn!] ?? ""}`))

		if (at < 0) continue

		const slot = join.slots[at]!
		const first = joinedPerSlot[slot] === 0

		joinedPerSlot[slot]!++

		joinedRecords++

		let newlyDiffering = false

		for (let column = 0; column < columns.length; column++) {
			const valueHash = hash32(record[columns[column]!] ?? "")
			const cell = slot * columns.length + column

			if (first) {
				columnHashes[cell] = valueHash

				continue
			}

			if (columnHashes[cell] === valueHash) continue

			const word = slot * columnWords + (column >>> 5)
			const bit = 1 << (column & 31)

			if (!(columnDiffered[word]! & bit)) {
				columnDiffered[word] = (columnDiffered[word]! | bit) >>> 0
				newlyDiffering = true
			}
		}

		if (newlyDiffering && exampleSlots.length < plan.exampleBudget && joinedPerSlot[slot] === 2) {
			exampleSlots.push(slot)
		}
	}

	let joinedGroups = 0
	let wholeGroups = 0
	let comparableGroups = 0

	for (let slot = 0; slot < groups; slot++) {
		if (joinedPerSlot[slot]! > 0) {
			joinedGroups++
		}

		if (joinedPerSlot[slot]! >= 2) {
			comparableGroups++
		}

		if (joinedPerSlot[slot] === census.groupSize[slot]) {
			wholeGroups++
		}
	}

	console.log(`  source records read                                 ${sourceRecords.toLocaleString()}`)
	console.log(`  source records that joined to a group               ${joinedRecords.toLocaleString()}`)
	console.log(
		`  groups with at least one joined record              ${joinedGroups.toLocaleString()} of ${groups.toLocaleString()}`
	)
	console.log(
		`  groups whose every row joined                       ${wholeGroups.toLocaleString()} of ${groups.toLocaleString()}`
	)

	if (!joinedRecords) {
		throw new Error(
			"dedup-cause-census: no source record joined. Check --id-column and --id-prefix: the tool looked for " +
				`source_id values of the form ${plan.idPrefix}<${plan.idColumn}>.`
		)
	}

	const perColumn = columns.map((column, at) => {
		let differing = 0

		for (let slot = 0; slot < groups; slot++) {
			if (joinedPerSlot[slot]! < 2) continue

			if (columnDiffered[slot * columnWords + (at >>> 5)]! & (1 << (at & 31))) {
				differing++
			}
		}

		return { column, differing, populated: columnPopulated[at]! }
	})

	console.log("\n  source columns, by the collapsed groups holding more than one value of that column:")
	console.log(
		`    ${"column".padEnd(38)} ${"groups differing".padStart(17)} ${"of comparable".padStart(14)} ` +
			`${"non-empty records".padStart(18)} of ${sourceRecords.toLocaleString()} read`
	)

	for (const { column, differing, populated } of perColumn.toSorted(
		(left, right) => right.differing - left.differing
	)) {
		const share = comparableGroups ? `${((100 * differing) / comparableGroups).toFixed(3)}%` : "unmeasured"
		const populatedShare = sourceRecords ? `${((100 * populated) / sourceRecords).toFixed(3)}%` : "unmeasured"

		console.log(
			`    ${column.padEnd(38)} ${differing.toLocaleString().padStart(17)} ${share.padStart(14)} ` +
				`${populated.toLocaleString().padStart(18)} ${populatedShare.padStart(10)}`
		)
	}

	await printExamples(plan, census, join, columns, exampleSlots)
}

/**
 * Prints every joined record of a few collapsed groups, marking the columns that differ.
 *
 * The groups are chosen during the counting pass and their records are collected in
 * a further pass, so counting retains no record of its own.
 */
async function printExamples(
	plan: CensusPlan,
	census: FieldCensus,
	join: JoinIndex,
	columns: readonly string[],
	exampleSlots: readonly number[]
): Promise<void> {
	if (!exampleSlots.length) return

	const wanted = new Set(exampleSlots)
	const held = new Map<number, Array<Record<string, string>>>()

	for await (const record of csvRecords(plan)) {
		const at = lowerBoundOfSorted(join.ids, hash64(`${plan.idPrefix}${record[plan.idColumn!] ?? ""}`))

		if (at < 0) continue

		const slot = join.slots[at]!

		if (!wanted.has(slot)) continue

		const records = held.get(slot) ?? []

		records.push(record)
		held.set(slot, records)
	}

	for (const slot of exampleSlots) {
		const records = held.get(slot) ?? []

		console.log(
			`\n  --- collapsed group: ${census.groupSize[slot]!.toLocaleString()} emitted rows, ` +
				`${records.length} joined source records`
		)

		for (const column of columns) {
			const seen = records.map((record) => record[column] ?? "")
			const differs = new Set(seen).size > 1

			console.log(
				`    ${differs ? "*" : " "} ${column.padEnd(42)} ${seen.map((value) => value || "(empty)").join(" | ")}`
			)
		}
	}
}

async function main(): Promise<void> {
	const plan = planFromArguments()

	if (plan.canonicalPath && !(await pathExists(PathBuilder.from(plan.canonicalPath)))) {
		throw new Error(`dedup-cause-census: no file at ${plan.canonicalPath}`)
	}

	console.log(`=== dedup cause census: ${plan.described}`)

	const index = await indexGroups(plan)
	const groups = index.hashes.length
	const share = index.rows ? ((100 * index.collapsed) / index.rows).toFixed(2) : "0.00"

	console.log(`  rows the source yielded        ${index.rows.toLocaleString()}`)
	console.log(`  distinct dedup keys            ${index.distinct.toLocaleString()}`)
	console.log(`  rows a dedup pass would drop   ${index.collapsed.toLocaleString()} (${share}% of yielded)`)
	console.log(`  collapsed groups               ${groups.toLocaleString()}`)

	if (!groups) {
		console.log("\n  No dedup key repeats, so no field distinguishes a collapsed row.")

		return
	}

	const census = await censusCanonicalFields(plan, index)

	reportCanonicalFields(groups, census)
	reportGroupSizes(groups, census)

	if (!plan.sourceCSVPath || !plan.idColumn) {
		console.log(
			"\n  No source-column report. Pass --source-csv and --id-column to join each group back to the " +
				"publisher's records."
		)

		return
	}

	await reportSourceColumns(plan, index, census)
}

await main()
