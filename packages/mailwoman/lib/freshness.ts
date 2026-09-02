/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which data is a running process serving — read out of the artifacts themselves.
 *
 *   A geocode answers from a specific set of sealed databases, and nothing on the wire said which:
 *   `data_updated` was declared in the Nominatim contract and fed by nothing (#997). An operator whose
 *   gazetteer predates a source swap had no surface that would tell them.
 *
 *   THE STAMP LIVES IN THE ARTIFACT, never beside it. A record kept next to a database goes stale on the
 *   first promotion — `mailwoman data status` reports `wof/candidate.db: stale — 2.9 GB on disk vs 1.7 GB
 *   (recorded)`, where the artifact is current and the RECORD is what drifted. So the only source read
 *   here is each database's own `layer_manifest` row, written by its builder before the seal.
 *
 *   AN UNSTAMPED ARTIFACT REPORTS ITS OWN ABSENCE. Every artifact the caller names appears in the report,
 *   and one carrying no manifest says so — never omitted, and never given a date guessed from its mtime or
 *   its filename. On the wire an omitted entry and a guessed epoch are both indistinguishable from a
 *   measured answer, and whether a measured answer exists is the whole question `/status` is asked.
 */

import { pathExists } from "@mailwoman/core/fs/readers"

import { probeManifest } from "#data/inventory"

/**
 * Whether an artifact could state its own provenance.
 *
 * Three states, not two, for the reason `data-inventory.ts` keeps four: "we could not open it" is not "it has no
 * manifest", and collapsing them would report a locked or truncated database as a plain provenance gap.
 */
export const ManifestState = {
	/**
	 * A `layer_manifest` row was read, and it carries a build date this reader could parse.
	 */
	Present: "present",
	/**
	 * The artifact is on disk and carries no manifest — it predates the layer contract, and takes its stamp on the next
	 * rebuild.
	 */
	Absent: "absent",
	/**
	 * The artifact could not be opened, or its manifest could not be dated. Reported apart from
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
	 * The ROLE this artifact plays for the running process (`gazetteer`, `reverse-admin`) — not its filename, which the
	 * caller can read off `path`. A reader wants to know which of the databases in front of them is stale, and the role
	 * is how they know which one to rebuild.
	 */
	name: string
	/**
	 * The absolute path this process opened.
	 */
	path: string
	manifest: ManifestState
	/**
	 * Why the manifest is absent or unreadable. Never set alongside {@link ManifestState.Present}.
	 */
	reason?: string
	/**
	 * `layer_manifest.created_at` — when this artifact was BUILT, verbatim as the builder wrote it.
	 */
	built?: string
	/**
	 * `<layer name>@<layer version>` — the artifact's own identity, which is what a reproduction asks for.
	 */
	version?: string
	/**
	 * What it was built FROM: the manifest's `source` then its `source_vintage`. Two entries rather than one string
	 * because the candidate gazetteer's source is a CHAIN (it names its ancestor admin build) and the vintage carries the
	 * database counts that make one candidate build different from another.
	 */
	sources?: string[]
}

/**
 * The provenance of everything a process opened, plus the one date a Nominatim client reads.
 */
export interface FreshnessReport {
	/**
	 * The newest `built` epoch across the artifacts that carried one, verbatim.
	 *
	 * ABSENT when nothing was stamped. A `/status` that answered with the boot time, the newest mtime, or an epoch zero
	 * would be answering a question it cannot answer — the field is optional in the Nominatim contract precisely so it
	 * can be left out.
	 */
	dataUpdated?: string
	artifacts: ArtifactFreshness[]
}

/**
 * An artifact to report on: the role it plays, and where it is.
 */
export interface FreshnessArtifact {
	name: string
	path: string
}

/**
 * Read one artifact's `layer_manifest`.
 *
 * Reuses `data-inventory`'s {@link probeManifest} — the package's one home for "read this database's manifest, or say
 * why not" — rather than opening a second reader over the same table. It deliberately does NOT run the contract's
 * `readLayerManifest` validator: that eval enforces the SPINE-KEY and tier invariants, which govern how a layer is
 * JOINED, and a layer whose spine declaration is wrong still has a build date this surface can report. Rejecting the
 * date over an unrelated field would report absence where a fact exists, which is the failure this whole reader is
 * built against.
 */
async function readArtifact({ name, path }: FreshnessArtifact): Promise<ArtifactFreshness> {
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
			reason: "no layer_manifest — this artifact predates the layer contract and is stamped on its next rebuild",
		}
	}

	// A stamp nobody can date is not a freshness answer. It is reported as a fault rather than silently
	// dropped out of the max below, where it would read as an artifact that was simply never stamped.
	if (Number.isNaN(Date.parse(manifest.created_at))) {
		return {
			name,
			path,
			manifest: ManifestState.Unreadable,
			reason: `layer_manifest.created_at is not a date: ${JSON.stringify(manifest.created_at)}`,
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
 * Report the provenance of the artifacts a session opened.
 *
 * Call this ONCE, at boot, with the paths the process actually resolved — not with everything in the data root. A
 * server holds its database handles open for its whole life, so the artifact it is serving from is the one it opened at
 * start, whatever a later symlink swap points at.
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
