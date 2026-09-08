/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two reproducibility records. The lock pins each source by URL, byte count and SHA-256 (plus the snapshot date
 *   for a nightly archive); the build manifest names the sources a build read, the artifacts it wrote with their
 *   checksums, and the exact tool invocations in between, so a published archive can be traced to its inputs.
 */

import { z } from "zod"

const SHA256_HEX_LENGTH = 64

/**
 * One locked source. `snapshot` is present for a nightly archive and names the day it was taken.
 */
export const LockedSourceSchema = z.object({
	url: z.url(),
	bytes: z.number().int().positive(),
	sha256: z.string().length(SHA256_HEX_LENGTH),
	fetchedAt: z.iso.datetime(),
	snapshot: z.iso.date().optional(),
})

/**
 * `sources.lock.json`: the locked sources keyed by source id. Written only by the fetch; read by every build.
 */
export const SourcesLockSchema = z.record(z.string(), LockedSourceSchema)

export type LockedSource = z.infer<typeof LockedSourceSchema>

export type SourcesLock = z.infer<typeof SourcesLockSchema>

/**
 * The coordinate convention a source carries, recorded so a consumer never infers it.
 */
export const SourceCoordinatesSchema = z.object({
	longitudeDirection: z.enum(["east", "west"]),
	longitudeRange: z.enum(["-180..180", "0..360"]),
	latitudeType: z.enum(["planetocentric", "planetographic"]),
	referenceBody: z.string(),
	controlNetwork: z.string().optional(),
})

/**
 * `manifest.json` beside a body's artifacts: what was read, what was written, and the transformations between.
 */
export const PlanetaryBuildManifestSchema = z.object({
	schemaVersion: z.literal(1),
	body: z.enum(["moon", "mars"]),
	builtAt: z.iso.datetime(),
	sources: z.array(
		z.object({
			id: z.string(),
			url: z.url(),
			sha256: z.string().length(SHA256_HEX_LENGTH),
			bytes: z.number().int().positive(),
			snapshot: z.string().optional(),
			coordinates: SourceCoordinatesSchema.optional(),
		})
	),
	outputs: z.array(
		z.object({
			tileset: z.string(),
			path: z.string(),
			sha256: z.string().length(SHA256_HEX_LENGTH),
			bytes: z.number().int().positive(),
		})
	),
	/**
	 * The exact tool invocations the build ran, in order.
	 */
	transformations: z.array(z.string()),
})

export type PlanetaryBuildManifest = z.infer<typeof PlanetaryBuildManifestSchema>
