/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman clients generate` — emit all four surfaces' OpenAPI documents, generate a Python package and
 *   a Rust crate, then verify both build; output lands under the gitignored `clients-build/`, and no
 *   generated file is committed.
 */

import { Box, Text } from "ink"

import {
	CheckList,
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	phaseReporter,
	useCommandTask,
} from "#cli-kit"

export const description = "Generate + verify the Python and Rust API clients from the emitted OpenAPI specs"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "generate",
	description,
	options: {
		"out-dir": { type: "string", description: "Output root. Default <repo>/clients-build (gitignored)" },
		"skip-verify": {
			type: "boolean",
			default: false,
			description: "Skip client build verification (development only)",
		},
	},
} as const satisfies CommandSpec

const ClientsGenerate: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { generateClients } = await import("#tools/generate-clients")

			return await generateClients({
				outDir: options.outDir,
				skipVerify: options.skipVerify,
				onPhase: phaseReporter(),
			})
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		const { ok, checks, receipt } = state.result

		return (
			<Box flexDirection="column">
				<CheckList checks={checks} verdict={ok} />
				{ok && (
					<Box flexDirection="column" marginTop={1}>
						<Text>version: {receipt.version}</Text>
						<Text>specs: {receipt.specsDir}</Text>
						<Text>
							python: {receipt.pythonDir}
							{receipt.pythonWheel ? ` (${receipt.pythonWheel})` : ""}
						</Text>
						<Text>rust: {receipt.rustDir}</Text>
						<Text>elapsed: {receipt.elapsedSeconds.toFixed(1)}s</Text>
					</Box>
				)}
			</Box>
		)
	}

	return null // progress streams to stderr until the summary lands
}

export default ClientsGenerate
