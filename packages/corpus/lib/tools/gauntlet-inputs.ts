/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every surface that appears as an input on a gauntlet board, so a recipe can refuse to train on one.
 *
 *   A recipe's own reserve list holds the strings its author knew about. The boards are a separate instrument with a
 *   separate history — `cz/bare-postcode.jsonl` was authored months before the recipe that trains on Czech postcodes —
 *   so neither register knows the other exists, and a board row that reaches the corpus stops measuring a capability
 *   and starts measuring recall of one string.
 *
 *   read from disk rather than imported. `mailwoman` depends on `@mailwoman/corpus`, so this package cannot import the
 *   gauntlet loader without a cycle. A recipe is a build tool reading the repository it is built in, which is a file
 *   read rather than a dependency. the shipped package never calls this.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { join, type PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

/**
 * The committed board corpus, as a path rather than a module.
 */
export const GAUNTLET_CASES_DIR: PathBuilderLike = repoRootPath(
	"packages",
	"mailwoman",
	"lib",
	"eval-harness",
	"gauntlet",
	"cases"
)

/**
 * The comparison surface: case-folded, every run of whitespace removed.
 *
 * Whitespace-insensitive because a postcode's board spelling and its corpus spelling differ by exactly that — `100 00`
 * against `10000` — and a check that missed the pair would report a clean build over a leaked row.
 */
export function normalizeGauntletSurface(surface: string): string {
	return surface.trim().toUpperCase().replaceAll(/\s+/gu, "")
}

/**
 * Every board row's `input`, normalized.
 *
 * Reads the whole corpus once. callers retain the output. A row that does not parse is skipped rather than thrown on:
 * the gauntlet loader is what validates the corpus, and a recipe that refused to build over a malformed board row would
 * turn one bad line into a stopped build for a check that is advisory to it.
 */
export async function readGauntletInputs(dir: PathBuilderLike = GAUNTLET_CASES_DIR): Promise<ReadonlySet<string>> {
	const inputs = new Set<string>()

	// Each immediate subdirectory is read independently so `generalization/` parked passes remain board inputs a
	// recipe must not train on.
	const entries = await Globerator.from("*", { cwd: String(dir), withFileTypes: true, onlyFiles: false }).toArray()
	const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)

	for (const directory of [".", ...directories]) {
		const here = directory === "." ? dir : join(dir, directory)

		for (const file of await Globerator.files("jsonl", {
			cwd: String(here),
			absolute: false,
			recursive: false,
		}).toArray()) {
			try {
				for await (const row of JSONSpliterator.fromAsync<{ input?: unknown }>(join(here, String(file)))) {
					if (typeof row.input === "string" && row.input.trim()) {
						inputs.add(normalizeGauntletSurface(row.input))
					}
				}
			} catch {
				// A file this cannot read or parse is skipped. The gauntlet loader is what validates the board corpus
				// and reports the file and line. a recipe stopping its build over one malformed row would turn an
				// advisory check into a blocked build.
				continue
			}
		}
	}

	return inputs
}
