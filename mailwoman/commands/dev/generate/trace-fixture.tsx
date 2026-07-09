/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev generate trace-fixture ["custom address"]` — regenerate the committed
 *   ModelVisualizer fixture (one real `NeuralParseTrace` from the locally-resolved en-us weights).
 *   Re-run after any trace-schema change or weights bump. On machines without the anchor lookup
 *   ($MAILWOMAN_DATA_ROOT) the trace's `anchor` channel is absent — regenerate on a lab box when
 *   that state matters.
 */

import { Text } from "ink"
import { argument } from "pastel"
import zod from "zod"

import { type PositionalCommandComponent, useCommandTask } from "../../../cli-kit/index.ts"
import { generateTraceFixture } from "../../../dev-tools/generate-trace-fixture.ts"

const ArgumentsSchema = zod
	.array(
		zod.string().describe(
			argument({
				name: "address",
				description: "Address to trace (default: 1600 Pennsylvania Ave NW, Washington, DC 20500)",
			})
		)
	)
	.default([])

export { ArgumentsSchema as args }

const report = (line: string): void => console.error(line)

const DevGenerateTraceFixture: PositionalCommandComponent<typeof ArgumentsSchema> = ({ args }) => {
	const state = useCommandTask(() => generateTraceFixture({ text: args[0] }, report))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Text color="green">
				✓ wrote {state.result.outPath} ({state.result.pieces} pieces, {state.result.labels} labels)
			</Text>
		)
	}

	return null
}

export default DevGenerateTraceFixture
