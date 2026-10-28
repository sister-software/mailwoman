/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Artifact identity, serving roles, normalization identity and artifact-set membership.
 *
 *   An artifact is one immutable file identified by the SHA-256 of its bytes. Its role identifies the
 *   reader interface that opens it, its scope lists where a selection may consider it, and its lineage
 *   lists the inputs its observations came from. These are separate fields because they answer separate
 *   questions.
 *
 *   An artifact set binds artifacts that activate together, such as an FST and the pair index built
 *   beside it, by artifact identity and schema version. A set's identity is a digest of its members, so
 *   two sets with the same members are the same set wherever they were installed.
 *
 *   Identity and scope come from recorded fields and digests, never from a filename. A field a build did
 *   not record stays `null`.
 */

import { sha256Hex } from "#hash"
import { canonicalJSON, stringifyJSON } from "#json"

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * Whether a scope country is written as an uppercase ISO 3166-1 alpha-2 code.
 *
 * This checks the spelling a scope stores.
 * Whether ISO has assigned the code is a separate question.
 */
export function isScopeCountryCode(value: string): boolean {
	return /^[A-Z]{2}$/.test(value)
}

/**
 * Whether a scope subdivision is written as an ISO 3166-2 code inside `country`,
 * such as `US-DC` inside `US`.
 */
export function isScopeSubdivisionCode(value: string, country: string | null): boolean {
	return /^[A-Z]{2}-[0-9A-Z]{1,3}$/.test(value) && value.slice(0, 2) === country
}

/**
 * Whether a value is 32 lowercase hex characters, the spelling of a recorded MD5.
 */
export function isRecordedMD5(value: string): boolean {
	return /^[0-9a-f]{32}$/.test(value)
}

/**
 * The identity of one artifact: `sha256:` and the lowercase hex SHA-256 of its bytes.
 */
export type ArtifactID = `sha256:${string}`

/**
 * The identity of one artifact set: `set-sha256:` and the hex SHA-256 of its canonical member list.
 */
export type ArtifactSetID = `set-sha256:${string}`

/**
 * The artifact identity of a file whose SHA-256 is `hex`.
 *
 * @throws When `hex` is not 64 lowercase hex characters, such as a 32-character MD5.
 */
export function artifactIDFromSHA256(hex: string): ArtifactID {
	if (!SHA256_HEX.test(hex)) {
		throw new Error(`artifact identity: a SHA-256 is 64 lowercase hex characters, got ${stringifyJSON(hex)}`)
	}

	return `sha256:${hex}`
}

/**
 * Whether a value is a well-formed {@link ArtifactID}.
 */
export function isArtifactID(value: unknown): value is ArtifactID {
	return typeof value === "string" && value.startsWith("sha256:") && SHA256_HEX.test(value.slice("sha256:".length))
}

/**
 * The reader interface an artifact serves.
 *
 * A role identifies the reader that opens the artifact.
 * The artifact's sources record where its rows came from.
 *
 * BAN, Overture and OpenStreetMap address-point databases all serve `AddressPoints`.
 */
export const ServingRole = {
	/**
	 * The candidate gazetteer the place resolver reads.
	 */
	Candidate: "candidate",
	/**
	 * A Who's On First admin extract the FTS backend reads.
	 */
	WOFExtract: "wof-extract",
	/**
	 * Rooftop or entrance points keyed by normalized street and house number.
	 */
	AddressPoints: "address-points",
	/**
	 * Street segments with address ranges for interpolation.
	 */
	Interpolation: "interpolation",
	/**
	 * Street centroids for a query without a house number.
	 */
	StreetCentroids: "street-centroids",
	/**
	 * The postal-city alias scorer's database.
	 */
	PostalCityAlias: "postal-city-alias",
	/**
	 * Points of interest.
	 */
	POI: "poi",
	/**
	 * An H3-keyed polygon overlay such as soil, flood, coastal or zoning.
	 */
	Overlay: "overlay",
	/**
	 * The street-morphology FST and the files built with it.
	 */
	StreetMorphology: "street-morphology",
} as const

export type ServingRole = (typeof ServingRole)[keyof typeof ServingRole]

const ROLES = new Set<string>(Object.values(ServingRole))

/**
 * The container format of an artifact's bytes.
 */
export const ArtifactFormat = {
	SQLite: "sqlite",
	FST: "fst",
	/**
	 * A binary pair index, such as the PIX1 files beside an FST.
	 */
	PairIndex: "pair-index",
	JSON: "json",
} as const

export type ArtifactFormat = (typeof ArtifactFormat)[keyof typeof ArtifactFormat]

const FORMATS = new Set<string>(Object.values(ArtifactFormat))

/**
 * Whether a role's reader keys its rows by a normalized street.
 */
export const NormalizationRequirement = {
	/**
	 * The reader keys rows by normalized street, so the artifact must name the normalization that keyed it.
	 */
	Required: "required",
	/**
	 * The reader keys no street, so an artifact of this role records no normalization.
	 */
	NotApplicable: "not-applicable",
} as const

export type NormalizationRequirement = (typeof NormalizationRequirement)[keyof typeof NormalizationRequirement]

/**
 * What each role requires of an artifact's manifest beyond the fields every artifact records.
 */
export interface RoleRequirement {
	normalization: NormalizationRequirement
	/**
	 * The formats a reader of this role opens.
	 */
	formats: readonly ArtifactFormat[]
}

/**
 * The per-role requirements.
 *
 * A postcode or admin role has no street-normalization requirement
 * because only street-keyed readers need one.
 */
export const ROLE_REQUIREMENTS: Readonly<Record<ServingRole, RoleRequirement>> = {
	[ServingRole.Candidate]: { normalization: NormalizationRequirement.NotApplicable, formats: [ArtifactFormat.SQLite] },
	[ServingRole.WOFExtract]: { normalization: NormalizationRequirement.NotApplicable, formats: [ArtifactFormat.SQLite] },
	[ServingRole.AddressPoints]: { normalization: NormalizationRequirement.Required, formats: [ArtifactFormat.SQLite] },
	[ServingRole.Interpolation]: { normalization: NormalizationRequirement.Required, formats: [ArtifactFormat.SQLite] },
	[ServingRole.StreetCentroids]: { normalization: NormalizationRequirement.Required, formats: [ArtifactFormat.SQLite] },
	[ServingRole.PostalCityAlias]: {
		normalization: NormalizationRequirement.NotApplicable,
		formats: [ArtifactFormat.SQLite],
	},
	[ServingRole.POI]: { normalization: NormalizationRequirement.NotApplicable, formats: [ArtifactFormat.SQLite] },
	[ServingRole.Overlay]: { normalization: NormalizationRequirement.NotApplicable, formats: [ArtifactFormat.SQLite] },
	[ServingRole.StreetMorphology]: {
		normalization: NormalizationRequirement.NotApplicable,
		formats: [ArtifactFormat.FST, ArtifactFormat.PairIndex, ArtifactFormat.JSON],
	},
}

/**
 * The normalization that keyed an artifact's street column.
 *
 * A query is keyed by the same algorithm, version and locale, or the lookup
 * compares strings normalized two different ways.
 */
export interface NormalizationIdentity {
	/**
	 * The algorithm's name, such as `street-key`.
	 */
	algorithm: string
	/**
	 * The algorithm's version.
	 * A change to its output is a new version.
	 */
	version: string
	/**
	 * The street locale the algorithm applied, such as `us` or `fr`.
	 */
	locale: string
}

/**
 * Whether two normalization identities key streets the same way.
 */
export function sameNormalization(a: NormalizationIdentity, b: NormalizationIdentity): boolean {
	return a.algorithm === b.algorithm && a.version === b.version && a.locale === b.locale
}

/**
 * Where a selection may consider an artifact.
 *
 * Scope is an installation selector rather than a coverage claim: an artifact scoped
 * to a country makes no statement about how much of the country it holds.
 */
export interface ArtifactScope {
	/**
	 * ISO 3166-1 alpha-2 codes, uppercase.
	 *
	 * An empty list means the artifact is not scoped by country, as a global gazetteer is not.
	 */
	countries: readonly string[]
	/**
	 * ISO 3166-2 codes, such as `US-DC`, when the artifact is scoped below the country.
	 * `null` means the artifact is scoped to whole countries.
	 */
	subdivisions: readonly string[] | null
}

/**
 * One input an artifact was built from.
 *
 * Every digest the build did not record stays `null`.
 * A migration never fills one in afterwards.
 */
export interface ArtifactSourceInput {
	/**
	 * The publisher's own name for the source.
	 */
	publisher: string
	/**
	 * The publisher's release identifier, such as a date or version.
	 */
	release: string | null
	url: string | null
	/**
	 * The input's SHA-256 as 64 lowercase hex characters.
	 */
	sha256: string | null
	/**
	 * The input's MD5 as 32 lowercase hex characters, recorded separately from the SHA-256.
	 */
	md5: string | null
}

/**
 * What one immutable artifact contains.
 *
 * The manifest validates the artifact.
 * It does not select it: only the active selection does that.
 */
export interface ArtifactManifest {
	id: ArtifactID
	role: ServingRole
	format: ArtifactFormat
	/**
	 * The version of the role's schema the artifact was written with.
	 */
	schemaVersion: number
	bytes: number
	/**
	 * Required when {@link ROLE_REQUIREMENTS} marks the role as street-keyed, and `null` otherwise.
	 */
	normalization: NormalizationIdentity | null
	scope: ArtifactScope
	/**
	 * The countries the build observed rows for, or `null` when the build did not record them.
	 * An observed country is not a claim of complete coverage.
	 */
	observedCountries: readonly string[] | null
	/**
	 * Whether the artifact stores per-cell coverage evidence, such as a `layer_coverage` table.
	 * Without it, a missed lookup supports no negative answer.
	 */
	coverageEvidence: boolean
	sources: readonly ArtifactSourceInput[]
	/**
	 * The build recipe's name, or `null` when the build did not record one.
	 */
	recipe: string | null
	/**
	 * The commit the builder ran from, or `null` when the build did not record it.
	 */
	builderSHA: string | null
	/**
	 * An SPDX license expression.
	 */
	license: string
	createdAt: string
}

/**
 * A manifest validation failure, naming the artifact and every field that failed.
 */
export class ArtifactManifestError extends Error {
	readonly problems: readonly string[]

	constructor(subject: string, problems: readonly string[]) {
		super(`${subject}: ${problems.join("; ")}`)
		this.name = "ArtifactManifestError"
		this.problems = problems
	}
}

function scopeProblems(scope: ArtifactScope | undefined): string[] {
	if (!scope || !Array.isArray(scope.countries)) return ["scope.countries is missing"]

	const problems = scope.countries
		.filter((country) => !isScopeCountryCode(country))
		.map((country) => `scope country ${stringifyJSON(country)} is not an uppercase ISO 3166-1 alpha-2 code`)

	if (scope.subdivisions === undefined) {
		problems.push("scope.subdivisions is missing; write null for an artifact scoped to whole countries")
	}

	for (const subdivision of scope.subdivisions ?? []) {
		const country = scope.countries.find((candidate) => candidate === subdivision.slice(0, 2)) ?? null

		if (!isScopeSubdivisionCode(subdivision, country)) {
			problems.push(`scope subdivision ${stringifyJSON(subdivision)} is not an ISO 3166-2 code in the scoped countries`)
		}
	}

	return problems
}

function sourceProblems(sources: readonly ArtifactSourceInput[] | undefined): string[] {
	if (!Array.isArray(sources)) return ["sources is missing"]

	if (!sources.length) return ["sources is empty; an artifact names at least one input publisher"]

	const problems: string[] = []

	sources.forEach((source, index) => {
		if (!source.publisher) {
			problems.push(`sources[${index}].publisher is missing`)
		}

		for (const field of ["release", "url", "sha256", "md5"] as const) {
			if (source[field] === undefined) {
				problems.push(`sources[${index}].${field} is missing; write null when unrecorded`)
			}
		}

		if (source.sha256 && !SHA256_HEX.test(source.sha256)) {
			problems.push(`sources[${index}].sha256 is not 64 lowercase hex characters`)
		}

		if (source.md5 && !isRecordedMD5(source.md5)) {
			problems.push(`sources[${index}].md5 is not 32 lowercase hex characters`)
		}
	})

	return problems
}

/**
 * Every way a manifest fails its required metadata, or an empty list.
 */
export function artifactManifestProblems(manifest: Partial<ArtifactManifest>): string[] {
	const problems: string[] = []

	if (!isArtifactID(manifest.id)) {
		problems.push(`id ${stringifyJSON(manifest.id)} is not sha256:<64 hex>`)
	}

	const role = manifest.role

	if (!role || !ROLES.has(role)) {
		problems.push(`role ${stringifyJSON(role)} is not a serving role`)
	}

	if (!manifest.format || !FORMATS.has(manifest.format)) {
		problems.push(`format ${stringifyJSON(manifest.format)} is not an artifact format`)
	}

	if (!Number.isSafeInteger(manifest.schemaVersion) || (manifest.schemaVersion ?? 0) < 1) {
		problems.push("schemaVersion must be a positive integer")
	}

	if (!Number.isSafeInteger(manifest.bytes) || (manifest.bytes ?? -1) < 0) {
		problems.push("bytes must be a non-negative integer")
	}

	if (role && ROLES.has(role)) {
		const requirement = ROLE_REQUIREMENTS[role]

		if (manifest.format && FORMATS.has(manifest.format) && !requirement.formats.includes(manifest.format)) {
			problems.push(`role ${role} does not read format ${manifest.format}`)
		}

		if (requirement.normalization === NormalizationRequirement.Required) {
			const normalization = manifest.normalization

			if (!normalization?.algorithm || !normalization.version || !normalization.locale) {
				problems.push(`role ${role} keys rows by street and requires normalization {algorithm, version, locale}`)
			}
		} else if (manifest.normalization != null) {
			problems.push(`role ${role} keys no street, so it records no normalization`)
		}
	}

	problems.push(...scopeProblems(manifest.scope))

	if (manifest.observedCountries === undefined) {
		problems.push("observedCountries is missing; write null when the build did not record them")
	}

	if (typeof manifest.coverageEvidence !== "boolean") {
		problems.push("coverageEvidence is missing")
	}

	problems.push(...sourceProblems(manifest.sources))

	if (manifest.recipe === undefined) {
		problems.push("recipe is missing; write null when unrecorded")
	}

	if (manifest.builderSHA === undefined) {
		problems.push("builderSHA is missing; write null when unrecorded")
	}

	if (!manifest.license) {
		problems.push("license is missing")
	}

	if (!manifest.createdAt) {
		problems.push("createdAt is missing")
	}

	return problems
}

/**
 * Throws unless a manifest records every required field for its role.
 *
 * @throws {@link ArtifactManifestError} listing every missing or malformed field.
 */
export function assertArtifactManifest(
	manifest: Partial<ArtifactManifest>,
	subject = "artifact manifest"
): asserts manifest is ArtifactManifest {
	const problems = artifactManifestProblems(manifest)

	if (problems.length) throw new ArtifactManifestError(subject, problems)
}

/**
 * One artifact's place in a set.
 */
export interface ArtifactSetMember {
	artifactID: ArtifactID
	role: ServingRole
	schemaVersion: number
}

/**
 * Artifacts that activate together.
 */
export interface ArtifactSetManifest {
	id: ArtifactSetID
	members: readonly ArtifactSetMember[]
}

/**
 * The identity of a set with these members, independent of their order.
 */
export function artifactSetID(members: readonly ArtifactSetMember[]): ArtifactSetID {
	const canonical = members
		.map((member) => ({ artifactID: member.artifactID, role: member.role, schemaVersion: member.schemaVersion }))
		.toSorted((a, b) => (a.artifactID < b.artifactID ? -1 : a.artifactID > b.artifactID ? 1 : 0))

	return `set-sha256:${sha256Hex(canonicalJSON(canonical))}`
}

/**
 * Every way a set disagrees with the manifests of its members, or an empty list.
 *
 * A set is incompatible when a member is missing or duplicated, when a member's role
 * or schema version differs from its manifest, when street-keyed members were normalized
 * differently, or when its identity is not the digest of its members.
 */
export function artifactSetProblems(set: ArtifactSetManifest, manifests: readonly ArtifactManifest[]): string[] {
	const problems: string[] = []

	if (!set.members.length) return ["the set has no members"]

	const byID = new Map(manifests.map((manifest) => [manifest.id, manifest]))
	const seen = new Set<string>()
	const normalized: ArtifactManifest[] = []

	for (const member of set.members) {
		if (seen.has(member.artifactID)) {
			problems.push(`member ${member.artifactID} is listed twice`)

			continue
		}

		seen.add(member.artifactID)

		const manifest = byID.get(member.artifactID)

		if (!manifest) {
			problems.push(`member ${member.artifactID} has no manifest`)

			continue
		}

		if (manifest.role !== member.role) {
			problems.push(`member ${member.artifactID} is listed as ${member.role} and its manifest says ${manifest.role}`)
		}

		if (manifest.schemaVersion !== member.schemaVersion) {
			problems.push(
				`member ${member.artifactID} is listed at schema ${member.schemaVersion} and its manifest says ${manifest.schemaVersion}`
			)
		}

		if (manifest.normalization) {
			normalized.push(manifest)
		}
	}

	const [first, ...rest] = normalized

	for (const other of rest) {
		if (
			first &&
			other.normalization &&
			first.normalization &&
			!sameNormalization(first.normalization, other.normalization)
		) {
			problems.push(
				`members ${first.id} and ${other.id} key streets differently ` +
					`(${stringifyJSON(first.normalization)} and ${stringifyJSON(other.normalization)})`
			)
		}
	}

	const expected = artifactSetID(set.members)

	if (set.id !== expected) {
		problems.push(`set id ${set.id} is not the digest of its members, ${expected}`)
	}

	return problems
}

/**
 * Throws unless a set agrees with its members' manifests.
 *
 * @throws {@link ArtifactManifestError} listing every disagreement.
 */
export function assertArtifactSet(set: ArtifactSetManifest, manifests: readonly ArtifactManifest[]): void {
	const problems = artifactSetProblems(set, manifests)

	if (problems.length) throw new ArtifactManifestError(`artifact set ${set.id}`, problems)
}

/**
 * What a reader of one role opens, so an installation can refuse an artifact before activating it.
 */
export interface ReaderCompatibility {
	role: ServingRole
	schemaVersions: readonly number[]
	/**
	 * The normalizations the reader keys queries with.
	 * Empty for a role that keys no street.
	 */
	normalizations: readonly NormalizationIdentity[]
}

/**
 * Why a reader cannot open an artifact, or `null` when it can.
 *
 * An unsupported normalization is refused rather than replaced by a default.
 */
export function readerIncompatibility(manifest: ArtifactManifest, reader: ReaderCompatibility): string | null {
	if (manifest.role !== reader.role) return `the reader opens ${reader.role}, not ${manifest.role}`

	if (!reader.schemaVersions.includes(manifest.schemaVersion)) {
		return `schema ${manifest.schemaVersion} is unsupported; the reader opens ${reader.schemaVersions.join(", ")}`
	}

	const normalization = manifest.normalization

	if (normalization && !reader.normalizations.some((supported) => sameNormalization(supported, normalization))) {
		return `normalization ${stringifyJSON(normalization)} is unsupported by the reader`
	}

	return null
}
