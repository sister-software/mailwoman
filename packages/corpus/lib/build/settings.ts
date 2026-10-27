/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The settings a corpus build resolves from its options, and the derivation of each source's files.
 *
 *   The serial build and the parallel coordinator both read these, so a source's files carry one derivation
 *   whichever path wrote them.
 */

import { sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"

import { adapterModules, moduleGraphHashes } from "#build/code-hash"
import { BuildProfile, PriorOutput, type BuildCorpusOptions } from "#build/types"
import { extractFingerprint, type FileDerivation, inputCheckouts } from "#parquet/record"
import { ROWS_PER_FILE } from "#parquet/schema"
import { DEFAULT_SHUFFLE_SEED, DEFAULT_SHUFFLE_WINDOW } from "#parquet/shuffle"
import type { AdapterOptions, CorpusAdapter } from "#types"
import { LicensePolicy } from "#utils/license"
import type { CountryHoldout } from "#utils/split"

/**
 * A build's options with every default applied.
 */
export interface ResolvedBuildSettings {
	synthesize: boolean
	rowsPerFile: number
	shuffleWindow: number
	shuffleSeed: number
	profile: BuildProfile
	licensePolicy: LicensePolicy
	excludeLicenses: readonly RegExp[]
	priorOutput: PriorOutput
	resume: boolean
}

export function resolveCorpusSettings(opts: BuildCorpusOptions): ResolvedBuildSettings {
	const priorOutput = opts.priorOutput ?? PriorOutput.Refuse

	return {
		synthesize: opts.synthesize ?? true,
		rowsPerFile: opts.rowsPerFile ?? ROWS_PER_FILE,
		shuffleWindow: opts.shuffleWindow ?? DEFAULT_SHUFFLE_WINDOW,
		shuffleSeed: opts.shuffleSeed ?? DEFAULT_SHUFFLE_SEED,
		profile: opts.profile ?? BuildProfile.Exploratory,
		licensePolicy: opts.licensePolicy ?? LicensePolicy.All,
		excludeLicenses: opts.excludeLicenses ?? [],
		priorOutput,
		resume: priorOutput === PriorOutput.Resume,
	}
}

/**
 * The build config every source's files are derived under.
 */
export function derivationConfig(
	settings: ResolvedBuildSettings,
	holdouts: Record<string, CountryHoldout>
): Record<string, unknown> {
	return {
		tool: "build",
		synthesize: settings.synthesize,
		profile: settings.profile,
		licensePolicy: settings.licensePolicy,
		excludeLicenses: settings.excludeLicenses.map((pattern) => pattern.source),
		holdouts,
		shuffleSeed: settings.shuffleSeed,
		shuffleWindow: settings.shuffleWindow,
	}
}

/**
 * The extract hash of one adapter's rows: its options with its input replaced by the input's fingerprint.
 *
 * A base row's `source` is its adapter's id (the runner refuses any other), a synthesized
 * row keeps its ancestor's `source`, and the runner deduplicates within one adapter's run.
 * A source's files therefore read only that adapter's input.
 *
 * `outputDir` is left out: it locates an adapter's side state and does not change a row.
 */
export async function adapterExtractHash(options: AdapterOptions): Promise<string> {
	const { inputPath, outputDir: _outputDir, ...rest } = options

	return sha256Hex(canonicalJSON({ ...rest, input: await extractFingerprint(inputPath) }))
}

/**
 * The build pipeline's root module, repository-relative: every base source passes through it.
 */
const BUILD_MODULE = "packages/corpus/lib/build.ts"

/**
 * The derivation of each configured adapter's files, from one cruise of the module graph.
 *
 * A source's code hash covers the build pipeline (`lib/build.ts` and what it reaches) and the
 * adapter's own module graph, so an edit to one adapter changes only that adapter's files.
 */
export async function adapterDerivations(
	adapters: readonly CorpusAdapter[],
	adapterInputs: Record<string, AdapterOptions>,
	config: Record<string, unknown>
): Promise<((source: string) => Promise<FileDerivation>) & { modules: ReadonlyMap<string, string> }> {
	const modules = await adapterModules(adapters)

	const codeHashes = await moduleGraphHashes(
		Object.fromEntries([...modules].map(([id, module]) => [id, [BUILD_MODULE, module]]))
	)

	const derived = new Map<string, Promise<FileDerivation>>()

	return Object.assign(derivationOf, { modules })

	function derivationOf(source: string): Promise<FileDerivation> {
		let derivation = derived.get(source)

		if (!derivation) {
			derived.set(source, (derivation = derive(source)))
		}

		return derivation
	}

	async function derive(source: string): Promise<FileDerivation> {
		const options = adapterInputs[source]
		const codeHash = codeHashes.get(source)

		if (!options || !codeHash) {
			throw new Error(`buildCorpus: rows of ${source} reached the parquet phase and no configured adapter has that id`)
		}

		return {
			extractHash: await adapterExtractHash(options),
			codeHash,
			config,
			...(await inputCheckouts(options.inputPath)),
		}
	}
}
