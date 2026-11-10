/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes one vintage of a snapshot source. A vintage is read-only once written, and a newer vintage sits beside it.
 */

import type { PathBuilderLike } from "path-ts"

import { pathExists } from "#fs/readers/stat"
import { makeDirectories, movePath, removePath, removePathIfPresent } from "#fs/writers"

/**
 * How a caller may write a vintage that already exists.
 */
export interface SnapshotWriteOptions {
	/**
	 * Whether the caller stated the vintage, such as with `--vintage 2026-08-31`.
	 *
	 * A vintage the command resolved itself, from the date or the publisher's
	 * newest release, is never overwritten.
	 */
	vintageFromCaller: boolean
	/**
	 * Whether the caller asked to overwrite an existing vintage, such as with `--force`.
	 */
	force?: boolean
}

/**
 * Thrown when a write would replace a vintage that already exists.
 */
export class SnapshotExistsError extends Error {
	public readonly path: string

	constructor(path: string, vintageFromCaller: boolean) {
		super(
			vintageFromCaller
				? `${path} already exists; pass --force to replace this vintage`
				: `${path} already exists; to replace it, state the vintage with --vintage and pass --force`
		)

		this.name = "SnapshotExistsError"
		this.path = path
	}
}

/**
 * Throws unless {@link writeSnapshot} would accept `target` under `options`.
 *
 * A fetch whose download is long checks this before downloading, so a refused vintage costs no transfer.
 *
 * @returns Whether `target` exists.
 * A `true` answer means the caller may replace it.
 * @throws {SnapshotExistsError} When `target` exists, unless the caller stated
 * the vintage and passed `force`.
 */
export async function assertSnapshotWritable(target: PathBuilderLike, options: SnapshotWriteOptions): Promise<boolean> {
	const path = target.toString()
	const exists = await pathExists(path)

	if (exists && !(options.force && options.vintageFromCaller)) {
		throw new SnapshotExistsError(path, options.vintageFromCaller)
	}

	return exists
}

/**
 * Writes the vintage directory `target` through `fill`, which writes into a staging directory beside it.
 *
 * The staging directory replaces `target` only after `fill` resolves, so a failed write
 * leaves an existing vintage as it was and leaves no partial vintage behind.
 *
 * @throws {SnapshotExistsError} When `target` exists, unless the caller stated
 * the vintage and passed `force`.
 */
export async function writeSnapshot(
	target: PathBuilderLike,
	options: SnapshotWriteOptions,
	fill: (staging: string) => Promise<void>
): Promise<void> {
	const path = target.toString()
	const exists = await assertSnapshotWritable(path, options)
	const staging = `${path}.staging-${process.pid}`

	await removePathIfPresent(staging)
	await makeDirectories(staging)

	try {
		await fill(staging)
	} catch (error) {
		await removePathIfPresent(staging)

		throw error
	}

	if (!exists) {
		await movePath(staging, path)

		return
	}

	const replaced = `${path}.replaced-${process.pid}`

	await movePath(path, replaced)
	await movePath(staging, path)
	await removePath(replaced)
}
