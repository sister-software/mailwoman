/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mailwoman:*` block, written into an archive's PMTiles metadata and read back. The block is validated before
 *   it is written and again after `pmtiles edit` has written it, so an archive that leaves the build carries the block
 *   the schema describes and nothing else the tool may have dropped.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"

import { BODIES, type BuildableBodyID } from "#bodies"
import { type PMTilesMetadata, PMTilesMetadataSchema } from "#schema/pmtiles-metadata"

/**
 * The archive's whole metadata object, as `pmtiles show --metadata` prints it.
 */
export async function readPMTilesMetadata(archivePath: string): Promise<Record<string, unknown>> {
	const { stdout } = await runFile("pmtiles", ["show", archivePath, "--metadata"])

	return parseJSONStrict<Record<string, unknown>>(stdout)
}

/**
 * The block an archive carries, validated; throws when the archive carries none or a malformed one.
 */
export async function readMailwomanMetadata(archivePath: string): Promise<PMTilesMetadata> {
	const metadata = await readPMTilesMetadata(archivePath)

	return PMTilesMetadataSchema.parse(
		Object.fromEntries(Object.entries(metadata).filter(([key]) => key.startsWith("mailwoman:")))
	)
}

/**
 * Merge the validated block over the archive's current metadata and write it back, then read it back and refuse unless
 * every key round-tripped.
 */
export async function applyPMTilesMetadata(archivePath: string, block: PMTilesMetadata): Promise<void> {
	const validated = PMTilesMetadataSchema.parse(block)
	const merged = { ...(await readPMTilesMetadata(archivePath)), ...validated }

	await using scratch = await temporaryDirectory("astrogeology-metadata-")
	const file = resolvePath(scratch.path, "metadata.json")

	await writeLocalJSONFile(merged, file)
	await runFile("pmtiles", ["edit", archivePath, `--metadata=${String(file)}`])

	const written = await readMailwomanMetadata(archivePath)

	for (const [key, value] of Object.entries(validated)) {
		if (written[key as keyof PMTilesMetadata] !== value) {
			throw new Error(
				`${archivePath}: metadata ${key} did not round-trip: wrote ${String(value)}, read ${String(written[key as keyof PMTilesMetadata])}`
			)
		}
	}
}

/**
 * The block for a body's nomenclature archive.
 */
export function nomenclatureMetadata(body: BuildableBodyID, buildVersion: string): PMTilesMetadata {
	return {
		"mailwoman:kind": "planetary-basemap",
		"mailwoman:body": body,
		"mailwoman:schema": "planetary-v1",
		"mailwoman:coordinate_longitude": "east-positive--180-180",
		"mailwoman:coordinate_latitude": BODIES[body].coordinates.latitudeType,
		"mailwoman:source": "USGS Astrogeology / IAU Working Group for Planetary System Nomenclature (public domain)",
		"mailwoman:build_version": buildVersion,
	}
}

/**
 * The block for a body's hillshade archive. `sourceProduct` names the DEM the shading came from.
 */
export function hillshadeMetadata(body: BuildableBodyID, buildVersion: string, sourceProduct: string): PMTilesMetadata {
	return {
		"mailwoman:kind": "planetary-hillshade",
		"mailwoman:body": body,
		"mailwoman:schema": "planetary-v1",
		"mailwoman:coordinate_longitude": "east-positive--180-180",
		"mailwoman:coordinate_latitude": BODIES[body].coordinates.latitudeType,
		"mailwoman:source": "USGS Astrogeology (public domain)",
		"mailwoman:build_version": buildVersion,
		"mailwoman:vertical_datum": BODIES[body].coordinates.referenceBody,
		"mailwoman:elevation_unit": "metre",
		"mailwoman:source_product": sourceProduct,
	}
}
