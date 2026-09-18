/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus tuples` — write the `(postcode, locality, region, country)` tuples the `trailing-region`
 *   recipe reads, one JSON line per tuple.
 *
 *   The extraction lived as a one-off whose output survived and whose code did not; `@mailwoman/corpus/tools`'s
 *   `postcode-triples` restored the code, and this command is its entry point, so a country's tuples can be rebuilt
 *   when the extraction changes. The `parent-join` source follows each `postalcode-intl.db` code's parent into the admin
 *   gazetteer and emits one tuple per REGION SURFACE in the languages the region's addresses are written in (#1673);
 *   the `geonames` source reads a fetched GeoNames postal export. Both stamp the country's attested postcode placement
 *   and refuse a country whose placement nothing attests.
 *
 *   The `admin-pairs` source answers the pair without a postcode, straight from the admin gazetteer, for a country no
 *   postcode source reaches — the recipe's bare `«locality», «region»[, «country»]` form needs none. It stamps the
 *   `--locale` the caller names, because the gazetteer says which languages a country writes and not which one a given
 *   region surface came from.
 */

import { countryDisplayNames } from "@mailwoman/codex/country"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { CommandError } from "@mailwoman/core/scripting/command"
import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, splitCountryCodes, useCommandTask } from "#cli-kit"
import { suffixTail } from "#dev-tools/coord-panel"

/**
 * The three buckets `--stratify-shape` spends the budget across, from the same {@link suffixTail} the probes over this
 * recipe's output report by — so a share measured in the tuples and a rate measured on a panel speak about one split.
 */
function localityShape(triple: { locality: string }): string {
	if (suffixTail(triple.locality)) return "suffix-tail"

	return triple.locality.trim().split(/\s+/).length > 1 ? "multi-word" : "single-word"
}

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "tuples",
	description: "Write the trailing-region tuples for a set of countries",
	options: {
		countries: { type: "string", description: "ISO-3166 alpha-2 codes, comma-separated (ES,GB)" },
		out: { type: "string", description: "Output tuples JSONL", deprecatedName: "output" },
		source: {
			type: "string",
			default: "parent-join",
			choices: ["parent-join", "geonames", "admin-pairs"],
			description:
				"parent-join (postalcode-intl.db → admin gazetteer), geonames (fetched postal export) or admin-pairs (gazetteer only, no postcode)",
		},
		locale: {
			type: "string",
			description: "BCP-47 tag stamped on admin-pairs rows (the other sources carry their country's own)",
		},
		quota: { type: "number", description: "Postcodes one locality may contribute (default: the tool's)" },
		budget: { type: "number", description: "Tuples one country may contribute" },
		"stratify-shape": {
			type: "boolean",
			description: "Spend the budget evenly across locality name shapes as well as regions (US suffix tails)",
		},
		"postcode-db": { type: "string", description: "postalcode-intl.db path (parent-join)" },
		"admin-db": { type: "string", description: "Admin gazetteer path" },
	},
} as const satisfies CommandSpec

interface TuplesReport {
	written: number
	byCountry: Record<string, number>
	regionSurfaces: number
	output: string
}

const CorpusTuples: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async (): Promise<TuplesReport> => {
		if (!options.countries) throw new CommandError("--countries <CC,CC> required")

		if (!options.out) throw new CommandError("--out <tuples.jsonl> required")

		const tools = await import("@mailwoman/corpus/tools/postcode-triples")
		const countries = splitCountryCodes(options.countries)

		type Extracted =
			| Awaited<ReturnType<typeof tools.readTriplesFromParentJoin>>[number]
			| Awaited<ReturnType<typeof tools.readPairsFromAdmin>>[number]

		let triples: Extracted[]

		if (options.source === "admin-pairs") {
			triples = await tools.readPairsFromAdmin(countries, {
				...(options.adminDB ? { adminDB: options.adminDB } : {}),
				...(options.locale ? { locale: () => options.locale as string } : {}),
			})
		} else if (options.source === "geonames") {
			triples = []

			for (const cc of countries) {
				const name = countryDisplayNames(cc, ["en"])[0] ?? cc

				triples.push(...(await tools.readTriplesFromGeonames(cc, tools.geonamesPostalPath(cc), name)))
			}
		} else {
			triples = await tools.readTriplesFromParentJoin(countries, {
				...(options.postcodeDB ? { postcodeDB: options.postcodeDB } : {}),
				...(options.adminDB ? { adminDB: options.adminDB } : {}),
			})
		}

		let kept = tools.applyLocalityQuota(triples, options.quota)

		if (options.budget !== undefined) {
			kept = tools.applyCountryBudget(kept, options.budget, options.stratifyShape ? localityShape : undefined)
		}

		await writeLocalTextFile(
			kept.map((triple) => stringifyJSON(triple)).join("\n") + (kept.length ? "\n" : ""),
			options.out
		)

		const byCountry: Record<string, number> = {}
		const surfaces = new Set<string>()

		for (const triple of kept) {
			byCountry[triple.cc] = (byCountry[triple.cc] ?? 0) + 1
			surfaces.add(`${triple.cc} ${triple.region}`)
		}

		return { written: kept.length, byCountry, regionSurfaces: surfaces.size, output: options.out }
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	const perCountry = Object.entries(state.result.byCountry)
		.map(([cc, n]) => `${cc} ${n.toLocaleString()}`)
		.join(", ")

	return (
		<Text>
			{`${state.result.written.toLocaleString()} tuples (${perCountry}; ${state.result.regionSurfaces} region surfaces) → ${state.result.output}`}
		</Text>
	)
}

export default CorpusTuples
