/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Plans and applies the move of a flat directory of Geofabrik extracts, `<leaf>-<YYMMDD>.osm.pbf` and
 *   `<leaf>-latest.osm.pbf` with or without a receipt, into one dated snapshot vintage per file under
 *   `snapshots/geofabrik/<region>/<vintage>/<leaf>.osm.pbf`. `move-flat-extracts.ts` is its command line.
 *
 *   Each file's vintage comes from the first of:
 *
 *   1. its receipt's `last_modified` date, or the receipt's `retrieved_at` date when the server sent none;
 *   2. the `YYMMDD` in its name. The fetcher took that date from `Last-Modified`, and every build record
 *      that read the file identifies it by that name;
 *   3. its modification time, for a `-latest` file with no receipt.
 *
 *   Each file's region comes from its receipt, then from a `--region <leaf>=<path>` the caller states, then from
 *   the one region in `geofabrikRegions()` with that leaf. A file whose region none of these settles is
 *   reported and not moved.
 */

import { readLocalJSONFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { pathExists, statPath } from "@mailwoman/core/fs/readers/stat"
import { writeSnapshot } from "@mailwoman/core/fs/snapshot"
import { copyPath, movePath, removePath } from "@mailwoman/core/fs/writers"
import { isoDate } from "@mailwoman/core/utils"
import { basename, PathBuilder, type PathBuilderLike } from "path-ts"

import { geofabrikExtractFileName, geofabrikExtractPath, geofabrikSnapshotDirectory } from "#paths"
import { extractReceiptPath } from "#sdk/extract/receipt"
import type { GeofabrikExtractReceipt } from "#sdk/fetch"
import { geofabrikRegions } from "#sdk/geofabrik/regions"
import { geofabrikVintage } from "#sdk/geofabrik/snapshot"

/**
 * Where a planned move took a file's vintage from.
 */
export const VintageBasis = {
	receipt: "receipt",
	fileName: "file name",
	modificationTime: "modification time",
} as const

export type VintageBasis = (typeof VintageBasis)[keyof typeof VintageBasis]

/**
 * Where a planned move took a file's region from.
 */
export const RegionBasis = {
	receipt: "receipt",
	caller: "--region",
	registry: "region registry",
} as const

export type RegionBasis = (typeof RegionBasis)[keyof typeof RegionBasis]

/**
 * What the move would do with one flat extract.
 */
export interface FlatExtractMove {
	/**
	 * The flat extract's path.
	 */
	source: string
	/**
	 * The receipt beside it, or `null` when it has none.
	 */
	receipt: string | null
	leaf: string
	vintage: string
	vintageBasis: VintageBasis
	/**
	 * The Geofabrik region path, or `null` when the file has no receipt, no `--region` and no registry match.
	 */
	region: string | null
	regionBasis: RegionBasis | null
	/**
	 * Where the extract would land, or `null` when the region is unsettled.
	 */
	target: string | null
	/**
	 * Why the file isn't moved, or `null` when it would be.
	 */
	blocked: string | null
}

const DATED_NAME = /^(?<leaf>.+)-(?<stamp>\d{6})\.osm\.pbf$/u
const LATEST_NAME = /^(?<leaf>.+)-latest\.osm\.pbf$/u

function vintageFromStamp(stamp: string): string {
	return `20${stamp.slice(0, 2)}-${stamp.slice(2, 4)}-${stamp.slice(4, 6)}`
}

function vintageFromReceipt(receipt: GeofabrikExtractReceipt): string {
	return geofabrikVintage(receipt.last_modified ?? receipt.retrieved_at)
}

/**
 * The region each leaf names when exactly one listed region ends in it.
 */
function registryRegionsByLeaf(): Map<string, string> {
	const byLeaf = new Map<string, string[]>()

	for (const { id } of geofabrikRegions()) {
		const leaf = id.split("/").at(-1)!

		byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), id])
	}

	return new Map([...byLeaf].filter(([, ids]) => ids.length === 1).map(([leaf, ids]) => [leaf, ids[0]!]))
}

/**
 * Plan the move of every `*.osm.pbf` in `flatDirectory` into vintages under `snapshotRoot`.
 *
 * Reads only: it changes no file.
 *
 * @param regions Regions the caller states, keyed by leaf, for files with no receipt.
 * @throws When a file in the directory has a name that's neither dated nor `-latest`.
 */
export async function planFlatExtractMove(
	flatDirectory: PathBuilderLike,
	snapshotRoot: PathBuilderLike,
	regions: ReadonlyMap<string, string> = new Map()
): Promise<FlatExtractMove[]> {
	const registry = registryRegionsByLeaf()
	const moves: FlatExtractMove[] = []

	for (const source of await sortedGlob(flatDirectory, "*.osm.pbf")) {
		const name = basename(source)
		const match = DATED_NAME.exec(name) ?? LATEST_NAME.exec(name)

		if (!match?.groups) throw new Error(`${source} is named neither <leaf>-<YYMMDD>.osm.pbf nor <leaf>-latest.osm.pbf`)

		const leaf = match.groups["leaf"]!
		const stamp = match.groups["stamp"]
		const receiptPath = extractReceiptPath(source)

		const receipt = (await pathExists(receiptPath))
			? await readLocalJSONFile<GeofabrikExtractReceipt>(receiptPath)
			: null

		const [vintage, vintageBasis] = receipt
			? [vintageFromReceipt(receipt), VintageBasis.receipt]
			: stamp
				? [vintageFromStamp(stamp), VintageBasis.fileName]
				: [isoDate((await statPath(source)).mtime), VintageBasis.modificationTime]

		const stated = regions.get(leaf)

		const [region, regionBasis] = receipt
			? [receipt.region, RegionBasis.receipt]
			: stated
				? [stated, RegionBasis.caller]
				: registry.has(leaf)
					? [registry.get(leaf)!, RegionBasis.registry]
					: [null, null]

		const target = region ? geofabrikExtractPath(region, vintage, snapshotRoot).toString() : null

		const blocked = !region
			? `no receipt and no listed region ends in ${leaf}; pass --region ${leaf}=<geofabrik/path>`
			: region.split("/").at(-1) !== leaf
				? `region ${region} does not end in ${leaf}`
				: (await pathExists(geofabrikSnapshotDirectory(region, snapshotRoot)(vintage)))
					? `vintage ${vintage} of ${region} is already on disk`
					: null

		moves.push({
			source,
			receipt: receipt ? receiptPath : null,
			leaf,
			vintage,
			vintageBasis,
			region,
			regionBasis,
			target,
			blocked,
		})
	}

	// Two flat files that land in one vintage would make the second write refuse, so both are blocked.
	const byTarget = new Map<string, FlatExtractMove[]>()

	for (const move of moves) {
		if (move.target && !move.blocked) {
			byTarget.set(move.target, [...(byTarget.get(move.target) ?? []), move])
		}
	}

	for (const [target, sharing] of byTarget) {
		if (sharing.length < 2) continue

		for (const move of sharing) {
			move.blocked = `${sharing.map((other) => basename(other.source)).join(" and ")} both land at ${target}`
		}
	}

	return moves
}

/**
 * One line of the plan, as the command prints it.
 */
export function describeFlatExtractMove(move: FlatExtractMove): string {
	const vintage = `vintage ${move.vintage} (from ${move.vintageBasis})`
	const region = move.region ? `region ${move.region} (from ${move.regionBasis})` : "region unknown"
	const receipt = move.receipt ? "with its receipt" : "no receipt"
	const head = `${basename(move.source)}: ${vintage}, ${region}, ${receipt}`

	return move.blocked ? `${head}; not moved: ${move.blocked}` : `${head} → ${move.target}`
}

/**
 * Move `source` to `destination`, copying and then removing it when the two sit on different filesystems.
 */
async function moveAcrossFilesystems(source: string, destination: string): Promise<void> {
	try {
		await movePath(source, destination)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error

		await copyPath(source, destination)
		await removePath(source)
	}
}

/**
 * Move every unblocked file in `moves` into its vintage, with its receipt beside it,
 * through `writeSnapshot`.
 *
 * @returns The moves applied.
 */
export async function applyFlatExtractMove(
	moves: readonly FlatExtractMove[],
	snapshotRoot: PathBuilderLike,
	report: (line: string) => void = () => {}
): Promise<FlatExtractMove[]> {
	const applied: FlatExtractMove[] = []

	for (const move of moves) {
		if (move.blocked || !move.region) continue

		const vintageDirectory = geofabrikSnapshotDirectory(move.region, snapshotRoot)(move.vintage)
		const fileName = geofabrikExtractFileName(move.region)

		// writeSnapshot removes the staging directory when the fill throws, so the fill moves the extract
		// last: a failure before that point leaves the flat extract and its receipt where they were.
		await writeSnapshot(vintageDirectory, { vintageFromCaller: false }, async (staging) => {
			const staged = PathBuilder.from(staging)(fileName).toString()

			if (move.receipt) {
				await copyPath(move.receipt, extractReceiptPath(staged))
			}

			await moveAcrossFilesystems(move.source, staged)
		})

		if (move.receipt) {
			await removePath(move.receipt)
		}

		report(`moved ${describeFlatExtractMove(move)}`)
		applied.push(move)
	}

	return applied
}
