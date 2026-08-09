// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman dev generate country-reference` — regenerate `codex/country/reference-data.ts` (the
 *   per-country calling code + currency table) from mledoze/countries. Network codegen; the output
 *   is committed for provenance.
 */

import { generateCountryReference } from "@mailwoman/codex/tools"
import { Text } from "ink"
import { useCommandTask } from "mailwoman/cli-kit"

const report = (line: string): void => console.error(line)

const DevGenerateCountryReference = () => {
	const state = useCommandTask(() => generateCountryReference({}, report))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

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
