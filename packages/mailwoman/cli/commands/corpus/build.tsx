/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end corpus build: drives every registered adapter (or the filtered subset) from `--inputs`.
 *   It runs synthesis and alignment. It computes the locality-holdout split and writes the final jsonl
 *   and parquet files plus per-stage manifests under `<out>/corpus-v<version>/`.
 *
 *   Adapters whose id is missing from `--inputs` are skipped and noted in the manifest. This lets the
 *   CLI handles partial builds during development.
 *
 *   A build whose `--inputs` names `wof-admin` or `wof-postalcode` needs
 *   `NODE_OPTIONS="--max-old-space-size=20480"`. Both adapters hold every source record in memory.
 *   Node's default heap makes the process abort with SIGABRT during the adapter phase. This command
 *   refuses such a launch through `assertHeapForAdapters`. `buildCorpus` prints the heap limit it has.
 */

import { isAlpha2CodeShape } from "@mailwoman/codex/country"
import { CommandError } from "@mailwoman/core/scripting/command"
import { heapLimitBytes } from "@mailwoman/core/utils/system"
import type { BuildStage } from "@mailwoman/corpus"
import { BuildProfile } from "@mailwoman/corpus/build/types"
import type { AdapterOptions } from "@mailwoman/corpus/types"
import { LicensePolicy } from "@mailwoman/corpus/utils/license"
import { Box, Text } from "ink"
import { useState } from "react"

import { isCorpusVersion, type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * The accepted `--license-policy` values, for the flag's validation message.
 *
 * Derived from {@linkcode LicensePolicy} so a value added there reaches the CLI.
 */
const LICENSE_POLICIES: readonly LicensePolicy[] = Object.values(LicensePolicy)

/**
 * The accepted `--profile` values, for the flag's validation message.
 *
 * Derived from {@linkcode BuildProfile} so a value added there reaches the CLI.
 */
const BUILD_PROFILES: readonly BuildProfile[] = Object.values(BuildProfile)

/**
 * `--inputs` accepts a bare path string when an adapter needs no extra options.
 *
 * An `AdapterOptions` object supplies options such as an OpenAddresses country filter or a fixture `limit`.
 */
export const spec = {
	name: "build",
	description: "Build a versioned corpus.",
	options: {
		"corpus-version": {
			type: "string",
			default: "0.1.0-dev",
			description: "Corpus version",
			validate: isCorpusVersion,
			validationMessage:
				"--corpus-version is the version alone, without the `corpus-v` prefix, as `0.7.0` or `0.7.0-de-holdout`.",
		},
		out: { type: "string", required: true, description: "Output root", deprecatedName: "output" },
		inputs: {
			type: "string",
			required: true,
			description:
				"Adapter inputs: a path to a committed record under `packages/corpus/data/builds/<version>/inputs.json`, " +
				"or a JSON map from adapter id to an input path or options object",
		},
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
		profile: {
			type: "string",
			default: BuildProfile.Exploratory,
			validate: (value): boolean => BUILD_PROFILES.includes(value as BuildProfile),
			validationMessage: `--profile must be one of ${BUILD_PROFILES.join(", ")}.`,
			description:
				"Whether a row's source must be eligible for ingest before the row enters: " +
				"exploratory admits every row an adapter yields, and release-eligible admits a row only " +
				"when the address-source register marks its source eligible",
		},
		"license-policy": {
			type: "string",
			default: LicensePolicy.All,
			validate: (value): boolean => LICENSE_POLICIES.includes(value as LicensePolicy),
			validationMessage: `--license-policy must be one of ${LICENSE_POLICIES.join(", ")}.`,
			description:
				"Which rows to admit on the evidence of their license obligations: " +
				"all, share-alike-free (refuse a license carrying or mentioning share-alike), " +
				"or resolved-only (also refuse a license resolving to no SPDX expression)",
		},
		"exclude-licenses": {
			type: "string",
			description: "Comma-separated license prefixes to refuse, e.g. ODbL,CC-BY-SA",
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

		// Check the shape because a lower-case `nl` is still a string.
		// The four adapters that filter per row compare it with the row's upper-case code.
		// A lower-case value selects zero rows and reports no matches.
		if ("country" in value && value.country !== undefined && !isAlpha2CodeShape(value.country)) return false

		return (
			!("limit" in value) ||
			value.limit === undefined ||
			(typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit > 0)
		)
	})
}

/**
 * Read the inline `--inputs` JSON map.
 *
 * @throws {CommandError} When the text is not JSON, or an entry is not an input path or options object.
 */
function readInlineAdapterInputs(
	text: string,
	parseJSONStrict: (text: string) => unknown
): Record<string, AdapterOptions> {
	let parsed: unknown

	try {
		parsed = parseJSONStrict(text)

		if (!isAdapterInputMap(parsed)) throw new TypeError("expected an adapter-id to input map")
	} catch (error) {
		throw new CommandError(`invalid --inputs JSON: ${(error as Error).message}`)
	}

	return Object.fromEntries(
		Object.entries(parsed).map(([id, value]) => [id, typeof value === "string" ? { inputPath: value } : value])
	)
}

const CorpusBuild: CommandComponent<typeof spec> = ({ options }) => {
	const [stage, setStage] = useState<{ name: BuildStage; message: string }>()

	const state = useCommandTask(async () => {
		const { parseJSONStrict } = await import("@mailwoman/core/json")
		const { assertHeapForAdapters, buildCorpus, defaultAdapterRegistry } = await import("@mailwoman/corpus")
		const { readBuildInputs } = await import("@mailwoman/corpus/build/inputs")
		const { compileLicenseExcludes } = await import("@mailwoman/corpus/utils/license")

		// A record's `inputPath` is data-root-relative and a JSON map's is absolute,
		// so the two forms are read by different functions rather than normalized into one.
		const adapterInputs = options.inputs.trimStart().startsWith("{")
			? readInlineAdapterInputs(options.inputs, parseJSONStrict)
			: await readBuildInputs(options.inputs).catch((error: Error) => {
					throw new CommandError(`--inputs ${options.inputs} could not be read as a build record: ${error.message}`)
				})

		const adapters = defaultAdapterRegistry.list()

		// The refusal lives at the launch rather than in `buildCorpus`, because the library's
		// own tests run the WOF adapter against a five-kilobyte fixture under the default heap.
		assertHeapForAdapters(Object.keys(adapterInputs), heapLimitBytes())

		const m = await buildCorpus({
			outputDir: options.out,
			corpusVersion: options.corpusVersion,
			adapters,
			adapterInputs,
			synthesize: options.synthesize,
			rowsPerFile: options.rowsPerFile,
			shuffleWindow: options.shuffleWindow,
			shuffleSeed: options.shuffleSeed,
			profile: options.profile as BuildProfile,
			licensePolicy: options.licensePolicy as LicensePolicy,
			excludeLicenses: options.excludeLicenses ? compileLicenseExcludes(options.excludeLicenses) : undefined,
			onProgress: (name, message) => setStage({ name, message }),
		})

		return {
			total: m.slices.total_rows,
			aligned: m.total_aligned_rows,
			quarantined: m.quarantine_count,
			adapters: m.adapters.length,
			refusedByLicense: m.excluded_by_license,
			refusedKinds: m.refused_by_license_kind,
			unresolvedLicenseRows: m.admitted_unresolved_license_rows,
			refusedByEligibility: m.excluded_by_eligibility,
			ineligibleSources: Object.keys(m.ineligible_sources),
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
				<Text dimColor>
					license policy {options.licensePolicy}: {done.refusedByLicense} rows refused
					{Object.keys(done.refusedKinds).length
						? ` (${Object.entries(done.refusedKinds)
								.map(([kind, rows]) => `${kind}=${rows}`)
								.join(", ")})`
						: ""}
					, {done.unresolvedLicenseRows} admitted whose license resolves to no expression
				</Text>
				{done.ineligibleSources.length ? (
					<Text color="yellow">
						profile {options.profile}: {done.refusedByEligibility} rows refused from {done.ineligibleSources.join(", ")}
						. MANIFEST.json records each reason under `ineligible_sources`.
					</Text>
				) : null}
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
