// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Lists what the data root holds, so a claim that a source is absent starts
 *   from the directory that would hold it.
 *
 *   The table states each directory's purpose.
 *   The listing reads the disk, and a top-level directory the table doesn't
 *   describe is reported as undescribed.
 */

import { cacheRootPathBuilder, dataRootPath } from "@mailwoman/core/data-root"
import { isDirectory } from "@mailwoman/core/fs/readers/stat"
import type { PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

export interface DataDirectory {
	/**
	 * The path under {@link DataDirectory.root}.
	 */
	path: string
	/**
	 * The root `path` is under: the cache root for current sources, the data root
	 * for snapshots and built artifacts.
	 *
	 * @defaultValue `"data"`
	 */
	root?: "cache" | "data"
	holds: string
	/**
	 * A way this directory has misled a search, stated so the next one looks elsewhere.
	 */
	caution?: string
}

/**
 * The directories a question about sources starts from.
 */
export const DATA_DIRECTORIES: readonly DataDirectory[] = [
	{
		path: "sources/wof-repos",
		root: "cache",
		holds:
			"Every Who's On First repository, admin and postcode, for every country, one clone per repository at " +
			"sources/wof-repos/<name> under the cache root. Each record holds its polygon. The corpus builds read this directory too.",
	},
	{
		path: "sources",
		root: "cache",
		holds:
			"One directory per current corpus source, which a fetch brings up to date: national registers, BAN, OpenAddresses.",
	},
	{
		path: "snapshots",
		holds: "One directory per snapshot source, one dated vintage beside another: NAD releases, NPPES, TIGER, Overture.",
	},
	{
		path: "sources/gb-os-open/open-roads/data",
		root: "cache",
		holds: "OS Open Roads GML: Great Britain's road links with start and end nodes.",
	},
	{
		path: "snapshots/tiger",
		holds: "TIGER addrfeat segments with names and ZIP Codes, one directory per yearly release.",
		caution: "addrfeat holds no node ids, so crossings cannot be read from it directly.",
	},
	{ path: "corpus/street-index", holds: "Street and town names per country, built from the premise registers." },
	{
		path: "snapshots/overture",
		holds: "Overture releases: addresses and places.",
		caution: "No road network is held here.",
	},
	{
		path: "snapshots/geofabrik",
		holds:
			"Geofabrik OpenStreetMap extracts, one directory per region path and one dated vintage per Last-Modified date, each with its receipt.",
	},
	{ path: "sub-venue/pbf", holds: "OpenStreetMap extracts: France, Germany, Hessen, Japan and Spain." },
	{
		path: "pelias-rig/data/photon",
		holds: "The Photon planet index: one document per OpenStreetMap way or place.",
		caution: "It holds no road geometry or node links.",
	},
	{ path: "db/wof", holds: "Gazetteer databases: candidate.db, the admin builds and the polygon files." },
	{ path: "db/address-points", holds: "Address point databases by country and US state, from open registers." },
	{ path: "db/osm", holds: "OpenStreetMap-derived databases, including address points and places-osm.db. ODbL." },
	{ path: "db/interpolation", holds: "US street segments with geometry, for house number interpolation." },
	{ path: "db/ban", holds: "France's Base Adresse Nationale points and street centroids." },
	{
		path: "db/tiger",
		holds:
			"tiger.db: TIGER blocks, places and named street segments, with P.L. 94-171 block counts, built by tiger fetch.",
	},
	{
		path: "corpus/staging/overture",
		holds: "The corpus JSONL and fill-rate report overture-ingest derives from each Overture release snapshot.",
	},
	{
		path: "db/poi",
		holds:
			"poi.db, the rail-station stations.db, the official post-office lists' post-offices.db, and the Wikidata landmarks.db.",
	},
	{ path: "gauntlet", holds: "regression.db and the gauntlet's other built rows." },
]

interface DataDirectoryListing extends DataDirectory {
	exists: boolean
	entries: number
	sample: string[]
}

export interface DataDirectoryReport {
	root: string
	directories: DataDirectoryListing[]
	/**
	 * Top-level data-root directories the table doesn't describe.
	 */
	undescribed: string[]
}

const SAMPLE_SIZE = 12

const entryNames = async (directory: PathBuilderLike): Promise<string[]> => {
	const names: string[] = await Globerator.from("*", { cwd: directory.toString(), onlyFiles: false }).toArray()

	return names.toSorted()
}

/**
 * Reads each described directory's contents, with `match` narrowing the sample to names that contain it.
 */
export async function listDataDirectories(match?: string): Promise<DataDirectoryReport> {
	const needle = match?.toLowerCase()

	const directories = await Promise.all(
		DATA_DIRECTORIES.map(async (directory): Promise<DataDirectoryListing> => {
			const path = directory.root === "cache" ? cacheRootPathBuilder(directory.path) : dataRootPath(directory.path)

			if (!(await isDirectory(path).catch(() => false))) return { ...directory, exists: false, entries: 0, sample: [] }

			const names = await entryNames(path)
			const matching = needle ? names.filter((name) => name.toLowerCase().includes(needle)) : names

			return { ...directory, exists: true, entries: names.length, sample: matching.slice(0, SAMPLE_SIZE) }
		})
	)

	const described = new Set(
		DATA_DIRECTORIES.filter(({ root }) => root !== "cache").map(({ path }) => path.split("/", 1)[0]!)
	)

	const topLevel = await entryNames(dataRootPath())

	return {
		root: String(dataRootPath()),
		directories: needle ? directories.filter(({ sample }) => sample.length) : directories,
		undescribed: topLevel.filter((name) => !described.has(name) && !name.includes(".")),
	}
}
