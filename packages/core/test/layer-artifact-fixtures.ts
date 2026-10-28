/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Artifact manifests for the installation cases the layer interfaces must describe.
 *
 *   Each fixture's identity is the SHA-256 of a fixed string standing in for its bytes, so no fixture
 *   derives anything from a filename. The cases are the global candidate gazetteer, the District of
 *   Columbia's address points and interpolation, two overlapping national address-point sources for
 *   France, one OpenStreetMap region spanning several countries, and an FST with its pair index.
 */

import { sha256Hex } from "#hash"
import {
	type ArtifactManifest,
	artifactIDFromSHA256,
	ArtifactFormat,
	type ArtifactSourceInput,
	type NormalizationIdentity,
	ServingRole,
} from "#layers"

function unrecordedSource(publisher: string): ArtifactSourceInput {
	return { publisher, release: null, url: null, sha256: null, md5: null }
}

const US_STREETS: NormalizationIdentity = { algorithm: "street-key", version: "1", locale: "us" }
const FR_STREETS: NormalizationIdentity = { algorithm: "street-key", version: "1", locale: "fr" }

function manifest(seed: string, fields: Omit<ArtifactManifest, "id" | "createdAt" | "bytes">): ArtifactManifest {
	return { ...fields, id: artifactIDFromSHA256(sha256Hex(seed)), bytes: seed.length, createdAt: "2026-10-28T00:00:00Z" }
}

const sqliteDefaults = {
	format: ArtifactFormat.SQLite,
	schemaVersion: 1,
	coverageEvidence: false,
	recipe: null,
	builderSHA: null,
} as const

/**
 * The global candidate gazetteer: no country scope and no street normalization.
 */
export const CANDIDATE = manifest("candidate", {
	...sqliteDefaults,
	role: ServingRole.Candidate,
	normalization: null,
	scope: { countries: [], subdivisions: null },
	observedCountries: null,
	sources: [unrecordedSource("Who's On First"), unrecordedSource("GeoNames")],
	license: "ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0",
})

/**
 * The District of Columbia's address points.
 */
export const DC_ADDRESS_POINTS = manifest("dc-address-points", {
	...sqliteDefaults,
	role: ServingRole.AddressPoints,
	normalization: US_STREETS,
	scope: { countries: ["US"], subdivisions: ["US-DC"] },
	observedCountries: ["US"],
	sources: [unrecordedSource("OpenAddresses")],
	license: "CC0-1.0",
})

/**
 * The District of Columbia's interpolation segments, keyed by the same normalization.
 */
export const DC_INTERPOLATION = manifest("dc-interpolation", {
	...sqliteDefaults,
	role: ServingRole.Interpolation,
	normalization: US_STREETS,
	scope: { countries: ["US"], subdivisions: ["US-DC"] },
	observedCountries: ["US"],
	sources: [{ ...unrecordedSource("US Census Bureau TIGER/Line"), release: "TIGER2023" }],
	license: "CC0-1.0",
})

/**
 * France's national register, the first of two overlapping French sources.
 */
export const FR_BAN = manifest("fr-ban", {
	...sqliteDefaults,
	role: ServingRole.AddressPoints,
	normalization: FR_STREETS,
	scope: { countries: ["FR"], subdivisions: null },
	observedCountries: ["FR"],
	coverageEvidence: true,
	sources: [unrecordedSource("Base Adresse Nationale")],
	license: "etalab-2.0",
})

/**
 * OpenStreetMap address points for France, overlapping {@link FR_BAN}.
 */
export const FR_OSM = manifest("fr-osm", {
	...sqliteDefaults,
	role: ServingRole.AddressPoints,
	normalization: FR_STREETS,
	scope: { countries: ["FR"], subdivisions: null },
	observedCountries: ["FR"],
	sources: [unrecordedSource("OpenStreetMap contributors")],
	license: "ODbL-1.0",
})

/**
 * One Geofabrik region's address points, scoped to every country the region supplies.
 */
export const DACH_OSM = manifest("dach-osm", {
	...sqliteDefaults,
	role: ServingRole.AddressPoints,
	normalization: { algorithm: "street-key", version: "1", locale: "de" },
	scope: { countries: ["AT", "CH", "DE", "LI"], subdivisions: null },
	observedCountries: ["AT", "CH", "DE", "LI"],
	sources: [unrecordedSource("OpenStreetMap contributors")],
	license: "ODbL-1.0",
})

/**
 * The street-morphology FST.
 */
export const MORPHOLOGY_FST = manifest("morphology-fst", {
	role: ServingRole.StreetMorphology,
	format: ArtifactFormat.FST,
	schemaVersion: 1,
	normalization: null,
	scope: { countries: [], subdivisions: null },
	observedCountries: null,
	coverageEvidence: false,
	sources: [unrecordedSource("Who's On First")],
	recipe: "street-morphology",
	builderSHA: null,
	license: "CC0-1.0",
})

/**
 * The pair index built beside {@link MORPHOLOGY_FST}.
 */
export const MORPHOLOGY_PAIRS = manifest("morphology-pairs", {
	...MORPHOLOGY_FST,
	format: ArtifactFormat.PairIndex,
})

/**
 * Every fixture manifest.
 */
export const LAYER_FIXTURES: readonly ArtifactManifest[] = [
	CANDIDATE,
	DC_ADDRESS_POINTS,
	DC_INTERPOLATION,
	FR_BAN,
	FR_OSM,
	DACH_OSM,
	MORPHOLOGY_FST,
	MORPHOLOGY_PAIRS,
]
