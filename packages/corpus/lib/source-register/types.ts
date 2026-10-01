/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module defines the address-source register's types. The register has a jurisdiction table and a source table.
 */

import type { AssertedProposition } from "@mailwoman/evidence/status"

import type { AddressRole } from "#types"

/**
 * The research state of a jurisdiction's premise-address backbone.
 *
 * The letters match the global address corpus specification and are separate
 * from locale tiers and layer tiers.
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
	 * An official address system exists.
	 *
	 * Bulk access, openness, coverage or redistribution rights are incomplete.
	 */
	Restricted: "B",
	/**
	 * The research pass found no permissive nationwide premise corpus.
	 * One may still exist.
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
	 * Its address fields, bulk access and terms have no review record.
	 */
	VerifiedAuthority: "verified-authority",
	/**
	 * A row retained from the earlier memo without a recheck.
	 * These rows lack a publisher and a URL.
	 */
	RetainedOriginal: "retained-original",
	/**
	 * Research confirmed that a bulk corpus is reachable.
	 *
	 * This state by itself does not make a source eligible for ingest.
	 */
	VerifiedCorpus: "verified-corpus",
	/**
	 * A bulk corpus is reachable but the examined copy is no longer updated.
	 *
	 * The row points to the national portal instead.
	 * This state differs from `VerifiedCorpus` so a filter for reachable corpora excludes it.
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
 * Whether a source provides coordinates; `Unresolved` differs from `Absent`.
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
	 * The source has no coordinate review record.
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
	/**
	 * The rights review that read each candidate publisher's own terms.
	 *
	 * The pass rewrites a row when reading the publisher settles something the earlier pass
	 * recorded wrongly, such as a row naming two publishers or a URL that now answers 404.
	 */
	RightsReview: "2026-09-30-rights-review",
} as const

/**
 * One of the {@link ResearchPass} values.
 */
export type ResearchPass = (typeof ResearchPass)[keyof typeof ResearchPass]

/**
 * The review state of a source's terms.
 *
 * An `unchecked` source cannot enter a training build because its recorded label describes only access cost.
 */
export const LicenseReviewState = {
	/**
	 * The publisher's terms have no review record.
	 *
	 * The research pass's license text is kept verbatim in
	 * {@linkcode UncheckedLicense.publisherStatement} and grants no license.
	 */
	Unchecked: "unchecked",
	/**
	 * A reviewer read the terms, elected one grant, retrieved a copy and recorded the reason.
	 */
	Elected: "elected",
	/**
	 * A reviewer read the terms and rejected the source.
	 * The row records the reason.
	 */
	Refused: "refused",
} as const

/**
 * One of the {@link LicenseReviewState} values.
 */
export type LicenseReviewState = (typeof LicenseReviewState)[keyof typeof LicenseReviewState]

/**
 * A license decision whose terms have no review record.
 */
export interface UncheckedLicense {
	licenseID: string
	state: typeof LicenseReviewState.Unchecked
	/**
	 * The research pass's license text, verbatim.
	 *
	 * Most values are access labels such as `Free` or `Licensed` that make no
	 * statement about redistribution or training.
	 */
	publisherStatement: string
	note: string
}

/**
 * The acts this repository performs on a source, in pipeline order.
 *
 * A grant can permit some and stay silent on others, so license decisions record a permission per operation.
 */
export const SourceOperation = {
	/**
	 * Bulk copy of the published dataset into `$MAILWOMAN_DATA_ROOT`.
	 */
	Fetch: "fetch",
	/**
	 * Postal-address extraction from the copied file.
	 */
	Extract: "extract",
	/**
	 * Transformation of extracted rows into a token and tag corpus.
	 */
	Transform: "transform",
	/**
	 * Model fitting on the transformed rows.
	 */
	Train: "train",
	/**
	 * Redistribution of raw or transformed rows as a database, lexicon or index.
	 */
	RedistributeData: "redistribute-data",
	/**
	 * Redistribution of weights trained on the rows.
	 */
	RedistributeModel: "redistribute-model",
	/**
	 * Commercial sublicensing of the result.
	 */
	CommercialSublicense: "commercial-sublicense",
} as const

/**
 * One of the {@link SourceOperation} values.
 */
export type SourceOperation = (typeof SourceOperation)[keyof typeof SourceOperation]

/**
 * What a grant permits for one operation.
 *
 * `unreviewed` means the terms lack an operation-specific review.
 * Eligibility checks treat it as blocking.
 * The state stays distinct from `refused`.
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
 * Most permissions rest on a publisher grant.
 * The other values mark permissions with a different basis.
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
	 * The audit requires a permission basis when the permission is `permitted`.
	 */
	basis?: PermissionBasis
	/**
	 * The relevant sentence in the terms, or the reason for a refusal.
	 */
	because: string
}

/**
 * A license decision whose terms a reviewer read and under which one grant was elected.
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
	 * The research pass's free-text list of propositions it expected sources to support.
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
 * What a review found about personal data in one publication, a question separate from licensing.
 *
 * `Present` blocks ingest.
 * A source without a review is also blocked.
 */
export const PersonalDataReading = {
	/**
	 * A review found no record about an identified or identifiable natural person.
	 */
	Absent: "absent",
	/**
	 * A review found such records.
	 * Analysis remains incomplete.
	 */
	Present: "present",
	/**
	 * A review found such records. {@link PersonalDataReview.record} points to the completed analysis.
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
	because: string
	/**
	 * The audit requires the completed analysis location when the reading is `assessed`.
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
	 */
	asserts: readonly AssertedProposition[]
	/**
	 * The research pass's reason for treating the publisher as authoritative.
	 */
	authorityBasis: string
	/**
	 * Free text on how the data is reached, such as a bulk CSV, an API or a portal search.
	 *
	 * Research may have recorded no route even when the data is reachable.
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
	 * The role each of the source's address columns carries, keyed by that
	 * column's path in the published record.
	 *
	 * A source is ineligible for ingest until at least one column has a role.
	 * One role per source cannot describe a publication that carries two roles on one record:
	 * AusTender's OCDS release gives a supplier address and a procuring-entity address on
	 * every contracting process, and Taiwan's GCIS register gives a registered company address
	 * and a tax-office business address in separate columns.
	 *
	 * A source whose every address carries one role records one entry keyed by the field that holds it.
	 */
	addressRoles?: Readonly<Record<string, AddressRole>>
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
	/**
	 * The id of the corpus adapter that emits this source's rows.
	 *
	 * A corpus row carries its adapter's id in `source` and its jurisdiction in `country`,
	 * and the register scopes a source to one publisher in one jurisdiction,
	 * so that pair addresses one record here.
	 * One adapter can serve several records: the `ban` reader emits eleven jurisdictions
	 * from one schema, and each is its own source under its own license decision.
	 *
	 * A source that declares no adapter produces no rows, so a build sees zero rows
	 * under it and has none to admit or refuse.
	 * Declaring one is what lets `readSourceEligibility` answer for a row at all.
	 */
	adapterID?: string
}

/**
 * Source fields that no row resolves yet.
 *
 * The audit checks both directions.
 * A listed field must be absent from every row.
 * An unlisted field must appear on at least one row.
 */
export const UNRESOLVED_FIELDS = ["addressRoles", "upstreamLineage", "coverage", "personalDataReview"] as const

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
	 * The build writes the SHA-256 digest of every other field.
	 *
	 * The research inputs are not committed, so this is the only way to detect
	 * a hand edit to the generated file.
	 */
	contentDigest: string
	provenance: RegisterProvenance
	unresolved: readonly UnresolvedField[]
	licenses: readonly LicenseDecision[]
	jurisdictions: readonly JurisdictionRecord[]
	sources: readonly AddressSourceRecord[]
}
