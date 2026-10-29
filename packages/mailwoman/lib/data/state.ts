/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What the catalog holds under a data root, in three separate lists: the artifacts the active generation
 *   selects, the installed artifacts it does not select, and acquisitions that stopped before they installed.
 *
 *   `data status`, `data inventory` and `doctor` read this one report, so they agree on the active generation.
 *   A record that cannot be read raises an error with its path, never an empty list.
 */

import type { Dirent } from "@mailwoman/core/fs/readers"
import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { selectedSources, UnreadableArtifactError, UnreadableReason } from "@mailwoman/core/layers"
import type { PathBuilderLike } from "path-ts"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import type { AcquisitionReceipt } from "#data/acquire"
import { catalogPaths, LayerCatalog } from "#data/catalog"
import { type InstalledCopy, readInstalledCopies } from "#data/plan"

/**
 * An acquisition that stopped before its artifact installed: interrupted,
 * cancelled or refused at verification.
 */
export interface InterruptedAcquisition {
	remotePath: string
	url: string
	/**
	 * The bytes kept for a resume.
	 */
	partialBytes: number
	/**
	 * The length the host reported, or `null` when it reported none.
	 */
	expectedBytes: number | null
	startedAt: string
}

/**
 * The catalog's three lists under one data root.
 */
export interface InstallationState {
	dataRoot: string
	/**
	 * The generation `active.json` holds, or `null` when no selection has been written.
	 */
	generation: number | null
	active: InstalledCopy[]
	inactive: InstalledCopy[]
	interrupted: InterruptedAcquisition[]
}

async function readInterrupted(dataRoot: string): Promise<InterruptedAcquisition[]> {
	const directory = catalogPaths(dataRoot).acquisitions
	let entries: Dirent[]

	try {
		entries = (await Globerator.from("*", { cwd: directory, withFileTypes: true, onlyFiles: false }).toArray()).filter(
			(entry) => entry.isDirectory()
		)
	} catch (error) {
		if ((error as { code?: unknown } | null)?.code === "ENOENT") return []

		throw new UnreadableArtifactError(directory.toString(), UnreadableReason.Unopenable, (error as Error).message, {
			cause: error,
		})
	}

	const interrupted: InterruptedAcquisition[] = []

	for (const entry of entries) {
		if (entry.name.endsWith(".lock")) continue

		const receiptPath = directory(entry.name, "receipt.json")

		const receipt = await tryReadLocalJSONFile<AcquisitionReceipt>(receiptPath).catch((error: unknown) => {
			throw new UnreadableArtifactError(receiptPath.toString(), UnreadableReason.Corrupt, (error as Error).message, {
				cause: error,
			})
		})

		if (!receipt) continue

		const partial = await tryStat(directory(entry.name, "object.part"))

		interrupted.push({
			remotePath: receipt.remotePath,
			url: receipt.remote.url,
			partialBytes: partial?.size ?? 0,
			expectedBytes: receipt.remote.contentLength,
			startedAt: receipt.startedAt,
		})
	}

	return interrupted.toSorted((a, b) => a.remotePath.localeCompare(b.remotePath))
}

/**
 * Read the catalog's active, inactive and interrupted lists.
 *
 * @throws {@link UnreadableArtifactError} when the selection, an installation record,
 * a manifest or a receipt exists and cannot be read.
 */
export async function readInstallationState(dataRoot: PathBuilderLike): Promise<InstallationState> {
	const root = resolvePath(dataRoot.toString())
	const catalog = await LayerCatalog.read(root)
	const copies = await readInstalledCopies(root)

	const selected = new Set(
		(catalog.selection?.entries ?? []).flatMap((entry) =>
			selectedSources(catalog.selection!, entry.role, entry.scope).map(
				(source) => `${source.installationID}|${source.artifactID}`
			)
		)
	)

	const isActive = (copy: InstalledCopy) => selected.has(`${copy.installationID}|${copy.artifactID}`)

	return {
		dataRoot: root,
		generation: catalog.generation,
		active: copies.filter(isActive),
		inactive: copies.filter((copy) => !isActive(copy)),
		interrupted: await readInterrupted(root),
	}
}
