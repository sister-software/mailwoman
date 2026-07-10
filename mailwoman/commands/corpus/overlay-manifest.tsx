/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus overlay-manifest` — ported from the scripts drawer (PR E, #1029). The tool module is
 *   lazy-imported so eager command loading stays dependency-light.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	base: zod.string().describe("Base corpus manifest path"),
	newDir: zod.string().describe("New overlay corpus dir"),
	modalRoot: zod.string().describe("Modal volume root the manifest paths are relative to"),
	version: zod.string().describe("New corpus version"),
	shardParquet: zod.string().describe("The ONE shard parquet to add"),
	source: zod.string().describe("Shard source label"),
	note: zod.string().describe("Manifest note"),
})

export { OptionsSchema as options }

const Cmd: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { assembleOverlayManifest } = await import("@mailwoman/corpus/tools")
		await assembleOverlayManifest({
			base: options.base,
			newDir: options.newDir,
			modalRoot: options.modalRoot,
			version: options.version,
			shardParquet: options.shardParquet,
			source: options.source,
			note: options.note,
		})

		return "done"
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default Cmd
