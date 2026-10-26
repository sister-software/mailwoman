/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman wof explore <id-or-name>`: print every row the `wof-admin` adapter renders for one Who's On First
 *   record, grouped by name slot and variant suffix.
 *
 *   A number is a WOF id. A name is looked up in `candidate.db`, the matches are listed by population and
 *   importance, and the first is explored unless `--pick` chooses another.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "explore",
	description: "Print every row the wof-admin adapter renders for one Who's On First record",
	positionals: [{ name: "id-or-name", required: true, description: "A WOF id, or a place name to look up" }],
	options: {
		pick: {
			type: "number",
			default: 1,
			description: "Which name match to explore, counting from 1 in the listed order",
			validate: (value) => Number.isInteger(value) && value >= 1,
			validationMessage: "--pick takes a whole number from 1",
		},
		augment: {
			type: "boolean",
			default: false,
			description: "Also print each row under every synthesizer augmentation that changes it",
		},
		"candidate-db": { type: "string", description: "Candidate database. Default <data-root>/db/wof/candidate.db" },
		"repos-root": { type: "string", description: "WOF repos directory. Default <data-root>/src/wof-repos" },
		limit: { type: "number", default: 20, description: "Most name matches listed" },
	},
} as const satisfies CommandSpec

const formatComponents = (components: Record<string, string | undefined>): string =>
	Object.entries(components)
		.filter(([, value]) => value)
		.map(([tag, value]) => `${tag}=${stringifyJSON(value)}`)
		.join(" ")

const ExploreWOF: CommandComponent<typeof spec, [string]> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const { exploreWOFRecord, augmentExploredRow, findWOFFeaturePath, listWOFRepos } =
			await import("@mailwoman/corpus/adapters/wof/admin/json/explore")

		const lines: string[] = []
		const query = args[0].trim()
		let id: number

		if (/^\d+$/.test(query)) {
			id = Number(query)
		} else {
			const { openBuiltClient } = await import("@mailwoman/sqlite/sealed")
			const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")
			const { normalizeLocalityForKey } = await import("@mailwoman/resolver-wof-sqlite/street/normalize")

			type Database = import("@mailwoman/resolver-wof-sqlite/candidate/schema").CandidateDatabase
			using db = await openBuiltClient<Database>(options.candidateDB ?? wofDatabasePath("candidate.db"))

			// One row per place.
			// A place carries a row per name and alias, and the list keeps the first.
			const matches = await db
				.selectFrom("candidate")
				.innerJoin("placetype_codes", "placetype_codes.id", "candidate.placetype_id")
				.innerJoin("country_codes", "country_codes.id", "candidate.country_id")
				.select([
					"candidate.spr_id as id",
					"candidate.name as name",
					"placetype_codes.placetype as placetype",
					"country_codes.code as country",
					"candidate.population as population",
					"candidate.importance as importance",
				])
				.where("candidate.name_key", "=", normalizeLocalityForKey(query))
				.where("placetype_codes.placetype", "!=", "postalcode")
				.orderBy("candidate.population", "desc")
				.orderBy("candidate.importance", "desc")
				.limit(options.limit * 4)
				.execute()

			const seen = new Set<number>()
			const unique = matches.filter((match) => !seen.has(match.id) && seen.add(match.id))

			if (!unique.length) throw new Error(`No candidate.db row has the name "${query}"`)

			// candidate.db also holds places from other gazetteers, whose ids have no Who's On First file to read.
			const reposRoot = options.reposRoot ?? undefined
			const repos = await listWOFRepos(reposRoot)
			const backed = await Promise.all(unique.map((match) => findWOFFeaturePath(match.id, reposRoot, repos)))
			const places = unique.filter((_, index) => backed[index]).slice(0, options.limit)

			if (!places.length) {
				throw new Error(`None of the ${unique.length} candidate.db places named "${query}" has a Who's On First file`)
			}

			if (options.pick > places.length) {
				throw new Error(`--pick ${options.pick} is past the ${places.length} matches for "${query}"`)
			}

			lines.push(`matches for "${query}" (population, importance):`)

			for (const [index, place] of places.entries()) {
				const mark = index + 1 === options.pick ? ">" : " "
				const importance = place.importance === null ? "-" : place.importance.toFixed(3)

				lines.push(
					`${mark} ${index + 1}. ${place.id}  ${place.name ?? "?"}  ${place.placetype}  ${place.country}  pop=${place.population ?? "-"}  importance=${importance}`
				)
			}

			lines.push("")
			id = places[options.pick - 1]!.id
		}

		const exploration = await exploreWOFRecord(id, options.reposRoot ? { reposRoot: options.reposRoot } : {})
		const { record } = exploration

		lines.push(`WOF ${record.id}  ${record.name}  ${record.placetype}  ${record.country}`)
		lines.push(`file: ${exploration.path}`)

		lines.push(
			`ancestors: ${exploration.ancestors.map((ancestor) => `${ancestor.id} ${ancestor.name} (${ancestor.placetype})`).join(", ") || "none"}`
		)

		if (exploration.unresolvedAncestors.length) {
			lines.push(`ancestors not read: ${exploration.unresolvedAncestors.join(", ")}`)
		}

		let total = 0

		for (const { slot, rows } of exploration.slots) {
			lines.push("")
			lines.push(`[${slot.key}] ${stringifyJSON(slot.value)}${slot.language ? `  language=${slot.language}` : ""}`)

			for (const row of rows) {
				total++
				lines.push(`  ${row.suffix}`)
				lines.push(`    raw: ${stringifyJSON(row.raw)}`)
				lines.push(`    components: ${formatComponents(row.components)}`)
				lines.push(`    source_id: ${row.source_id}`)

				if (!options.augment) continue

				for (const augmented of augmentExploredRow(row)) {
					lines.push(`    +${augmented.augmentation}: ${stringifyJSON(augmented.raw)}`)
				}
			}
		}

		lines.push("")
		lines.push(`${total} rows across ${exploration.slots.length} name slots`)

		return lines
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return (
		<Box flexDirection="column">
			{state.result.map((line, index) => (
				<Text key={index}>{line || " "}</Text>
			))}
		</Box>
	)
}

export default ExploreWOF
