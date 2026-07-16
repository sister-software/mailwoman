/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus shard <recipe>` — build a synthetic training-corpus shard from a registered
 *   recipe (the durable replacement for the 16 `scripts/build-*-shard.mjs` scripts). `--list`
 *   prints the registry. Recipes are `tuples` (read `--input` JSONL of
 *   (locality,region,postcode,country) tuples) or `generate` (self-generate `--count` rows). Output
 *   is aligned LabeledRow JSONL ready for the parquet sharding step (`mailwoman corpus ...`). See
 *   corpus/src/shard-recipes.
 */

import { createWriteStream } from "node:fs"

import { getShardRecipe, listShardRecipes, type ShardRecipeOpts } from "@mailwoman/corpus"
import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, commandError, useCommandTask } from "../../../cli-kit/index.ts"

/** Bare `mailwoman corpus shard` stays the recipe runner now that `shard/` hosts subcommands. */
export const isDefault = true

const ArgumentsSchema = zod
	.array(zod.string().describe("Recipe name (omit with --list to see the registry)"))
	.default([])

const OptionsSchema = zod.object({
	list: zod.boolean().default(false).describe("List the available recipes and exit"),
	output: zod.string().optional().describe("Output JSONL path (required to build)"),
	input: zod.string().optional().describe("Input tuples JSONL (tuples-mode recipes)"),
	count: zod.string().optional().describe("Rows to generate (generate-mode recipes)"),
	variants: zod.string().default("1").describe("Variants per input tuple (tuples-mode)"),
	seed: zod.string().optional().describe("PRNG seed (default: time-based)"),
	golden: zod.boolean().default(false).describe("Emit the golden/holdout variant where the recipe supports it"),
	sourceName: zod.string().optional().describe("Override the source tag"),
	// recipe-specific (each recipe reads only what it needs; see `--list` / the recipe's options):
	houseNumberProb: zod.string().optional().describe("street: P(house number)"),
	pmbRatio: zod.string().optional().describe("po-box: P(private-mailbox layout)"),
	militaryRatio: zod.string().optional().describe("po-box: P(US military/diplomatic row)"),
	reversedFraction: zod.string().optional().describe("fr-order: fraction reversed-order"),
	edgesDir: zod.string().optional().describe("intersection: TIGER EDGES dir"),
	country: zod.string().optional().describe("locale: target country"),
	intlFraction: zod.string().optional().describe("german/locale: international-order fraction"),
	bareProb: zod.string().optional().describe("street-bare: P(bare street)"),
	hnProb: zod.string().optional().describe("street-bare: P(house number)"),
	communes: zod.string().optional().describe("fr-admin-split: communes source"),
	excludeSurfaces: zod
		.string()
		.optional()
		.describe("fr-fragment: REQUIRED — reserved street-surface list to exclude (the fragment board's eval set)"),
	multilocaleCount: zod.string().optional().describe("street-affix: multilocale row count"),
})

export { ArgumentsSchema as args, OptionsSchema as options }

const num = (s: string | undefined): number | undefined => (s == null ? undefined : Number(s))

const CorpusShard: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		if (options.list || args.length === 0) {
			return [
				"recipes:",
				...listShardRecipes().map((r) => `  ${r.name.padEnd(20)} [${r.mode}] ${r.description}`),
				"",
				"usage: mailwoman corpus shard <recipe> --output <out.jsonl> [--input <tuples.jsonl> | --count N] [--seed N]",
			]
		}

		const name = args[0]!
		const recipe = getShardRecipe(name)

		if (!recipe) {
			throw commandError(`unknown recipe "${name}". Run \`mailwoman corpus shard --list\`.`)
		}

		if (!options.output) throw commandError("--output <out.jsonl> required")

		if (recipe.mode === "tuples" && !options.input) throw commandError(`recipe "${name}" needs --input <tuples.jsonl>`)

		if (recipe.mode === "generate" && !options.count) throw commandError(`recipe "${name}" needs --count <N>`)

		const seed = options.seed != null ? Number(options.seed) : Date.now()
		const opts: ShardRecipeOpts = {
			output: options.output,
			seed,
			variants: Number(options.variants) || 1,
			input: options.input,
			count: num(options.count),
			golden: options.golden,
			sourceName: options.sourceName,
			houseNumberProb: num(options.houseNumberProb),
			pmbRatio: num(options.pmbRatio),
			militaryRatio: num(options.militaryRatio),
			reversedFraction: num(options.reversedFraction),
			edgesDir: options.edgesDir,
			country: options.country,
			intlFraction: num(options.intlFraction),
			bareProb: num(options.bareProb),
			hnProb: num(options.hnProb),
			communes: options.communes,
			excludeSurfaces: options.excludeSurfaces,
			multilocaleCount: num(options.multilocaleCount),
		}

		console.error(`▸ shard recipe "${name}" [${recipe.mode}] seed=${seed} → ${options.output}`)
		const stream = createWriteStream(options.output, { encoding: "utf8" })
		const write = (line: string): void => {
			stream.write(line)
		}
		const stats = await recipe.run(opts, write)
		stream.end()
		await new Promise<void>((res) => stream.on("finish", () => res()))

		return [
			`recipe: ${name}`,
			`${stats.emitted.toLocaleString()} rows emitted, ${stats.skipped.toLocaleString()} skipped${stats.read != null ? `, ${stats.read.toLocaleString()} read` : ""} → ${options.output}`,
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i}>{line}</Text>
				))}
			</Box>
		)
	}

	return null
}

export default CorpusShard
