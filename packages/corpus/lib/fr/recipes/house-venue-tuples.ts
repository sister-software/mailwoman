/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file France's house-venue tuples, sampled from the BAN national address register.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { repoRootPath } from "@mailwoman/core/paths"
import { capitalize, splitLines, splitWhitespace } from "@mailwoman/core/strings/unicode"
import type { PathBuilderLike } from "path-ts"

import { sampleAddressPoints } from "#recipes/address-points"
import type { HouseVenueTuple } from "#recipes/house-venue-tuples"
import type { PyRandom } from "#training/pyrandom"

/**
 * The BAN address-point database.
 */
export function banAddressPointsPath() {
	return dataRootPath("db", "ban", "address-points-fr.db")
}

/**
 * The street surfaces the FR fragment board holds out, one per line, as BAN's `street_norm` spells them.
 */
export function frReservedSurfacesPath() {
	return repoRootPath("packages", "mailwoman", "tools", "eval-harness", "fixtures", "ban-fragments-fr.surfaces.txt")
}

/**
 * Particles that stay lower case inside a French name unless they open it:
 * `Rue de la Paix`, not `Rue De La Paix`.
 */
const PARTICLES = new Set(splitWhitespace("de la du des le les l d au aux et sur sous en un une"))

/**
 * French title case: particles stay lower case after the first word,
 * and an elision capitalizes after its apostrophe.
 */
export function frenchTitleCase(text: string): string {
	return splitWhitespace(text)
		.map((word, index) => {
			if (index > 0 && PARTICLES.has(word)) return word

			const apostrophe = word.indexOf("'")

			if (apostrophe !== -1) {
				return word.slice(0, apostrophe).toLowerCase() + "'" + capitalize(word.slice(apostrophe + 1))
			}

			if (word.includes("-")) return word.split("-").map(capitalize).join("-")

			return capitalize(word)
		})
		.join(" ")
}

/**
 * The held-out street surfaces: every non-blank line, stripped.
 *
 * @throws When the file does not exist, naming it, because a missing list
 * would admit the board's own streets.
 */
export async function readFRReservedSurfaces(path: PathBuilderLike = frReservedSurfacesPath()): Promise<Set<string>> {
	if (!(await pathExists(path))) {
		throw new Error(`No FR reserved-surface list at ${path.toString()}; the FR board's streets cannot be held out`)
	}

	return new Set(
		splitLines(await readLocalTextFile(path))
			.map((line) => line.trim())
			.filter((line) => line)
	)
}

/**
 * Up to `count` BAN rows rendered as tuples, less any whose street is in `reserved`.
 *
 * `region` is empty because the FR rendering has none.
 */
export async function sampleFRHouseVenueTuples(
	count: number,
	rng: PyRandom,
	reserved: ReadonlySet<string>,
	path: PathBuilderLike = banAddressPointsPath()
): Promise<HouseVenueTuple[]> {
	const sampled = await sampleAddressPoints(path, count, rng)

	return sampled
		.filter(([street]) => !reserved.has(street))
		.map(([street, number, postcode, locality]) => ({
			locality: frenchTitleCase(locality),
			region: "",
			postcode,
			country: "FR",
			street: frenchTitleCase(street),
			houseNumber: number,
		}))
}
