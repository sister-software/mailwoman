/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev download ssl-address` — refresh the checked-in Chromium libaddressinput
 *   per-country metadata under `core/data/chromium-i18n/ssl-address/`.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "ssl-address",
	description: "Download Chromium libaddressinput metadata.",
	options: {
		"out-dir": { type: "string", description: "Destination directory (default: the checked-in ssl-address data)" },
		concurrency: { type: "number", default: 8, description: "Parallel per-country fetches" },
	},
} as const satisfies CommandSpec

interface Options {
	outDir?: string
	concurrency: number
}

const DevDownloadSSLAddress: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { downloadSSLAddress } = await import("@mailwoman/core/tools")

			return downloadSSLAddress(options, (line) => console.error(line))
		},
		(result) => (result.failed > 0 ? 1 : 0)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done")
		return (
			<Text color={state.result.failed > 0 ? "red" : "green"}>
				{state.result.written} written, {state.result.failed} failed
			</Text>
		)

	return null
}

export default DevDownloadSSLAddress
