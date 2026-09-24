/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Held-out corpus and truth builders for `filerLinkageEval`. This module contains data and pure functions only;
 *   it does not import the evaluation module.
 */

import { createHash } from "@mailwoman/core/hash"
import { createUnionFind } from "@mailwoman/core/utils"

import { toFRN, type FRN } from "#frn"
import { FilerIdentifierType } from "#schema"
import { mintFamilyID } from "#sdk/family-id"
import type { Form499Row } from "#sdk/form499/index"
import type { ProviderListRow } from "#sdk/provider-list"

/**
 * Generation date of the committed linkage scorecard, pinned for byte-for-byte test reproduction.
 */
export const PUBLISHED_LINKAGE_EVAL_DATE = "2026-07-31"

/**
 * Published SHA-256 of the withheld run's inputs, checked by the evaluation test.
 */
export const PUBLISHED_WITHHELD_INPUTS_SHA256 = "b20909439dcf6bc0d2b04da43b3b3fb11cdb9ff68313e12d3eeb78a24bacda58"

/**
 * Published SHA-256 of the control inputs, with `holdingCompany` intact.
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
 * Fill optional Form 499 fields so fixtures specify only distinctive values.
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
 * Authored held-out corpus of 12 Form 499 filers.
 *
 * It covers two multi-member families with spelling variants, standalone filers,
 * same-name distinct entities, a registrant with two FRNs, and shared management companies.
 * Legal names and DBAs do not repeat another row's holding-company value,
 * so withholding that field is meaningful.
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
 * Provider rows for selected fixtures.
 *
 * Provider `700004` links the two FRNs of one registrant; holding-company
 * values agree with Form 499 or are null.
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
 * Control and withheld input projections for the evaluation.
 */
export interface LinkageEvalInputs {
	form499Rows: Form499Row[]
	providerRows: ProviderListRow[]
}

/**
 * Return unmodified inputs for the control run.
 */
export function buildControlEvalInputs(): LinkageEvalInputs {
	return { form499Rows: buildLinkageEvalForm499Rows(), providerRows: buildLinkageEvalProviderRows() }
}

/**
 * Return inputs for the withheld run, clearing `holdingCompany` from both sources
 * before building the database.
 */
export function buildFilteredEvalInputs(): LinkageEvalInputs {
	const form499Rows = buildLinkageEvalForm499Rows().map((row) => ({ ...row, holdingCompany: "" }))
	const providerRows = buildLinkageEvalProviderRows().map((row) => ({ ...row, holdingCompany: null }))

	return { form499Rows, providerRows }
}

/**
 * Registrant used as the evaluation unit; one registrant may hold multiple FRNs.
 */
export interface LinkageEvalRegistrant {
	/**
	 * Smallest member FRN, used as the scored ID.
	 */
	representative: FRN
	/**
	 * Sorted FRNs held by this registrant.
	 */
	frns: FRN[]
	/**
	 * FRN and linked provider nodes used to read family memberships.
	 */
	nodeIDs: string[]
}

/**
 * Group FRNs linked by provider ID into registrants.
 *
 * Build truth from the input data rather than the evaluated artifact, so family
 * scoring does not depend on entity-resolution results.
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
		// A filer may have multiple Form 499 rows for the same FRN.
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
 * Unique truth label for a registrant without a disclosed parent.
 */
function singletonTruthGroup(representative: FRN): string {
	return `singleton:${representative}`
}

/**
 * Build held-out family truth from `holdingCompany` values using the same canonicalization as the builder.
 *
 * Collect disclosures across all rows for each registrant; shared parents
 * and multi-parent links form connected groups.
 * Management companies are excluded because they represent operational control, not ownership.
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

	// Keep family IDs by registrant until all unions finish; roots can change during construction.
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

	// All unions are complete; aggregate family IDs by final component.
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
 * Hash the exact evaluation inputs in fixed field order so results are stable across runtimes.
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
