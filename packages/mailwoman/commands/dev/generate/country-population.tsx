/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev generate country-population` — regenerate `codex/country/population.ts` (the
 *   per-country population table, #1650's prominence-race fallback) from GeoNames countryInfo.txt.
 *   Network codegen; the output is committed for provenance.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, reportToStderr, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "country-population",
	description: "Generate country population data",
} as const satisfies CommandSpec

const DevGenerateCountryPopulation = () => {
	const state = useCommandTask(async () => {
		const { generateCountryPopulation } = await import("@mailwoman/codex/tools")

		return generateCountryPopulation({}, reportToStderr)
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

export default DevGenerateCountryPopulation
