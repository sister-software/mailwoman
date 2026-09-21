/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the address-source register — the reviewed table of jurisdictions and the address sources research has
 *   resolved for each.
 *
 *   Two tables, each keyed differently. The jurisdiction table is a complete enumeration: one row per ISO 3166-1
 *   alpha-2 code plus the operational code `XK`, always 250 rows, whether or not anybody has found a source. The
 *   source table is zero or more rows per jurisdiction. Nesting the second inside the first would make a jurisdiction
 *   nobody has researched structurally identical to one whose list happens to be empty, and the reader would have to
 *   guess which it was looking at. A jurisdiction row states `researchState` instead, so "nobody has looked yet" is
 *   written down rather than inferred from an empty array — the rule in
 *   `docs/engineering/reference/the-meaning-of-zero.mdx`.
 *
 *   Splitting them also gives the audit something to check in both directions: every source names a jurisdiction the
 *   register carries, and every jurisdiction it calls `seeded` has at least one source. Under a nested list the
 *   second check cannot fail.
 */

import type { AssertedProposition } from "@mailwoman/evidence/status"

import type { AddressRole } from "#types"

/**
 * How far research has got on a jurisdiction's own premise-address backbone.
 *
 * Each value records a position in the backlog, and the letters are the ones the
 * global address corpus specification uses in its own prose, so a reader can move
 * between the two without a translation table.
 * They are deliberately not called a tier: this repository already has locale tiers 1 through
 * 5 in `scope.config.json` and the `shipped` / `build-local` / `private` tiers in the layer
 * interface, and a third single-letter ladder under that name would be read as one of those two.
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
	 * An official address system exists, and bulk access, openness, coverage or redistribution rights are incomplete.
	 */
	Restricted: "B",
	/**
	 * No permissive nationwide premise corpus was verified in this pass.
	 *
	 * It never means none exists.
	 */
	Unverified: "C",
	/**
	 * An exceptional jurisdiction where routing and hand-verified grammar dominate
	 * over an ordinary street hierarchy.
	 */
	Exceptional: "D",
} as const

export type BackboneState = (typeof BackboneState)[keyof typeof BackboneState]

/**
 * What the functional-authority research pass did about a jurisdiction, kept separate from what it found.
 *
 * The three are not degrees of the same thing.
 * `exception` is a researched absence — somebody looked and recorded that no
 * ordinary register exists, which is a finding.
 *
 * `unexamined` is no reading at all.
 * Collapsing them would let a consumer read "we could not look" as "there is nothing there".
 */
export const JurisdictionResearchState = {
	/**
	 * At least one national source was resolved.
	 *
	 * The jurisdiction must have source rows.
	 */
	Seeded: "seeded",
	/**
	 * No ordinary national registry exists to resolve — an uninhabited territory,
	 * a treaty area, a defence installation.
	 *
	 * The reason is recorded on the row.
	 */
	Exception: "exception",
	/**
	 * Nothing has been resolved and nothing has been ruled out.
	 *
	 * The reason is recorded on the row.
	 */
	Unexamined: "unexamined",
} as const

export type JurisdictionResearchState = (typeof JurisdictionResearchState)[keyof typeof JurisdictionResearchState]

/**
 * How far one source has been taken.
 *
 * Every value here is a statement about OUR reading of the source, never about the publisher's competence.
 */
export const SourceStatus = {
	/**
	 * The register was confirmed to exist and be the national authority.
	 *
	 * Its address fields, bulk access and terms were not inspected.
	 */
	VerifiedAuthority: "verified-authority",
	/**
	 * Carried forward from the earlier memo without recheck.
	 *
	 * These rows have no publisher and no URL, so a reader cannot visit them.
	 * Re-resolving one is what moves it out of this state.
	 */
	RetainedOriginal: "retained-original",
	/**
	 * A bulk corpus was confirmed reachable.
	 *
	 * This is the strongest state in the table and still not ingest-eligible on its own —
	 * see {@linkcode AddressSourceRegister} and the eligibility reasons the reader reports.
	 */
	VerifiedCorpus: "verified-corpus",
	/**
	 * A bulk corpus was reachable and the copy examined has stopped being updated.
	 *
	 * The row names the national portal to inspect instead, and reading it gets you
	 * a corpus frozen at the date the aggregator stopped.
	 * It is its own state rather than a note on {@linkcode SourceStatus.VerifiedCorpus}
	 * because a consumer filtering for a reachable corpus would otherwise take it.
	 */
	VerifiedCorpusStale: "verified-corpus-stale",
} as const

export type SourceStatus = (typeof SourceStatus)[keyof typeof SourceStatus]

/**
 * The sectors the research pass worked in.
 *
 * Closed so that adding one is an edit somebody makes on purpose.
 * The audit refuses a row naming anything else.
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

export type RegisterSector = (typeof REGISTER_SECTORS)[number]

/**
 * Whether the source carries coordinates, with the unread case named rather than folded into `absent`.
 */
export const SourceGeometry = {
	Present: "present",
	/**
	 * Read, and there are no coordinates.
	 */
	Absent: "absent",
	/**
	 * Read, and some records carry coordinates.
	 */
	Partial: "partial",
	/**
	 * Not read.
	 *
	 * Not the same claim as `absent`.
	 */
	Unresolved: "unresolved",
} as const

export type SourceGeometry = (typeof SourceGeometry)[keyof typeof SourceGeometry]

/**
 * Which research pass put a row in the table.
 *
 * It is the coarsest provenance the pass recorded, and for a `retained-original`
 * row it is the only one there is.
 */
export const ResearchPass = {
	WebResearch: "2026-09-18-web-research",
	OriginalMemo: "original-memo",
} as const

export type ResearchPass = (typeof ResearchPass)[keyof typeof ResearchPass]

/**
 * What has been established about a source's terms.
 *
 * `unchecked` is a first-class value and the one every row carries today: a source whose
 * terms nobody opened is a different record from one that was read and found permissive,
 * and a type that could not tell them apart would let an unread source into a training
 * build on a label that only ever described what the download costs.
 */
export const LicenseReviewState = {
	/**
	 * Nobody opened the publisher's terms.
	 *
	 * Whatever the research pass wrote in the licence column is carried verbatim as
	 * {@linkcode UncheckedLicense.publisherStatement} and licenses nothing.
	 */
	Unchecked: "unchecked",
	/**
	 * The terms were read and one grant elected, with the copy retrieved and the reason recorded.
	 */
	Elected: "elected",
	/**
	 * The terms were read and the source may not be used here.
	 *
	 * The reason is recorded so the decision is not retaken by the next reader.
	 */
	Refused: "refused",
} as const

export type LicenseReviewState = (typeof LicenseReviewState)[keyof typeof LicenseReviewState]

/**
 * A source whose terms have not been read.
 */
export interface UncheckedLicense {
	licenseID: string
	state: typeof LicenseReviewState.Unchecked
	/**
	 * What the research pass wrote down, verbatim.
	 *
	 * Most of these are access labels — `Free`, `Free-reg`, `Licensed` — which say what
	 * the download costs and nothing about redistribution or training rights.
	 */
	publisherStatement: string
	note: string
}

/**
 * The acts this repository performs on a source, each of which a grant permits or does not.
 *
 * One `license` field answers all of them at once, and a grant rarely does.
 * A publisher may permit copying its file and say nothing about redistributing a model trained on it.
 *
 * Another may permit non-commercial reuse, which covers training and refuses
 * the commercial license sold over the result.
 * Recording one decision per source makes the narrowest of those the answer for every act, or the widest.
 *
 * Which of the two it made is invisible in the record.
 *
 * The list is the acts named in the license review, in the order a row moves through them.
 */
export const SourceOperation = {
	/**
	 * Bulk copy the published dataset into `$MAILWOMAN_DATA_ROOT`.
	 */
	Fetch: "fetch",
	/**
	 * Read postal addresses out of the copied file.
	 */
	Extract: "extract",
	/**
	 * Relabel extracted rows into a token and tag corpus.
	 */
	Transform: "transform",
	/**
	 * Train a statistical model on the transformed rows.
	 */
	Train: "train",
	/**
	 * Republish the rows themselves, raw or transformed — a packaged database, a lexicon, an index.
	 */
	RedistributeData: "redistribute-data",
	/**
	 * Publish weights trained on the rows.
	 */
	RedistributeModel: "redistribute-model",
	/**
	 * Sell a commercial license over the result.
	 */
	CommercialSublicense: "commercial-sublicense",
} as const

export type SourceOperation = (typeof SourceOperation)[keyof typeof SourceOperation]

/**
 * What a grant says about one operation.
 *
 * `Unreviewed` is the default for an operation a decision does not name, and it is not
 * a synonym for refused: it says nobody has read the terms against this act.
 * A control refuses on it, and a reviewer can tell it apart from a term somebody read and rejected.
 */
export const OperationPermission = {
	Permitted: "permitted",
	Refused: "refused",
	Unreviewed: "unreviewed",
} as const

export type OperationPermission = (typeof OperationPermission)[keyof typeof OperationPermission]

/**
 * Where a permission comes from.
 *
 * A grant is the ordinary case.
 * The other two exist so a permission resting on something other than the publisher's
 * own words says so rather than reading as one.
 */
export const PermissionBasis = {
	PublisherGrant: "publisher-grant",
	StatutoryException: "statutory-exception",
	OtherDocumented: "other-documented",
} as const

export type PermissionBasis = (typeof PermissionBasis)[keyof typeof PermissionBasis]

/**
 * One operation's reading, with what it rests on.
 */
export interface OperationDecision {
	permission: OperationPermission
	/**
	 * Required when the permission is `permitted`.
	 *
	 * A permission with no stated basis is a claim with no source.
	 */
	basis?: PermissionBasis
	/**
	 * The sentence in the terms, or the reason for a refusal.
	 *
	 * Read by a later reviewer rather than re-derived.
	 */
	because: string
}

/**
 * A source whose terms were read and one grant elected.
 *
 * The four required fields are what the corpus acceptance rules ask for: which terms, the copy they
 * were read from, their version where the publisher gives one, and why this grant rather than another.
 * BAN is the case that shaped it — dual-licensed, and the build elects the attribution-only half.
 */
export interface ElectedLicense {
	licenseID: string
	state: typeof LicenseReviewState.Elected
	/**
	 * The elected terms as the publisher names them, e.g. `Licence Ouverte 2.0`.
	 */
	electedTerms: string
	/**
	 * An spdx identifier when one applies.
	 *
	 * The mechanical exclude filter reads this in preference to
	 * {@linkcode ElectedLicense.electedTerms}; see `electedLicenseLabel`.
	 */
	spdx?: string
	termsVersion?: string
	/**
	 * Where the copy that was read is held, so a later reader checks the same text rather than today's page.
	 */
	retrievedCopy: string
	retrievedAt?: string
	/**
	 * Why this grant.
	 *
	 * A dual-licensed source has an election to explain.
	 * A single-grant source says so here.
	 */
	electedBecause: string
	/**
	 * What the elected terms permit, per operation.
	 *
	 * An operation this omits reads `unreviewed`, never `permitted`.
	 *
	 * Electing terms establishes which grant applies rather than what every act under it is allowed.
	 * A publisher permitting bulk download and silent on model redistribution has one elected grant
	 * and two different answers, and the omission is the honest record of the second.
	 */
	operations?: Partial<Record<SourceOperation, OperationDecision>>
}

/**
 * A source whose terms were read and refused.
 */
export interface RefusedLicense {
	licenseID: string
	state: typeof LicenseReviewState.Refused
	publisherStatement?: string
	refusedBecause: string
}

export type LicenseDecision = UncheckedLicense | ElectedLicense | RefusedLicense

/**
 * One jurisdiction.
 *
 * Present for all 250 whether or not any source has been resolved.
 */
export interface JurisdictionRecord {
	/**
	 * ISO 3166-1 alpha-2, plus `XK`, which is operational rather than ISO
	 * and carries no claim about sovereignty.
	 */
	iso2: string
	name: string
	backboneState: BackboneState
	researchState: JurisdictionResearchState
	/**
	 * The best path currently known to an address backbone for this jurisdiction,
	 * as the research pass wrote it.
	 */
	bestPath: string
	/**
	 * The propositions the pass expected this jurisdiction's sources to carry, in its own prose.
	 *
	 * It is not the `AssertedProposition` vocabulary — it uses wider words such as
	 * `admin` and `global geometry` — and is carried verbatim rather than mapped,
	 * because mapping it would invent precision the pass did not have.
	 */
	assertionPlan: string
	note: string
	/**
	 * Why a jurisdiction has no sources.
	 *
	 * Required on every row that is not `seeded`, so an empty result always carries its
	 * own explanation, and refused by the audit when it is missing.
	 */
	stateReason?: string
}

/**
 * One address source, in one sector, in one jurisdiction.
 */
/**
 * What a review found about personal data in one publication.
 *
 * A license decision answers whether the publisher permits an act.
 * It says nothing about whether the records are about identifiable people, which is a separate
 * question governed by a different body of law and reached through a different analysis.
 *
 * Several candidate registers carry both: the French SIRENE enterprise register publishes
 * sole traders, where the business address is a natural person's address.
 *
 * `Present` is the reading that blocks.
 * `Absent` and `Assessed` admit a source, and the three stay apart because a publication
 * nobody has looked at must not read the same as one somebody read and found clear.
 */
export const PersonalDataReading = {
	/**
	 * A review found no record about an identified or identifiable natural person.
	 */
	Absent: "absent",
	/**
	 * A review found such records and no analysis of them is complete.
	 */
	Present: "present",
	/**
	 * Such records are present and an analysis of them is recorded,
	 * which {@link PersonalDataReview.record} names.
	 */
	Assessed: "assessed",
} as const

export type PersonalDataReading = (typeof PersonalDataReading)[keyof typeof PersonalDataReading]

/**
 * One publication's personal-data review.
 */
export interface PersonalDataReview {
	reading: PersonalDataReading
	/**
	 * What the reading rests on, in the reviewer's words.
	 *
	 * Read by a later reviewer rather than re-derived.
	 */
	because: string
	/**
	 * Where the completed analysis is recorded.
	 *
	 * Required when the reading is `assessed`, because an assessment nobody can
	 * open is a claim with no source.
	 */
	record?: string
}

export interface AddressSourceRecord {
	/**
	 * `<iso2 lowercased>-<sector>-<n>`, stable across rebuilds of the register.
	 */
	sourceID: string
	iso2: string
	sector: RegisterSector
	name: string
	status: SourceStatus
	/**
	 * Which propositions this source asserts, per the `@mailwoman/evidence` axis.
	 *
	 * A company register asserting both carries `["identity", "observation"]`:
	 * it issues the identifier and it received the address string.
	 */
	asserts: readonly AssertedProposition[]
	/**
	 * What makes the publisher authoritative, in the pass's own words.
	 */
	authorityBasis: string
	/**
	 * How the data is reached — bulk CSV, an API, a portal search.
	 *
	 * Free text, because normalizing the spellings would lose the qualifications each one carries.
	 *
	 * Absent means the research pass did not record a route, which is not the
	 * same as the data being unreachable.
	 */
	access?: string
	geometry: SourceGeometry
	/**
	 * The `licenseID` of a decision in the register's own `licenses` table.
	 *
	 * The audit refuses an id nothing declares.
	 */
	license: string
	researchPass: ResearchPass
	publisher?: string
	sourceURL?: string
	note?: string
	/**
	 * What role the addresses in this source play.
	 *
	 * Absent while unresolved.
	 * A source becomes ingest-eligible only once it carries one, because ingesting a
	 * register of seats as premises is the defect the role field exists to stop.
	 */
	addressRole?: AddressRole
	/**
	 * The upstream sources this one copied from, where known.
	 *
	 * Two downstream databases carrying one upstream submission are one observation
	 * and not two votes, which is only checkable once this is filled.
	 */
	upstreamLineage?: readonly string[]
	/**
	 * A measured coverage statement. A national portal is not evidence of national coverage.
	 */
	coverage?: string
	/**
	 * What a review found about personal data in this publication.
	 *
	 * Absent while nobody has reviewed it, which refuses the source for ingest:
	 * a publication nobody examined is not a publication found clear.
	 */
	personalDataReview?: PersonalDataReview
}

/**
 * A field the research pass resolved on no source row at all.
 *
 * Declared at the top of the register rather than repeated as a null on 389 rows,
 * and audited in both directions: a field listed here must be absent from every row,
 * and a field not listed must be present on at least one.
 * That makes the claim checkable instead of a sentence somebody has to keep true by hand.
 */
export const UNRESOLVED_FIELDS = ["addressRole", "upstreamLineage", "coverage", "personalDataReview"] as const

export type UnresolvedField = (typeof UNRESOLVED_FIELDS)[number]

/**
 * Where the register came from.
 */
export interface RegisterProvenance {
	source: string
	sourceVersion?: string
	/**
	 * ISO 8601 calendar date, `yyyy-MM-DD`.
	 */
	authoredAt?: string
	notes?: string
}

/**
 * The committed register.
 */
export interface AddressSourceRegister {
	registerID: string
	version: string
	/**
	 * A sha256 over everything in this register except the digest itself, written by the build.
	 *
	 * The register is generated and the two research CSVs it is generated from are working documents
	 * under `.notes/`, which is not committed, so no check can regenerate the file and compare.
	 * Without a recorded digest a hand edit to a generated artifact is undetectable:
	 * a prose sweep renamed Contracts Finder to "Interfaces Finder" on three rows and the
	 * structural audit passed, because nothing here knew what the build had written (#2352).
	 *
	 * It detects an edit rather than attributing one.
	 * Someone who changes a value and reruns the build gets a new digest, which is the intended path.
	 *
	 * Someone who changes a value in the committed file does not, and the audit refuses it.
	 */
	contentDigest: string
	provenance: RegisterProvenance
	unresolved: readonly UnresolvedField[]
	licenses: readonly LicenseDecision[]
	jurisdictions: readonly JurisdictionRecord[]
	sources: readonly AddressSourceRecord[]
}
