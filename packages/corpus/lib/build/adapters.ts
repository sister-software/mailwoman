/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The adapter phase: drive each configured adapter to its own `canonical.jsonl`, or reuse the run a
 *   previous build finished.
 */

import { pathExists, readLocalJSONFile, statPath } from "@mailwoman/core/fs/readers"
import type { PathBuilder } from "path-ts"

import type { BuildStage } from "#build/types"
import { $public } from "#env"
import { runAdapter, type AdapterRunManifest } from "#runner"
import type { AdapterOptions, CorpusAdapter } from "#types"

export interface AdapterPhaseOptions {
	adapters: readonly CorpusAdapter[]
	adapterInputs: Record<string, AdapterOptions>
	corpusVersion: string
	intermediateDir: PathBuilder
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
 * Reuse a finished adapter run, or return `null` when this build has to drive the adapter.
 *
 * @throws When the cached manifest and the file on disk disagree on the byte count.
 * The writer flushes the canonical file before writing the manifest.
 * Manifest presence establishes that the writer reached the end of its run.
 * The manifest describes the file as of that moment.
 * A truncated copy, an interrupted move or a partial transfer leaves the
 * manifest intact beside a shorter file.
 * The recorded byte count distinguishes those cases.
 * A resumed build that reuses a short file can produce a corpus whose row count later readers accept.
 */
async function reusableRun(adapterID: string, adapterDir: PathBuilder): Promise<AdapterRunManifest | null> {
	if ($public.MAILWOMAN_RESUME !== "1") return null

	const cachedManifest = adapterDir("MANIFEST.json")
	const canonicalPath = adapterDir("canonical.jsonl")

	if (!(await pathExists(cachedManifest)) || !(await pathExists(canonicalPath))) return null

	const cached = await readLocalJSONFile<AdapterRunManifest>(cachedManifest)
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

		const cached = await reusableRun(adapter.id, opts.intermediateDir(adapter.id))

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
			})
		)
	}

	return { runs, skipped }
}
