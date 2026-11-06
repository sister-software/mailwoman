/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coverage and provenance inspection: what an artifact's profile holds, read from its header and directory.
 */

import { type Artifact, type ArtifactHeader, Artifact as RGY1Artifact } from "#rgy1/reader"

/**
 * What an artifact declares about itself.
 */
export interface ArtifactInspection {
	artifact: string
	profile: string
	namespaces: string[]
	sources: ArtifactHeader["sources"]
	coverage: Record<string, number>
	/**
	 * What a miss means under this profile.
	 *
	 * The source holds no such code, and the issuing authority may have assigned it.
	 */
	missMeans: "not-found-in-snapshot"
	status?: string
	kinds?: string[]
	generator: string
	sections: Array<{ kind: number; count: number; bytes: number; aux: number }>
}

/**
 * Reads an artifact's header and directory into a plain inspection record.
 */
export function inspectArtifact(bytes: Uint8Array | Artifact): ArtifactInspection {
	const artifact = bytes instanceof RGY1Artifact ? bytes : RGY1Artifact.parse(bytes)
	const { header } = artifact

	return {
		artifact: header.artifact,
		profile: header.profile,
		namespaces: header.namespaces,
		sources: header.sources,
		coverage: header.coverage,
		missMeans: "not-found-in-snapshot",
		...(header.status ? { status: header.status } : {}),
		...(header.kinds ? { kinds: header.kinds } : {}),
		generator: header.generator,
		sections: artifact.sections.map((section) => ({
			kind: section.kind,
			count: section.count,
			bytes: section.length,
			aux: section.aux,
		})),
	}
}
