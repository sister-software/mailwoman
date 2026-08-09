/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus overlay-manifest` — ported from the scripts drawer (PR E, #1029). The tool module is
 *   lazy-imported so eager command loading stays dependency-light.
 */

import { Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

const OptionsSchema = zod.object({
	base: zod.string().describe("Base corpus manifest path"),
	newDir: zod.string().describe("New overlay corpus dir"),
	modalRoot: zod.string().describe("Modal volume root the manifest paths are relative to"),
	// NOT `version`: Pastel registers `-v, --version` on the ROOT program, and commander resolves it
	// before the subcommand's own options, so `--version 9.9.9` printed the CLI version (8.7.0) and
	// exited 0 without ever running the tool (#1491). Pastel decamelizes the key, so this derives
	// `--corpus-version`. `mailwoman/test/command-option-collisions.test.ts` keeps the whole command
	// tree off the reserved names.
	corpusVersion: zod.string().describe("New corpus version"),
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
			version: options.corpusVersion,
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
