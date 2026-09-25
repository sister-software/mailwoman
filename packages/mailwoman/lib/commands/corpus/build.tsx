/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus build --version 0.1.0 --out /data/corpus/versioned/ --inputs '{ "wof-admin":
 *   "/data/wof/admin.db", "wof-postalcode": "/data/wof/post.db" }'`
 *
 *   End-to-end corpus build. Drives every registered adapter (or the filtered subset) per `--inputs`,
 *   runs synthesis + alignment, computes the locality-holdout split, and writes the final jsonl
 *   parquet files + per-stage manifests under `<out>/corpus-v<version>/`.
 *
 *   Adapters whose id is missing from `--inputs` are skipped (and noted in the manifest); this is how
 *   the CLI handles partial builds during development.
 */

import { isAlpha2CodeShape } from "@mailwoman/codex/country"
import { CommandError } from "@mailwoman/core/scripting/command"
import type { BuildStage } from "@mailwoman/corpus"
import type { AdapterOptions } from "@mailwoman/corpus/types"
import { Box, Text } from "ink"
import { useState } from "react"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * `--inputs` accepts either:
 *
 * - A bare string (path-only, for adapters that need no extra options): `"wof-admin": "/data/wof.db"`
 * - A full AdapterOptions object: `"openaddresses": { "inputPath": "/data/oa.geojsonl", "country": "US" }`
 *
 * The object form is required by adapters that need a country filter (OpenAddresses),
 * or for fixture runs that want a `limit`.
 */
export const spec = {
	name: "build",
	description: "Build a versioned corpus.",
	options: {
		"corpus-version": { type: "string", default: "0.1.0-dev", description: "Corpus version" },
		out: { type: "string", required: true, description: "Output root", deprecatedName: "output" },
		inputs: { type: "string", required: true, description: "Adapter input JSON map" },
		synthesize: { type: "boolean", default: true, description: "Enable augmentation" },
		"rows-per-file": {
			type: "number",
			default: 1_000_000,
			validate: (value) => Number.isInteger(value) && value > 0,
			validationMessage: "--rows-per-file must be a positive integer.",
			description: "Max rows per parquet file",
			deprecatedName: "rows-per-slice",
		},
		"shuffle-window": {
			type: "number",
			validate: (value) => Number.isInteger(value) && value >= 0,
			validationMessage: "--shuffle-window must be a non-negative integer.",
			description: "Rows held in memory while shuffling each split. 0 writes arrival order",
		},
		"shuffle-seed": {
			type: "number",
			validate: (value) => Number.isInteger(value) && value >= 0,
			validationMessage: "--shuffle-seed must be a non-negative integer.",
			description: "Seed for --shuffle-window",
		},
	},
} as const satisfies CommandSpec

type AdapterInput = string | AdapterOptions

function isAdapterInputMap(input: unknown): input is Record<string, AdapterInput> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return false

	return Object.values(input).every((value) => {
		if (typeof value === "string") return true

		if (typeof value !== "object" || value === null || Array.isArray(value)) return false

		if (!("inputPath" in value) || typeof value.inputPath !== "string") return false

		if ("outputDir" in value && value.outputDir !== undefined && typeof value.outputDir !== "string") return false

		// The shape rather than the type.
		// A lower-case `nl` is a string, and the four adapters that filter per row compare it
		// against the row's own upper-case code, so it selects zero rows and reports no matches.
		// `corpus run` rejects it at the flag, and this is the other way in.
		if ("country" in value && value.country !== undefined && !isAlpha2CodeShape(value.country)) return false

		return (
			!("limit" in value) ||
			value.limit === undefined ||
			(typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit > 0)
		)
	})
}

const CorpusBuild: CommandComponent<typeof spec> = ({ options }) => {
	const [stage, setStage] = useState<{ name: BuildStage; message: string }>()

	const state = useCommandTask(async () => {
		const { parseJSONStrict } = await import("@mailwoman/core/json")
		const { buildCorpus, defaultAdapterRegistry } = await import("@mailwoman/corpus")

		let inputsParsed: unknown

		try {
			inputsParsed = parseJSONStrict(options.inputs)

			if (!isAdapterInputMap(inputsParsed)) throw new TypeError("expected an adapter-id to input map")
		} catch (error) {
			throw new CommandError(`invalid --inputs JSON: ${(error as Error).message}`)
		}

		const adapterInputs: Record<string, AdapterOptions> = Object.fromEntries(
			Object.entries(inputsParsed).map(([id, value]) => [id, typeof value === "string" ? { inputPath: value } : value])
		)

		const adapters = defaultAdapterRegistry.list()

		const m = await buildCorpus({
			outputDir: options.out,
			corpusVersion: options.corpusVersion,
			adapters,
			adapterInputs,
			synthesize: options.synthesize,
			rowsPerFile: options.rowsPerFile,
			shuffleWindow: options.shuffleWindow,
			shuffleSeed: options.shuffleSeed,
			onProgress: (name, message) => setStage({ name, message }),
		})

		return {
			total: m.slices.total_rows,
			aligned: m.total_aligned_rows,
			quarantined: m.quarantine_count,
			adapters: m.adapters.length,
		}
	})

	if (state.status === "error") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		const done = state.result

		return (
			<Box flexDirection="column">
				<Text>
					corpus-v{options.corpusVersion}: <Text color="green">{done.total}</Text> rows ({done.adapters} adapters,{" "}
					<Text dimColor>{done.quarantined} quarantined</Text>)
				</Text>
				<Text dimColor>{options.out}</Text>
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
