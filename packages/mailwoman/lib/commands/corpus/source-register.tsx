/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Deterministic: the same research CSVs produce byte-identical output.
 *
 *   The build refuses to write a register that fails its own audit, so an unseeded jurisdiction or an undeclared
 *   licence decision fails here rather than in a consumer.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "source-register",
	description: "Regenerate the address-source register from a research pass.",
	options: {
		inventory: { type: "string", description: "Jurisdiction inventory CSV" },
		sources: { type: "string", description: "Functional-authority CSV, discovery lookups included" },
		out: { type: "string", default: "packages/corpus/data/address-source-register.json", description: "Destination" },
		decisions: {
			type: "string",
			default: "packages/corpus/data/license-decisions.json",
			description: "Licence decisions to apply over the research pass's unchecked defaults",
		},
		"register-version": { type: "string", default: "0.1.0", description: "Register version" },
		"authored-at": { type: "string", description: "Date the research pass was taken, YYYY-MM-DD" },
		"source-version": { type: "string", description: "Research document the pass was written against" },
	},
} as const satisfies CommandSpec

const CorpusSourceRegister: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildSourceRegister } = await import("@mailwoman/corpus/tools")

		if (!options.inventory) throw new Error("--inventory is required")

		if (!options.sources) throw new Error("--sources is required")

		if (!options.authoredAt) throw new Error("--authored-at is required")

		return await buildSourceRegister({
			inventoryPath: options.inventory,
			sourcesPath: options.sources,
			outPath: options.out,
			decisionsPath: options.decisions,
			version: options.registerVersion,
			authoredAt: options.authoredAt,
			sourceVersion: options.sourceVersion,
		})
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	const { outPath, jurisdictions, sources, licenses, discoveryRailRowsDropped, researchStates, statuses } = state.result

	return (
		<Text color="green">
			{outPath}: {jurisdictions} jurisdictions ({researchStates.seeded ?? 0} seeded, {researchStates.exception ?? 0}{" "}
			exception, {researchStates.unexamined ?? 0} unexamined), {sources} sources ({statuses["verified-authority"] ?? 0}{" "}
			verified-authority, {statuses["retained-original"] ?? 0} retained-original, {statuses["verified-corpus"] ?? 0}{" "}
			verified-corpus, {statuses["verified-corpus-stale"] ?? 0} stale), {licenses} license decisions,{" "}
			{discoveryRailRowsDropped} discovery-lookup rows dropped
		</Text>
	)
}

export default CorpusSourceRegister
