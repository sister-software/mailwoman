/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared harness for the corpus-recipe tests.
 *
 *   It lives under `test-kit/` and is excluded from corpus's build project, so it is never emitted into
 *   `out/` and never reaches the published tarball.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import type { PathBuilder } from "path-ts"

import type { RecipeOptions } from "#recipes/scaffold"

/**
 * The fields a recipe assertion reads off an emitted row; naming the shape is what
 * lets `parseJSONStrict`'s `unknown` be checked at all.
 */
export interface RecipeRow {
	raw: string
	recipe?: string
	register?: string | null
	surface?: string
	base_source_id?: string | null
	source?: string
	source_id?: string
	components?: Partial<Record<string, string>>
	labels?: string[]
	tokens?: string[]
}

/**
 * A recipe's `run` surface, as the tests drive it.
 */
export interface CorpusRecipe<TStats> {
	run(options: RecipeOptions, emit: (line: string) => void): Promise<TStats>
}

/**
 * The two input paths a recipe reads, plus the directory holding them; the caller owns it,
 * because a recipe opens both files by path well after this function returns.
 */
export type RecipeInputs = TemporaryDirectory & { input: PathBuilder; exclude: PathBuilder }

/**
 * Write the tuple + reserved-surface inputs a recipe reads, into a fresh temporary directory.
 */
export async function scratch(prefix: string, tuples: object[], surfaces: string[]): Promise<RecipeInputs> {
	const dir = await temporaryDirectory(`${prefix}-`)
	const input = dir.path("tuples.jsonl")
	const exclude = dir.path("surfaces.txt")

	await writeLocalJSONLFile(tuples, input)
	await writeLocalTextFile("# reserved\n" + surfaces.join("\n") + "\n", exclude)

	return dir.moveWith({ input, exclude })
}

/**
 * The register id a harness-built tuple set carries; it names no publisher,
 * so a row written under it cannot be mistaken for a real register's record.
 */
export const TEST_REGISTER = "test-harness"

/**
 * Bind a recipe and its seed to a runner the tests call with just the tuples and reserved
 * surfaces; the seed is required because these suites assert on generated distributions.
 */
export function recipeRunner<TStats>(prefix: string, recipe: CorpusRecipe<TStats>, seed: number) {
	return async function run(
		tuples: object[],
		surfaces: string[],
		opts: Partial<RecipeOptions> = {}
	): Promise<{ stats: TStats; rows: RecipeRow[] }> {
		await using inputs = await scratch(prefix, tuples, surfaces)
		const lines: string[] = []

		const stats = await recipe.run(
			{
				output: "",
				seed,
				variants: 1,
				input: inputs.input,
				excludeSurfaces: inputs.exclude,
				// The tuples come from this harness rather than a publisher, and a recipe
				// that reads them refuses to run without a register.
				register: TEST_REGISTER,
				...opts,
			},
			(line) => lines.push(line)
		)

		return { stats, rows: lines.map((line) => parseJSONStrict<RecipeRow>(line)) }
	}
}
