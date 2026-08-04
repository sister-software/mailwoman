/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createHash } from "node:crypto"

/**
 * A value that can be used as input to {@link simpleSHA3}.
 *
 * Values are converted to strings via {@link String}, trimmed, and empty values are discarded before hashing.
 *
 * @internal
 */
export type SHA3Seed = string | number | boolean | null | Date | undefined

/**
 * Input accepted by {@link simpleSHA3}.
 *
 * Arrays preserve insertion order. Object inputs are hashed using the order returned by {@link Object.values}.
 *
 * @internal
 */
export type SHA3Input = Record<string | number, SHA3Seed> | SHA3Seed[]

/**
 * Converts hash input into a normalized array of non-empty strings.
 *
 * @param input - Seeds to normalize.
 *
 * @returns Normalized string values.
 * @throws {Error} If no non-empty values remain after normalization.
 * @internal
 */
export function normalizeSHASeeds(input: SHA3Input): string[] {
	const seeds = Array.isArray(input) ? input : Object.values(input)

	const normalizedSeeds = seeds.map((seed) => seed?.toString().trim()).filter(Boolean) as string[]

	if (!normalizedSeeds.length) {
		throw new Error("Cannot generate a SHA3 hash without input.")
	}

	return normalizedSeeds
}

/**
 * Generates an uppercase SHAKE128 digest from one or more input values.
 *
 * Each normalized seed is fed into the hash sequentially.
 *
 * @param seeds - Values to hash.
 * @param outputLength - Length of the digest in **bytes**. Defaults to `32` (256-bit output).
 *
 * @returns Uppercase hexadecimal digest.
 */
export function simpleSHA3(seeds: SHA3Input, outputLength = 32): string {
	const hash = createHash("shake128", {
		outputLength,
	})

	for (const seed of normalizeSHASeeds(seeds)) {
		hash.update(seed, "utf8")
	}

	return hash.digest("hex").toUpperCase()
}
