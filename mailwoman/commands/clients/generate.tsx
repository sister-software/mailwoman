/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman clients generate` — the client-generation pipeline: emit all four surfaces' OpenAPI
 *   documents (mailwoman/photon/nominatim/libpostal — 3.1 + the progenitor-diet 3.0), generate a
 *   Python package (openapi-python-client, the salvaged `mailwoman_client` layout from the retired
 *   `feat/api-clients` branch) and a Rust crate (progenitor `generate_api!`, the salvaged Cargo.toml
 *   / lib.rs pattern), then VERIFY both actually build (`uv build` + a wheel import-check, `cargo
 *   check --examples`). Output lands under the gitignored `clients-build/` — nothing generated here
 *   is committed. This is the local, receipt-verified proof the gated CI job (Phase 5 Task 4)
 *   replays on dispatch. See `docs/articles/api.mdx` "Client libraries" for install/usage snippets
 *   and the not-yet-published status.
 */

import { Box, Text } from "ink"
import zod from "zod"

import { CheckList, type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { generateClients } from "../../tools/generate-clients.ts"

export const description = "Generate + verify the Python and Rust API clients from the emitted OpenAPI specs"

const OptionsSchema = zod.object({
	outDir: zod.string().optional().describe("Output root. Default <repo>/clients-build (gitignored)"),
	skipVerify: zod
		.boolean()
		.default(false)
		.describe(
			"Skip `uv build`/import-check + `cargo check --examples` (dev only — an unverified pipeline must never stand in as a release proof)"
		),
})

export { OptionsSchema as options }

const ClientsGenerate: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		() =>
			generateClients({
				outDir: options.outDir,
				skipVerify: options.skipVerify,
				onPhase: (phase, detail) => console.error(`  [${phase}]${detail ? ` ${detail}` : ""}`),
			}),
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

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
