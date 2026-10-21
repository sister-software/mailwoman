/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The paid artifacts the download route serves, keyed by the scope entry a token names: a `tier:<name>` for an
 *   atlas tier or a package name for a weights overlay. Each entry gives the object key in the private bucket and the
 *   object's size when it is known. The catalog is code rather than a table, so a release states what it serves.
 */

export interface PaidArtifact {
	/**
	 * The object key under the private bucket.
	 */
	key: string
	/**
	 * The object's size in bytes, or `null` before it is measured.
	 */
	bytes: number | null
}

export type ArtifactCatalog = Readonly<Record<string, PaidArtifact>>

/**
 * The paid artifacts in production.
 *
 * Empty until the operator publishes the first paid artifact to the private bucket:
 * until then every download request answers 400 for an unknown artifact.
 */
export const PAID_ARTIFACTS: ArtifactCatalog = {}
