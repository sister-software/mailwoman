/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The adapter phase: drive each configured adapter to its own `canonical.jsonl`, or reuse the run a
 *   previous build finished.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists, statPath } from "@mailwoman/core/fs/readers/stat"
import { sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"
import type { PathBuilder } from "path-ts"

import type { BuildStage } from "#build/types"
import type { FileDerivation } from "#parquet/record"
import { runAdapter, type AdapterRunManifest } from "#runner"
import type { AdapterOptions, CorpusAdapter } from "#types"

export interface AdapterPhaseOptions {
	adapters: readonly CorpusAdapter[]
	adapterInputs: Record<string, AdapterOptions>
	corpusVersion: string
	intermediateDir: PathBuilder

	/**
	 * Each configured adapter's {@linkcode adapterRunInputs} digest.
	 */
	inputsFor: (adapterID: string) => Promise<string>

	/**
	 * Reuse each adapter run a previous build finished rather than driving the adapter again.
	 */
	resume: boolean

	onProgress?: (stage: BuildStage, message: string) => void
}

export interface AdapterPhaseResult {
	/**
	 * One manifest per adapter that ran or was reused, in the order they were driven.
	 */
	runs: AdapterRunManifest[]

	/**
	 * Adapter ids with no entry in `adapterInputs`.
	 */
	skipped: string[]
}

/**
 * What a resumed build expects a reusable adapter run to have been made from.
 */
export interface AdapterRunIdentity {
	corpusVersion: string
	/**
	 * See {@linkcode adapterRunInputs}.
	 */
	inputs: string
}

/**
 * The digest of what an adapter run's rows depend on: the adapter's options with
 * its input's fingerprint, and the code that wrote them.
 *
 * Both come from the source's derivation.
 * `adapterDerivations` computes it.
 */
export function adapterRunInputs(derivation: Pick<FileDerivation, "extractHash" | "codeHash">): string {
	return sha256Hex(canonicalJSON({ extractHash: derivation.extractHash, codeHash: derivation.codeHash }))
}

/**
 * Reuse a finished adapter run, or return `null` when this build has to drive the adapter.
 *
 * @throws When the run was made for another corpus version or from other inputs or code.
 * The align checkpoint records the adapter as aligned, so a run made again here
 * would leave the rows aligned from the old run in place.
 * @throws When the cached manifest and the file on disk disagree on the byte count.
 * The writer flushes the canonical file before writing the manifest.
 * Manifest presence establishes that the writer reached the end of its run.
 * The manifest describes the file as of that moment.
 * A truncated copy, an interrupted move or a partial transfer leaves the
 * manifest intact beside a shorter file.
 * The recorded byte count distinguishes those cases.
 * A resumed build that reuses a short file can produce a corpus whose row count later readers accept.
 */
export async function reusableRun(
	adapterID: string,
	adapterDir: PathBuilder,
	expected: AdapterRunIdentity
): Promise<AdapterRunManifest | null> {
	const cachedManifest = adapterDir("MANIFEST.json")
	const canonicalPath = adapterDir("canonical.jsonl")

	if (!(await pathExists(cachedManifest)) || !(await pathExists(canonicalPath))) return null

	const cached = await readLocalJSONFile<AdapterRunManifest>(cachedManifest)

	if (cached.corpus_version !== expected.corpusVersion || cached.inputs !== expected.inputs) {
		const recorded =
			cached.corpus_version !== expected.corpusVersion
				? `corpus version ${cached.corpus_version}, where this build is ${expected.corpusVersion}`
				: cached.inputs
					? "other inputs or code than this build configures"
					: "a manifest that records no inputs"

		throw new Error(
			`resume refused for ${adapterID}: ${cachedManifest} describes a run made with ${recorded}. ` +
				`Rebuild it with --fresh, or with --fresh-sources ${adapterID} under --jobs above 1.`
		)
	}

	const onDisk = (await statPath(canonicalPath)).size

	if (onDisk !== cached.bytes) {
		throw new Error(
			`resume refused for ${adapterID}: ${canonicalPath} is ${onDisk.toLocaleString()} bytes and its ` +
				`manifest records ${cached.bytes.toLocaleString()}. Delete ${cachedManifest} to ` +
				`re-run the adapter, or restore the file this manifest describes.`
		)
	}

	return cached
}

/**
 * Drive every configured adapter, reusing whatever a previous build already finished.
 */
export async function runAdapterPhase(opts: AdapterPhaseOptions): Promise<AdapterPhaseResult> {
	const runs: AdapterRunManifest[] = []
	const skipped: string[] = []

	for (const adapter of opts.adapters) {
		const adapterOptions = opts.adapterInputs[adapter.id]

		if (!adapterOptions) {
			skipped.push(adapter.id)
			opts.onProgress?.("adapter-run", `skipped ${adapter.id} (no input configured)`)

			continue
		}

		const inputs = await opts.inputsFor(adapter.id)

		const cached = opts.resume
			? await reusableRun(adapter.id, opts.intermediateDir(adapter.id), { corpusVersion: opts.corpusVersion, inputs })
			: null

		if (cached) {
			opts.onProgress?.("adapter-run", `resumed ${adapter.id} (reused ${cached.yielded} canonical rows)`)
			runs.push(cached)

			continue
		}

		opts.onProgress?.("adapter-run", `running ${adapter.id}`)

		runs.push(
			await runAdapter({
				adapter,
				adapterOptions,
				outputDir: opts.intermediateDir,
				corpusVersion: opts.corpusVersion,
				inputs,
			})
		)
	}

	return { runs, skipped }
}
