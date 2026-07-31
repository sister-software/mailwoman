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

import { describe, expect, it } from "vitest"

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
import { filerLinkageEval, type FilerLinkageEvalResult } from "./linkage-eval.ts"

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

	it("does NOT treat a shared management company as a truth family", () => {
		expect(truth().get(FRN_COMANAGED)).toBe(`singleton:${FRN_COMANAGED}`)
		expect(truth().get(FRN_COMANAGED)).not.toBe(truth().get(FRN_CASCADE_3))
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
	it("leaves NO ownership node, edge or family row in the withheld build", async () => {
		const { withheld } = await runEval()

		expect(withheld.census.holdingCompanyNodes).toBe(0)
		expect(withheld.census.holdingCompanyEdges).toBe(0)
		expect(withheld.census.holdingCompanyFamilyRows).toBe(0)
	})

	it("DOES leave management-company filer_family rows there — the old page claimed none could exist", async () => {
		const { withheld } = await runEval()

		expect(withheld.census.managementCompanyFamilyRows).toBe(2)
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

		expect(control.census.holdingCompanyNodes).toBeGreaterThan(0)
		expect(control.census.holdingCompanyEdges).toBeGreaterThan(0)
		expect(control.census.holdingCompanyFamilyRows).toBeGreaterThan(0)
	})
})
