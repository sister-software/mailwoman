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

import { tempRootPath } from "@mailwoman/core/utils"
import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "tx-hhsc",
	description: "Convert the TX HHSC nursing-facilities TSV to OaRow JSONL.",
	options: {
		src: {
			type: "string",
			description: "TX HHSC nursing-facilities TSV (default $MAILWOMAN_DATA_ROOT/record-matcher/sources/…)",
		},
		out: { type: "string", default: tempRootPath("txhhsc-oarow.jsonl"), description: "Output OaRow JSONL path" },
	},
} as const satisfies CommandSpec

interface Options {
	src?: string
	out: string
}

const RegistryConvertTXHHSC: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { convertTXHHSC } = await import("@mailwoman/registry/tools")

		return await convertTXHHSC({ src: options.src, out: options.out }, (line) => console.error(line))
	})

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
