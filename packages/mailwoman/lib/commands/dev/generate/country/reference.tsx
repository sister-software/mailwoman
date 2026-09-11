/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev generate country-reference` — regenerate `codex/country/reference-data.ts` (the
 *   per-country calling code + currency table) from mledoze/countries. Network codegen; the output
 *   is committed for provenance.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, reportToStderr, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "country-reference",
	description: "Generate country reference data",
} as const satisfies CommandSpec

const DevGenerateCountryReference = () => {
	const state = useCommandTask(async () => {
		const { generateCountryReference } = await import("@mailwoman/codex/tools")

		return generateCountryReference({}, reportToStderr)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Text color="green">
				✓ wrote {state.result.outPath} ({state.result.countries} countries)
			</Text>
		)
	}

	return null
}

export default DevGenerateCountryReference
