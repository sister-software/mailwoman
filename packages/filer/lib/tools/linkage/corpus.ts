/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createHash } from "@mailwoman/core/hash"
import { createUnionFind } from "@mailwoman/core/utils"

import { toFRN, type FRN } from "#frn"
import { FilerIdentifierType } from "#schema"
import { mintFamilyID } from "#sdk/family-id"
import type { Form499Row } from "#sdk/form499/index"
import type { ProviderListRow } from "#sdk/provider-list"

/**
 * This date is the generation date of the committed linkage scorecard.
 *
 * Tests pass it so that the regenerated scorecard matches byte for byte.
 */
export const PUBLISHED_LINKAGE_EVAL_DATE = "2026-07-31"

/**
 * The eval reads `filer_family` membership as of this date.
 *
 * Membership is temporal (`valid_from`/`valid_to`), so a same-family prediction needs a date.
 * The date falls after the corpus's latest `lastFiledAt` and is fixed
 * so that scores never depend on the current date.
 */
export const LINKAGE_EVAL_AS_OF = "2026-06-01"

/**
 * This hash is the published SHA-256 of the withheld run's inputs.
 * The evaluation test checks it.
 */
export const PUBLISHED_WITHHELD_INPUTS_SHA256 = "b20909439dcf6bc0d2b04da43b3b3fb11cdb9ff68313e12d3eeb78a24bacda58"

/**
 * This hash is the published SHA-256 of the control run's inputs, which keep `holdingCompany`.
 */
export const PUBLISHED_CONTROL_INPUTS_SHA256 = "86f4c23616835425615960dabbf22df214fb2001b325e9b0128f9e0abf45f802"

const FRN_CASCADE_1 = toFRN("9100000001")!
const FRN_CASCADE_2 = toFRN("9100000002")!
const FRN_CASCADE_3 = toFRN("9100000003")!
const FRN_MERIDIAN_1 = toFRN("9100000004")!
const FRN_MERIDIAN_2 = toFRN("9100000005")!
const FRN_STANDALONE_1 = toFRN("9100000006")!
const FRN_STANDALONE_2 = toFRN("9100000007")!
const FRN_NAMESAKE_1 = toFRN("9100000008")!
const FRN_NAMESAKE_2 = toFRN("9100000009")!
const FRN_SHARED_REGISTRANT_1 = toFRN("9100000010")!
const FRN_SHARED_REGISTRANT_2 = toFRN("9100000011")!
const FRN_COMANAGED = toFRN("9100000012")!

/**
 * This function fills the optional Form 499 fields so that each fixture states only its distinctive values.
 */
function evalForm499Row(
	overrides: Partial<Form499Row> &
		Pick<Form499Row, "form499ID" | "frn" | "legalNameOfCarrier" | "holdingCompany" | "lastFiledAt">
): Form499Row {
	return {
		doingBusinessAs: "",
		usfContributor: false,
		principalCommType: "Competitive Local Exchange Carrier (CLEC)",
		managementCompany: "",
		hqAddress: "",
		customerInquiriesTelephone: "",
		customerInquiriesAddress: "",
		dcAgentDisplayName: "",
		dcAgentOrganizationName: "",
		dcAgentTelephone: "",
		dcAgentEmailAddress: "",
		dcAgentAddress: "",
		...overrides,
	}
}

/**
 * This function returns the authored held-out corpus of 12 Form 499 filers.
 *
 * The corpus covers two multi-member families with spelling variants, standalone filers,
 * distinct entities that share a name, a registrant with two FRNs, and a shared management company.
 * No legal name or DBA repeats a holding-company value, so a withheld run cannot
 * recover a parent from another field.
 */
export function buildLinkageEvalForm499Rows(): Form499Row[] {
	return [
		evalForm499Row({
			form499ID: "991001",
			frn: FRN_CASCADE_1,
			legalNameOfCarrier: "Trailhead Broadband LLC",
			doingBusinessAs: "Trailhead Fiber",
			holdingCompany: "Cascade Fiber Holdings, Inc.",
			lastFiledAt: "2026-03-01",
		}),
		evalForm499Row({
			form499ID: "991002",
			frn: FRN_CASCADE_2,
			legalNameOfCarrier: "Piedmont Rural Telephone Co",
			principalCommType: "Incumbent Local Exchange Carrier",
			holdingCompany: "Cascade Fiber Holdings Inc",
			lastFiledAt: "2026-03-05",
		}),
		evalForm499Row({
			form499ID: "991003",
			frn: FRN_CASCADE_3,
			legalNameOfCarrier: "Summit Ridge Communications Inc",
			doingBusinessAs: "Summit Ridge Networks",
			holdingCompany: "Cascade Fiber Holdings, Inc.",
			managementCompany: "Timberline Management Co",
			lastFiledAt: "2026-03-10",
		}),
		evalForm499Row({
			form499ID: "991004",
			frn: FRN_MERIDIAN_1,
			legalNameOfCarrier: "Bluegrass Rural Exchange Inc",
			principalCommType: "Incumbent Local Exchange Carrier",
			holdingCompany: "Meridian Communications Group LLC",
			lastFiledAt: "2026-03-12",
		}),
		evalForm499Row({
			form499ID: "991005",
			frn: FRN_MERIDIAN_2,
			legalNameOfCarrier: "Harborview Telecom Co",
			holdingCompany: "Meridian Communications Group, LLC",
			lastFiledAt: "2026-03-15",
		}),
		evalForm499Row({
			form499ID: "991006",
			frn: FRN_STANDALONE_1,
			legalNameOfCarrier: "Lonestar Independent Telephone Co",
			principalCommType: "Incumbent Local Exchange Carrier",
			holdingCompany: "",
			lastFiledAt: "2026-03-18",
		}),
		evalForm499Row({
			form499ID: "991007",
			frn: FRN_STANDALONE_2,
			legalNameOfCarrier: "Harbor Point Communications Inc",
			holdingCompany: "",
			lastFiledAt: "2026-03-20",
		}),
		evalForm499Row({
			form499ID: "991008",
			frn: FRN_NAMESAKE_1,
			legalNameOfCarrier: "American Fiber Partners LLC",
			holdingCompany: "",
			lastFiledAt: "2026-03-22",
		}),
		evalForm499Row({
			form499ID: "991009",
			frn: FRN_NAMESAKE_2,
			legalNameOfCarrier: "American Fiber Partners, LLC",
			holdingCompany: "",
			lastFiledAt: "2026-03-25",
		}),
		evalForm499Row({
			form499ID: "991010",
			frn: FRN_SHARED_REGISTRANT_1,
			legalNameOfCarrier: "Cedar Hollow Telephone Co",
			principalCommType: "Incumbent Local Exchange Carrier",
			holdingCompany: "",
			lastFiledAt: "2026-03-26",
		}),
		evalForm499Row({
			form499ID: "991011",
			frn: FRN_SHARED_REGISTRANT_2,
			legalNameOfCarrier: "Cedar Hollow Wireless LLC",
			holdingCompany: "Meridian Communications Group, LLC",
			lastFiledAt: "2026-03-27",
		}),
		evalForm499Row({
			form499ID: "991012",
			frn: FRN_COMANAGED,
			legalNameOfCarrier: "Ridgeline Communications LLC",
			holdingCompany: "",
			managementCompany: "Timberline Management Co",
			lastFiledAt: "2026-03-28",
		}),
	]
}

/**
 * This function returns BDC provider rows for a subset of the fixtures.
 *
 * Provider `700004` links the two FRNs of one registrant.
 * Each holding-company value either matches the Form 499 row or is null.
 */
export function buildLinkageEvalProviderRows(): ProviderListRow[] {
	return [
		{ providerID: 700_001, frn: FRN_CASCADE_1, holdingCompany: "Cascade Fiber Holdings, Inc." },
		{ providerID: 700_002, frn: FRN_MERIDIAN_1, holdingCompany: "Meridian Communications Group LLC" },
		{ providerID: 700_003, frn: FRN_NAMESAKE_1, holdingCompany: null },
		{ providerID: 700_004, frn: FRN_SHARED_REGISTRANT_1, holdingCompany: null },
		{ providerID: 700_004, frn: FRN_SHARED_REGISTRANT_2, holdingCompany: null },
	]
}

/**
 * This interface holds the Form 499 and provider rows that one eval run builds from.
 */
export interface LinkageEvalInputs {
	form499Rows: Form499Row[]
	providerRows: ProviderListRow[]
}

/**
 * This function returns the unmodified inputs for the control run.
 */
export function buildControlEvalInputs(): LinkageEvalInputs {
	return { form499Rows: buildLinkageEvalForm499Rows(), providerRows: buildLinkageEvalProviderRows() }
}

/**
 * This function returns the withheld run's inputs, with `holdingCompany` cleared in both sources.
 */
export function buildFilteredEvalInputs(): LinkageEvalInputs {
	const form499Rows = buildLinkageEvalForm499Rows().map((row) => ({ ...row, holdingCompany: "" }))
	const providerRows = buildLinkageEvalProviderRows().map((row) => ({ ...row, holdingCompany: null }))

	return { form499Rows, providerRows }
}

/**
 * A registrant is the eval's scoring unit.
 * One registrant can hold several FRNs.
 */
export interface LinkageEvalRegistrant {
	/**
	 * The smallest member FRN serves as the registrant's scored ID.
	 */
	representative: FRN
	/**
	 * This list holds the registrant's FRNs in sorted order.
	 */
	frns: FRN[]
	/**
	 * These IDs cover the registrant's FRN and provider nodes, which the eval
	 * reads family memberships through.
	 */
	nodeIDs: string[]
}

/**
 * This function groups FRNs that share a provider ID into registrants.
 *
 * It builds truth from the inputs rather than from the evaluated artifact,
 * so family scoring does not depend on entity-resolution results.
 */
export function buildTruthRegistrants(
	rows: readonly Form499Row[],
	providerRows: readonly ProviderListRow[]
): LinkageEvalRegistrant[] {
	const identity = createUnionFind()
	const frns: FRN[] = []

	for (const row of rows) {
		if (!row.frn) continue

		frns.push(row.frn)
		identity.find(row.frn)
	}

	const frnsOfProvider = new Map<number, FRN[]>()

	for (const row of providerRows) {
		frnsOfProvider.set(row.providerID, [...(frnsOfProvider.get(row.providerID) ?? []), row.frn])
	}

	for (const providerFRNs of frnsOfProvider.values()) {
		for (const frn of providerFRNs.slice(1)) {
			identity.union(providerFRNs[0]!, frn)
		}
	}

	const membersOfRoot = new Map<string, FRN[]>()

	for (const frn of frns) {
		const root = identity.find(frn)
		membersOfRoot.set(root, [...(membersOfRoot.get(root) ?? []), frn])
	}

	const registrants: LinkageEvalRegistrant[] = []

	for (const members of membersOfRoot.values()) {
		// One FRN can appear on several Form 499 rows.
		const sorted = [...new Set(members)].toSorted()
		const nodeIDs = sorted.map((frn) => `${FilerIdentifierType.FRN}:${frn}`)

		for (const row of providerRows) {
			if (sorted.includes(row.frn)) {
				nodeIDs.push(`${FilerIdentifierType.BDCProviderID}:${row.providerID}`)
			}
		}

		registrants.push({ representative: sorted[0]!, frns: sorted, nodeIDs: [...new Set(nodeIDs)].toSorted() })
	}

	return registrants.toSorted((a, b) => (a.representative < b.representative ? -1 : 1))
}

/**
 * This function returns a truth label unique to a registrant that discloses no parent.
 */
function singletonTruthGroup(representative: FRN): string {
	return `singleton:${representative}`
}

/**
 * This function builds held-out family truth from `holdingCompany` values.
 *
 * It mints family IDs with `mintFamilyID`, so truth uses the builder's name canonicalization.
 * Registrants that share a parent join one group.
 *
 * A registrant that discloses two parents merges those parents' groups.
 *
 * Management companies are excluded because they indicate operational control rather than ownership.
 */
export function buildTruthFamilyGroups(
	rows: readonly Form499Row[],
	providerRows: readonly ProviderListRow[]
): Map<FRN, string> {
	const registrants = buildTruthRegistrants(rows, providerRows)
	const representativeOfFRN = new Map<FRN, FRN>()

	for (const registrant of registrants) {
		for (const frn of registrant.frns) {
			representativeOfFRN.set(frn, registrant.representative)
		}
	}

	const families = createUnionFind()

	// Family IDs stay keyed by registrant until all unions finish, because union-find roots change during construction.
	const familyIDsOfRegistrant = new Map<FRN, Set<string>>()

	const attribute = (frn: FRN | null, holdingCompany: string | null): void => {
		if (!frn || !holdingCompany) return

		const familyID = mintFamilyID(FilerIdentifierType.HoldingCompanyName, holdingCompany)

		if (!familyID) return

		const representative = representativeOfFRN.get(frn)

		if (!representative) return

		families.union(`registrant:${representative}`, `family:${familyID}`)
		familyIDsOfRegistrant.set(representative, (familyIDsOfRegistrant.get(representative) ?? new Set()).add(familyID))
	}

	for (const row of rows) {
		attribute(row.frn, row.holdingCompany)
	}

	for (const row of providerRows) {
		attribute(row.frn, row.holdingCompany)
	}

	const familyIDsOfRoot = new Map<string, Set<string>>()

	for (const registrant of registrants) {
		const root = families.find(`registrant:${registrant.representative}`)
		const rolled = familyIDsOfRoot.get(root) ?? new Set<string>()

		for (const familyID of familyIDsOfRegistrant.get(registrant.representative) ?? []) {
			rolled.add(familyID)
		}

		familyIDsOfRoot.set(root, rolled)
	}

	const truth = new Map<FRN, string>()

	for (const registrant of registrants) {
		const familyIDs = [
			...(familyIDsOfRoot.get(families.find(`registrant:${registrant.representative}`)) ?? []),
		].toSorted()

		truth.set(
			registrant.representative,
			familyIDs.length ? familyIDs.join(" + ") : singletonTruthGroup(registrant.representative)
		)
	}

	return truth
}

function serializeForm499Row(row: Form499Row): string {
	return [
		row.form499ID,
		row.frn ?? "",
		row.lastFiledAt,
		String(row.usfContributor),
		row.legalNameOfCarrier,
		row.doingBusinessAs,
		row.principalCommType,
		row.holdingCompany,
		row.managementCompany,
		row.hqAddress,
		row.customerInquiriesTelephone,
		row.customerInquiriesAddress,
		row.dcAgentDisplayName,
		row.dcAgentOrganizationName,
		row.dcAgentTelephone,
		row.dcAgentEmailAddress,
		row.dcAgentAddress,
	].join("\t")
}

function serializeProviderListRow(row: ProviderListRow): string {
	return [String(row.providerID), row.frn, row.holdingCompany ?? ""].join(",")
}

/**
 * This function returns the SHA-256 of the evaluation inputs.
 *
 * It serializes fields in a fixed order so that the hash is stable across runtimes.
 */
export function hashLinkageEvalInputs(inputs: {
	form499Rows: readonly Form499Row[]
	providerRows: readonly ProviderListRow[]
}): string {
	const hash = createHash("sha256")

	for (const row of inputs.form499Rows) {
		hash.update(serializeForm499Row(row))
		hash.update("\n")
	}

	hash.update("---\n")

	for (const row of inputs.providerRows) {
		hash.update(serializeProviderListRow(row))
		hash.update("\n")
	}

	return hash.digest("hex")
}
