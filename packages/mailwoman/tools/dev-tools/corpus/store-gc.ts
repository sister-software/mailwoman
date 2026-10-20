/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reachability over the corpus store, for `store-gc.run.ts`.
 *
 *   A store directory, `store/<source>/<derivation hash>/`, holds one parquet file and its record. It is
 *   reachable when a version manifest lists a file inside it, and a version manifest is a root when a frozen
 *   training manifest under `packages/corpus/data/training-manifests/` or a model card
 *   (`packages/neural-weights-*\/model-card.json`) names its corpus version. Every other store directory is
 *   unreachable: no released model and no frozen record can need its bytes.
 *
 *   A root whose manifest cannot be read makes the reachable set unknown, so the report states each such root
 *   and the deleting caller refuses to run.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists, statPath } from "@mailwoman/core/fs/readers/stat"
import { corpusDirectoryName } from "@mailwoman/corpus/directory"
import { baseManifestFiles, localManifestFilePath } from "@mailwoman/corpus/tools/overlay/manifest"
import { dirname, type PathBuilderLike, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * A corpus version as frozen manifests and model cards spell it: `v`
 * and a dotted version, then an optional tag.
 */
const CORPUS_VERSION_PATTERN = /^v\d+(?:\.\d+){2,3}(?:-[a-z0-9-]+)?$/u

/**
 * One file's reference to a corpus version.
 */
export interface StoreRoot {
	/**
	 * The file that refers to the version.
	 */
	namedBy: string
	corpusVersion: string
}

/**
 * The corpus versions the frozen training manifests in a directory name, one per `corpusVersion` field.
 */
export async function trainingManifestRoots(directory: PathBuilderLike): Promise<StoreRoot[]> {
	const names = await Globerator.from("*.json", { cwd: directory.toString(), onlyFiles: true }).toArray()
	const roots: StoreRoot[] = []

	for (const name of names.map(String).toSorted()) {
		const path = resolvePath(directory, name)
		const manifest = await readLocalJSONFile<{ corpusVersion?: unknown }>(path)

		if (typeof manifest.corpusVersion !== "string") {
			throw new TypeError(`${path} records no corpusVersion, so the version it froze cannot be a root`)
		}

		roots.push({ namedBy: path, corpusVersion: manifest.corpusVersion })
	}

	return roots
}

/**
 * Every `corpus_version` value anywhere in a model card.
 *
 * A value that is not a corpus version, such as a sentence describing an older feed,
 * is returned under `unparsed` rather than dropped, so the report shows what the card states.
 */
export async function modelCardRoots(path: string): Promise<{ roots: StoreRoot[]; unparsed: string[] }> {
	const card = await readLocalJSONFile<unknown>(path)
	const roots: StoreRoot[] = []
	const unparsed: string[] = []

	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) {
				visit(item)
			}

			return
		}

		if (typeof value !== "object" || value == null) return

		for (const [key, inner] of Object.entries(value)) {
			if (key === "corpus_version" && typeof inner === "string") {
				if (CORPUS_VERSION_PATTERN.test(inner)) {
					roots.push({ namedBy: path, corpusVersion: inner })
				} else {
					unparsed.push(inner)
				}
			}

			visit(inner)
		}
	}

	visit(card)

	return { roots, unparsed }
}

/**
 * A version manifest's path under a `corpus/versioned`
 * directory: `<version>/corpus-<version without v>/MANIFEST.json`.
 */
export function versionManifestPath(versionedRoot: PathBuilderLike, corpusVersion: string): string {
	return resolvePath(versionedRoot, corpusVersion, corpusDirectoryName(corpusVersion.slice(1)), "MANIFEST.json")
}

/**
 * The local paths one version manifest reaches: each listed file, each split attribute
 * and each deletion sidecar.
 */
export async function manifestReach(manifestPath: string): Promise<string[]> {
	const manifest = await readLocalJSONFile<Record<string, unknown>>(manifestPath)
	const reached: string[] = []

	for (const file of baseManifestFiles(manifest)) {
		reached.push(localManifestFilePath(file.path))

		const attribute = file["split_attribute"] as { path?: string } | undefined

		if (attribute?.path) {
			reached.push(localManifestFilePath(attribute.path))
		}
	}

	for (const deletion of (manifest["deletions"] as Array<{ source_ids_file?: { path: string } }> | undefined) ?? []) {
		if (deletion.source_ids_file) {
			reached.push(localManifestFilePath(deletion.source_ids_file.path))
		}
	}

	return reached
}

/**
 * One `store/<source>/<derivation hash>/` directory with what it holds.
 */
export interface StoreDirectory {
	path: string
	bytes: number
	/**
	 * The latest modification time of any file inside, in milliseconds since the epoch.
	 */
	newestMtimeMs: number
}

/**
 * List the store directories under one store root, with each one's size and newest file time.
 */
export async function listStoreDirectories(storeRoot: string): Promise<StoreDirectory[]> {
	const files = await Globerator.from("*/*/**/*", { cwd: storeRoot, onlyFiles: true }).toArray()
	const directories = new Map<string, StoreDirectory>()

	for (const relative of files.map(String)) {
		const [source, hash] = relative.split("/")
		const path = resolvePath(storeRoot, source!, hash!)
		const stat = await statPath(resolvePath(storeRoot, relative))
		const entry = directories.get(path) ?? { path, bytes: 0, newestMtimeMs: 0 }

		entry.bytes += stat.size
		entry.newestMtimeMs = Math.max(entry.newestMtimeMs, stat.mtimeMs)
		directories.set(path, entry)
	}

	return [...directories.values()].toSorted((a, b) => a.path.localeCompare(b.path))
}

/**
 * A root's manifest read, or the reason it could not be.
 */
export type RootReach =
	| { root: StoreRoot; manifest: string; reached: string[] }
	| { root: StoreRoot; manifest: string; unreadable: string }

/**
 * Read every root's version manifest.
 */
export async function readRootReach(roots: readonly StoreRoot[], versionedRoot: PathBuilderLike): Promise<RootReach[]> {
	const out: RootReach[] = []

	for (const root of roots) {
		const manifest = versionManifestPath(versionedRoot, root.corpusVersion)

		if (!(await pathExists(manifest))) {
			out.push({ root, manifest, unreadable: "the version manifest is absent" })

			continue
		}

		try {
			out.push({ root, manifest, reached: await manifestReach(manifest) })
		} catch (error) {
			out.push({ root, manifest, unreadable: String(error) })
		}
	}

	return out
}

/**
 * The store directories no reached path sits inside.
 */
export function unreachableDirectories(
	directories: readonly StoreDirectory[],
	reached: Iterable<string>
): StoreDirectory[] {
	const known = new Set(directories.map((directory) => directory.path))
	const live = new Set<string>()

	for (const path of reached) {
		// Walk up from the reached file, because a store directory is an ancestor of every path inside it.
		for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
			if (known.has(parent)) {
				live.add(parent)

				break
			}
		}
	}

	return directories.filter((directory) => !live.has(directory.path))
}
