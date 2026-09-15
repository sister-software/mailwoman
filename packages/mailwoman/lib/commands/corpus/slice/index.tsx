/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus slice <recipe>` — build a synthetic training-corpus slice from a registered
 *   recipe (the durable replacement for the 16 `scripts/build-*-slice.mjs` scripts). `--list`
 *   prints the registry. Recipes are `tuples` (read `--input` JSONL of
 *   (locality,region,postcode,country) tuples) or `generate` (self-generate `--count` rows). Output
 *   is aligned LabeledRow JSONL ready for the parquet slicing step (`mailwoman corpus ...`). See
 *   corpus/src/recipes.
 */

import { openWriteStream } from "@mailwoman/core/fs/streams"
import { CommandError } from "@mailwoman/core/scripting/command"
import type { SliceRecipeOpts } from "@mailwoman/corpus"
import { createRecipeLineWriter } from "@mailwoman/corpus/recipes/scaffold"
import { Box, Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	countOption,
	type CommandComponent,
	stringOption,
	useCommandTask,
} from "#cli-kit"
/**
 * Bare `mailwoman corpus slice` stays the recipe runner now that `slice/` hosts subcommands.
 */
export const isDefault = true

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "slice",
	description: "Build a synthetic corpus slice",
	positionals: [{ name: "recipe", description: "Recipe name" }],
	options: {
		list: { type: "boolean", default: false, description: "List recipes" },
		out: { ...stringOption("Output JSONL path"), deprecatedName: "output" },
		input: stringOption("Input tuples JSONL"),
		count: stringOption("Rows to generate"),
		variants: { type: "string", default: "1", description: "Variants per tuple" },
		seed: stringOption("PRNG seed"),
		golden: { type: "boolean", default: false, description: "Emit golden variant" },
		"source-name": stringOption("Source tag"),
		"house-number-prob": stringOption("street house-number probability"),
		"pmb-ratio": stringOption("private-mailbox ratio"),
		"military-ratio": stringOption("military row ratio"),
		"reversed-fraction": stringOption("reversed-order fraction"),
		"edges-dir": stringOption("TIGER EDGES directory"),
		country: stringOption("target country"),
		"intl-fraction": stringOption("international-order fraction"),
		"comma-free-fraction": stringOption("german: comma-free native-order fraction"),
		"ortsteil-fraction": stringOption("german: fraction carrying a WOF Ortsteil as dependent_locality"),
		"admin-db": stringOption("german: WOF admin database for the Ortsteil pool"),
		"country-fraction": stringOption("explicit-country fraction"),
		"district-as-locality": { type: "boolean", description: "Override district-as-locality mapping" },
		"bare-prob": stringOption("bare-street probability"),
		"hn-prob": stringOption("house-number probability"),
		communes: stringOption("communes source"),
		"ban-dir": stringOption("BAN directory"),
		"exclude-surfaces": stringOption("reserved surfaces to exclude"),
		"multilocale-count": stringOption("multilocale row count"),
		lexicon: stringOption("sub-venue lexicon"),
		"extracts-dir": stringOption("OSM extract directory"),
		"poi-db": stringOption("POI database"),
		"sub-venue-tuples": stringOption("address-context tuples"),
		"negative-fraction": stringOption("confound-negative fraction"),
	},
} as const satisfies CommandSpec

const num = (s: string | undefined): number | undefined => (s == null ? undefined : Number(s))

const CorpusSlice: CommandComponent<typeof spec> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const { getSliceRecipe, listSliceRecipes } = await import("@mailwoman/corpus")

		if (options.list || !args.length) {
			return [
				"recipes:",
				...listSliceRecipes().map((r) => `  ${r.name.padEnd(20)} [${r.mode}] ${r.description}`),
				"",
				"usage: mailwoman corpus slice <recipe> --out <out.jsonl> [--input <tuples.jsonl> | --count N] [--seed N]",
			]
		}

		const name = args[0]!
		const recipe = getSliceRecipe(name)

		if (!recipe) {
			throw new CommandError(`unknown recipe "${name}". Run \`mailwoman corpus slice --list\`.`)
		}

		if (!options.out) throw new CommandError("--out <out.jsonl> required")

		if (recipe.mode === "tuples" && !options.input)
			throw new CommandError(`recipe "${name}" needs --input <tuples.jsonl>`)

		if (recipe.mode === "generate" && !options.count) throw new CommandError(`recipe "${name}" needs --count <N>`)

		const seed = options.seed != null ? Number(options.seed) : Date.now()

		const opts: SliceRecipeOpts = {
			output: options.out,
			seed,
			variants: countOption(options.variants, 1),
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
			commaFreeFraction: num(options.commaFreeFraction),
			ortsteilFraction: num(options.ortsteilFraction),
			adminDB: options.adminDB,
			countryFraction: num(options.countryFraction),
			districtAsLocality: options.districtAsLocality,
			bareProb: num(options.bareProb),
			hnProb: num(options.hnProb),
			communes: options.communes,
			banDir: options.banDir,
			excludeSurfaces: options.excludeSurfaces,
			multilocaleCount: num(options.multilocaleCount),
			lexicon: options.lexicon,
			extractsDir: options.extractsDir,
			poiDB: options.poiDB,
			subVenueTuples: options.subVenueTuples,
			negativeFraction: num(options.negativeFraction),
		}

		console.error(`▸ slice recipe "${name}" [${recipe.mode}] seed=${seed} → ${options.out}`)

		const stream = openWriteStream(options.out, { encoding: "utf8" })

		const write = createRecipeLineWriter(stream)

		const stats = await recipe.run(opts, write)
		stream.end()

		await new Promise<void>((res) => {
			stream.on("finish", () => res())
		})

		return [
			`recipe: ${name}`,
			`${stats.emitted.toLocaleString()} rows emitted, ${stats.skipped.toLocaleString()} skipped${stats.read != null ? `, ${stats.read.toLocaleString()} read` : ""}${stats.contaminated ? `, ${stats.contaminated.toLocaleString()} board-reserved` : ""} → ${options.out}`,
		]
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

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

export default CorpusSlice
