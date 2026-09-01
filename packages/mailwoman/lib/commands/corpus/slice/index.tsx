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
import type { SliceRecipeOpts } from "@mailwoman/corpus"
import { Box, Text } from "ink"

import {
	CommandError,
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
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
		output: stringOption("Output JSONL path"),
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

interface Options {
	list: boolean
	output?: string
	input?: string
	count?: string
	variants: string
	seed?: string
	golden: boolean
	sourceName?: string
	houseNumberProb?: string
	pmbRatio?: string
	militaryRatio?: string
	reversedFraction?: string
	edgesDir?: string
	country?: string
	intlFraction?: string
	countryFraction?: string
	districtAsLocality?: boolean
	bareProb?: string
	hnProb?: string
	communes?: string
	banDir?: string
	excludeSurfaces?: string
	multilocaleCount?: string
	lexicon?: string
	extractsDir?: string
	poiDB?: string
	subVenueTuples?: string
	negativeFraction?: string
}

const num = (s: string | undefined): number | undefined => (s == null ? undefined : Number(s))

const CorpusSlice: ParsedCommandComponent<Options> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const { getSliceRecipe, listSliceRecipes } = await import("@mailwoman/corpus")

		if (options.list || !args.length) {
			return [
				"recipes:",
				...listSliceRecipes().map((r) => `  ${r.name.padEnd(20)} [${r.mode}] ${r.description}`),
				"",
				"usage: mailwoman corpus slice <recipe> --output <out.jsonl> [--input <tuples.jsonl> | --count N] [--seed N]",
			]
		}

		const name = args[0]!
		const recipe = getSliceRecipe(name)

		if (!recipe) {
			throw new CommandError(`unknown recipe "${name}". Run \`mailwoman corpus slice --list\`.`)
		}

		if (!options.output) throw new CommandError("--output <out.jsonl> required")

		if (recipe.mode === "tuples" && !options.input)
			throw new CommandError(`recipe "${name}" needs --input <tuples.jsonl>`)

		if (recipe.mode === "generate" && !options.count) throw new CommandError(`recipe "${name}" needs --count <N>`)

		const seed = options.seed != null ? Number(options.seed) : Date.now()

		const opts: SliceRecipeOpts = {
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

		console.error(`▸ slice recipe "${name}" [${recipe.mode}] seed=${seed} → ${options.output}`)

		const stream = openWriteStream(options.output, { encoding: "utf8" })

		const write = (line: string): void => {
			stream.write(line)
		}

		const stats = await recipe.run(opts, write)
		stream.end()

		await new Promise<void>((res) => {
			stream.on("finish", () => res())
		})

		return [
			`recipe: ${name}`,
			`${stats.emitted.toLocaleString()} rows emitted, ${stats.skipped.toLocaleString()} skipped${stats.read != null ? `, ${stats.read.toLocaleString()} read` : ""}${stats.contaminated ? `, ${stats.contaminated.toLocaleString()} board-reserved` : ""} → ${options.output}`,
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
