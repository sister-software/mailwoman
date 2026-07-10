/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev download ssl-address` — refresh the checked-in Chromium libaddressinput
 *   per-country metadata under `core/data/chromium-i18n/ssl-address/`.
 */

import { downloadSSLAddress } from "@mailwoman/core/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	outDir: zod.string().optional().describe("Destination directory (default: the checked-in ssl-address data)"),
	concurrency: zod.number().default(8).describe("Parallel per-country fetches"),
})

export { OptionsSchema as options }

const DevDownloadSSLAddress: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		() => downloadSSLAddress(options, (line) => console.error(line)),
		(result) => (result.failed > 0 ? 1 : 0)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done")
		return (
			<Text color={state.result.failed > 0 ? "red" : "green"}>
				{state.result.written} written, {state.result.failed} failed
			</Text>
		)

	return null
}

export default DevDownloadSSLAddress
