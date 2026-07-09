/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry convert tx-hhsc` — convert the TX HHSC nursing-facilities TSV (which ships
 *   an authoritative `Geo Location` per facility) into the OaRow JSONL the resolver eval consumes
 *   (#619), so the geocoder can be graded against provided coordinates via
 *   `oa-resolver-eval --address-points`.
 */

import { convertTXHHSC } from "@mailwoman/registry/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	src: zod
		.string()
		.optional()
		.describe("TX HHSC nursing-facilities TSV (default $MAILWOMAN_DATA_ROOT/record-matcher/sources/…)"),
	out: zod.string().default("/tmp/txhhsc-oarow.jsonl").describe("Output OaRow JSONL path"),
})

export { OptionsSchema as options }

const RegistryConvertTXHHSC: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () =>
		convertTXHHSC({ src: options.src, out: options.out }, (line) => console.error(line))
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Text color="green">
				tx-hhsc: wrote {state.result.written} rows (skipped {state.result.skipped}) → {state.result.out}
			</Text>
		)
	}

	return null
}

export default RegistryConvertTXHHSC
