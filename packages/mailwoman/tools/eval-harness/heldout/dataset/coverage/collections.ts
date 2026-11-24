// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The held-out collections a release specification's evaluation roles score, read from their manifests.
 *
 *   A role pins each collection as `datasetID@version`.
 *   The manifest is found on the data root's `corpus/heldout` directory under the dataset id, as
 *   `<datasetID>.json` or a revision `<datasetID>.v<n>.json`, and read through `readHeldoutDatasetManifest`.
 *   A pinned collection with no manifest of that version throws, so a missing file never reads as a
 *   collection that samples no country.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { readHeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"
import { releaseSpecPath } from "#tools/eval-harness/release/current-spec"
import {
	EVALUATION_ROLES,
	type EvaluationRole,
	parseCollectionID,
	readReleaseSpec,
} from "#tools/eval-harness/release/requirements"

/**
 * One collection an evaluation role scores, and the address rows it samples per country.
 */
export interface RoleCollection {
	role: EvaluationRole
	/**
	 * `datasetID@version`, as the specification pins it.
	 */
	id: string
	path: string
	/**
	 * Sampled address rows per country, from the manifest's `address` cells.
	 *
	 * A country the collection samples no address row of is absent.
	 */
	addressRows: Record<string, number>
}

/**
 * The role collections of one specification version.
 */
export interface RoleCollections {
	specVersion: string
	collections: RoleCollection[]
}

/**
 * The highest specification version committed under `release/specs/`.
 *
 * A re-split retires a role's collections in the newest specification before that
 * version is registered, so a coverage reading of the current collections reads
 * the newest version rather than `CURRENT_RELEASE_SPEC`.
 */
export async function newestReleaseSpecVersion(): Promise<number> {
	const specs = resolvePathBuilder(releaseSpecPath(1), "..")
	let newest = 0

	for await (const file of Globerator.files("json", { cwd: specs, recursive: false })) {
		const match = /^release-requirements\.v(\d+)\.json$/.exec(file)

		if (match) { newest = Math.max(newest, Number(match[1])) }
	}

	if (!newest) throw new Error(`${specs} holds no release-requirements.v<n>.json specification`)

	return newest
}

/**
 * Reads the collections every evaluation role of specification `version` scores.
 *
 * @param root The directory holding the collection manifests, by default the data root's `corpus/heldout`.
 *
 * @throws When a pinned collection has no manifest of its version under `root`.
 */
export async function readRoleCollections(
	version: number,
	root: PathBuilderLike = dataRootPath("corpus", "heldout")
): Promise<RoleCollections> {
	const spec = await readReleaseSpec(releaseSpecPath(version))
	const collections: RoleCollection[] = []

	for (const role of EVALUATION_ROLES) {
		for (const id of spec.evaluations[role].ids) {
			const parsed = parseCollectionID(id)

			if (!parsed) throw new Error(`specification ${spec.specVersion} pins ${role} collection "${id}", which isn't datasetID@version`)

			const candidates = [`${parsed.datasetID}.json`]

			for await (const file of Globerator.files("json", { cwd: root, recursive: false })) {
				if (new RegExp(`^${parsed.datasetID.replaceAll(".", "\\.")}\\.v\\d+\\.json$`).test(file)) {
					candidates.push(file)
				}
			}

			let found: RoleCollection | null = null

			for (const file of candidates) {
				const path = resolvePathBuilder(root, file)

				if (!(await pathExists(path))) continue

				const manifest = await readHeldoutDatasetManifest(path)

				if (manifest.datasetID !== parsed.datasetID || manifest.version !== parsed.version) continue

				const addressRows: Record<string, number> = {}

				for (const cell of manifest.cells) {
					if (cell.kind === "address" && cell.sampled > 0) {
						addressRows[cell.country] = (addressRows[cell.country] ?? 0) + cell.sampled
					}
				}

				found = { role, id, path: path.toString(), addressRows }

				break
			}

			if (!found) {
				throw new Error(
					`specification ${spec.specVersion} pins ${role} collection ${id}, and ${root.toString()} holds no manifest of ` +
						`that version (read ${candidates.join(", ")})`
				)
			}

			collections.push(found)
		}
	}

	return { specVersion: spec.specVersion, collections }
}
