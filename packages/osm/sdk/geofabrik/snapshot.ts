// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Geofabrik extracts as dated snapshots.
 *
 *   Each region keeps its own vintages under
 *   `$MAILWOMAN_DATA_ROOT/snapshots/geofabrik/<region>/<YYYY-MM-DD>/<leaf>.osm.pbf`,
 *   where the date is the `Last-Modified` date Geofabrik served for the file,
 *   and the receipt sits beside the extract.
 */

import { assertVintage, snapshotSourcesRoot } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { isoDate } from "@mailwoman/core/utils"
import type { PathBuilder, PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { geofabrikExtractFileName, geofabrikExtractPath, geofabrikSnapshotDirectory } from "#paths"

/**
 * A vintage of a Geofabrik extract: the UTC date of its `Last-Modified` header.
 */
const DATED_VINTAGE = /^\d{4}-\d{2}-\d{2}$/u

/**
 * The vintage a `Last-Modified` header dates, such as `2026-10-16` for `Fri, 16 Oct 2026 23:56:31 GMT`.
 *
 * @throws When the header isn't a date.
 */
export function geofabrikVintage(lastModified: string): string {
	const date = new Date(lastModified)

	if (!Number.isFinite(date.getTime())) throw new Error(`Last-Modified "${lastModified}" is not a date`)

	return isoDate(date)
}

/**
 * The vintages of `region` that hold its extract, oldest first.
 *
 * A staging directory a fetch left behind isn't a vintage and isn't listed.
 */
export async function geofabrikVintages(
	region: string,
	snapshotRoot: PathBuilderLike = snapshotSourcesRoot()
): Promise<string[]> {
	const directory = geofabrikSnapshotDirectory(region, snapshotRoot)

	if (!(await pathExists(directory))) return []

	const found: string[] = await Globerator.from(`*/${geofabrikExtractFileName(region)}`, {
		cwd: directory.toString(),
		absolute: false,
	}).toArray()

	return found
		.map((entry) => entry.split("/")[0]!)
		.filter((vintage) => DATED_VINTAGE.test(vintage))
		.toSorted()
}

/**
 * One region's extract, resolved to a vintage on disk.
 */
export interface ResolvedGeofabrikExtract {
	path: PathBuilder
	vintage: string
}

/**
 * The extract of `region` in `vintage`, or in its newest vintage when `vintage` isn't given.
 *
 * @throws When the stated vintage holds no extract, or the region has no vintage, naming the directory read.
 */
export async function resolveGeofabrikExtract(
	region: string,
	options: { vintage?: string | null; snapshotRoot?: PathBuilderLike } = {}
): Promise<ResolvedGeofabrikExtract> {
	const snapshotRoot = options.snapshotRoot ?? snapshotSourcesRoot()

	if (options.vintage) {
		assertVintage(options.vintage)

		const path = geofabrikExtractPath(region, options.vintage, snapshotRoot)

		if (!(await pathExists(path))) {
			throw new Error(`${region} has no extract in vintage ${options.vintage}: ${path} is absent`)
		}

		return { path, vintage: options.vintage }
	}

	const vintage = (await geofabrikVintages(region, snapshotRoot)).at(-1)

	if (!vintage) {
		throw new Error(
			`${geofabrikSnapshotDirectory(region, snapshotRoot)} holds no vintage of ${region}; ` +
				`fetch one with packages/osm/tools/fetch/extract.ts --region ${region}`
		)
	}

	return { path: geofabrikExtractPath(region, vintage, snapshotRoot), vintage }
}

/**
 * The extract a command reads, from its `--pbf`, or from its `--region` and optional `--vintage`.
 *
 * @returns The extract's path, and its vintage when it was resolved from a region, or `null`.
 * `null` when the command was given neither option.
 * @throws When `--pbf` and `--region` are both given, or `--vintage` is given without `--region`.
 */
export async function resolveExtractOption(options: {
	pbf?: string | undefined
	region?: string | undefined
	vintage?: string | undefined
}): Promise<{ pbf: string; vintage: string | null } | null> {
	if (options.pbf && options.region) throw new Error("pass --pbf or --region, not both")

	if (options.vintage && !options.region) throw new Error("--vintage selects a vintage of the --region extract")

	if (options.pbf) return { pbf: options.pbf, vintage: null }

	if (!options.region) return null

	const resolved = await resolveGeofabrikExtract(options.region, { vintage: options.vintage ?? null })

	return { pbf: resolved.path.toString(), vintage: resolved.vintage }
}
