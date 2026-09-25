/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Schemas for the source lock and the build manifest, which trace a published archive to its inputs.
 */

import { z } from "zod"

const SHA256_HEX_LENGTH = 64

/**
 * One locked source.
 *
 * `snapshot` records the capture date of a nightly archive.
 */
export const LockedSourceSchema = z.object({
	url: z.url(),
	bytes: z.number().int().positive(),
	sha256: z.string().length(SHA256_HEX_LENGTH),
	fetchedAt: z.iso.datetime(),
	snapshot: z.iso.date().optional(),
})

/**
 * Schema for `sources.lock.json`, which maps source IDs to locked sources.
 *
 * Only the fetch step writes this file.
 */
export const SourcesLockSchema = z.record(z.string(), LockedSourceSchema)

/**
 * One locked source.
 */
export type LockedSource = z.infer<typeof LockedSourceSchema>

/**
 * Contents of `sources.lock.json`.
 */
export type SourcesLock = z.infer<typeof SourcesLockSchema>

/**
 * The coordinate convention of a source, recorded so that a consumer does not have to guess it.
 */
export const SourceCoordinatesSchema = z.object({
	longitudeDirection: z.enum(["east", "west"]),
	longitudeRange: z.enum(["-180..180", "0..360"]),
	latitudeType: z.enum(["planetocentric", "planetographic"]),
	referenceBody: z.string(),
	controlNetwork: z.string().optional(),
})

/**
 * One source as recorded in the build manifest.
 */
export const ResourceManifest = z.object({
	id: z.string(),
	url: z.url(),
	sha256: z.string().length(SHA256_HEX_LENGTH),
	bytes: z.number().int().positive(),
	snapshot: z.string().optional(),
	coordinates: SourceCoordinatesSchema.optional(),
})

/**
 * One output as recorded in the build manifest.
 */
export const OutputManifest = z.object({
	tileset: z.string(),
	path: z.string(),
	sha256: z.string().length(SHA256_HEX_LENGTH),
	bytes: z.number().int().positive(),
})

/**
 * Schema for the `manifest.json` beside a body's artifacts.
 *
 * It lists the sources read, the outputs written and the commands run between them.
 */
export const PlanetaryBuildManifestSchema = z.object({
	schemaVersion: z.literal(1),
	body: z.enum(["moon", "mars"]),
	builtAt: z.iso.datetime(),
	sources: z.array(ResourceManifest),
	outputs: z.array(OutputManifest),
	/**
	 * The exact tool invocations the build ran, in order.
	 */
	transformations: z.array(z.string()),
})

/**
 * Contents of a body's build `manifest.json`.
 */
export type PlanetaryBuildManifest = z.infer<typeof PlanetaryBuildManifestSchema>
