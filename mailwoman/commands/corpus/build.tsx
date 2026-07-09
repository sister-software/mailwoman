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

import { setImmediate } from "node:timers/promises"

import { buildCorpus, defaultAdapterRegistry, type BuildStage } from "@mailwoman/corpus"
import type { AdapterOptions } from "@mailwoman/corpus/types"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../cli-kit/index.ts"

/**
 * `--inputs` accepts either:
 *
 * - A bare string (path-only, for adapters that need no extra options): `"wof-admin": "/data/wof.db"`
 * - A full AdapterOptions object: `"openaddresses": { "inputPath": "/data/oa.geojsonl", "country": "US" }`
 *
 * The object form is required by adapters that need a country filter (OpenAddresses), or for fixture runs that want a
 * `limit`.
 */
const AdapterInputSchema = zod.union([
	zod.string(),
	zod.object({
		inputPath: zod.string(),
		outputDir: zod.string().optional(),
		country: zod.string().optional(),
		limit: zod.number().int().positive().optional(),
	}),
])
const InputsSchema = zod.record(zod.string(), AdapterInputSchema)

const BuildConfigSchema = zod.object({
	corpusVersion: zod
		.string()
		.default("0.1.0-dev")
		.describe(
			"Corpus version stamped onto every row + into the output dir name (--version is reserved by Pastel for the CLI's own version)"
		),
	output: zod.string().describe("Root output directory; everything lands beneath corpus-v<corpus-version>/"),
	inputs: zod
		.string()
		.describe(
			'JSON map "adapter-id" → input. Each value is either an input path string or a full ' +
				'AdapterOptions object {"inputPath","country?","limit?"}. Adapters requiring a country ' +
				"filter (e.g. openaddresses) need the object form. Example: " +
				'{"wof-admin":"/data/wof.db","openaddresses":{"inputPath":"/data/oa.geojsonl","country":"US"}}'
		),
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
		let inputsParsed: Record<string, zod.infer<typeof AdapterInputSchema>>

		try {
			inputsParsed = InputsSchema.parse(JSON.parse(options.inputs))
		} catch (err) {
			// eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount validation; refactor pending
			setError(`invalid --inputs JSON: ${(err as Error).message}`)

			return
		}

		const adapterInputs: Record<string, AdapterOptions> = Object.fromEntries(
			Object.entries(inputsParsed).map(([id, value]) => [id, typeof value === "string" ? { inputPath: value } : value])
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
