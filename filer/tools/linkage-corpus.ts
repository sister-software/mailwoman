/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The corpus {@linkcode filerLinkageEval} (`linkage-eval.ts`) measures against, and the held-out truth
 *   derived from it. Split out of the eval itself so each file stays readable: this one is pure data and
 *   pure functions over that data — no database, no I/O, nothing that has to run to be audited. Every truth
 *   fact the scorecard publishes is checkable by reading the literals below.
 *
 *   Nothing here imports `linkage-eval.ts`, so the dependency between the two stays one-directional.
 */

import { createHash } from "node:crypto"

import { FilerIdentifierType } from "../schema.ts"
import { mintFamilyID } from "../sdk/family-id.ts"
import type { Form499Row } from "../sdk/form499.ts"
import { toFRN, type FRN } from "../sdk/frn.ts"
import type { ProviderListRow } from "../sdk/provider-list.ts"

/**
 * The date the committed scorecard (`docs/articles/evals/2026-07-31-filer-linkage.md`) was generated under. Exported so
 * `linkage-eval.test.ts` can regenerate that exact file and byte-compare it — without this pin, editing the corpus
 * silently stales the published numbers with nothing failing.
 */
export const PUBLISHED_LINKAGE_EVAL_DATE = "2026-07-31"

/**
 * The SHA-256 {@linkcode hashLinkageEvalInputs} produces over the WITHHELD run's inputs, as published in the committed
 * scorecard. Asserted against the freshly computed value in `linkage-eval.test.ts`.
 */
export const PUBLISHED_WITHHELD_INPUTS_SHA256 = "b20909439dcf6bc0d2b04da43b3b3fb11cdb9ff68313e12d3eeb78a24bacda58"

/**
 * The same hash over the CONTROL run's inputs (the corpus with `holdingCompany` intact). Differs from
 * {@linkcode PUBLISHED_WITHHELD_INPUTS_SHA256} by construction — if the two ever matched, the two runs would not
 * actually differ in the field this eval claims to withhold.
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
 * Fills every optional `Form499Row` field with an empty/false default, so each corpus row below states only what's
 * distinctive about it. Mirrors `filer-lookup.test.ts`'s `minimalForm499Row` convention.
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
 * The authored held-out corpus — 12 Form 499 filers, written out (never sampled) so every truth fact is auditable by
 * reading this file and the eval is exactly reproducible. What it deliberately covers:
 *
 * - **Two multi-filer corporate families.** "Cascade Fiber Holdings, Inc." (3 members) and "Meridian Communications Group
 *   LLC" (3 members, counting the shared registrant below). One member of each reports a spelling-drifted
 *   holding-company name, so both the truth construction and the builder have to canonicalize rather than
 *   string-match.
 * - **Four standalone filers**, no holding company — true negatives for the pairwise score.
 * - **A same-canonical-name/different-entity trap.** "American Fiber Partners LLC" / "American Fiber Partners, LLC"
 *   canonicalize identically and are NOT the same company. Nothing in this crosswalk may merge them.
 * - **One registrant holding two FRNs** (`9100000010`/`9100000011`, joined by a shared `bdc_provider_id` in
 *   {@linkcode buildLinkageEvalProviderRows}), where only the SECOND of the two discloses the parent. Its family
 *   membership therefore has to be found through the registrant, not through whichever FRN happens to sort first.
 * - **Two filers reporting the same management company** (`9100000003`/`9100000012`) — the case the management-exclusion
 *   decision in the module docstring exists to handle.
 *
 * No `legalNameOfCarrier`/`doingBusinessAs` value here contains another row's `holdingCompany` string — deliberately,
 * so withholding that field can't be defeated by accident through a different field that happens to restate it.
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
 * BDC provider-list rows layered onto a subset of the corpus above. Provider `700004` is reported for BOTH `9100000010`
 * and `9100000011` — one registrant that holds two FRN registrations, the shape {@linkcode buildTruthRegistrants} exists
 * to fold into a single scored id. Every other `providerID` maps to exactly one FRN.
 *
 * Each row's `holdingCompany` either agrees with its FRN's Form 499 value or is `null`, so stripping it later never
 * creates an internal contradiction between the two sources' held-out truth. Provider `700004` reports `null` on both
 * rows on purpose: the shared registrant's parent is disclosed on ONE of its two Form 499 filings and nowhere else.
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
 * {@linkcode filerLinkageEval}'s two input projections. `control` is the corpus verbatim; `withheld` is the same corpus
 * with `holdingCompany` cleared on every row of both sources.
 */
export interface LinkageEvalInputs {
	form499Rows: Form499Row[]
	providerRows: ProviderListRow[]
}

/**
 * The corpus verbatim — what the CONTROL run hands `buildFilerDatabase`. Named for what it is (an unfiltered
 * projection), so the withheld/control distinction is visible at every call site rather than implied.
 */
export function buildControlEvalInputs(): LinkageEvalInputs {
	return { form499Rows: buildLinkageEvalForm499Rows(), providerRows: buildLinkageEvalProviderRows() }
}

/**
 * The WITHHELD run's entire input to the builder (decision 4) — the corpus with `holdingCompany` cleared on every row,
 * before anything reaches `buildFilerDatabase`. {@linkcode filerLinkageEval} calls exactly this function to build what
 * it hands the builder, so a test asserting the truth field's absence here is asserting it against the SAME code path
 * the eval actually runs — not a parallel copy that could drift out of sync with it.
 */
export function buildFilteredEvalInputs(): LinkageEvalInputs {
	const form499Rows = buildLinkageEvalForm499Rows().map((row) => ({ ...row, holdingCompany: "" }))
	const providerRows = buildLinkageEvalProviderRows().map((row) => ({ ...row, holdingCompany: null }))

	return { form499Rows, providerRows }
}

/**
 * A minimal union-find over string keys — used twice below, to fold FRNs into registrants and registrants into truth
 * families. Small enough to keep local; pulling in a dependency for 20 lines of disjoint-set would be the larger cost.
 */
function createUnionFind(): { union: (a: string, b: string) => void; find: (a: string) => string } {
	const parent = new Map<string, string>()

	const find = (key: string): string => {
		const current = parent.get(key)

		if (current === undefined) {
			parent.set(key, key)

			return key
		}

		if (current === key) return key

		const root = find(current)
		parent.set(key, root)

		return root
	}

	const union = (a: string, b: string): void => {
		const rootA = find(a)
		const rootB = find(b)

		if (rootA === rootB) return

		// Deterministic merge direction (lexicographic) — the component's representative must not depend on the order
		// rows happened to arrive in, or the scored id universe would shift under an unrelated corpus edit.
		if (rootA < rootB) {
			parent.set(rootB, rootA)
		} else {
			parent.set(rootA, rootB)
		}
	}

	return { union, find }
}

/**
 * One REGISTRANT — the eval's unit of analysis. Usually one FRN, but an operator can hold several FRN registrations,
 * and the corpus's `bdc_provider_id` linkage says when that's the case.
 */
export interface LinkageEvalRegistrant {
	/**
	 * The lexicographically smallest member FRN — the id this registrant is scored under.
	 */
	representative: FRN
	/**
	 * Every FRN this registrant holds, sorted.
	 */
	frns: FRN[]
	/**
	 * Every `filer_node` id whose family memberships belong to this registrant: its FRN nodes plus any `bdc_provider_id`
	 * node the provider list ties to one of them. The prediction reads all of these — a parent disclosed on one
	 * registration is a fact about the company, not about that one registration.
	 */
	nodeIDs: string[]
}

/**
 * Fold the corpus's FRNs into registrants. Two FRNs reported under the SAME `bdc_provider_id` are one legal entity with
 * two registrations; scoring them as two separate ids lets the truth partition assert that one company belongs to two
 * different corporate families at once, which is not a coherent thing for a truth partition to say and makes every
 * downstream count questionable.
 *
 * Identity here is taken from `providerID`, a field the builder also sees — it is NOT withheld, so using it to define
 * the scored id universe leaks nothing about the field that is. The eval deliberately does not ask the built artifact
 * who is the same entity: that is the entity-resolution pass's question, measured elsewhere, and reading it here would
 * make the family measurement depend on it.
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
		// Deduped: two Form 499 rows CAN carry the same FRN (a filer that filed twice), and a repeated member would
		// otherwise double-count in `frns` and in anything sized off it.
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
 * A truth group label for a registrant with no disclosed parent. Embeds the representative FRN, so two unrelated
 * standalone registrants never collide into one truth family. (Every registrant that DOES have a parent gets the
 * canonical family id instead, so these labels are unique by construction — nothing downstream needs to special-case
 * the prefix.)
 */
function singletonTruthGroup(representative: FRN): string {
	return `singleton:${representative}`
}

/**
 * The held-out ground truth (decision 4): which corporate family each REGISTRANT really belongs to, per the
 * (never-stripped) `holdingCompany` field, canonicalized via {@linkcode mintFamilyID} — the exact rule
 * `buildFilerDatabase` itself applies, so the corpus's spelling variants collapse onto the same truth group.
 *
 * Keyed by {@link LinkageEvalRegistrant.representative}. A registrant's parent may be disclosed on any of its Form 499
 * filings or provider-list rows; all of them count. Registrants that name the same parent land in one truth group, and
 * a registrant naming two parents transitively joins both — hence the second union-find rather than a plain map.
 *
 * `managementCompany` is NOT a truth family here: see the module docstring for why operational control is held apart
 * from ownership on both sides of this measurement.
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

	// Accumulated per REGISTRANT, never per union-find root. Keying this on the root as it stands
	// mid-loop means a later union that re-roots the component orphans the earlier key, and the family id recorded
	// under it silently vanishes from the label — the label being what the corpus and pairs tables publish as truth. The
	// partition stays right either way, so no score moves; the published string is what goes wrong. Unreachable on
	// today's corpus (no registrant names two parents) and reachable the moment one does.
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

	// Every union is done, so every root below is final — roll the per-registrant sets up into per-component ones.
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
 * SHA-256 over the EXACT bytes a run hands to `buildFilerDatabase` (decision 4's "the scorecard reports … the SHA of
 * its inputs") — computed over a fixed field order (mirrors the real TSV/CSV column order), so the hash is stable
 * across Node versions and can never depend on an object-key-iteration-order accident. The withheld and control runs
 * therefore publish DIFFERENT hashes, which is itself the evidence that they differ in the field they claim to.
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
