/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode filerLinkageEval} (3b Task 4, decisions 3 & 4). Gate 4's structural requirements
 *   live here — the truth field's absence from the withheld run's input (asserted against the SAME
 *   `buildFilteredEvalInputs()` seam the eval itself calls, not a parallel copy), and reproducibility — plus
 *   the POSITIVE CONTROL the task 4 review added: the control run's perfect score is asserted, so stubbing
 *   the prediction predicate kills a test instead of leaving 19/19 green. Runs the REAL
 *   `buildFilerDatabase`/`clusterFilers` pipeline end to end against scratch on-disk artifacts.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { DatabaseClient } from "@mailwoman/core/kysley/client"
import { describe, expect, it } from "vitest"

import { FilerRelationship, type FilerDatabase } from "../schema.ts"
import { toFRN } from "../sdk/frn.ts"
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
} from "./linkage-corpus.ts"
import {
	assertNoOwnershipLeak,
	filerLinkageEval,
	runLinkagePass,
	type FilerLinkageEvalResult,
	type LinkageEvalRun,
} from "./linkage-eval.ts"

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

const PUBLISHED_REPORT_PATH = join(
	import.meta.dirname,
	"..",
	"..",
	"docs",
	"articles",
	"evals",
	`${PUBLISHED_LINKAGE_EVAL_DATE}-filer-linkage.md`
)

const MANAGEMENT_FAMILY_ID = "management_company_name:timberline management"

/**
 * A family id no writer in this repo mints — deliberately not `holding_company_name:`-shaped, so the standing guarantee
 * below cannot pass by accident through a code path that special-cases the builder's own namespace.
 */
const INJECTED_FAMILY_ID = "cik:0001234567"

/**
 * One eval run shared by every test below — `filerLinkageEval` builds two real SQLite artifacts and runs the full
 * clustering pass twice, so re-running it per test would multiply that for no added coverage. The reproducibility test
 * runs its own second pass on purpose.
 */
let cached: Promise<FilerLinkageEvalResult> | undefined

function runEval(): Promise<FilerLinkageEvalResult> {
	cached ??= filerLinkageEval({ date: PUBLISHED_LINKAGE_EVAL_DATE, printMarkdown: false })

	return cached
}

describe("buildFilteredEvalInputs — decision 4's leakage exclusion (gate 4)", () => {
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

describe("buildTruthRegistrants — the scored unit (task 4 review fix, C2)", () => {
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
		// The parent is on 9100000011's filing; the registrant is scored under 9100000010. Before the C2 fix these were
		// two ids in two different truth families — one legal entity asserted to be in two families at once.
		expect(truth().get(FRN_SHARED_REGISTRANT_1)).toBe(truth().get(FRN_MERIDIAN_1))
		expect(truth().has(FRN_SHARED_REGISTRANT_2)).toBe(false)
	})

	it("keeps every family id in the label when one registrant names TWO parents (task 4 re-review, m1)", () => {
		// Unreachable on the shipped corpus, reachable on any edit that adds a registrant naming two parents. Keying the
		// accumulator on the union-find root as it stood MID-loop dropped whichever id was recorded before a later union
		// re-rooted the component — the partition stayed correct, the published label silently lost a name.
		// Both parents are unique to this registrant, so its label depends ONLY on its own accumulated set — no other
		// registrant's contribution can put a dropped id back via the component roll-up and mask the bug.
		//
		// BOTH ORIENTATIONS are asserted, and that is the whole test. `union` merges toward the lexicographically smaller
		// root, so exactly one ordering of any two parent names re-roots the component AWAY from the key the first id was
		// filed under — and only that one orphans anything. The first version of this test fixed the Form 499 parent as
		// "Northbridge" and the provider parent as "Southgate", which is the safe ordering: the second union re-rooted
		// ONTO the existing key, nothing was dropped, and the test passed against the unfixed code. Naming both parents
		// per orientation removes the coin-flip.
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

		// The FULL joined label, not a substring: the id set is what gets published, and `toContain(":northbridge")`
		// would pass just as happily on a label that had lost the other parent.
		const expected = "holding_company_name:northbridge holdings + holding_company_name:southgate capital partners"

		// Equal to each other AND equal to the full expected set — the label is a property of the registrant, not of
		// which source happened to be read first.
		expect(northbridgeFirst).toBe(expected)
		expect(southgateFirst).toBe(expected)
	})

	it("does NOT treat a shared management company as a truth family", () => {
		expect(truth().get(FRN_COMANAGED)).toBe(`singleton:${FRN_COMANAGED}`)
		expect(truth().get(FRN_COMANAGED)).not.toBe(truth().get(FRN_CASCADE_3))
	})
})

describe("the corpus's own invariants", () => {
	it("never restates one row's holdingCompany inside another row's name fields (task 4 re-review, m4)", () => {
		// The corpus docstring claims withholding cannot be defeated through a name field that happens to repeat a
		// parent's name. Nothing checked it, and the leakage census could not see it: a legal name is an attribute, not
		// an ownership row, so a restated parent would sail past the gate and quietly feed the entity-resolution pass.
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

	it("matches the SHA published in the committed scorecard (task 4 review fix, I3)", () => {
		// Before this pin, the published hash lived only in the markdown file — editing the corpus staled the
		// scorecard silently, with nothing failing.
		expect(hashLinkageEvalInputs(buildFilteredEvalInputs())).toBe(PUBLISHED_WITHHELD_INPUTS_SHA256)
		expect(hashLinkageEvalInputs(buildControlEvalInputs())).toBe(PUBLISHED_CONTROL_INPUTS_SHA256)
	})
})

describe("filerLinkageEval — reproducibility (gate 4)", () => {
	it("reproduces identical scores and input SHAs across two independent runs", async () => {
		const first = await runEval()
		const second = await filerLinkageEval({ date: PUBLISHED_LINKAGE_EVAL_DATE, printMarkdown: false })

		expect(second.withheld.score).toEqual(first.withheld.score)
		expect(second.control.score).toEqual(first.control.score)
		expect(second.withheld.inputsSHA256).toBe(first.withheld.inputsSHA256)
		expect(second.markdown).toBe(first.markdown)
	})

	it("regenerates the committed scorecard byte for byte (task 4 review fix, I3)", async () => {
		const { markdown } = await runEval()

		expect(markdown).toBe(await readFile(PUBLISHED_REPORT_PATH, "utf8"))
	})

	it("emits a markdown report — no embedded JSON, headed by a dated H1", async () => {
		const { markdown, withheld, control } = await runEval()

		expect(markdown.startsWith(`# ${PUBLISHED_LINKAGE_EVAL_DATE} — does filer.db recover corporate family`)).toBe(true)
		expect(markdown).toContain("## Results")
		expect(markdown).toContain(withheld.inputsSHA256)
		expect(markdown).toContain(control.inputsSHA256)
		expect(markdown).not.toMatch(/[{[]"[a-zA-Z]/) // no inline JSON-object/array literal
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

		// The parent sits on 9100000011's filing; the registrant is scored under 9100000010. A prediction that read
		// only the representative FRN's own node would miss this.
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
		// I2: undefined, not zero — "claimed nothing" is not "claimed wrongly".
		expect(withheld.score.f1).toBeNull()
	})

	it("scores over registrant pairs, so the two runs share one truth partition", async () => {
		const { withheld, control, registrants } = await runEval()

		expect(registrants).toHaveLength(11)
		expect(withheld.score.totalPairs).toBe(55)
		expect(withheld.score.totalPairs).toBe(control.score.totalPairs)
	})
})

describe("filerLinkageEval — what is really in the artifacts (task 4 review fix, I4)", () => {
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
		// Cascade 3 keeps its ownership family in the control run and loses only the management one.
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

describe("the standing guarantee: this baseline CAN be beaten (task 4 re-review)", () => {
	/**
	 * The three Cascade registrants, joined to one ownership family by a relationship the BUILDER never emits —
	 * `subsidiary`, the shape a corporate-filing importer is specified to produce. Injected into the withheld artifact
	 * after the leakage gate has already passed on the untouched build, so the gate stays armed while the probe runs.
	 */
	const injectSubsidiaryFamily = async (db: DatabaseClient<FilerDatabase>): Promise<void> => {
		for (const frn of [FRN_CASCADE_1, FRN_CASCADE_2, FRN_CASCADE_3]) {
			await db
				.insertInto("filer_family")
				.values({
					node_id: `frn:${frn}`,
					family_id: INJECTED_FAMILY_ID,
					naming_node_id: INJECTED_FAMILY_ID,
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

		return runLinkagePass({
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

		// 3 of the 6 truth-positive pairs are the Cascade ones; none of the Meridian pairs is reachable from this
		// injection, so recall lands at exactly one half with nothing falsely merged.
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

	it("counts the injected rows in the census (task 4 re-review, I2)", async () => {
		const injected = await runInjected()

		// The pre-fix census counted `holding_company` only and would have read 0 here, under a heading promising the
		// numbers were counted from the build.
		expect(injected.census.scoredFamilyRows).toBe(3)
		expect(injected.census.nonOwnershipFamilyRows).toBe(2)
		expect(injected.census.familyRows).toBe(5)
	})

	it("keeps the leakage gate armed while the probe runs — the gate sees the untouched build", async () => {
		// The injection adds exactly the ownership rows the gate refuses. It does not throw, because the gate reads the
		// census BEFORE the probe writes; break that ordering and this test starts throwing instead of scoring.
		await expect(runInjected()).resolves.toBeDefined()
	})

	/**
	 * A relationship string that is not a {@linkcode FilerRelationship} value at all — the shape a `filer_family` row
	 * would carry if some future writer, or a hand-edited artifact, put an assertion in the table that this eval has
	 * never been taught to classify.
	 */
	const UNRECOGNIZED_RELATIONSHIP = "transfer_of_control"

	const injectUnrecognizedFamily = async (db: DatabaseClient<FilerDatabase>): Promise<void> => {
		for (const frn of [FRN_CASCADE_1, FRN_CASCADE_2, FRN_CASCADE_3]) {
			await db
				.insertInto("filer_family")
				.values({
					node_id: `frn:${frn}`,
					family_id: INJECTED_FAMILY_ID,
					naming_node_id: INJECTED_FAMILY_ID,
					relationship: UNRECOGNIZED_RELATIONSHIP,
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
			injectEvidence: injectUnrecognizedFamily,
		})

		// The exhaustiveness refactor briefly folded unrecognized relationships in with `management_company`, because both
		// simply failed the ownership test. That put the one class the eval cannot reason about on the SILENT side of the
		// gate. It gets its own bucket so the gate can refuse on it and the published census cannot hide it.
		expect(injected.census.unrecognizedFamilyRows).toBe(3)
		expect(injected.census.nonOwnershipFamilyRows).toBe(2)
		expect(injected.census.scoredFamilyRows).toBe(0)
		expect(injected.census.familyRows).toBe(5)
	})

	it("refuses to report a withheld build carrying a relationship it cannot classify", () => {
		// The gate's default must be the OPPOSITE of the prediction's. The prediction ignores what it does not understand
		// (never score an unrecognized assertion); the gate must refuse it (an assertion this eval cannot classify, in a
		// build it did not write, is exactly what a leakage check exists to stop). One predicate cannot serve both.
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

		// …and stays quiet on the shape the withheld build actually produces, so the gate is not simply always-throwing.
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
