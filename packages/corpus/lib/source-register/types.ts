/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the address-source register, which holds a jurisdiction table and a separate source table.
 */

import type { AssertedProposition } from "@mailwoman/evidence/status"

import type { AddressRole } from "#types"

/**
 * The research state of a jurisdiction's premise-address backbone.
 *
 * The letters match the global address corpus specification.
 * These states are separate from locale tiers and layer tiers.
 */
export const BackboneState = {
	/**
	 * A verified open nationwide, or effectively nationwide, official premise-address
	 * source, subject to its own terms.
	 */
	Verified: "A",
	/**
	 * A strong open official source that is federated, partial, establishment-only
	 * or territory-specific, or whose national completeness has not been measured.
	 */
	VerifiedPartial: "A~",
	/**
	 * An official address system exists, and bulk access, openness, coverage
	 * or redistribution rights are incomplete.
	 */
	Restricted: "B",
	/**
	 * The research pass verified no permissive nationwide premise corpus.
	 *
	 * Such a corpus may still exist.
	 */
	Unverified: "C",
	/**
	 * A jurisdiction where routing and hand-verified grammar outweigh an ordinary street hierarchy.
	 */
	Exceptional: "D",
} as const

/**
 * One of the {@link BackboneState} values.
 */
export type BackboneState = (typeof BackboneState)[keyof typeof BackboneState]

/**
 * What the research pass did for a jurisdiction.
 *
 * An `exception` records that someone looked and found no ordinary register.
 * An `unexamined` row records that nobody has looked yet.
 */
export const JurisdictionResearchState = {
	/**
	 * Research resolved at least one national source, so the jurisdiction must have source rows.
	 */
	Seeded: "seeded",
	/**
	 * No ordinary national registry exists, as in an uninhabited territory or a treaty area.
	 *
	 * The row records the reason.
	 */
	Exception: "exception",
	/**
	 * Research has neither resolved a source nor ruled one out.
	 *
	 * The row records the reason.
	 */
	Unexamined: "unexamined",
} as const

/**
 * One of the {@link JurisdictionResearchState} values.
 */
export type JurisdictionResearchState = (typeof JurisdictionResearchState)[keyof typeof JurisdictionResearchState]

/**
 * How far this repository's review of one source has progressed.
 */
export const SourceStatus = {
	/**
	 * Research confirmed that the register exists and is the national authority.
	 *
	 * Nobody has inspected its address fields, bulk access or terms.
	 */
	VerifiedAuthority: "verified-authority",
	/**
	 * The row was carried forward from the earlier memo without a recheck.
	 *
	 * These rows lack a publisher and a URL.
	 */
	RetainedOriginal: "retained-original",
	/**
	 * Research confirmed that a bulk corpus is reachable.
	 *
	 * This state alone does not make a source eligible for ingest.
	 */
	VerifiedCorpus: "verified-corpus",
	/**
	 * A bulk corpus is reachable, but the examined copy is no longer updated.
	 *
	 * The row points to the national portal to inspect instead.
	 * The state is separate from `VerifiedCorpus` so that a filter for reachable corpora excludes it.
	 */
	VerifiedCorpusStale: "verified-corpus-stale",
} as const

/**
 * One of the {@link SourceStatus} values.
 */
export type SourceStatus = (typeof SourceStatus)[keyof typeof SourceStatus]

/**
 * The closed list of sectors that source rows may use.
 *
 * The audit rejects a row with any other sector.
 */
export const REGISTER_SECTORS = [
	"business-legal",
	"business-register",
	"charity-nonprofit",
	"education",
	"environment-industry",
	"finance",
	"food-pharma",
	"health",
	"mixed-regulatory",
	"procurement-grants",
	"professional-licensing",
	"property-building",
	"public-administration",
	"telecom",
	"transport",
] as const

/**
 * One of the {@link REGISTER_SECTORS}.
 */
export type RegisterSector = (typeof REGISTER_SECTORS)[number]

/**
 * Whether a source carries coordinates.
 *
 * `Unresolved` means nobody has checked, which differs from `Absent`.
 */
export const SourceGeometry = {
	Present: "present",
	/**
	 * A reviewer checked and found no coordinates.
	 */
	Absent: "absent",
	/**
	 * A reviewer checked and found coordinates on some records.
	 */
	Partial: "partial",
	/**
	 * Nobody has checked the source for coordinates.
	 */
	Unresolved: "unresolved",
} as const

/**
 * One of the {@link SourceGeometry} values.
 */
export type SourceGeometry = (typeof SourceGeometry)[keyof typeof SourceGeometry]

/**
 * The research pass that added a row to the table.
 *
 * A `retained-original` row has no other provenance.
 */
export const ResearchPass = {
	WebResearch: "2026-09-18-web-research",
	OriginalMemo: "original-memo",
} as const

/**
 * One of the {@link ResearchPass} values.
 */
export type ResearchPass = (typeof ResearchPass)[keyof typeof ResearchPass]

/**
 * The review state of a source's terms.
 *
 * An `unchecked` source cannot enter a training build, because its recorded
 * label describes only access cost.
 */
export const LicenseReviewState = {
	/**
	 * Nobody has read the publisher's terms.
	 *
	 * The research pass's license text is kept verbatim in
	 * {@linkcode UncheckedLicense.publisherStatement} and grants nothing.
	 */
	Unchecked: "unchecked",
	/**
	 * A reviewer read the terms, elected one grant, retrieved a copy and recorded the reason.
	 */
	Elected: "elected",
	/**
	 * A reviewer read the terms and ruled the source out, and the row records the reason.
	 */
	Refused: "refused",
} as const

/**
 * One of the {@link LicenseReviewState} values.
 */
export type LicenseReviewState = (typeof LicenseReviewState)[keyof typeof LicenseReviewState]

/**
 * A license decision whose terms nobody has read.
 */
export interface UncheckedLicense {
	licenseID: string
	state: typeof LicenseReviewState.Unchecked
	/**
	 * The research pass's license text, verbatim.
	 *
	 * Most values are access labels such as `Free` or `Licensed`, which say nothing
	 * about redistribution or training.
	 */
	publisherStatement: string
	note: string
}

/**
 * The acts that this repository performs on a source, in pipeline order.
 *
 * A grant can permit some acts and stay silent on others, so license decisions
 * record a permission per operation.
 */
export const SourceOperation = {
	/**
	 * Copying the published dataset in bulk into `$MAILWOMAN_DATA_ROOT`.
	 */
	Fetch: "fetch",
	/**
	 * Reading postal addresses out of the copied file.
	 */
	Extract: "extract",
	/**
	 * Relabeling extracted rows into a token and tag corpus.
	 */
	Transform: "transform",
	/**
	 * Training a model on the transformed rows.
	 */
	Train: "train",
	/**
	 * Republishing the rows, raw or transformed, as a database, lexicon or index.
	 */
	RedistributeData: "redistribute-data",
	/**
	 * Publishing weights trained on the rows.
	 */
	RedistributeModel: "redistribute-model",
	/**
	 * Selling a commercial license over the result.
	 */
	CommercialSublicense: "commercial-sublicense",
} as const

/**
 * One of the {@link SourceOperation} values.
 */
export type SourceOperation = (typeof SourceOperation)[keyof typeof SourceOperation]

/**
 * What a grant says about one operation.
 *
 * `Unreviewed` means that nobody has read the terms against the operation.
 * Eligibility checks treat it as blocking, and it stays distinct from `Refused`.
 */
export const OperationPermission = {
	Permitted: "permitted",
	Refused: "refused",
	Unreviewed: "unreviewed",
} as const

/**
 * One of the {@link OperationPermission} values.
 */
export type OperationPermission = (typeof OperationPermission)[keyof typeof OperationPermission]

/**
 * The legal basis of a permission.
 *
 * Most permissions rest on a publisher grant, and the other values mark permissions that rest elsewhere.
 */
export const PermissionBasis = {
	PublisherGrant: "publisher-grant",
	StatutoryException: "statutory-exception",
	OtherDocumented: "other-documented",
} as const

/**
 * One of the {@link PermissionBasis} values.
 */
export type PermissionBasis = (typeof PermissionBasis)[keyof typeof PermissionBasis]

/**
 * The permission recorded for one operation, with its basis and reason.
 */
export interface OperationDecision {
	permission: OperationPermission
	/**
	 * The basis of the permission, which the audit requires when the permission is `permitted`.
	 */
	basis?: PermissionBasis
	/**
	 * The relevant sentence in the terms, or the reason for a refusal.
	 */
	because: string
}

/**
 * A license decision whose terms a reviewer read and under which one grant was elected.
 *
 * A dual-licensed source such as BAN needs an election between its grants.
 */
export interface ElectedLicense {
	licenseID: string
	state: typeof LicenseReviewState.Elected
	/**
	 * The elected terms as the publisher names them, such as `Licence Ouverte 2.0`.
	 */
	electedTerms: string
	/**
	 * The SPDX identifier, when one applies.
	 *
	 * `electedLicenseLabel` prefers this value to {@linkcode ElectedLicense.electedTerms}.
	 */
	spdx?: string
	termsVersion?: string
	/**
	 * The location of the retrieved copy of the terms, so later reviewers read the same text.
	 */
	retrievedCopy: string
	retrievedAt?: string
	/**
	 * The reason for electing this grant, or a note that the source offers only one.
	 */
	electedBecause: string
	/**
	 * The permission for each reviewed operation.
	 *
	 * An omitted operation reads as `unreviewed`.
	 */
	operations?: Partial<Record<SourceOperation, OperationDecision>>
}

/**
 * A license decision whose terms a reviewer read and refused.
 */
export interface RefusedLicense {
	licenseID: string
	state: typeof LicenseReviewState.Refused
	publisherStatement?: string
	refusedBecause: string
}

/**
 * A license decision in any review state.
 */
export type LicenseDecision = UncheckedLicense | ElectedLicense | RefusedLicense

/**
 * One jurisdiction row.
 *
 * The table holds a row for every jurisdiction whether or not research has found a source.
 */
export interface JurisdictionRecord {
	/**
	 * The ISO 3166-1 alpha-2 code, or the operational code `XK`.
	 */
	iso2: string
	name: string
	backboneState: BackboneState
	researchState: JurisdictionResearchState
	/**
	 * The research pass's note on the best known route to an address backbone.
	 */
	bestPath: string
	/**
	 * The research pass's free-text list of propositions it expected sources to carry.
	 *
	 * The text is kept verbatim because it does not map onto the `AssertedProposition` vocabulary.
	 */
	assertionPlan: string
	note: string
	/**
	 * The reason a jurisdiction has no sources.
	 *
	 * The audit requires it on every row that is not `seeded`.
	 */
	stateReason?: string
}

/**
 * What a review found about personal data in one publication.
 *
 * This question is separate from licensing.
 * For example, the French SIRENE register lists sole traders, whose business address is a personal address.
 *
 * Only `Present` blocks ingest.
 * A source without any review is also blocked.
 */
export const PersonalDataReading = {
	/**
	 * A review found no record about an identified or identifiable natural person.
	 */
	Absent: "absent",
	/**
	 * A review found such records, and no analysis of them is complete.
	 */
	Present: "present",
	/**
	 * A review found such records, and {@link PersonalDataReview.record} points to the completed analysis.
	 */
	Assessed: "assessed",
} as const

/**
 * One of the {@link PersonalDataReading} values.
 */
export type PersonalDataReading = (typeof PersonalDataReading)[keyof typeof PersonalDataReading]

/**
 * One publication's personal-data review.
 */
export interface PersonalDataReview {
	reading: PersonalDataReading
	/**
	 * The reviewer's reason for the reading.
	 */
	because: string
	/**
	 * The location of the completed analysis, which the audit requires when the reading is `assessed`.
	 */
	record?: string
}

/**
 * One address source in one sector of one jurisdiction.
 */
export interface AddressSourceRecord {
	/**
	 * The id `<lowercase iso2>-<sector>-<n>`, which stays stable across rebuilds.
	 */
	sourceID: string
	iso2: string
	sector: RegisterSector
	name: string
	status: SourceStatus
	/**
	 * The `@mailwoman/evidence` propositions that this source asserts.
	 *
	 * A company register that issues identifiers and receives addresses carries `["identity", "observation"]`.
	 */
	asserts: readonly AssertedProposition[]
	/**
	 * The research pass's reason for treating the publisher as authoritative.
	 */
	authorityBasis: string
	/**
	 * Free text on how the data is reached, such as a bulk CSV, an API or a portal search.
	 *
	 * An absent value means that research recorded no route, and the data may still be reachable.
	 */
	access?: string
	geometry: SourceGeometry
	/**
	 * The `licenseID` of a decision in the register's `licenses` table.
	 */
	license: string
	researchPass: ResearchPass
	publisher?: string
	sourceURL?: string
	note?: string
	/**
	 * The role that the source's addresses play, such as a registered seat or a premise.
	 *
	 * A source is ineligible for ingest until this is set.
	 */
	addressRole?: AddressRole
	/**
	 * The upstream sources that this source copies from, where known.
	 *
	 * Two databases that copy one upstream record count as one observation.
	 */
	upstreamLineage?: readonly string[]
	/**
	 * A measured coverage statement.
	 */
	coverage?: string
	/**
	 * The personal-data review of this publication.
	 *
	 * A source without a review is ineligible for ingest.
	 */
	personalDataReview?: PersonalDataReview
}

/**
 * Source fields that no row resolves yet.
 *
 * The audit checks both directions: a listed field must be absent from every row,
 * and an unlisted field must be present on at least one row.
 */
export const UNRESOLVED_FIELDS = ["addressRole", "upstreamLineage", "coverage", "personalDataReview"] as const

/**
 * One of the {@link UNRESOLVED_FIELDS}.
 */
export type UnresolvedField = (typeof UNRESOLVED_FIELDS)[number]

/**
 * The origin of the register's research data.
 */
export interface RegisterProvenance {
	source: string
	sourceVersion?: string
	/**
	 * An ISO 8601 calendar date in the form `YYYY-MM-DD`.
	 */
	authoredAt?: string
	notes?: string
}

/**
 * The committed address-source register.
 */
export interface AddressSourceRegister {
	registerID: string
	version: string
	/**
	 * The SHA-256 digest of every other field, which the build writes.
	 *
	 * The research inputs are not committed, so this digest is the only way to
	 * detect a hand edit to the generated file.
	 * Change values by rerunning the build.
	 */
	contentDigest: string
	provenance: RegisterProvenance
	unresolved: readonly UnresolvedField[]
	licenses: readonly LicenseDecision[]
	jurisdictions: readonly JurisdictionRecord[]
	sources: readonly AddressSourceRecord[]
}
