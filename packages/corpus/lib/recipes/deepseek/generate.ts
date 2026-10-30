/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One DeepSeek generation run: admit the sources the mode writes, read the key, then run the mode.
 *
 *   The order is the guarantee. The source-rights check runs before the key is read and before the output directory
 *   is created, so a refused source costs no request and leaves no directory.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { resolvePath } from "path-ts"

import { emittedDeepSeekSources } from "#recipes/deepseek/batches"
import type { DeepSeekCompleter } from "#recipes/deepseek/client"
import { emitKryptonite } from "#recipes/deepseek/kryptonite"
import { DeepSeekSink, type Tally } from "#recipes/deepseek/run"
import { emitTransliteration, type TranslitOptions } from "#recipes/deepseek/transliteration"
import { type SourceRightsAdmission, writeSourceRightsRecord } from "#source-register/corpus-inputs"

/**
 * The two generation modes.
 */
export const DeepSeekMode = {
	Transliteration: "transliteration",
	Kryptonite: "kryptonite",
} as const

export type DeepSeekMode = (typeof DeepSeekMode)[keyof typeof DeepSeekMode]

/**
 * Everything one run reads from its command line.
 */
export interface DeepSeekRunOptions extends TranslitOptions {
	mode: DeepSeekMode
	outDir: string
	targetCount: number
}

/**
 * What a run is given rather than reads itself, so a test can drive it with no key and no network.
 */
export interface DeepSeekRunDependencies {
	/**
	 * Builds the check for the run's context.
	 * It is called first.
	 */
	openAdmission(context: string): Promise<SourceRightsAdmission>
	/**
	 * Reads the API key.
	 * It is called only after the sources are admitted.
	 */
	readAPIKey(): string
	/**
	 * Builds the completion client from the key.
	 */
	createClient(apiKey: string): DeepSeekCompleter
}

/**
 * The files a mode writes under the output directory.
 */
export function deepSeekOutputPaths(mode: DeepSeekMode, outDir: string) {
	const slug = mode === DeepSeekMode.Transliteration ? "transliteration" : "kryptonite"
	const checkpoint = mode === DeepSeekMode.Transliteration ? ".translit-checkpoint.json" : ".kryptonite-checkpoint.json"

	return {
		canonical: resolvePath(outDir, `canonical-${slug}.jsonl`).toString(),
		rawLog: resolvePath(outDir, `raw-deepseek-${slug}.jsonl`).toString(),
		checkpoint: resolvePath(outDir, checkpoint).toString(),
	}
}

/**
 * Runs one generation mode end to end and returns its tally.
 *
 * @throws When transliteration is given no seed files, when a source is refused, or
 * when the key is missing, each before any request is made.
 */
export async function runDeepSeekGeneration(
	options: DeepSeekRunOptions,
	dependencies: DeepSeekRunDependencies
): Promise<Tally> {
	if (options.mode === DeepSeekMode.Transliteration && !options.seedPaths.length) {
		throw new Error("--seed-paths required for transliteration mode")
	}

	const admission = await dependencies.openAdmission(`deepseek ${options.mode}`)

	admission.admitAll(emittedDeepSeekSources(options.mode, options.scripts))

	// The key is required before anything is loaded, so a missing one fails beside its cause.
	const client = dependencies.createClient(dependencies.readAPIKey())

	await makeDirectories(options.outDir)
	await writeSourceRightsRecord(admission.record(), options.outDir)

	const paths = deepSeekOutputPaths(options.mode, options.outDir)
	const sink = new DeepSeekSink(paths.canonical, paths.rawLog)

	return options.mode === DeepSeekMode.Transliteration
		? emitTransliteration(options, client, sink, paths.checkpoint)
		: emitKryptonite(options, client, sink, paths.checkpoint)
}
