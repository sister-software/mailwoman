/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { openWriteStream } from "@mailwoman/core/fs/streams"
import { movePath, removePathIfPresent, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { CommandError } from "@mailwoman/core/scripting/command"
import type { RecipeOptions } from "@mailwoman/corpus"
import { createRecipeLineWriter, admittingRecipeLineWriter } from "@mailwoman/corpus/recipes/scaffold"
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
 * Bare `mailwoman corpus recipe` stays the recipe runner despite the subcommands in this directory.
 */
export const isDefault = true

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "recipe",
	description: "Run a corpus recipe and write its output",
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
		register: stringOption("The published register the --input tuples were extracted from"),
		"house-number-prob": stringOption("street house-number probability"),
		"pmb-ratio": stringOption("private-mailbox ratio"),
		"military-ratio": stringOption("military row ratio"),
		"reversed-fraction": stringOption("reversed-order fraction"),
		"edges-dir": stringOption("TIGER EDGES directory"),
		country: stringOption("target country"),
		"comma-free-fraction": stringOption("german: comma-free fraction"),
		"ortsteil-fraction": stringOption("german: fraction carrying a WOF Ortsteil as dependent_locality"),
		"region-fraction": stringOption(
			"locale/german: fraction writing the tuple's region; default is the country's share"
		),
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
		"sub-venue-tuples": stringOption("address-context tuples"),
		"negative-fraction": stringOption("confound-negative fraction"),
		"venue-names": stringOption("venue, sub-venue: Overture place-names parquet"),
		"venue-region-fraction": stringOption("venue: share of locality rows that also carry the region"),
		"unshippable-reason": stringOption(
			"Admit a source whose register rows lack a permission for transform and train, for a local experiment; the invocation record marks the output not shippable"
		),
	},
} as const satisfies CommandSpec

const num = (s: string | null | undefined): number | null => (typeof s === "string" ? Number(s) : null)

const CorpusRecipeRun: CommandComponent<typeof spec> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const { getRecipe, listRecipes } = await import("@mailwoman/corpus")

		if (options.list || !args.length) {
			return [
				"recipes:",
				...listRecipes().map((r) => `  ${r.name.padEnd(20)} [${r.mode}] ${r.description}`),
				"",
				"usage: mailwoman corpus recipe <recipe> --out <out.jsonl> [--input <tuples.jsonl> | --count N] [--seed N]",
			]
		}

		const name = args[0]!
		const recipe = getRecipe(name)

		if (!recipe) {
			throw new CommandError(`unknown recipe "${name}". Run \`mailwoman corpus recipe --list\`.`)
		}

		if (!options.out) throw new CommandError("--out <out.jsonl> required")

		if (recipe.mode === "tuples" && !options.input)
			throw new CommandError(`recipe "${name}" needs --input <tuples.jsonl>`)

		if (recipe.mode === "generate" && !options.count) throw new CommandError(`recipe "${name}" needs --count <N>`)

		const seed = options.seed ? Number(options.seed) : Date.now()

		const opts: RecipeOptions = {
			output: options.out,
			seed,
			variants: countOption(options.variants, 1),
			input: options.input,
			count: num(options.count),
			golden: options.golden,
			sourceName: options.sourceName,
			register: options.register,
			houseNumberProb: num(options.houseNumberProb),
			pmbRatio: num(options.pmbRatio),
			militaryRatio: num(options.militaryRatio),
			reversedFraction: num(options.reversedFraction),
			edgesDir: options.edgesDir,
			country: options.country,
			commaFreeFraction: num(options.commaFreeFraction),
			ortsteilFraction: num(options.ortsteilFraction),
			regionFraction: num(options.regionFraction),
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
			subVenueTuples: options.subVenueTuples,
			negativeFraction: num(options.negativeFraction),
			venueNames: options.venueNames,
			venueRegionFraction: num(options.venueRegionFraction),
		}

		console.error(`▸ recipe "${name}" [${recipe.mode}] seed=${seed} → ${options.out}`)

		// `openWriteStream` truncates on open and a recipe validates its inputs inside `run`,
		// so writing directly would leave the target at zero bytes when a run refuses.
		const stagedPath = `${options.out}.partial`
		const stream = openWriteStream(stagedPath, { encoding: "utf8" })

		const { openSourceRightsAdmission } = await import("@mailwoman/corpus/source-register/corpus-inputs")

		const rights = await openSourceRightsAdmission({
			context: `recipe ${name}`,
			unshippableReason: options.unshippableReason ?? null,
		}).catch((error: unknown) => {
			stream.destroy()

			throw error
		})

		const write = admittingRecipeLineWriter(createRecipeLineWriter(stream), rights)

		let stats: Awaited<ReturnType<typeof recipe.run>>

		try {
			stats = await recipe.run(opts, write)
		} catch (error) {
			stream.destroy()
			await removePathIfPresent(stagedPath)

			throw error
		}

		stream.end()

		await new Promise<void>((res) => {
			stream.on("finish", () => res())
		})

		await movePath(stagedPath, options.out)

		// A recipe output records what a recipe emitted rather than what it was asked for,
		// so the invocation is written beside it after the rows, marking only a finished run.
		await writeLocalJSONFile(
			{
				recipe: name,
				mode: recipe.mode,
				emitted: stats.emitted,
				skipped: stats.skipped,
				read: stats.read ?? null,
				ranAt: new Date().toISOString(),
				options: Object.fromEntries(Object.entries(opts).filter(([, value]) => value)),
				source_rights: rights.record(),
			},
			`${options.out}.invocation.json`
		)

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

export default CorpusRecipeRun
