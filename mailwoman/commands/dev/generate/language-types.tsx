/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev generate language-types` — regenerate `core/resources/languages/types.gen.ts`
 *   (the ISO 639-1/639-2b language-code types + label maps) from the committed
 *   `internal/languages.csv` resource dictionary. Offline codegen.
 */

import { generateLanguageTypes } from "@mailwoman/core/tools"
import { Text } from "ink"

import { useCommandTask } from "../../../cli-kit/index.ts"

const report = (line: string): void => console.error(line)

const DevGenerateLanguageTypes = () => {
	const state = useCommandTask(() => generateLanguageTypes({}, report))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Text color="green">
				✓ wrote {state.result.outPath} ({state.result.languages} languages)
			</Text>
		)
	}

	return null
}

export default DevGenerateLanguageTypes
