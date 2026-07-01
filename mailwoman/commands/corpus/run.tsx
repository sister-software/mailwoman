/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus run <adapter-id> --input <path> --output <dir> [--country XX] [--limit N]`
 *
 *   CLI shim around `runAdapter` from `@mailwoman/corpus`. Resolves `<adapter-id>` against the
 *   default registry; refuses with a clear, non-zero exit if the id isn't known (and lists the
 *   registered ids). On success, prints a one-line summary and the path to the manifest file.
 */

import { setImmediate } from "node:timers/promises"

import { ProgressBar } from "@inkjs/ui"
import { defaultAdapterRegistry, runAdapter, type AdapterRunManifest } from "@mailwoman/corpus"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../sdk/cli.js"

const ArgumentsSchema = zod.array(zod.string().describe("Adapter id (e.g. wof-admin, ban, openaddresses)"))

const RunConfigSchema = zod.object({
	input: zod.string().describe("Path to the adapter's input data (file, directory, or URL — adapter-specific)"),
	output: zod.string().describe("Output root directory; the runner creates <output>/<adapter-id>/ under it"),
	country: zod
		.string()
		.regex(/^[A-Z]{2}$/u, "Expected ISO 3166-1 alpha-2 country code (e.g. US, FR)")
		.optional()
		.describe("Filter to a single ISO 3166-1 alpha-2 country"),
	limit: zod.coerce
		.number()
		.int()
		.positive()
		.optional()
		.describe("Soft cap on rows the adapter is allowed to emit (smoke runs, fixtures)"),
	corpusVersion: zod
		.string()
		.optional()
		.default("0.1.0-dev")
		.describe("Corpus version string stamped onto every row; locks tokenizer pairing"),
	progressEvery: zod.coerce
		.number()
		.int()
		.positive()
		.optional()
		.default(1_000)
		.describe("Yield count between progress ticks (smaller = chattier, larger = quieter)"),
})

export { ArgumentsSchema as args, RunConfigSchema as options }

const CorpusRun: CommandComponent<typeof RunConfigSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const [error, setError] = useState<string>()
	const [progress, setProgress] = useState<{ yielded: number; written: number; bytes: number }>({
		yielded: 0,
		written: 0,
		bytes: 0,
	})
	const [manifest, setManifest] = useState<AdapterRunManifest>()

	useEffect(() => {
		if (error) {
			setImmediate().then(() => process.exit(1))
		} else if (manifest) {
			setImmediate().then(() => process.exit(0))
		}
	}, [error, manifest])

	useEffect(() => {
		const adapterID = args[0]

		if (!adapterID) {
			// eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount validation; refactor pending
			setError("missing positional argument: <adapter-id>")

			return
		}

		const adapter = defaultAdapterRegistry.get(adapterID)

		if (!adapter) {
			const ids = defaultAdapterRegistry.ids()
			const hint = ids.length === 0 ? "(no adapters registered yet)" : `registered: ${ids.join(", ")}`
			setError(`unknown adapter id ${JSON.stringify(adapterID)}; ${hint}`)

			return
		}

		const ac = new AbortController()
		runAdapter({
			adapter,
			adapterOptions: {
				inputPath: options.input,
				outputDir: options.output,
				country: options.country,
				limit: options.limit,
				signal: ac.signal,
			},
			outputDir: options.output,
			corpusVersion: options.corpusVersion,
			progressEvery: options.progressEvery,
			onProgress: (snap) => {
				setProgress({ yielded: snap.yielded, written: snap.written, bytes: snap.bytes })
			},
		})
			.then((m) => setManifest(m))
			.catch((err: Error) => setError(err.message))

		return () => ac.abort()
	}, [args, options])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (manifest) {
		return (
			<Box flexDirection="column">
				<Text>
					<Text bold>{manifest.adapter_id}</Text>
					{": wrote "}
					<Text color="green">{manifest.written}</Text>
					{" rows ("}
					<Text dimColor>{manifest.deduped} deduped</Text>
					{") in "}
					{(manifest.elapsed_ms / 1000).toFixed(2)}s
				</Text>
				<Text dimColor>{manifest.jsonl_path}</Text>
				<Text dimColor>sha256={manifest.sha256}</Text>
			</Box>
		)
	}

	const ratio = progress.written && progress.yielded ? (progress.written / progress.yielded) * 100 : 0

	return (
		<Box flexDirection="column">
			<Text>
				yielded={progress.yielded}
				{"  "}written={progress.written}
				{"  "}bytes={progress.bytes}
			</Text>
			<Box paddingX={1}>
				<ProgressBar value={Math.min(100, ratio)} />
			</Box>
		</Box>
	)
}

export default CorpusRun
