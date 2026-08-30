/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared harness for the shard-recipe tests. Each of them was carrying its own copy of the same three
 *   pieces — a row type, a scratch-directory writer, and a runner that differed only in which recipe and
 *   which seed it passed.
 *
 *   Lives under `test-kit/` (the convention `mailwoman/test-kit/` set) and is excluded from corpus's
 *   build project, so it is never emitted into `out/` and never reaches the published tarball.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/objects"

import type { ShardRecipeOpts } from "../src/shard-recipes/scaffold.ts"

/**
 * The fields a shard-recipe assertion reads off an emitted row.
 *
 * `parseJSONStrict` without a type argument hands back `unknown`; naming the shape is what lets the assertions be
 * checked at all. The previous `Record<string, never>` typed every property as `never`, so nothing could be read
 * without a cast and nothing was ever verified.
 */
export interface ShardRow {
	raw: string
	synth_method?: string
	source?: string
	source_id?: string
	components?: Partial<Record<string, string>>
	labels?: string[]
	tokens?: string[]
}

/**
 * A recipe's `run` surface, as the tests drive it.
 */
export interface ShardRecipe<TStats> {
	run(options: ShardRecipeOpts, emit: (line: string) => void): Promise<TStats>
}

/**
 * The two input paths a recipe reads, plus the directory holding them.
 *
 * The CALLER owns it: a recipe opens both files by path well after this function returns, so the directory has to
 * outlive the call. Bind it with `using` and it goes when the test does.
 */
export type ShardRecipeInputs = TemporaryDirectory & { input: string; exclude: string }

/**
 * Write the tuple + reserved-surface inputs a recipe reads, into a fresh temporary directory.
 */
export async function scratch(prefix: string, tuples: object[], surfaces: string[]): Promise<ShardRecipeInputs> {
	const dir = await temporaryDirectory(`${prefix}-`)
	const input = dir.resolve("tuples.jsonl")
	const exclude = dir.resolve("surfaces.txt")

	await writeLocalTextFile(tuples.map((t) => JSON.stringify(t)).join("\n") + "\n", input)
	await writeLocalTextFile("# reserved\n" + surfaces.join("\n") + "\n", exclude)

	return dir.moveWith({ input, exclude })
}

/**
 * Bind a recipe and its seed to a runner the tests call with just the tuples and reserved surfaces. The seed is
 * per-recipe and required — these suites assert on generated distributions.
 */
export function shardRunner<TStats>(prefix: string, recipe: ShardRecipe<TStats>, seed: number) {
	return async function run(
		tuples: object[],
		surfaces: string[],
		opts: Partial<ShardRecipeOpts> = {}
	): Promise<{ stats: TStats; rows: ShardRow[] }> {
		await using inputs = await scratch(prefix, tuples, surfaces)
		const lines: string[] = []

		const stats = await recipe.run(
			{ output: "", seed, variants: 1, input: inputs.input, excludeSurfaces: inputs.exclude, ...opts },
			(line) => lines.push(line)
		)

		return { stats, rows: lines.map((line) => parseJSONStrict<ShardRow>(line)) }
	}
}
