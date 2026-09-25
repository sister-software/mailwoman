/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests {@linkcode filerLinkageEval} by running the real build and clustering pipeline on scratch databases.
 *
 *   The control run must score perfectly. That check fails if the prediction is stubbed out.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { toFRN } from "@mailwoman/filer/frn"
import { FilerEdgeAssertion, FilerRelationship, type FilerDatabase } from "@mailwoman/filer/schema"
import {
	buildControlEvalInputs,
	buildFilteredEvalInputs,
	buildLinkageEvalForm499Rows,
	buildLinkageEvalProviderRows,
	buildTruthFamilyGroups,
	buildTruthRegistrants,
	hashLinkageEvalInputs,
	PUBLISHED_CONTROL_INPUTS_SHA256,
	PUBLISHED_LINKAGE_EVAL_DATE,
	PUBLISHED_WITHHELD_INPUTS_SHA256,
} from "@mailwoman/filer/tools/linkage-corpus"
import {
	assertNoOwnershipLeak,
	filerLinkageEval,
	runLinkagePass,
	type FilerLinkageEvalResult,
	type LinkageEvalRun,
} from "@mailwoman/filer/tools/linkage-eval"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

const FRN_CASCADE_1 = toFRN("9100000001")!
const FRN_CASCADE_2 = toFRN("9100000002")!
const FRN_CASCADE_3 = toFRN("9100000003")!
const FRN_MERIDIAN_1 = toFRN("9100000004")!
const FRN_MERIDIAN_2 = toFRN("9100000005")!
const FRN_NAMESAKE_1 = toFRN("9100000008")!
const FRN_NAMESAKE_2 = toFRN("9100000009")!
const FRN_SHARED_REGISTRANT_1 = toFRN("9100000010")!
const FRN_SHARED_REGISTRANT_2 = toFRN("9100000011")!
const FRN_COMANAGED = toFRN("9100000012")!

const PUBLISHED_REPORT_PATH = repoRootPath(
	"docs",
	"records",
	"evals",
	`${PUBLISHED_LINKAGE_EVAL_DATE}-filer-linkage.md`
)

const MANAGEMENT_FAMILY_ID = "management_company_name:timberline management"

/**
 * A family ID outside the builder's namespaces, so no code path that special-cases
 * those namespaces can handle it.
 */
const INJECTED_FAMILY_ID = "cik:0001234567"

/**
 * The eval run that the tests share, because each run builds two databases.
 */
let cached: Promise<FilerLinkageEvalResult> | undefined

async function runEval(): Promise<FilerLinkageEvalResult> {
	// Caching the promise keeps concurrent callers from starting a second run.
	cached ??= filerLinkageEval({ date: PUBLISHED_LINKAGE_EVAL_DATE, printMarkdown: false })

	return await cached
}

describe("buildFilteredEvalInputs — decision 4's leakage exclusion (criterion 4)", () => {
	it("clears holdingCompany to an empty string on every Form499Row", () => {
		const { form499Rows } = buildFilteredEvalInputs()

		expect(form499Rows.length).toBeGreaterThan(0)

		for (const row of form499Rows) {
			expect(row.holdingCompany).toBe("")
		}
	})

	it("clears holdingCompany to null on every ProviderListRow", () => {
		const { providerRows } = buildFilteredEvalInputs()

		expect(providerRows.length).toBeGreaterThan(0)

		for (const row of providerRows) {
			expect(row.holdingCompany).toBeNull()
		}
	})

	it("leaves every OTHER field populated — this is a targeted redaction, not a blanked corpus", () => {
		const { form499Rows } = buildFilteredEvalInputs()

		for (const row of form499Rows) {
			expect(row.frn).not.toBeNull()
			expect(row.legalNameOfCarrier.length).toBeGreaterThan(0)
			expect(row.lastFiledAt.length).toBeGreaterThan(0)
		}
	})

	it("the CONTROL projection keeps holdingCompany — without this the two runs would not differ at all", () => {
		const control = buildControlEvalInputs()

		expect(control.form499Rows.some((row) => row.holdingCompany !== "")).toBe(true)
		expect(control.providerRows.some((row) => row.holdingCompany !== null)).toBe(true)
		expect(hashLinkageEvalInputs(control)).not.toBe(hashLinkageEvalInputs(buildFilteredEvalInputs()))
	})
})

describe("buildTruthRegistrants — the scored unit", () => {
	it("folds two FRNs reported under ONE bdc_provider_id into a single registrant", () => {
		const registrants = buildTruthRegistrants(buildLinkageEvalForm499Rows(), buildLinkageEvalProviderRows())
		const shared = registrants.find((registrant) => registrant.frns.includes(FRN_SHARED_REGISTRANT_1))

		expect(shared?.frns).toEqual([FRN_SHARED_REGISTRANT_1, FRN_SHARED_REGISTRANT_2])
		expect(shared?.representative).toBe(FRN_SHARED_REGISTRANT_1)
		expect(registrants.filter((registrant) => registrant.frns.includes(FRN_SHARED_REGISTRANT_2))).toHaveLength(1)
	})

	it("carries the registrant's bdc_provider_id node alongside its FRN nodes", () => {
		const registrants = buildTruthRegistrants(buildLinkageEvalForm499Rows(), buildLinkageEvalProviderRows())
		const shared = registrants.find((registrant) => registrant.frns.includes(FRN_SHARED_REGISTRANT_1))

		expect(shared?.nodeIDs).toEqual([
			"bdc_provider_id:700004",
			`frn:${FRN_SHARED_REGISTRANT_1}`,
			`frn:${FRN_SHARED_REGISTRANT_2}`,
		])
	})

	it("leaves every other FRN as its own registrant", () => {
		const registrants = buildTruthRegistrants(buildLinkageEvalForm499Rows(), buildLinkageEvalProviderRows())

		expect(registrants).toHaveLength(buildLinkageEvalForm499Rows().length - 1)
	})
})

describe("buildTruthFamilyGroups — the held-out ground truth", () => {
	const truth = () => buildTruthFamilyGroups(buildLinkageEvalForm499Rows(), buildLinkageEvalProviderRows())

	it("collapses a spelling-drifted holding-company name onto the SAME truth family (Cascade, comma dropped)", () => {
		expect(truth().get(FRN_CASCADE_1)).toBe(truth().get(FRN_CASCADE_2))
		expect(truth().get(FRN_CASCADE_2)).toBe(truth().get(FRN_CASCADE_3))
	})

	it("collapses a spelling-drifted holding-company name onto the SAME truth family (Meridian, comma added)", () => {
		expect(truth().get(FRN_MERIDIAN_1)).toBe(truth().get(FRN_MERIDIAN_2))
	})

	it("never puts the two truth families in the same group", () => {
		expect(truth().get(FRN_CASCADE_1)).not.toBe(truth().get(FRN_MERIDIAN_1))
	})

	it("gives two standalone filers with an IDENTICAL canonical legal name DIFFERENT truth groups", () => {
		expect(truth().get(FRN_NAMESAKE_1)).not.toBe(truth().get(FRN_NAMESAKE_2))
	})

	it("gives a multi-FRN registrant ONE truth family, taken from whichever registration disclosed the parent (C2)", () => {
		// The parent is on the filing for 9100000011, and the registrant is scored under 9100000010.
		expect(truth().get(FRN_SHARED_REGISTRANT_1)).toBe(truth().get(FRN_MERIDIAN_1))
		expect(truth().has(FRN_SHARED_REGISTRANT_2)).toBe(false)
	})

	it("gives every registrant in one truth component the SAME label, including ids only a sibling named", () => {
		// Sibling one names only Ridgeway.
		// Sibling two names Ridgeway and Fernbank.
		// Ridgeway joins them into one component, so both labels must list both parents.
		const base = buildLinkageEvalForm499Rows()

		const rows = [
			...base,
			{
				...base[0]!,
				form499ID: "991091",
				frn: toFRN("9100000091")!,
				legalNameOfCarrier: "Sibling One Telecom LLC",
				holdingCompany: "Ridgeway Group LLC",
			},
			{
				...base[0]!,
				form499ID: "991092",
				frn: toFRN("9100000092")!,
				legalNameOfCarrier: "Sibling Two Telecom LLC",
				holdingCompany: "Ridgeway Group LLC",
			},
		]

		const providerRows = [
			...buildLinkageEvalProviderRows(),
			{ providerID: 700_092, frn: toFRN("9100000092")!, holdingCompany: "Fernbank Partners LLC" },
		]

		const rolled = buildTruthFamilyGroups(rows, providerRows)
		const expected = "holding_company_name:fernbank partners + holding_company_name:ridgeway group"

		expect(rolled.get(toFRN("9100000092")!)).toBe(expected)
		expect(rolled.get(toFRN("9100000091")!)).toBe(expected)
	})

	it("keeps every family id in the label when one registrant names TWO parents", () => {
		// `union` merges toward the lexicographically smaller root, so only one ordering
		// of the two parents re-roots the component mid-loop.
		// The test runs both orderings so it always covers that case.
		const labelFor = (form499Parent: string, providerParent: string): string | undefined => {
			const rows = [
				...buildLinkageEvalForm499Rows(),
				{
					...buildLinkageEvalForm499Rows()[0]!,
					form499ID: "991090",
					frn: toFRN("9100000090")!,
					legalNameOfCarrier: "Two Parents Telecom LLC",
					holdingCompany: form499Parent,
				},
			]

			const providerRows = [
				...buildLinkageEvalProviderRows(),
				{ providerID: 700_090, frn: toFRN("9100000090")!, holdingCompany: providerParent },
			]

			return buildTruthFamilyGroups(rows, providerRows).get(toFRN("9100000090")!)
		}

		const northbridgeFirst = labelFor("Northbridge Holdings LLC", "Southgate Capital Partners LLC")
		const southgateFirst = labelFor("Southgate Capital Partners LLC", "Northbridge Holdings LLC")

		// The test compares whole labels because a substring check would pass on a label missing one parent.
		const expected = "holding_company_name:northbridge holdings + holding_company_name:southgate capital partners"

		expect(northbridgeFirst).toBe(expected)
		expect(southgateFirst).toBe(expected)
	})

	it("does NOT treat a shared management company as a truth family", () => {
		expect(truth().get(FRN_COMANAGED)).toBe(`singleton:${FRN_COMANAGED}`)
		expect(truth().get(FRN_COMANAGED)).not.toBe(truth().get(FRN_CASCADE_3))
	})
})

describe("the corpus's own invariants", () => {
	it("never restates one row's holdingCompany inside another row's name fields", () => {
		// A parent's name inside a legal name or DBA would leak the withheld answer.
		// The leakage census counts only ownership rows, so it cannot catch this case.
		const rows = buildLinkageEvalForm499Rows()
		const parents = rows.map((row) => row.holdingCompany).filter((name) => name !== "")

		expect(parents.length).toBeGreaterThan(0)

		for (const row of rows) {
			for (const parent of parents) {
				expect(row.legalNameOfCarrier.toLowerCase()).not.toContain(parent.toLowerCase())
				expect(row.doingBusinessAs.toLowerCase()).not.toContain(parent.toLowerCase())
			}
		}
	})
})

describe("hashLinkageEvalInputs", () => {
	it("is deterministic over the same inputs", () => {
		const inputs = buildFilteredEvalInputs()

		expect(hashLinkageEvalInputs(inputs)).toBe(hashLinkageEvalInputs(buildFilteredEvalInputs()))
	})

	it("changes when a matcher-visible field changes", () => {
		const inputs = buildFilteredEvalInputs()

		const mutated = {
			form499Rows: inputs.form499Rows.map((row, i) => (i === 0 ? { ...row, legalNameOfCarrier: "Mutated Co" } : row)),
			providerRows: inputs.providerRows,
		}

		expect(hashLinkageEvalInputs(mutated)).not.toBe(hashLinkageEvalInputs(inputs))
	})

	it("matches the SHA published in the committed scorecard", () => {
		// Editing the corpus without regenerating the scorecard fails here.
		expect(hashLinkageEvalInputs(buildFilteredEvalInputs())).toBe(PUBLISHED_WITHHELD_INPUTS_SHA256)
		expect(hashLinkageEvalInputs(buildControlEvalInputs())).toBe(PUBLISHED_CONTROL_INPUTS_SHA256)
	})
})

describe("filerLinkageEval — reproducibility (criterion 4)", () => {
	it("reproduces identical scores and input SHAs across two independent runs", async () => {
		const first = await runEval()
		const second = await filerLinkageEval({ date: PUBLISHED_LINKAGE_EVAL_DATE, printMarkdown: false })

		expect(second.withheld.score).toEqual(first.withheld.score)
		expect(second.control.score).toEqual(first.control.score)
		expect(second.withheld.inputsSHA256).toBe(first.withheld.inputsSHA256)
		expect(second.markdown).toBe(first.markdown)
	})

	it("regenerates the committed scorecard byte for byte", async () => {
		const { markdown } = await runEval()

		expect(markdown).toBe(await readLocalTextFile(PUBLISHED_REPORT_PATH))
	})

	it("emits a markdown report — no embedded JSON, headed by a dated H1", async () => {
		const { markdown, withheld, control } = await runEval()

		expect(markdown.startsWith(`# ${PUBLISHED_LINKAGE_EVAL_DATE} — does filer.db recover corporate family`)).toBe(true)
		expect(markdown).toContain("## Results")
		expect(markdown).toContain(withheld.inputsSHA256)
		expect(markdown).toContain(control.inputsSHA256)
		expect(markdown).not.toMatch(/[{[]"[a-zA-Z]/) // The report contains no inline JSON.
	})
})

describe("filerLinkageEval — the control run (POSITIVE CONTROL: this is what dies if the prediction is stubbed)", () => {
	it("recovers every same-family registrant pair when the parent is disclosed", async () => {
		const { control } = await runEval()

		expect(control.score.truthPositivePairs).toBe(6)
		expect(control.score.truePositivePairs).toBe(6)
		expect(control.score.falsePositivePairs).toBe(0)
		expect(control.score.falseNegativePairs).toBe(0)
		expect(control.score.precision).toBe(1)
		expect(control.score.recall).toBe(1)
		expect(control.score.f1).toBe(1)
	})

	it("finds the multi-FRN registrant's family through the registration that disclosed it", async () => {
		const { control } = await runEval()

		// The parent is on the filing for 9100000011, and the registrant is scored under 9100000010.
		// A prediction that read only the representative FRN would miss it.
		expect(control.predictedFamilyIDsOf.get(FRN_SHARED_REGISTRANT_1)).toEqual([
			"holding_company_name:meridian communications group",
		])
	})

	it("never merges the two unrelated companies with identical canonical names", async () => {
		const { control } = await runEval()

		expect(control.predictedFamilyIDsOf.get(FRN_NAMESAKE_1)).toEqual([])
		expect(control.predictedFamilyIDsOf.get(FRN_NAMESAKE_2)).toEqual([])
	})
})

describe("filerLinkageEval — the withheld run (the measurement)", () => {
	it("recovers none of the held-out same-family pairs, and makes no positive call at all", async () => {
		const { withheld } = await runEval()

		expect(withheld.score.truthPositivePairs).toBe(6)
		expect(withheld.score.truePositivePairs).toBe(0)
		expect(withheld.score.predictedPositivePairs).toBe(0)
		expect(withheld.score.precision).toBeNull()
		expect(withheld.score.recall).toBe(0)
		// F1 is null because the run made no positive calls.
		expect(withheld.score.f1).toBeNull()
	})

	it("scores over registrant pairs, so the two runs share one truth partition", async () => {
		const { withheld, control, registrants } = await runEval()

		expect(registrants).toHaveLength(11)
		expect(withheld.score.totalPairs).toBe(55)
		expect(withheld.score.totalPairs).toBe(control.score.totalPairs)
	})
})

describe("filerLinkageEval — what is really in the artifacts", () => {
	it("leaves NO ownership node, edge or scoreable family row in the withheld build", async () => {
		const { withheld } = await runEval()

		expect(withheld.census.holdingCompanyNodes).toBe(0)
		expect(withheld.census.ownershipEdges).toBe(0)
		expect(withheld.census.scoredFamilyRows).toBe(0)
	})

	it("DOES leave management-company filer_family rows there — the old page claimed none could exist", async () => {
		const { withheld } = await runEval()

		expect(withheld.census.nonOwnershipFamilyRows).toBe(2)
		expect(withheld.census.familyRows).toBe(2)
		expect(withheld.observedFamilyIDsOf.get(FRN_CASCADE_3)).toEqual([MANAGEMENT_FAMILY_ID])
		expect(withheld.observedFamilyIDsOf.get(FRN_COMANAGED)).toEqual([MANAGEMENT_FAMILY_ID])
	})

	it("excludes those management families from the prediction, in BOTH runs", async () => {
		const { withheld, control } = await runEval()

		expect(withheld.predictedFamilyIDsOf.get(FRN_COMANAGED)).toEqual([])
		expect(control.predictedFamilyIDsOf.get(FRN_COMANAGED)).toEqual([])
		// Cascade 3 keeps its ownership family in the control run.
		// Only its management family is dropped.
		expect(control.predictedFamilyIDsOf.get(FRN_CASCADE_3)).toEqual(["holding_company_name:cascade fiber holdings"])
		expect(control.observedFamilyIDsOf.get(FRN_CASCADE_3)).toContain(MANAGEMENT_FAMILY_ID)
	})

	it("builds the ownership artifacts in the control run — the contrast that makes the census meaningful", async () => {
		const { control } = await runEval()

		expect(control.census.holdingCompanyNodes).toBe(4)
		expect(control.census.ownershipEdges).toBe(8)
		expect(control.census.scoredFamilyRows).toBe(8)
		expect(control.census.nonOwnershipFamilyRows).toBe(2)
		expect(control.census.familyRows).toBe(10)
	})
})

describe("the standing guarantee: this baseline CAN be beaten", () => {
	// This helper joins the three Cascade registrants to one family through a
	// `subsidiary` relationship, which the builder never writes.
	// The eval injects the rows after its leakage check has run.
	const injectSubsidiaryFamily = async (db: DatabaseClient<FilerDatabase>): Promise<void> => {
		for (const frn of [FRN_CASCADE_1, FRN_CASCADE_2, FRN_CASCADE_3]) {
			await db
				.insertInto("filer_family")
				.values({
					node_id: `frn:${frn}`,
					family_id: INJECTED_FAMILY_ID,
					naming_node_id: INJECTED_FAMILY_ID,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.Subsidiary,
					source: "linkage-eval-injection-probe",
					source_vintage: "2026-eval-v1",
					valid_from: "2026-01-01",
					valid_to: null,
				})
				.execute()
		}
	}

	const runInjected = async (): Promise<LinkageEvalRun> => {
		const form499Rows = buildLinkageEvalForm499Rows()
		const providerRows = buildLinkageEvalProviderRows()

		return await runLinkagePass({
			inputs: buildFilteredEvalInputs(),
			registrants: buildTruthRegistrants(form499Rows, providerRows),
			truthGroupOf: buildTruthFamilyGroups(form499Rows, providerRows),
			label: "withheld-injected",
			holdingCompanyWithheld: true,
			injectEvidence: injectSubsidiaryFamily,
		})
	}

	it("moves the score off zero when ownership arrives as filer_family rows", async () => {
		const injected = await runInjected()

		// The Cascade registrants account for 3 of the 6 true pairs, and the Meridian pairs stay unlinked.
		expect(injected.score.truePositivePairs).toBe(3)
		expect(injected.score.falsePositivePairs).toBe(0)
		expect(injected.score.recall).toBe(0.5)
		expect(injected.score.precision).toBe(1)
		expect(injected.score.f1).toBeCloseTo(2 / 3)
	})

	it("scores a relationship the builder never emits — the prediction is not holding_company-only", async () => {
		const injected = await runInjected()

		expect(injected.predictedFamilyIDsOf.get(FRN_CASCADE_1)).toEqual([INJECTED_FAMILY_ID])
	})

	it("counts the injected rows in the census", async () => {
		const injected = await runInjected()

		// The census counts every ownership relationship, including ones the builder never writes.
		expect(injected.census.scoredFamilyRows).toBe(3)
		expect(injected.census.nonOwnershipFamilyRows).toBe(2)
		expect(injected.census.familyRows).toBe(5)
	})

	it("keeps the leakage check armed while the probe runs — the check sees the untouched build", async () => {
		// The injected rows would fail the leakage check.
		// The run succeeds only because the check reads the census before the injection writes.
		await expect(runInjected()).resolves.toBeDefined()
	})

	// This relationship string is missing from `FilerRelationship`.
	const UNRECOGNIZED_RELATIONSHIP = "transfer_of_control"

	const injectFamilyRowsWithRelationship = async (
		db: DatabaseClient<FilerDatabase>,
		relationship: string
	): Promise<void> => {
		for (const frn of [FRN_CASCADE_1, FRN_CASCADE_2, FRN_CASCADE_3]) {
			await db
				.insertInto("filer_family")
				.values({
					node_id: `frn:${frn}`,
					family_id: INJECTED_FAMILY_ID,
					naming_node_id: INJECTED_FAMILY_ID,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship,
					source: "linkage-eval-injection-probe",
					source_vintage: "2026-eval-v1",
					valid_from: "2026-01-01",
					valid_to: null,
				})
				.execute()
		}
	}

	it("counts an unrecognized relationship in its own census bucket, not as non-ownership", async () => {
		const form499Rows = buildLinkageEvalForm499Rows()
		const providerRows = buildLinkageEvalProviderRows()

		const injected = await runLinkagePass({
			inputs: buildFilteredEvalInputs(),
			registrants: buildTruthRegistrants(form499Rows, providerRows),
			truthGroupOf: buildTruthFamilyGroups(form499Rows, providerRows),
			label: "withheld-unrecognized",
			holdingCompanyWithheld: true,
			injectEvidence: (db) => injectFamilyRowsWithRelationship(db, UNRECOGNIZED_RELATIONSHIP),
		})

		// Unrecognized relationships get their own count so the leakage check can fail on them.
		expect(injected.census.unrecognizedFamilyRows).toBe(3)
		expect(injected.census.nonOwnershipFamilyRows).toBe(2)
		expect(injected.census.scoredFamilyRows).toBe(0)
		expect(injected.census.familyRows).toBe(5)
	})

	it("does NOT move when the same ownership fact arrives only as filer_edge rows (the EDGAR-importer precondition)", async () => {
		const form499Rows = buildLinkageEvalForm499Rows()
		const providerRows = buildLinkageEvalProviderRows()

		// These are the edges an EDGAR importer writes.
		// The family readers use only `filer_family`, so edges alone leave recall at zero.
		const injected = await runLinkagePass({
			inputs: buildFilteredEvalInputs(),
			registrants: buildTruthRegistrants(form499Rows, providerRows),
			truthGroupOf: buildTruthFamilyGroups(form499Rows, providerRows),
			label: "withheld-edges-only",
			holdingCompanyWithheld: true,
			injectEvidence: async (db) => {
				await db
					.insertInto("filer_node")
					.values({ node_id: INJECTED_FAMILY_ID, identifier_type: "cik", identifier_value: "0001234567" })
					.execute()

				for (const frn of [FRN_CASCADE_1, FRN_CASCADE_2, FRN_CASCADE_3]) {
					await db
						.insertInto("filer_edge")
						.values({
							from_node_id: `frn:${frn}`,
							to_node_id: INJECTED_FAMILY_ID,
							// The relationship describes what the target is to the source, so the CIK is the parent.
							relationship: FilerRelationship.ParentCompany,
							assertion: "inferred",
							match_score: 0.92,
							source: "edgar-exhibit-21",
							source_vintage: "2026-eval-v1",
							valid_from: "2026-01-01",
							valid_to: null,
						})
						.execute()
				}
			},
		})

		// The census shows the edges were written.
		expect(injected.census.ownershipEdges).toBe(3)
		expect(injected.score.truePositivePairs).toBe(0)
		expect(injected.score.recall).toBe(0)
		expect(injected.census.scoredFamilyRows).toBe(0)
	})

	it("does not score an Object.prototype key as ownership", async () => {
		const form499Rows = buildLinkageEvalForm499Rows()
		const providerRows = buildLinkageEvalProviderRows()

		// A bare lookup of "constructor" in a plain object returns an inherited function, which is truthy.
		const injected = await runLinkagePass({
			inputs: buildFilteredEvalInputs(),
			registrants: buildTruthRegistrants(form499Rows, providerRows),
			truthGroupOf: buildTruthFamilyGroups(form499Rows, providerRows),
			label: "withheld-prototype-key",
			holdingCompanyWithheld: true,
			injectEvidence: (db) => injectFamilyRowsWithRelationship(db, "constructor"),
		})

		expect(injected.predictedFamilyIDsOf.get(FRN_CASCADE_1)).toEqual([])
		expect(injected.score.truePositivePairs).toBe(0)
		expect(injected.census.scoredFamilyRows).toBe(0)
		expect(injected.census.unrecognizedFamilyRows).toBe(3)

		// The published census rows must sum to the total.
		const { scoredFamilyRows, nonOwnershipFamilyRows, unrecognizedFamilyRows, familyRows } = injected.census

		expect(scoredFamilyRows + nonOwnershipFamilyRows + unrecognizedFamilyRows).toBe(familyRows)
	})

	it("refuses to report a withheld build carrying a relationship it cannot classify", () => {
		// The prediction ignores an unrecognized relationship, but the leakage check must fail on one.
		expect(() =>
			assertNoOwnershipLeak({
				holdingCompanyNodes: 0,
				ownershipEdges: 0,
				scoredFamilyRows: 0,
				nonOwnershipFamilyRows: 2,
				unrecognizedFamilyRows: 3,
				familyRows: 5,
			})
		).toThrow(/unrecognized relationship/)

		// The check passes on the census that the real withheld build produces.
		expect(() =>
			assertNoOwnershipLeak({
				holdingCompanyNodes: 0,
				ownershipEdges: 0,
				scoredFamilyRows: 0,
				nonOwnershipFamilyRows: 2,
				unrecognizedFamilyRows: 0,
				familyRows: 2,
			})
		).not.toThrow()
	})
})
