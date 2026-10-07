/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which data a running process is serving, read out of the artifacts themselves.
 *
 *   Each artifact stores its own freshness stamp. An adjacent record would become stale on promotion.
 *   This reader uses the artifact's `layer_manifest` row. The builder writes that row before sealing.
 *
 *   The report includes every artifact the caller names. An artifact without a manifest reports that state explicitly.
 *   The reader does not infer a date from file modification time or filename.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

import { probeManifest } from "#data/inventory"

/**
 * Whether an artifact could state its own provenance — three states rather than two,
 * because an open failure and an artifact without a manifest are different results.
 */
export const ManifestState = {
	/**
	 * A `layer_manifest` row was read.
	 * It contains a build date this reader could parse.
	 */
	Present: "present",
	/**
	 * The artifact is on disk and has no manifest.
	 *
	 * It predates the layer interface and takes its stamp on the next rebuild.
	 */
	Absent: "absent",
	/**
	 * The artifact could not be opened, or its manifest could not be dated, reported apart from
	 * {@link ManifestState.Absent} because it is a fault to chase rather than a rebuild to schedule.
	 */
	Unreadable: "unreadable",
} as const

export type ManifestState = (typeof ManifestState)[keyof typeof ManifestState]

/**
 * One artifact's provenance, as the artifact itself states it.
 */
export interface ArtifactFreshness {
	/**
	 * The role this artifact plays for the running process, such as `gazetteer` or `reverse-admin`.
	 * The caller can read its filename from `path`.
	 */
	name: string
	/**
	 * The absolute path this process opened.
	 */
	path: string
	manifest: ManifestState
	/**
	 * Why the manifest is absent or unreadable.
	 * Null alongside {@link ManifestState.Present}.
	 */
	reason: string | null
	/**
	 * `layer_manifest.created_at` — when this artifact was built, verbatim as the builder wrote it.
	 */
	built: string | null
	/**
	 * `<layer name>@<layer version>`, the artifact's own identity.
	 */
	version: string | null
	/**
	 * What it was built from — the manifest's `source` then its `source_vintage` — kept as two entries
	 * because the candidate gazetteer's source is a chain and the vintage records the database counts.
	 */
	sources: string[] | null
	/**
	 * `layer_manifest.license` — the SPDX expression the build admitted, verbatim.
	 *
	 * A row written before the column existed leaves this null.
	 * A null expression states that the build recorded no obligations rather than that the artifact has none.
	 *
	 * This field makes the per-result rights record the subset of
	 * `docs/static/sbom/mailwoman-data-<version>.cdx.json` that the process opened,
	 * read from the same `layer_manifest` row the document's components are built from.
	 */
	license: string | null
	/**
	 * `layer_manifest.attribution` — the credit line the publisher's terms ask for, verbatim.
	 */
	attribution: string | null
}

/**
 * The provenance of everything a process opened, plus the one date a Nominatim client reads.
 */
export interface FreshnessReport {
	/**
	 * The newest `built` epoch across the artifacts that recorded one, verbatim,
	 * null when no artifact was stamped.
	 *
	 * A boot time, the newest mtime, or zero would answer a question this surface cannot answer.
	 */
	dataUpdated: string | null
	artifacts: ArtifactFreshness[]
}

/**
 * An artifact to report on, with its role and path.
 */
export interface FreshnessArtifact {
	name: string
	path: PathBuilderLike
}

/**
 * Reads one artifact's `layer_manifest` through `data-inventory`'s {@link probeManifest}.
 *
 * It skips the `readLayerManifest` validator because that validator enforces spine-key and tier invariants.
 * This report can still include the build date from a layer with an incorrect spine declaration.
 */
async function readArtifact({ name, path: artifactPath }: FreshnessArtifact): Promise<ArtifactFreshness> {
	const path = artifactPath.toString()

	if (!(await pathExists(path))) {
		return {
			name,
			path,
			manifest: ManifestState.Absent,
			reason: "artifact is not on disk",
			built: null,
			version: null,
			sources: null,
			license: null,
			attribution: null,
		}
	}

	const { error, manifest } = probeManifest(path)

	if (error) {
		return {
			name,
			path,
			manifest: ManifestState.Unreadable,
			reason: error,
			built: null,
			version: null,
			sources: null,
			license: null,
			attribution: null,
		}
	}

	if (!manifest) {
		return {
			name,
			path,
			manifest: ManifestState.Absent,
			reason: "no layer_manifest — this artifact predates the layer interface and is stamped on its next rebuild",
			built: null,
			version: null,
			sources: null,
			license: null,
			attribution: null,
		}
	}

	// An undated stamp is a freshness fault, so it is reported as Unreadable.
	// An absent label would read as an artifact that was never stamped.
	if (Number.isNaN(Date.parse(manifest.created_at))) {
		return {
			name,
			path,
			manifest: ManifestState.Unreadable,
			reason: `layer_manifest.created_at is not a date: ${stringifyJSON(manifest.created_at)}`,
			built: null,
			version: null,
			sources: null,
			license: null,
			attribution: null,
		}
	}

	return {
		name,
		path,
		manifest: ManifestState.Present,
		built: manifest.created_at,
		version: `${manifest.name}@${manifest.version}`,
		sources: [manifest.source, manifest.source_vintage],
		reason: null,
		license: manifest.license || null,
		attribution: manifest.attribution || null,
	}
}

/**
 * Report the provenance of the artifacts a session opened, called once at boot
 * with the paths the process actually resolved.
 *
 * A server holds its database handles open for its whole life, so the artifact it serves
 * from is the one it opened at start, whatever a later symlink swap points at.
 */
export async function readFreshness(artifacts: readonly FreshnessArtifact[]): Promise<FreshnessReport> {
	const read: ArtifactFreshness[] = []

	for (const artifact of artifacts) {
		read.push(await readArtifact(artifact))
	}

	let dataUpdated: string | null = null
	let newest = Number.NEGATIVE_INFINITY

	for (const artifact of read) {
		if (!artifact.built) continue

		const epoch = Date.parse(artifact.built)

		if (epoch > newest) {
			newest = epoch
			dataUpdated = artifact.built
		}
	}

	return { dataUpdated, artifacts: read }
}
