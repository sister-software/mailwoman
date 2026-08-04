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

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"

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
	run(options: never, emit: (line: string) => void): Promise<TStats>
}

/**
 * Write the tuple + reserved-surface inputs a recipe reads, into a fresh temp directory.
 */
export function scratch(prefix: string, tuples: object[], surfaces: string[]): { input: string; exclude: string } {
	const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
	const input = join(dir, "tuples.jsonl")
	const exclude = join(dir, "surfaces.txt")

	writeFileSync(input, tuples.map((t) => JSON.stringify(t)).join("\n") + "\n")
	writeFileSync(exclude, "# reserved\n" + surfaces.join("\n") + "\n")

	return { input, exclude }
}

/**
 * Bind a recipe and its seed to a runner the tests call with just the tuples and reserved surfaces. The seed is
 * per-recipe and load-bearing — these suites assert on generated distributions.
 */
export function shardRunner<TStats>(prefix: string, recipe: ShardRecipe<TStats>, seed: number) {
	return async function run(
		tuples: object[],
		surfaces: string[],
		opts: Record<string, unknown> = {}
	): Promise<{ stats: TStats; rows: ShardRow[] }> {
		const { input, exclude } = scratch(prefix, tuples, surfaces)
		const lines: string[] = []

		const stats = await recipe.run(
			{ output: "", seed, variants: 1, input, excludeSurfaces: exclude, ...opts } as never,
			(line) => lines.push(line)
		)

		return { stats, rows: lines.map((line) => parseJSONStrict<ShardRow>(line)) }
	}
}
