/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts duplicate rows in an adapter's `canonical.jsonl`. It splits them by whether the
 *   runner's dedup set held their key when the duplicate arrived.
 *
 *   The runner holds at most `DEFAULT_DEDUP_MAX_SIZE` distinct keys. Three adapters passed that limit in
 *   `v0.7.0-de-holdout`. Every row in the file was written, so every duplicate the census finds reached the
 *   corpus. The split states which mechanism removes each group. A duplicate whose key was among the first
 *   `--cap` distinct keys is refused by the membership check that now runs whether or not the set is full.
 *   A duplicate whose key was first seen after the cap is removed only by raising the key capacity.
 *
 *   The set holds exactly the first `--cap` distinct keys in written order, because the runner adds a key
 *   at the moment it writes that key's first row. The census therefore reconstructs the set's contents from
 *   the file without reading the build log.
 *
 *   **Why this holds hashes rather than keys.** A V8 `Set` refuses a 16,777,216th entry. These
 *   adapters exceed it. The census stores a 64-bit hash of each dedup key in a growable `BigUint64Array`,
 *   sorts it and counts adjacent equal values. A 64-bit collision would report a duplicate where none exists.
 *   The collision rate is under 1 in 10^8 for 100 million keys. State that rate here rather than leaving it for a
 *   reader to assume away.
 *
 *   Usage:
 *   node --max-old-space-size=8192 packages/mailwoman/tools/dev-tools/corpus/dedup-census.run.ts \
 *     --intermediate <corpus>/intermediate --adapters usgov-nad,ban,wof-admin [--cap 10000000]
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { extractDelimited, parseArguments } from "@mailwoman/core/scripting/arguments"
import { canonicalDedupKey } from "@mailwoman/corpus/adapters/dedup-key"
import type { CanonicalRow } from "@mailwoman/corpus/types"
import { PathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

const { values } = parseArguments({
	options: {
		intermediate: { type: "string", description: "The build's `intermediate/` directory" },
		adapters: { type: "string", description: "Comma-separated adapter ids to census" },
		cap: { type: "string", description: "The dedup cap the build ran under (default 10000000)" },
	},
})

const intermediate = PathBuilder.from(values.intermediate ?? ".")
const adapters = extractDelimited(values.adapters ?? "")
const cap = Number(values.cap ?? 10_000_000)

if (!adapters.length) throw new Error("--adapters is required, as `usgov-nad,ban,wof-admin`")

/**
 * A 64-bit FNV-1a hash of a dedup key.
 *
 * The census compares hashes rather than keys because the distinct count exceeds what a `Set` holds.
 */
function hashKey(key: string): bigint {
	let hash = 0xcb_f2_9c_e4_84_22_23_25n

	for (let index = 0; index < key.length; index++) {
		hash ^= BigInt(key.charCodeAt(index))
		hash = BigInt.asUintN(64, hash * 0x1_00_00_01_b3n)
	}

	return hash
}

/**
 * A growable array of 64-bit hashes.
 *
 * `BigUint64Array` has a fixed length.
 * The row count is unknown before the pass, so this doubles.
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

	/**
	 * The filled portion, sorted ascending.
	 */
	sorted(): BigUint64Array {
		return this.#data.subarray(0, this.#length).toSorted()
	}
}

/**
 * One breakdown dimension's duplicate tally.
 *
 * `heldKey` counts duplicates whose key was among the first `cap` distinct keys.
 * The membership check restored by the runner change refuses those rows.
 *
 * `newKey` counts duplicates whose key was first seen after the cap.
 * Only a larger key capacity removes those.
 */
type Tally = Map<string, { rows: number; heldKey: number; newKey: number }>

function record(tally: Tally, key: string, heldKey: boolean, newKey: boolean): void {
	const entry = tally.get(key) ?? { rows: 0, heldKey: 0, newKey: 0 }

	entry.rows++

	if (heldKey) {
		entry.heldKey++
	}

	if (newKey) {
		entry.newKey++
	}

	tally.set(key, entry)
}

function report(label: string, tally: Tally, limit = 12): void {
	const rows = [...tally.entries()].toSorted(
		(left, right) => right[1].heldKey + right[1].newKey - (left[1].heldKey + left[1].newKey)
	)

	console.log(`\n  by ${label}, most duplicate rows first (${rows.length} distinct values):`)
	console.log(
		`    ${"value".padEnd(30)} ${"held key".padStart(12)} ${"new key".padStart(12)} ${"rows".padStart(12)}  duplicate%`
	)

	for (const [value, counts] of rows.slice(0, limit)) {
		const duplicates = counts.heldKey + counts.newKey
		const share = counts.rows ? ((100 * duplicates) / counts.rows).toFixed(3) : "0.000"

		console.log(
			`    ${(value || "(absent)").slice(0, 28).padEnd(30)} ${String(counts.heldKey).padStart(12)} ${String(counts.newKey).padStart(12)} ${String(counts.rows).padStart(12)}  ${share}%`
		)
	}

	if (rows.length > limit) {
		console.log(`    … ${rows.length - limit} further values`)
	}
}

/**
 * The index of `value` in a sorted array, or -1.
 *
 * The census looks up every row against the duplicated-hash array, so this runs once per row
 * and avoids a `Map` whose entry count would exceed what V8 holds.
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

for (const adapter of adapters) {
	const path = intermediate(adapter, "canonical.jsonl")

	if (!(await pathExists(path))) {
		console.log(`\n=== ${adapter}: UNMEASURED, no file at ${path}`)

		continue
	}

	console.log(`\n=== ${adapter}`)
	console.log(`  reading ${path}`)

	const hashes = new HashList()
	const seenBeforeCap = new Set<bigint>()
	let rows = 0
	let distinctAtCap = 0
	let exhaustedAt: number | null = null

	// First pass fills the hash list and finds the row at which a set capped at `cap` would stop growing.
	for await (const row of JSONSpliterator.fromAsync<CanonicalRow>(path)) {
		const hash = hashKey(canonicalDedupKey(row))

		hashes.push(hash)

		rows++

		if (exhaustedAt === null && !seenBeforeCap.has(hash)) {
			if (seenBeforeCap.size >= cap) {
				exhaustedAt = rows
				distinctAtCap = seenBeforeCap.size
				// The set is no longer read after this point and holds the bulk of this pass's memory.
				seenBeforeCap.clear()
			} else {
				seenBeforeCap.add(hash)
			}
		}

		if (rows % 5_000_000 === 0) {
			console.error(`    ${rows.toLocaleString()} rows…`)
		}
	}

	if (exhaustedAt === null) {
		distinctAtCap = seenBeforeCap.size
	}

	const sorted = hashes.sorted()
	let distinct = 0
	let duplicates = 0

	for (let index = 0; index < sorted.length; index++) {
		if (index === 0 || sorted[index] !== sorted[index - 1]) {
			distinct++
		} else {
			duplicates++
		}
	}

	// The unique hashes that occur more than once.
	// Every row outside this set is its key's only occurrence, so the second pass can ignore it.
	// The array is bounded by the duplicate count rather than by the row count.
	const repeated = new BigUint64Array(distinct === sorted.length ? 0 : sorted.length - distinct)
	let repeatedCount = 0

	for (let index = 1; index < sorted.length; index++) {
		if (sorted[index] !== sorted[index - 1]) continue

		if (repeatedCount > 0 && repeated[repeatedCount - 1] === sorted[index]) continue

		repeated[repeatedCount++] = sorted[index]!
	}

	const repeatedHashes = repeated.subarray(0, repeatedCount)

	console.log(`  rows                       ${rows.toLocaleString()}`)
	console.log(`  distinct keys              ${distinct.toLocaleString()}`)
	console.log(`  duplicate rows             ${duplicates.toLocaleString()}`)
	console.log(`  keys occurring more than once ${repeatedCount.toLocaleString()}`)
	console.log(
		`  cap reached at row         ${exhaustedAt === null ? `never, ${distinctAtCap.toLocaleString()} distinct keys under a cap of ${cap.toLocaleString()}` : exhaustedAt.toLocaleString()}`
	)

	// The second pass classifies every row: its key's first occurrence, a duplicate of a
	// key the set held at the cap, or a duplicate of a key first seen after the cap.
	const occurrences = new Uint32Array(repeatedCount)
	const firstSeenAt = new Uint32Array(repeatedCount)
	const byCountry: Tally = new Map()
	const byRegion: Tally = new Map()
	const byRole: Tally = new Map()
	const capAt = exhaustedAt ?? Number.MAX_SAFE_INTEGER
	let heldKey = 0
	let newKey = 0
	let index = 0

	for await (const row of JSONSpliterator.fromAsync<CanonicalRow>(path)) {
		index++

		const slot = indexOfSorted(repeatedHashes, hashKey(canonicalDedupKey(row)))
		let rowHeldKey = false
		let rowNewKey = false

		if (slot >= 0) {
			occurrences[slot]!++

			if (occurrences[slot] === 1) {
				firstSeenAt[slot] = index
			} else if (firstSeenAt[slot]! <= capAt) {
				rowHeldKey = true

				heldKey++
			} else {
				rowNewKey = true

				newKey++
			}
		}

		record(byCountry, row.country, rowHeldKey, rowNewKey)
		record(byRegion, row.components.region ?? "", rowHeldKey, rowNewKey)
		record(byRole, row.addressRole ?? "", rowHeldKey, rowNewKey)

		if (index % 5_000_000 === 0) {
			console.error(`    attributing ${index.toLocaleString()} rows…`)
		}
	}

	console.log(`  duplicates of a key the set held         ${heldKey.toLocaleString()}`)
	console.log(`  duplicates of a key first seen after cap ${newKey.toLocaleString()}`)

	if (heldKey + newKey !== duplicates) {
		throw new Error(
			`census: ${heldKey.toLocaleString()} held-key plus ${newKey.toLocaleString()} new-key does not ` +
				`equal ${duplicates.toLocaleString()} duplicate rows for ${adapter}`
		)
	}

	report("country", byCountry)
	report("components.region", byRegion)
	report("addressRole", byRole)
}
