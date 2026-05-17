/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus build --version 0.1.0 --output /data/corpus/versioned/ --inputs '{ "wof-admin":
 *   "/data/wof/admin.db", "wof-postalcode": "/data/wof/post.db" }'`
 *
 *   End-to-end corpus build. Drives every registered adapter (or the filtered subset) per `--inputs`,
 *   runs synthesis + alignment, computes the locality-holdout split, and writes the final JSONL
 *   shards + per-stage manifests under `<output>/corpus-v<version>/`.
 *
 *   Adapters whose id is missing from `--inputs` are skipped (and noted in the manifest); this is how
 *   the CLI handles partial builds during development.
 */

import { buildCorpus, defaultAdapterRegistry, type BuildStage } from "@mailwoman/corpus"
import { Box, Text } from "ink"
import { setImmediate } from "node:timers/promises"
import { useEffect, useState } from "react"
import zod from "zod"
import { CommandComponent } from "../../sdk/cli.js"

const InputsSchema = zod.record(zod.string(), zod.string())

const BuildConfigSchema = zod.object({
	corpusVersion: zod
		.string()
		.default("0.1.0-dev")
		.describe(
			"Corpus version stamped onto every row + into the output dir name (--version is reserved by Pastel for the CLI's own version)"
		),
	output: zod.string().describe("Root output directory; everything lands beneath corpus-v<corpus-version>/"),
	inputs: zod.string().describe('JSON map "adapter-id":"input-path", e.g. {"wof-admin":"/data/wof/admin.db"}'),
	synthesize: zod.coerce.boolean().optional().default(true).describe("Enable augmentation pass (default true)"),
	rowsPerShard: zod.coerce.number().int().positive().optional().default(1_000_000).describe("Max rows per JSONL shard"),
})

export { BuildConfigSchema as options }

const CorpusBuild: CommandComponent<typeof BuildConfigSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [done, setDone] = useState<{ total: number; aligned: number; quarantined: number; adapters: number }>()
	const [stage, setStage] = useState<{ name: BuildStage; message: string }>()

	useEffect(() => {
		if (error) {
			setImmediate().then(() => process.exit(1))
		} else if (done) {
			setImmediate().then(() => process.exit(0))
		}
	}, [error, done])

	useEffect(() => {
		let inputsParsed: Record<string, string>
		try {
			inputsParsed = InputsSchema.parse(JSON.parse(options.inputs))
		} catch (err) {
			setError(`invalid --inputs JSON: ${(err as Error).message}`)
			return
		}

		const adapterInputs = Object.fromEntries(
			Object.entries(inputsParsed).map(([id, path]) => [id, { inputPath: path }])
		)

		const adapters = defaultAdapterRegistry.list()
		buildCorpus({
			outputDir: options.output,
			corpusVersion: options.corpusVersion,
			adapters,
			adapterInputs,
			synthesize: options.synthesize,
			rowsPerShard: options.rowsPerShard,
			onProgress: (name, message) => setStage({ name, message }),
		})
			.then((m) =>
				setDone({
					total: m.shards.total_rows,
					aligned: m.total_aligned_rows,
					quarantined: m.quarantine_count,
					adapters: m.adapters.length,
				})
			)
			.catch((err: Error) => setError(err.message))
	}, [options])

	if (error) return <Text color="red">{error}</Text>

	if (done) {
		return (
			<Box flexDirection="column">
				<Text>
					corpus-v{options.corpusVersion}: <Text color="green">{done.total}</Text> rows ({done.adapters} adapters,{" "}
					<Text dimColor>{done.quarantined} quarantined</Text>)
				</Text>
				<Text dimColor>{options.output}</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column">
			<Text>building corpus-v{options.corpusVersion}…</Text>
			{stage ? (
				<Text dimColor>
					[{stage.name}] {stage.message}
				</Text>
			) : null}
		</Box>
	)
}

export default CorpusBuild
