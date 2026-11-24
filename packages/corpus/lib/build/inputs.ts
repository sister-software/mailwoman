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
	/**
	 * The fraction of rows rendered with a country surface, for a country-implicit source.
	 */
	countryFraction?: number
	/**
	 * The seed of the {@linkcode BuildInputRecord.countryFraction} draw.
	 */
	seed?: number
}

/**
 * One `corpus run` of an adapter under a source name of its own.
 *
 * A build's `adapters` map holds one entry per adapter id and can't state several runs of one adapter.
 * The `overture` runs for BR, MX and CA stamped `overture-latam` are each a run here.
 *
 * Their rows join a corpus as an overlay (`corpus overlay-manifest --replace-source`).
 */
export interface SourceRunRecord extends BuildInputRecord {
	/**
	 * The adapter id `corpus run` resolves.
	 */
	adapter: string
	/**
	 * The `source` the run stamps on every row (`corpus run --source-name`).
	 */
	sourceName: string
}

/**
 * The adapter inputs of one base corpus build.
 */
export interface BuildInputsRecord {
	corpusVersion: string
	builtAt?: string
	adapters: Record<string, BuildInputRecord>
	/**
	 * The runs whose rows join the corpus as an overlay, run by `corpus recorded-runs`.
	 * `corpus build` reads `adapters` only.
	 */
	sourceRuns?: SourceRunRecord[]
}

/**
 * One recorded source run with its input resolved, as `corpus recorded-runs` runs it.
 */
export interface SourceRun {
	adapter: string
	sourceName: string
	options: AdapterOptions
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

	return Object.fromEntries(entries.map(([id, input]) => [id, resolveBuildInput(path, `adapter ${id}`, input)]))
}

/**
 * One recorded input as {@linkcode AdapterOptions}, its paths resolved against their roots.
 *
 * @throws When the input has no `inputPath`, or its root is neither `cache` nor `data`.
 */
function resolveBuildInput(path: PathBuilderLike, label: string, input: BuildInputRecord): AdapterOptions {
	if (typeof input?.inputPath !== "string" || !input.inputPath) {
		throw new Error(`${path.toString()}: ${label} has no \`inputPath\`.`)
	}

	const { inputPath, streetIndex, root = BuildInputRoot.data, ...options } = input

	if (root !== BuildInputRoot.cache && root !== BuildInputRoot.data) {
		throw new Error(`${path.toString()}: ${label} names root "${String(root)}", not "cache" or "data".`)
	}

	const under = (base: (relative: string) => PathBuilderLike, relative: string) =>
		isAbsolute(relative) ? relative : base(relative).toString()

	return {
		...options,
		inputPath: under(
			root === BuildInputRoot.cache
				? (relative) => cacheRootPathBuilder(relative)
				: (relative) => dataRootPath(relative),
			inputPath
		),
		// The street index is built from the previous corpus, a built artifact under the data root.
		...(streetIndex ? { streetIndex: under((relative) => dataRootPath(relative), streetIndex) } : {}),
	}
}

/**
 * Read a committed record's `sourceRuns`, each input resolved as {@linkcode readBuildInputs} resolves one.
 *
 * @throws When the record lists no source run, a run lacks its adapter or source name,
 * or two runs would write one source and country.
 */
export async function readSourceRuns(path: PathBuilderLike): Promise<SourceRun[]> {
	const record = await readLocalJSONFile<BuildInputsRecord>(path)
	const runs = record.sourceRuns ?? []

	if (!runs.length) throw new Error(`${path.toString()} lists no run under \`sourceRuns\`.`)

	const seen = new Set<string>()

	return runs.map((run, index) => {
		const label = `source run ${index}`

		if (typeof run?.adapter !== "string" || !run.adapter)
			throw new Error(`${path.toString()}: ${label} names no adapter.`)

		if (typeof run.sourceName !== "string" || !run.sourceName) {
			throw new Error(`${path.toString()}: ${label} names no \`sourceName\`.`)
		}

		const slot = sourceRunDirectoryName(run)

		if (seen.has(slot)) throw new Error(`${path.toString()}: ${label} repeats ${slot}.`)

		seen.add(slot)

		const { adapter, sourceName, ...input } = run

		return { adapter, sourceName, options: resolveBuildInput(path, label, input) }
	})
}

/**
 * The directory a source run writes under the output root: its source name,
 * and its country when it has one.
 */
export function sourceRunDirectoryName(run: { sourceName: string; country?: string }): string {
	return run.country ? `${run.sourceName}-${run.country.toLowerCase()}` : run.sourceName
}
