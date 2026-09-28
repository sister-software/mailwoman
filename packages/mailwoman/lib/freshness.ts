/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which data a running process is serving, read out of the artifacts themselves.
 *
 *   The stamp lives in the artifact, never beside it: a record kept next to a database goes stale on the
 *   first promotion, so the only source read here is each database's own `layer_manifest` row, written by
 *   its builder before the seal.
 *
 *   An unstamped artifact reports its own absence: every artifact the caller names appears in the report,
 *   and one carrying no manifest says so rather than being omitted or given a date guessed from its mtime
 *   or filename.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

import { probeManifest } from "#data/inventory"

/**
 * Whether an artifact could state its own provenance — three states rather than two,
 * because "we could not open it" is not "it has no manifest".
 */
export const ManifestState = {
	/**
	 * A `layer_manifest` row was read, and it carries a build date this reader could parse.
	 */
	Present: "present",
	/**
	 * The artifact is on disk and carries no manifest; it predates the layer interface
	 * and takes its stamp on the next rebuild.
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
	 * The role this artifact plays for the running process (`gazetteer`, `reverse-admin`),
	 * not its filename, which the caller can read off `path`.
	 */
	name: string
	/**
	 * The absolute path this process opened.
	 */
	path: string
	manifest: ManifestState
	/**
	 * Why the manifest is absent or unreadable; never set alongside {@link ManifestState.Present}.
	 */
	reason?: string
	/**
	 * `layer_manifest.created_at` — when this artifact was built, verbatim as the builder wrote it.
	 */
	built?: string
	/**
	 * `<layer name>@<layer version>`, the artifact's own identity.
	 */
	version?: string
	/**
	 * What it was built from — the manifest's `source` then its `source_vintage` — kept as two entries
	 * because the candidate gazetteer's source is a chain and the vintage carries the database counts.
	 */
	sources?: string[]
}

/**
 * The provenance of everything a process opened, plus the one date a Nominatim client reads.
 */
export interface FreshnessReport {
	/**
	 * The newest `built` epoch across the artifacts that carried one, verbatim, absent
	 * when no artifact was stamped; answering with the boot time, the newest mtime,
	 * or zero would answer a question this surface cannot answer.
	 */
	dataUpdated?: string
	artifacts: ArtifactFreshness[]
}

/**
 * An artifact to report on: the role it plays, and where it is.
 */
export interface FreshnessArtifact {
	name: string
	path: PathBuilderLike
}

/**
 * Read one artifact's `layer_manifest` via `data-inventory`'s {@link probeManifest}, deliberately not
 * running the interface's `readLayerManifest` validator: that enforces spine-key and tier invariants,
 * and a layer with a wrong spine declaration still has a build date this surface can report.
 */
async function readArtifact({ name, path: artifactPath }: FreshnessArtifact): Promise<ArtifactFreshness> {
	const path = artifactPath.toString()

	if (!(await pathExists(path))) {
		return { name, path, manifest: ManifestState.Absent, reason: "artifact is not on disk" }
	}

	const { error, manifest } = probeManifest(path)

	if (error) {
		return { name, path, manifest: ManifestState.Unreadable, reason: error }
	}

	if (!manifest) {
		return {
			name,
			path,
			manifest: ManifestState.Absent,
			reason: "no layer_manifest — this artifact predates the layer interface and is stamped on its next rebuild",
		}
	}

	// A stamp nobody can date is a freshness fault, not an absence: dropping it out of
	// the max below would read as an artifact that was never stamped.
	if (Number.isNaN(Date.parse(manifest.created_at))) {
		return {
			name,
			path,
			manifest: ManifestState.Unreadable,
			reason: `layer_manifest.created_at is not a date: ${stringifyJSON(manifest.created_at)}`,
		}
	}

	return {
		name,
		path,
		manifest: ManifestState.Present,
		built: manifest.created_at,
		version: `${manifest.name}@${manifest.version}`,
		sources: [manifest.source, manifest.source_vintage],
	}
}

/**
 * Report the provenance of the artifacts a session opened, called once at boot with the paths
 * the process actually resolved; a server holds its database handles open for its whole life,
 * so the artifact it serves from is the one it opened at start, whatever a later symlink swap points at.
 */
export async function readFreshness(artifacts: readonly FreshnessArtifact[]): Promise<FreshnessReport> {
	const read: ArtifactFreshness[] = []

	for (const artifact of artifacts) {
		read.push(await readArtifact(artifact))
	}

	let dataUpdated: string | undefined
	let newest = Number.NEGATIVE_INFINITY

	for (const artifact of read) {
		if (!artifact.built) continue

		const epoch = Date.parse(artifact.built)

		if (epoch > newest) {
			newest = epoch
			dataUpdated = artifact.built
		}
	}

	return { ...(dataUpdated ? { dataUpdated } : {}), artifacts: read }
}
