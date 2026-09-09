/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus tuples` — write the `(postcode, locality, region, country)` tuples the `trailing-region` slice
 *   recipe reads, one JSON line per tuple.
 *
 *   The extraction lived as a one-off whose output survived and whose code did not; `@mailwoman/corpus/tools`'s
 *   `postcode-triples` restored the code, and this command is its entry point, so a country's tuples can be rebuilt
 *   when the extraction changes. The `parent-join` source follows each `postalcode-intl.db` code's parent into the admin
 *   gazetteer and emits one tuple per REGION SURFACE in the languages the region's addresses are written in (#1673);
 *   the `geonames` source reads a fetched GeoNames postal export. Both stamp the country's attested postcode placement
 *   and refuse a country whose placement nothing attests.
 */

import { countryDisplayNames } from "@mailwoman/codex/country"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { CommandError } from "@mailwoman/core/scripting/command"
import { Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	splitUpperList,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "tuples",
	description: "Write the trailing-region tuples for a set of countries",
	options: {
		countries: { type: "string", description: "ISO-3166 alpha-2 codes, comma-separated (ES,GB)" },
		output: { type: "string", description: "Output tuples JSONL" },
		source: {
			type: "string",
			default: "parent-join",
			choices: ["parent-join", "geonames"],
			description: "parent-join (postalcode-intl.db → admin gazetteer) or geonames (fetched postal export)",
		},
		quota: { type: "number", description: "Postcodes one locality may contribute (default: the tool's)" },
		budget: { type: "number", description: "Tuples one country may contribute" },
		"postcode-db": { type: "string", description: "postalcode-intl.db path (parent-join)" },
		"admin-db": { type: "string", description: "Admin gazetteer path" },
	},
} as const satisfies CommandSpec

interface Options {
	countries?: string
	output?: string
	source: "parent-join" | "geonames"
	quota?: number
	budget?: number
	postcodeDb?: string
	adminDb?: string
}

interface TuplesReport {
	written: number
	byCountry: Record<string, number>
	regionSurfaces: number
	output: string
}

const CorpusTuples: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async (): Promise<TuplesReport> => {
		if (!options.countries) throw new CommandError("--countries <CC,CC> required")

		if (!options.output) throw new CommandError("--output <tuples.jsonl> required")

		const tools = await import("@mailwoman/corpus/tools/postcode-triples")
		const countries = splitUpperList(options.countries)
		let triples: Awaited<ReturnType<typeof tools.readTriplesFromParentJoin>>

		if (options.source === "geonames") {
			triples = []

			for (const cc of countries) {
				const name = countryDisplayNames(cc, ["en"])[0] ?? cc

				triples.push(...(await tools.readTriplesFromGeonames(cc, tools.geonamesPostalPath(cc), name)))
			}
		} else {
			triples = await tools.readTriplesFromParentJoin(countries, {
				...(options.postcodeDb ? { postcodeDB: options.postcodeDb } : {}),
				...(options.adminDb ? { adminDB: options.adminDb } : {}),
			})
		}

		let kept = tools.applyLocalityQuota(triples, options.quota)

		if (options.budget !== undefined) {
			kept = tools.applyCountryBudget(kept, options.budget)
		}

		await writeLocalTextFile(
			kept.map((triple) => JSON.stringify(triple)).join("\n") + (kept.length ? "\n" : ""),
			options.output
		)

		const byCountry: Record<string, number> = {}
		const surfaces = new Set<string>()

		for (const triple of kept) {
			byCountry[triple.cc] = (byCountry[triple.cc] ?? 0) + 1
			surfaces.add(`${triple.cc} ${triple.region}`)
		}

		return { written: kept.length, byCountry, regionSurfaces: surfaces.size, output: options.output }
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
