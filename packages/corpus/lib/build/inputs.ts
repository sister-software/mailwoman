// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The committed record of which adapter read which input for one base corpus version.
 *
 *   Before this record existed, the only statement of a build's inputs was a JSON string in the launch
 *   command, kept afterwards in a build-log directory under the data root. The predecessor of the
 *   `v0.7.0-de-holdout` record names paths under `/mnt/playpen/mailwoman-data`. Those paths stopped resolving
 *   when the data root moved on 2026-09-23. A corpus `MANIFEST.json` records `skipped_adapters` without any
 *   adapter's input path, so a rebuild began by re-deriving the adapter set from that skip list.
 *
 *   Each `inputPath` is written relative to a root and resolved at launch, so the record survives a root
 *   move. The root is `$MAILWOMAN_DATA_ROOT` unless the entry states `"root": "cache"`, which a current
 *   source under `$MAILWOMAN_CACHE_ROOT/sources/` takes. A path that has to sit outside both roots is
 *   written absolute and used as written.
 */

import { cacheRootPathBuilder, dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { isAbsolute, type PathBuilderLike } from "path-ts"

import type { AdapterOptions } from "#types"

/**
 * The roots a build input can be recorded relative to.
 */
export const BuildInputRoot = { cache: "cache", data: "data" } as const

export type BuildInputRoot = (typeof BuildInputRoot)[keyof typeof BuildInputRoot]

/**
 * One adapter's input as the committed record states it.
 *
 * `inputPath` is data-root-relative.
 * The remaining fields match {@linkcode AdapterOptions} and exist so a per-country
 * or truncated run can be recorded as it ran.
 */
export interface BuildInputRecord {
	inputPath: string
	/**
	 * The root a relative `inputPath` resolves against: `"cache"` for a current source
	 * under `$MAILWOMAN_CACHE_ROOT`, such as `sources/ban`, and `"data"` for a snapshot
	 * or built artifact under `$MAILWOMAN_DATA_ROOT`, such as `snapshots/usgov-nppes/2026-05`.
	 *
	 * A record written before the storage classes identifies no root,
	 * and every path in it is under the data root.
	 *
	 * @defaultValue `"data"`
	 */
	root?: BuildInputRoot
	country?: string
	limit?: number
	/**
	 * The street index the unit splitter reads (`#tools/street-index/build`),
	 * data-root-relative like `inputPath`.
	 *
	 * A build reads the index built from the previous corpus version.
	 */
	streetIndex?: string
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
 * @throws When the record identifies no adapter, because a build with no inputs
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

			const { inputPath, streetIndex, root = BuildInputRoot.data, ...options } = input

			if (root !== BuildInputRoot.cache && root !== BuildInputRoot.data) {
				throw new Error(`${path.toString()}: adapter ${id} names root "${String(root)}", not "cache" or "data".`)
			}

			const under = (base: (relative: string) => PathBuilderLike, relative: string) =>
				isAbsolute(relative) ? relative : base(relative).toString()

			return [
				id,
				{
					...options,
					inputPath: under(
						root === BuildInputRoot.cache
							? (relative) => cacheRootPathBuilder(relative)
							: (relative) => dataRootPath(relative),
						inputPath
					),
					// The street index is built from the previous corpus, a built artifact under the data root.
					...(streetIndex ? { streetIndex: under((relative) => dataRootPath(relative), streetIndex) } : {}),
				} satisfies AdapterOptions,
			]
		})
	)
}
