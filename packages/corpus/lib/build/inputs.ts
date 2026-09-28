/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The committed record of which adapter read which input for one base corpus version.
 *
 *   Before this record existed, the only statement of a build's inputs was a JSON string in the launch
 *   command, kept afterwards in a build-log directory under the data root. The predecessor of the
 *   `v0.7.0-de-holdout` record names paths under `/mnt/playpen/mailwoman-data`. Those paths stopped resolving
 *   when the data root moved on 2026-09-23. A corpus `MANIFEST.json` records `skipped_adapters` without any
 *   adapter's input path, so a rebuild began by re-deriving the adapter set from that skip list.
 *
 *   Each `inputPath` is written relative to `$MAILWOMAN_DATA_ROOT` and resolved at launch, so the record
 *   survives a data-root move. A path that has to sit outside the data root is written absolute and used as
 *   written.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { isAbsolute, type PathBuilderLike } from "path-ts"

import type { AdapterOptions } from "#types"

/**
 * One adapter's input as the committed record states it.
 *
 * `inputPath` is data-root-relative.
 * The remaining fields match {@linkcode AdapterOptions} and exist so a per-country
 * or truncated run can be recorded as it ran.
 */
export interface BuildInputRecord {
	inputPath: string
	country?: string
	limit?: number
}

/**
 * The adapter inputs of one base corpus build.
 */
export interface BuildInputsRecord {
	corpusVersion: string
	builtAt?: string
	adapters: Record<string, BuildInputRecord>
}

/**
 * Resolve the committed inputs record for a corpus version through the package's `./data/*` export.
 *
 * Resolution happens on call, matching `addressSourceRegisterPath`.
 */
export function buildInputsPath(corpusVersion: string): string {
	return resolveModulePath(`@mailwoman/corpus/data/builds/${corpusVersion}/inputs.json`)
}

/**
 * Read a committed inputs record and resolve every `inputPath` against the data root.
 *
 * @throws When the record names no adapter, because a build with no inputs
 * writes an empty corpus and reports success.
 */
export async function readBuildInputs(path: PathBuilderLike): Promise<Record<string, AdapterOptions>> {
	const record = await readLocalJSONFile<BuildInputsRecord>(path)
	const entries = Object.entries(record.adapters ?? {})

	if (!entries.length) {
		throw new Error(`${path.toString()} names no adapter under \`adapters\`, so the build would read nothing.`)
	}

	return Object.fromEntries(
		entries.map(([id, input]) => {
			if (typeof input?.inputPath !== "string" || !input.inputPath) {
				throw new Error(`${path.toString()}: adapter ${id} has no \`inputPath\`.`)
			}

			const resolved = isAbsolute(input.inputPath) ? input.inputPath : dataRootPath(input.inputPath).toString()

			return [id, { ...input, inputPath: resolved } satisfies AdapterOptions]
		})
	)
}
