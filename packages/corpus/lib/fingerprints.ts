/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A fixed-capacity set of 128-bit fingerprints in one flat `Uint32Array`.
 *
 *   The adapter runner deduplicates by holding every key it has seen. A V8 `Set` refuses its 16,777,217th
 *   entry outright, so the runner capped itself at 10,000,000 keys, and three adapters passed that cap in
 *   `v0.7.0-de-holdout`. The duplicate census over that build measured what the cap costs: of the
 *   2,491,399 duplicate rows the three adapters wrote, 1,490,992 duplicate a key first seen after the cap,
 *   which no membership test on a capped set can refuse.
 *
 *   This holds the keys as fingerprints instead. Four 32-bit words per slot, open addressing with linear
 *   probing, and the allocation happens once at construction, so the entry count is bounded by the array
 *   the caller sized rather than by a V8 limit. A 2^27-slot table holds 57,570,829 keys at load 0.43 in
 *   2.0 GiB outside the V8 heap.
 *
 *   **A fingerprint collision drops a legitimate row.** Two distinct keys sharing all 128 bits are read as
 *   one and the second row is dropped. Over 57,847,619 keys the expected number of colliding pairs is
 *   about 4.9e-24, so the table trades that for the 1,490,992 duplicates a capped set admits. A caller
 *   that cannot accept any false drop keeps the `Set`.
 */

import { md5Bytes } from "@mailwoman/core/hash"

/**
 * Words per slot: 128 bits of fingerprint.
 */
const WORDS_PER_SLOT = 4

/**
 * The load factor at which linear probing's expected probe count stays low enough to ignore.
 *
 * Above this the table refuses further keys rather than degrading, because a build whose
 * dedup slows by an order of magnitude partway through reports no cause.
 */
export const FINGERPRINT_MAX_LOAD = 0.7

/**
 * The largest slot count this accepts, as a base-2 logarithm.
 *
 * 2^30 slots hold 751,619,276 keys at the load limit and occupy 16 GiB.
 * Past that the backing `Uint32Array` exceeds what one allocation can hold on a 30.5 GB host,
 * and a run that asked for it would abort on the allocation rather than on the key that overflowed.
 */
export const MAX_SLOTS_LOG2 = 30

/**
 * A fingerprint set sized once, holding 128-bit values outside the V8 heap.
 */
export class FingerprintSet {
	readonly #words: Uint32Array
	readonly #slots: number
	readonly #mask: number
	readonly #limit: number
	#size = 0

	/**
	 * @param slotsLog2 Base-2 logarithm of the slot count, so the mask is exact.
	 * 27 gives 134,217,728 slots in 2.0 GiB.
	 */
	constructor(slotsLog2: number) {
		if (!Number.isInteger(slotsLog2) || slotsLog2 < 1 || slotsLog2 > MAX_SLOTS_LOG2) {
			throw new RangeError(
				`FingerprintSet: slotsLog2 must be an integer in 1..${MAX_SLOTS_LOG2}, received ${slotsLog2}`
			)
		}

		this.#slots = 2 ** slotsLog2
		this.#mask = this.#slots - 1
		this.#limit = Math.floor(this.#slots * FINGERPRINT_MAX_LOAD)
		this.#words = new Uint32Array(this.#slots * WORDS_PER_SLOT)
	}

	get size(): number {
		return this.#size
	}

	/**
	 * How many keys this table accepts before {@linkcode add} throws.
	 */
	get limit(): number {
		return this.#limit
	}

	get slots(): number {
		return this.#slots
	}

	/**
	 * Bytes the table occupies, which sit outside the V8 heap and are absent from `--max-old-space-size`.
	 */
	get bytes(): number {
		return this.#words.byteLength
	}

	/**
	 * Add a key's fingerprint.
	 *
	 * @returns `true` when the key is new, `false` when this table already holds its fingerprint.
	 * @throws When the table is at {@linkcode FINGERPRINT_MAX_LOAD}.
	 * A silent degradation would make a build slow down partway through with no cause to read.
	 */
	add(key: string): boolean {
		const digest = md5Bytes(key)

		// A slot holding four zero words is empty, so an all-zero fingerprint would read as one.
		// The low bit of the first word is forced, which merges the two values whose
		// fingerprints differ only there and costs one bit of the 128.
		//
		// `>>> 0` is required: `|` evaluates as int32, so a word above 2^31 comes back negative,
		// and a negative never equals the unsigned value `Uint32Array` stores.
		// Without it every key reads as new.
		const w0 = (digest.readUInt32LE(0) | 1) >>> 0
		const w1 = digest.readUInt32LE(4)
		const w2 = digest.readUInt32LE(8)
		const w3 = digest.readUInt32LE(12)

		let slot = w0 & this.#mask

		for (;;) {
			const at = slot * WORDS_PER_SLOT
			const found = this.#words[at]!

			if (found === 0) {
				if (this.#size >= this.#limit) {
					throw new Error(
						`FingerprintSet: ${this.#size.toLocaleString()} keys reached the load limit of ` +
							`${this.#limit.toLocaleString()} over ${this.#slots.toLocaleString()} slots. Construct it with a ` +
							`larger slotsLog2: probing past this load costs an order of magnitude per lookup and reports no cause.`
					)
				}

				this.#words[at] = w0
				this.#words[at + 1] = w1
				this.#words[at + 2] = w2
				this.#words[at + 3] = w3

				this.#size++

				return true
			}

			if (found === w0 && this.#words[at + 1] === w1 && this.#words[at + 2] === w2 && this.#words[at + 3] === w3) {
				return false
			}

			slot = (slot + 1) & this.#mask
		}
	}
}
