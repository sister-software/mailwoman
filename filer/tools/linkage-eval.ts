/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `filerLinkageEval` (decisions 3 & 4) — measures whether a `filer.db` build places two registrants
 *   in the same CORPORATE FAMILY, and how much of that answer depends on the filer having disclosed its
 *   parent.
 *
 *   **What the prediction is read from.** Two registrants are
 *   predicted to be the same family iff `filer_family` places them in a common family as of
 *   {@linkcode EVAL_AS_OF}, read through the shipped reader (`family-rollup.ts`'s `familyRollup`) rather
 *   than a query written for this eval. That is where corporate-family membership actually lives: the
 *   builder writes one `filer_family` row per holding-/management-company edge, and every reader on the
 *   product surface answers "which families does this node belong to" from that table.
 *
 *   `filer_cluster` is the wrong table for this question, and wrong in a way that looks like a result: it
 *   is the ENTITY-resolution output, answering "are these two identifiers the same legal entity". An eval
 *   pointed at it scores 0.000 — and scores exactly 0.000 with the truth field fully present, with the
 *   answer handed back as an authoritative ownership edge, and with two same-family filers given
 *   byte-identical legal names. A measurement that cannot move when it is handed the answer is not
 *   measuring anything, which is the whole job of the control run below.
 *
 *   **The two runs.** Both build a real scratch `filer.db` from the same authored corpus and run the same
 *   shipped pipeline; they differ in one field.
 *
 *   - `withheld` — `holdingCompany` cleared on every input row ({@linkcode buildFilteredEvalInputs}) before
 *     `buildFilerDatabase` ever sees it. This is the measurement: can family membership be recovered
 *     WITHOUT the disclosure?
 *   - `control` — the identical corpus with `holdingCompany` intact. This is not a product result (a
 *     pipeline that transcribes a disclosed field should score 1.000 on it); it is the check that the
 *     harness reads a table the truth can actually reach, so that the withheld run's number is falsifiable.
 *
 *   **Truth.** Two registrants belong to the same corporate family iff their reported `holdingCompany`
 *   values canonicalize to the same string ({@linkcode mintFamilyID}, the builder's own rule). The unit is
 *   the REGISTRANT, not the FRN: two FRNs that share a `bdc_provider_id` are one legal entity, so
 *   {@linkcode buildTruthRegistrants} folds them into a single scored id before any family label is
 *   assigned. Scoring them as two ids would let the truth partition claim one company sits in two
 *   different families at once.
 *
 *   **Management-company families are excluded from both truth and prediction, deliberately.** The builder
 *   also writes a `filer_family` row for a reported `managementCompany`, under a separately namespaced
 *   `management_company_name:` family id. Operational control is not ownership, `managementCompany` is not
 *   withheld by this eval, and the truth partition makes no claim about it — counting a shared manager as
 *   evidence of shared ownership would let a field this eval does NOT withhold answer a question about one
 *   it does. The corpus contains two filers reporting the same management company precisely so that
 *   exclusion is load-bearing rather than theoretical: including them would show up immediately as a false
 *   positive in the control run.
 *
 *   The corpus itself, the two input projections and the truth construction live in `linkage-corpus.ts` —
 *   pure data and pure functions, auditable without running anything. This file is the part that has to
 *   run: build, cluster, count, read, score, render.
 */

import { chmodSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"

import { FilerIdentifierType, FilerRelationship, type FilerDatabase } from "../schema.ts"
import { buildFilerDatabase } from "../sdk/build-filer.ts"
import { clusterFilers, type InferredClusterResult } from "../sdk/cluster-filers.ts"
import { familyRollup } from "../sdk/family-rollup.ts"
import type { Form499Row } from "../sdk/form499.ts"
import type { FRN } from "../sdk/frn.ts"
import type { ProviderListRow } from "../sdk/provider-list.ts"
import {
	buildControlEvalInputs,
	buildFilteredEvalInputs,
	buildLinkageEvalForm499Rows,
	buildLinkageEvalProviderRows,
	buildTruthFamilyGroups,
	buildTruthRegistrants,
	hashLinkageEvalInputs,
	type LinkageEvalInputs,
	type LinkageEvalRegistrant,
} from "./linkage-corpus.ts"
import { groupPredicateFromMap, scorePairwiseGrouping, type PairwiseGroupingScore } from "./linkage-metrics.ts"

/**
 * `sourceVintage`/`validFrom` for the eval's own `buildFilerDatabase`/`clusterFilers` calls — FIXED constants, never
 * "today", so a re-run at a different wall-clock date builds byte-identical `filer_edge`/`filer_family` provenance
 * columns (gate 4's reproducibility clause).
 */
const EVAL_SOURCE_VINTAGE = "2026-eval-v1"
const EVAL_VALID_FROM = "2026-01-01"

/**
 * The `asOf` date every `filer_family` read in this eval is scoped to — a FIXED constant, later than the latest
 * `lastFiledAt` in the corpus and never "today", for the same reproducibility reason as the two constants above. A
 * family membership is a temporal fact in this schema (`valid_from`/`valid_to`), so "predicted same family" is only
 * well-defined relative to a date; this is that date.
 */
const EVAL_AS_OF = "2026-06-01"

/**
 * `buildFilerDatabase`'s `buildSHA` for this eval's artifact — a fixed label (not a real `git rev-parse`) since this is
 * a synthetic, in-repo corpus with no git-tracked source file of its own to attribute the build to.
 */
const EVAL_BUILD_SHA = "filer-linkage-eval"

/**
 * What a built artifact actually contains that bears on ownership — counted, not asserted. The withheld artifact is not
 * family-row-free: two `filer_family` rows reach it from the corpus's management-company disclosures, so the one page
 * whose credibility rests on the withholding being real has to measure the artifact rather than describe it.
 *
 * **Every count here is scoped to what the PREDICTION scores, not to `holding_company` alone.** The prediction accepts
 * any `filer_family` membership whose relationship asserts OWNERSHIP — `holding_company` today,
 * `parent_company`/`subsidiary` the moment a writer emits one. Counting only `holding_company` leaves the census silent
 * about exactly the rows a future evidence channel will add: three injected `subsidiary` family rows move recall from
 * 0.000 to 0.500 while a `holding_company`-only census still reads `0`, under a heading promising the numbers were
 * counted from the build.
 */
export interface LeakageCensus {
	/**
	 * `filer_node` rows of type `holding_company_name` — one per distinct raw parent name in the input.
	 */
	holdingCompanyNodes: number
	/**
	 * `filer_edge` rows whose relationship asserts OWNERSHIP ({@linkcode OWNERSHIP_BY_RELATIONSHIP}) — today
	 * `holding_company`, and `parent_company`/`subsidiary` the moment a writer emits one. Note that an ownership EDGE
	 * alone moves no score: see {@linkcode renderWhySection}.
	 */
	ownershipEdges: number
	/**
	 * `filer_family` rows the prediction will score — every membership whose relationship asserts OWNERSHIP
	 * ({@linkcode OWNERSHIP_BY_RELATIONSHIP}). Must be 0 in the withheld build.
	 */
	scoredFamilyRows: number
	/**
	 * `filer_family` rows carrying a recognized relationship that asserts something OTHER than ownership — today that is
	 * `management_company` only, since no writer emits a `same_entity` family row. Non-zero in BOTH runs:
	 * `managementCompany` is not the field under test, and the prediction ignores these.
	 */
	nonOwnershipFamilyRows: number
	/**
	 * `filer_family` rows whose relationship is not a {@linkcode FilerRelationship} value at all — impossible from any
	 * shipped writer, so a non-zero count means a row this build did not write. Counted separately rather than folded
	 * into either bucket, and the gate REFUSES on it: an assertion the eval cannot classify is exactly what a leakage
	 * check should stop on, not something to file under "not ownership" and pass.
	 */
	unrecognizedFamilyRows: number
	/**
	 * Every `filer_family` row in the artifact. Published alongside the splits so a relationship class nobody anticipated
	 * cannot hide between them — and, since the three splits are exhaustive by construction, so the reader can check they
	 * sum to this.
	 */
	familyRows: number
}

/**
 * Whether each {@linkcode FilerRelationship} asserts OWNERSHIP — the thing this eval withholds and scores — as opposed
 * to operational control or plain identity.
 *
 * **Exhaustive by construction, and that is the point.** Expressed the obvious way — two DENYLISTS typed `readonly
 * string[]`, naming the relationships that don't count — a relationship class added to `FilerRelationship` later falls
 * through to "counts as ownership" silently, in BOTH the prediction and the leakage census, scoring a fact nobody
 * decided should be scored and doing it without a test failing. The `satisfies Record<FilerRelationship, boolean>` pin
 * below inverts that default: a new member is a COMPILE error here until someone classifies it deliberately. Same idiom
 * the BDC plausibility gate uses (`bdc/sdk/plausibility.test.ts`'s `satisfies Record<keyof PlausibilityBundle, true>`).
 * Unlike the `satisfies` pins that live in TEST files — which only `yarn typecheck:tests` evaluates — this one sits in
 * a source file inside `filer/tsconfig.json`'s default include, so plain `tsc -b` enforces it: dropping a member fails
 * with TS1360 naming the missing relationship.
 *
 * `SameEntity` is false because two identifiers denoting ONE filer say nothing about who owns it; `ManagementCompany`
 * because operational control is not ownership (spec §3.1 finding 1, and the reason this eval excludes management
 * families from both prediction and truth). `HoldingCompany`, `ParentCompany` and `Subsidiary` each assert an ownership
 * relation between two DIFFERENT entities, which is exactly what a withheld-parent run must not be able to see.
 */
const OWNERSHIP_BY_RELATIONSHIP = {
	[FilerRelationship.SameEntity]: false,
	[FilerRelationship.ManagementCompany]: false,
	[FilerRelationship.HoldingCompany]: true,
	[FilerRelationship.ParentCompany]: true,
	[FilerRelationship.Subsidiary]: true,
} as const satisfies Record<FilerRelationship, boolean>

/**
 * Does this relationship assert ownership? Single source of truth for {@linkcode readLeakageCensus}'s "scored" count
 * and {@linkcode readRegistrantFamilies}'s filter, so the census can never promise to police rows the prediction
 * quietly scored, or vice versa. An unrecognized value is treated as NON-ownership: it cannot come from
 * `FilerRelationship` (the pin above makes that a compile error), so it is a raw string read back from a
 * `filer_family`/`filer_edge` row this build did not write, and silently scoring an unknown assertion as ownership is
 * the failure this exists to stop.
 *
 * **The {@linkcode isRecognizedRelationship} guard is required, not belt-and-braces.** `OWNERSHIP_BY_RELATIONSHIP` is a
 * plain object literal, so a bare index lookup inherits `Object.prototype`: `relationship === "constructor"` (or
 * `"toString"`, or `"__proto__"`) resolves to a FUNCTION, which is truthy and never nullish, so `??` does not fire and
 * the lookup answers `true` for a string it does not classify — the precise failure the paragraph above says it exists
 * to stop. Measured through the real builder: three injected `constructor` family rows score as ownership AND land in
 * the unrecognized bucket, so the three census splits sum to 8 against a published total of 5.
 */
function assertsOwnership(relationship: string): boolean {
	return isRecognizedRelationship(relationship) && OWNERSHIP_BY_RELATIONSHIP[relationship as FilerRelationship]
}

/**
 * Is this relationship one {@linkcode OWNERSHIP_BY_RELATIONSHIP} actually classifies? Distinct from
 * {@linkcode assertsOwnership} because the PREDICTION and the GATE want opposite defaults for a string neither
 * recognizes, and one predicate cannot serve both.
 *
 * The prediction must not score an assertion it does not understand, so unknown → not ownership → ignored. The gate
 * exists to REFUSE publication when the withheld build holds ownership facts it should never have seen, and "a
 * relationship this eval does not recognize, in a build it did not write" is precisely the case it should refuse rather
 * than quietly bucket as non-ownership. Collapse the two call sites onto `assertsOwnership` alone and the gate narrows
 * to nothing on exactly that case: three injected `transfer_of_control` family rows leave `scoredFamilyRows: 0` and the
 * gate silent.
 */
function isRecognizedRelationship(relationship: string): boolean {
	return Object.hasOwn(OWNERSHIP_BY_RELATIONSHIP, relationship)
}

async function readLeakageCensus(db: DatabaseClient<FilerDatabase>): Promise<LeakageCensus> {
	const nodes = await db
		.selectFrom("filer_node")
		.select("node_id")
		.where("identifier_type", "=", FilerIdentifierType.HoldingCompanyName)
		.execute()

	const edges = await db.selectFrom("filer_edge").select("relationship").execute()
	const familyRows = await db.selectFrom("filer_family").select("relationship").execute()

	return {
		holdingCompanyNodes: nodes.length,
		ownershipEdges: edges.filter((row) => assertsOwnership(row.relationship)).length,
		scoredFamilyRows: familyRows.filter((row) => assertsOwnership(row.relationship)).length,
		nonOwnershipFamilyRows: familyRows.filter(
			(row) => isRecognizedRelationship(row.relationship) && !assertsOwnership(row.relationship)
		).length,
		unrecognizedFamilyRows: familyRows.filter((row) => !isRecognizedRelationship(row.relationship)).length,
		familyRows: familyRows.length,
	}
}

/**
 * Hard gate on the withheld build (decision 4). The leakage exclusion is structural —
 * {@linkcode buildFilteredEvalInputs} is the only thing that builds what the builder receives — but "structural" is an
 * argument, and this is a check: if any ownership artifact survives into the withheld build, the eval refuses to report
 * a number rather than reporting a flattered one. Runs against the census taken straight off the BUILD, before any
 * injected evidence, so a deliberate probe can still be measured without disarming the gate.
 */
export function assertNoOwnershipLeak(census: LeakageCensus): void {
	if (census.holdingCompanyNodes || census.ownershipEdges || census.scoredFamilyRows || census.unrecognizedFamilyRows) {
		throw new Error(
			"filerLinkageEval: the withheld build contains ownership facts it was supposed to have never seen " +
				`(${census.holdingCompanyNodes} holding_company_name nodes, ${census.ownershipEdges} ownership edges, ` +
				`${census.scoredFamilyRows} scoreable filer_family rows, ${census.unrecognizedFamilyRows} filer_family rows ` +
				"carrying an unrecognized relationship) — the withheld run's score would be measuring the truth field it is " +
				"meant to withhold. Refusing to report it."
		)
	}
}

/**
 * Every `filer_family` family a registrant's nodes belong to, split into the ones the prediction uses and the full set.
 */
interface RegistrantFamilies {
	/**
	 * Family ids the prediction treats as evidence of shared ownership — everything except a membership this node holds
	 * only by way of a relationship that does not assert ownership (see the module docstring).
	 */
	predicted: Map<FRN, string[]>
	/**
	 * Every family id any of the registrant's nodes belongs to, management included. Reported, never scored.
	 */
	observed: Map<FRN, string[]>
}

/**
 * Read each registrant's corporate-family memberships through the SHIPPED reader (`familyRollup`), at
 * {@linkcode EVAL_AS_OF}. This is the eval's entire prediction: no query is written here that a product caller couldn't
 * make, and nothing about the clustering output is consulted.
 */
async function readRegistrantFamilies(
	db: DatabaseClient<FilerDatabase>,
	registrants: readonly LinkageEvalRegistrant[]
): Promise<RegistrantFamilies> {
	const predicted = new Map<FRN, string[]>()
	const observed = new Map<FRN, string[]>()

	for (const registrant of registrants) {
		const used = new Set<string>()
		const all = new Set<string>()

		for (const nodeID of registrant.nodeIDs) {
			for (const rollup of await familyRollup(db, { nodeID, asOf: EVAL_AS_OF })) {
				all.add(rollup.family_id)

				const ownThisNode = rollup.members.filter((member) => member.node_id === nodeID)

				if (ownThisNode.some((member) => assertsOwnership(member.relationship))) {
					used.add(rollup.family_id)
				}
			}
		}

		predicted.set(registrant.representative, [...used].toSorted())
		observed.set(registrant.representative, [...all].toSorted())
	}

	return { predicted, observed }
}

/**
 * One truth-positive pair (two registrants the withheld `holdingCompany` field puts in the same real family) and
 * whether the run recovered it — the report's per-pair table.
 */
export interface TruthPositivePairOutcome {
	a: FRN
	b: FRN
	familyID: string
	recovered: boolean
}

function findTruthPositivePairs(
	representatives: readonly FRN[],
	truthGroupOf: ReadonlyMap<FRN, string>,
	predictedSame: (a: FRN, b: FRN) => boolean
): TruthPositivePairOutcome[] {
	const outcomes: TruthPositivePairOutcome[] = []

	for (let i = 0; i < representatives.length; i++) {
		for (let j = i + 1; j < representatives.length; j++) {
			const a = representatives[i]!
			const b = representatives[j]!
			const familyID = truthGroupOf.get(a)

			// A `singleton:` label embeds its own representative, so it can never equal another registrant's label —
			// no separate singleton check is needed here.
			if (familyID === undefined || familyID !== truthGroupOf.get(b)) continue

			outcomes.push({ a, b, familyID, recovered: predictedSame(a, b) })
		}
	}

	return outcomes
}

function formatScoreValue(value: number | null): string {
	return value === null ? "N/A" : value.toFixed(3)
}

/**
 * Renders a GitHub-flavoured markdown table already padded the way `oxfmt` would pad it — column width is the widest
 * cell, separator dashes fill it. Unpadded output fails `oxfmt --check`, so a scorecard regenerated by the documented
 * `--out-md` command would leave the tree failing lint until someone reformatted it by hand.
 */
function renderTable(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string[] {
	const width = (cell: string): number => [...cell].length

	const widths = header.map((cell, column) => Math.max(3, width(cell), ...rows.map((row) => width(row[column] ?? ""))))

	const renderRow = (cells: readonly string[]): string => {
		const padded = widths.map((columnWidth, column) => {
			const cell = cells[column] ?? ""

			return cell + " ".repeat(Math.max(0, columnWidth - width(cell)))
		})

		return `| ${padded.join(" | ")} |`
	}

	return [
		renderRow(header),
		`| ${widths.map((columnWidth) => "-".repeat(columnWidth)).join(" | ")} |`,
		...rows.map(renderRow),
	]
}

/**
 * Per-field commentary for the input-shape table. Typed as a total `Record` over `keyof Form499Row` so adding a field
 * to the parser is a compile error here rather than a silently stale published claim.
 */
const FORM_499_FIELD_NOTES: Record<keyof Form499Row, string> = {
	form499ID: "",
	frn: "the truth key, never itself withheld",
	lastFiledAt: "",
	usfContributor: "",
	legalNameOfCarrier: "the entity-resolution pass's blocking key and score input",
	doingBusinessAs: "",
	principalCommType: "",
	holdingCompany: "the field under test",
	managementCompany: "control, not ownership — kept in the input, excluded from the prediction",
	hqAddress: "staged as an attribute; no code on the family or entity-resolution path reads it",
	customerInquiriesTelephone: "staged as an attribute; no code on the family or entity-resolution path reads it",
	customerInquiriesAddress: "staged as an attribute; no code on the family or entity-resolution path reads it",
	dcAgentDisplayName: "attribute only — never an edge input (shared-agent doctrine)",
	dcAgentOrganizationName: "attribute only — never an edge input",
	dcAgentTelephone: "attribute only — never an edge input",
	dcAgentEmailAddress: "attribute only — never an edge input",
	dcAgentAddress: "attribute only — never an edge input",
}

const PROVIDER_FIELD_NOTES: Record<keyof ProviderListRow, string> = {
	providerID: "registrant identity — two FRNs under one providerID are one registrant",
	frn: "the truth key, never itself withheld",
	holdingCompany: "the field under test",
}

function isPopulated(value: unknown): boolean {
	return value !== null && value !== undefined && value !== "" && value !== false
}

/**
 * How many corpus rows actually carry a value for a field — computed from the corpus, never asserted by hand. Hand
 * assertion gets this wrong in the most misleading direction available: `hqAddress`, both `customerInquiries*` fields
 * and all five `dcAgent*` fields look like channels "given to the matcher" while being `""` on every row, which is the
 * opposite of the impression a reader takes from that column — and those are the same channels the caveats name as the
 * way forward.
 */
function describeCoverage<Row>(rows: readonly Row[], field: keyof Row, heldOut: boolean): string {
	if (heldOut) return "**withheld**"

	const populated = rows.filter((row) => isPopulated(row[field])).length

	if (populated === 0) return `**0 of ${rows.length}** — never set`

	return `${populated} of ${rows.length}`
}

function renderInputShapeTables(withheld: LinkageEvalInputs, control: LinkageEvalInputs): string[] {
	const form499Rows = (Object.keys(FORM_499_FIELD_NOTES) as Array<keyof Form499Row>).map((field) => {
		const heldOut = control.form499Rows.some((row, index) => row[field] !== withheld.form499Rows[index]![field])

		return [
			`\`${field}\``,
			heldOut ? "**no**" : "yes",
			describeCoverage(withheld.form499Rows, field, heldOut),
			FORM_499_FIELD_NOTES[field],
		]
	})

	const providerRows = (Object.keys(PROVIDER_FIELD_NOTES) as Array<keyof ProviderListRow>).map((field) => {
		const heldOut = control.providerRows.some((row, index) => row[field] !== withheld.providerRows[index]![field])

		return [
			`\`${field}\``,
			heldOut ? "**no**" : "yes",
			describeCoverage(withheld.providerRows, field, heldOut),
			PROVIDER_FIELD_NOTES[field],
		]
	})

	return [
		...renderTable(["Form499Row field", "in the withheld input?", "populated in the corpus", "note"], form499Rows),
		"",
		...renderTable(
			["ProviderListRow field", "in the withheld input?", "populated in the corpus", "note"],
			providerRows
		),
	]
}

function renderCorpusTable(
	rows: readonly Form499Row[],
	registrants: readonly LinkageEvalRegistrant[],
	truthGroupOf: ReadonlyMap<FRN, string>
): string[] {
	const representativeOfFRN = new Map<FRN, FRN>()

	for (const registrant of registrants) {
		for (const frn of registrant.frns) {
			representativeOfFRN.set(frn, registrant.representative)
		}
	}

	const tableRows = rows.map((row) => {
		const frn = row.frn!
		const representative = representativeOfFRN.get(frn)!
		const group = truthGroupOf.get(representative) ?? ""

		return [
			frn,
			row.legalNameOfCarrier,
			representative === frn ? "itself" : `${representative}`,
			row.holdingCompany || "_(none)_",
			row.managementCompany || "_(none)_",
			group.startsWith("singleton:") ? "_(no family)_" : `\`${group}\``,
		]
	})

	return renderTable(
		[
			"FRN",
			"legal name (always given)",
			"registrant",
			"holding company (withheld)",
			"management company",
			"truth family",
		],
		tableRows
	)
}

function renderResultsTable(withheld: LinkageEvalRun, control: LinkageEvalRun): string[] {
	const row = (label: string, of: (run: LinkageEvalRun) => string): string[] => [label, of(withheld), of(control)]

	return renderTable(
		["metric", "withheld (the measurement)", "control (parent disclosed)"],
		[
			row("precision", (run) => formatScoreValue(run.score.precision)),
			row("recall", (run) => formatScoreValue(run.score.recall)),
			row("F1", (run) => formatScoreValue(run.score.f1)),
			row("true-positive pairs", (run) => String(run.score.truePositivePairs)),
			row("false-positive pairs", (run) => String(run.score.falsePositivePairs)),
			row("false-negative pairs", (run) => String(run.score.falseNegativePairs)),
			row("truth-positive pairs", (run) => String(run.score.truthPositivePairs)),
			row("predicted-positive pairs", (run) => String(run.score.predictedPositivePairs)),
			row("total registrant pairs scored", (run) => String(run.score.totalPairs)),
			row("input SHA-256", (run) => `\`${run.inputsSHA256.slice(0, 16)}…\``),
		]
	)
}

function renderCensusTable(withheld: LinkageEvalRun, control: LinkageEvalRun): string[] {
	const row = (label: string, of: (run: LinkageEvalRun) => number): string[] => [
		label,
		String(of(withheld)),
		String(of(control)),
	]

	return renderTable(
		["what the built artifact contains", "withheld", "control"],
		[
			row("`holding_company_name` nodes", (run) => run.census.holdingCompanyNodes),
			row("ownership `filer_edge` rows (relationship asserts ownership)", (run) => run.census.ownershipEdges),
			row(
				"`filer_family` rows the prediction scores (relationship asserts ownership)",
				(run) => run.census.scoredFamilyRows
			),
			row(
				"`filer_family` rows the prediction ignores (recognized, not ownership)",
				(run) => run.census.nonOwnershipFamilyRows
			),
			row(
				"`filer_family` rows with an unrecognized relationship (gate refuses on these)",
				(run) => run.census.unrecognizedFamilyRows
			),
			row("`filer_family` rows, total", (run) => run.census.familyRows),
			row("entity-resolution records scored", (run) => run.inferred.recordsConsidered),
			row("entity-resolution links written", (run) => run.inferred.links),
		]
	)
}

function renderPairsTable(
	pairs: readonly TruthPositivePairOutcome[],
	recoveredBy: (pair: TruthPositivePairOutcome) => string
): string[] {
	return renderTable(
		["registrant A", "registrant B", "truth family", "recovered?"],
		pairs.map((pair) => [pair.a, pair.b, `\`${pair.familyID}\``, recoveredBy(pair)])
	)
}

/**
 * One pass of the eval — one corpus projection, one built artifact, one score.
 */
export interface LinkageEvalRun {
	/**
	 * `"withheld"` or `"control"`.
	 */
	label: string
	/**
	 * Whether `holdingCompany` was cleared from this run's input.
	 */
	holdingCompanyWithheld: boolean
	inputsSHA256: string
	score: PairwiseGroupingScore
	/**
	 * The entity-resolution pass's own counters. Reported as context — this eval's prediction does not read its output.
	 */
	inferred: InferredClusterResult
	census: LeakageCensus
	/**
	 * Per scored registrant, the family ids the prediction used.
	 */
	predictedFamilyIDsOf: Map<FRN, string[]>
	/**
	 * Per scored registrant, every family id `filer_family` places its nodes in — including the management-company
	 * families the prediction deliberately ignores.
	 */
	observedFamilyIDsOf: Map<FRN, string[]>
	truthPositivePairs: TruthPositivePairOutcome[]
}

/**
 * {@linkcode runLinkagePass}'s arguments.
 */
export interface LinkageEvalPassOptions {
	inputs: LinkageEvalInputs
	registrants: readonly LinkageEvalRegistrant[]
	truthGroupOf: ReadonlyMap<FRN, string>
	label: string
	/**
	 * Whether `holdingCompany` was cleared from `inputs`. Arms {@linkcode assertNoOwnershipLeak}.
	 */
	holdingCompanyWithheld: boolean
	/**
	 * Writes evidence into the built artifact AFTER the leakage gate has passed and BEFORE the prediction is read — the
	 * seam the standing "this baseline can be beaten" test uses to simulate an evidence channel that does not exist yet.
	 * Never set by {@linkcode filerLinkageEval} itself: the two published runs measure builds nobody touched. Ordering is
	 * the point — the gate still polices what the BUILDER produced from a withheld input, so a probe can add ownership
	 * facts without disarming it.
	 */
	injectEvidence?: (db: DatabaseClient<FilerDatabase>) => Promise<void>
}

/**
 * One pass: build a scratch `filer.db` from one projection, run the shipped clustering over it, census it, read each
 * registrant's corporate families, score. Exported so a test can run the SAME code path with injected evidence rather
 * than reimplementing the pipeline beside it.
 */
export async function runLinkagePass(options: LinkageEvalPassOptions): Promise<LinkageEvalRun> {
	const { inputs, registrants, truthGroupOf, label, holdingCompanyWithheld, injectEvidence } = options

	const scratch = await mkdtemp(join(tmpdir(), `filer-linkage-eval-${label}-`))
	const out = join(scratch, "filer.db")

	try {
		await buildFilerDatabase({
			form499Rows: inputs.form499Rows,
			providerRows: inputs.providerRows,
			out,
			sourceVintage: EVAL_SOURCE_VINTAGE,
			validFrom: EVAL_VALID_FROM,
			buildSHA: EVAL_BUILD_SHA,
		})

		// buildFilerDatabase seals the artifact read-only — clusterFilers writes filer_cluster/filer_edge, so unseal
		// first (mirrors filer-lookup.test.ts's "REAL builder + REAL clusterAuthoritativeComponents" gate).
		chmodSync(out, 0o644)

		using db = new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(out) })

		// Run the full shipped pipeline, not just the builder — the entity-resolution pass is part of what produces a
		// real filer.db, and its counters belong in the report even though this eval scores a different table.
		const { inferred } = await clusterFilers(db, { sourceVintage: EVAL_SOURCE_VINTAGE, validFrom: EVAL_VALID_FROM })

		// Gate the BUILD, then inject, then census what will actually be scored. Taking one census for both jobs is what
		// let three injected `subsidiary` family rows move recall to 0.500 while the published census still read 0.
		if (holdingCompanyWithheld) {
			assertNoOwnershipLeak(await readLeakageCensus(db))
		}

		await injectEvidence?.(db)

		const census = await readLeakageCensus(db)
		const { predicted, observed } = await readRegistrantFamilies(db, registrants)

		const predictedSame = (a: FRN, b: FRN): boolean => {
			const familiesOfA = new Set(predicted.get(a))

			return (predicted.get(b) ?? []).some((familyID) => familiesOfA.has(familyID))
		}

		const representatives = registrants.map((registrant) => registrant.representative)
		const score = scorePairwiseGrouping(representatives, groupPredicateFromMap(truthGroupOf), predictedSame)

		return {
			label,
			holdingCompanyWithheld,
			inputsSHA256: hashLinkageEvalInputs(inputs),
			score,
			inferred,
			census,
			predictedFamilyIDsOf: predicted,
			observedFamilyIDsOf: observed,
			truthPositivePairs: findTruthPositivePairs(representatives, truthGroupOf, predictedSame),
		}
	} finally {
		await rm(scratch, { recursive: true, force: true })
	}
}

interface RenderLinkageEvalReportInput {
	date: string
	withheld: LinkageEvalRun
	control: LinkageEvalRun
	withheldInputs: LinkageEvalInputs
	controlInputs: LinkageEvalInputs
	registrants: readonly LinkageEvalRegistrant[]
	truthForm499Rows: readonly Form499Row[]
	truthGroupOf: ReadonlyMap<FRN, string>
}

function renderVerdict(withheld: LinkageEvalRun, control: LinkageEvalRun): string {
	return (
		"**Corporate-family membership resolves correctly when the filer discloses its parent, and not at all when it " +
		`doesn't.** Given the corpus with \`holdingCompany\` present, \`filer.db\` puts every one of the ` +
		`${control.score.truthPositivePairs} same-family registrant pairs in the same family and invents none: precision ` +
		`${formatScoreValue(control.score.precision)}, recall ${formatScoreValue(control.score.recall)}. Given the same ` +
		"corpus with that one field removed, it makes no family call at all — " +
		`${withheld.score.truePositivePairs} of ${withheld.score.truthPositivePairs} pairs recovered, recall ` +
		`${formatScoreValue(withheld.score.recall)}, precision and F1 undefined because there were no positive calls to ` +
		"score. Family membership in this pipeline is a disclosed field, transcribed and canonicalized; nothing in the " +
		"build infers one from anything else."
	)
}

function renderControlSection(control: LinkageEvalRun): string {
	return (
		"The control run is not an achievement and should not be read as one. A pipeline whose entire family mechanism " +
		'is "copy the parent name the filer wrote down, canonicalize it, and group by the result" is supposed to score ' +
		`${formatScoreValue(control.score.f1)} when handed that name. Its job here is narrower and more important: it ` +
		"proves this harness reads a table the truth can actually reach. Without it, the withheld run's zero is " +
		"unfalsifiable — an eval pointed at the wrong table reports zero too, and reports it just as confidently with " +
		"the answer sitting in the artifact. The two runs differ in exactly one field, and the input hashes below " +
		"differ accordingly."
	)
}

function renderWhySection(withheld: LinkageEvalRun): string {
	return (
		"Nothing else in the build produces an ownership fact. Two mechanisms account for that, and both are " +
		"deliberate. First, the builder writes a corporate-family row only where an input row names a parent — there is " +
		"no path from a filing to a family that does not run through a disclosed name. Second, the entity-resolution " +
		`pass (which ran here, over ${withheld.inferred.recordsConsidered} records) answers a different question: it ` +
		"decides whether two identifiers denote the same legal entity, and it will not merge two records that share no " +
		'identifier code, no matter how similar their names are. Even if it did merge them, a merge asserts "same ' +
		'company", not "same parent", so it could not populate a family. The corpus exercises that refusal on purpose: ' +
		"two of its filers canonicalize to the byte-identical legal name `american fiber partners` and are NOT the same " +
		"company. The canonical name is the blocking key, so that pair is proposed as a candidate and scored — and the " +
		"veto refuses it, which is what a veto is for."
	)
}

/**
 * The precondition a future run has to satisfy to beat this baseline, stated as narrowly as the code supports. The
 * tempting broader claim — that "any channel that actually correlates with ownership — a shared headquarters address, a
 * shared officer, an external corporate filing that names a parent — would show up here as recall above zero" — is
 * false, and has been falsified by probe twice. The page carries both falsified probes rather than dropping them: a
 * stated causal relation the data contradicts is exactly the defect this page exists not to commit, and its whole value
 * is that its claims survive being checked.
 */
function renderWhatWouldMoveItSection(): string {
	return (
		"It is tempting to call the withheld number a floor that any better evidence would lift. That is not what this " +
		"code does, and an earlier version of this page said it anyway. Two probes settle it.\n\n" +
		"**Populating the address and contact columns changes nothing.** Fill `hqAddress`, " +
		"`customerInquiriesTelephone` and `customerInquiriesAddress` identically across all three members of one family " +
		"in the withheld corpus, then rebuild, re-cluster and re-score: byte-identical result, 0 pairs recovered. Those " +
		"columns are stored as attributes and nothing on the family path — or on the entity-resolution path, which reads " +
		"only legal names and identifier codes — ever looks at them. That is a property of the pipeline, not a gap in " +
		"the corpus.\n\n" +
		"**Adding an ownership EDGE changes nothing either.** Write inferred `subsidiary` `filer_edge` rows joining those " +
		"same filers to a parent — the shape a corporate-filing importer is specified to emit — and recall stays 0.000. " +
		"Corporate-family MEMBERSHIP is read from `filer_family` alone. The family readers do query `filer_edge`, but " +
		"only to recover the raw company name behind a canonicalized family id — never to decide who belongs to a " +
		"family, which is the only thing this eval scores.\n\n" +
		"The accurate statement is narrower, and worth stating exactly: **a channel that produces a `filer_family` row " +
		"moves this number; a channel that produces only a `filer_edge` row does not.** Injecting three ownership " +
		"`filer_family` rows into the withheld build moves recall from 0.000 to 0.500 at precision 1.000. A standing test " +
		'holds that open, so "this baseline can be beaten" is re-checked on every run rather than asserted here.\n\n' +
		"That is also the forward dependency for anyone using this page as a before/after baseline. A later build beats " +
		"0.000 only if its new evidence lands as `filer_family` membership rows. An importer that writes ownership edges " +
		"and stops there re-runs to 0.000 — and it will read as though the evidence didn't help, when in fact nothing " +
		"read it."
	)
}

function renderLinkageEvalReport(input: RenderLinkageEvalReportInput): string {
	const { date, withheld, control, withheldInputs, controlInputs, registrants, truthForm499Rows, truthGroupOf } = input

	const lines: string[] = [
		`# ${date} — does filer.db recover corporate family without the disclosed parent? (3b task 4)`,
		"",
		renderVerdict(withheld, control),
		"",
		"## The question",
		"",
		"A corporate family is a set of operating companies under one parent. `filer.db` builds families from the parent " +
			"name a filer discloses — on its Form 499, or on the broadband provider list, whichever carries it; both " +
			"sources contribute rows to the control build below. The open question this eval exists to baseline is whether " +
			"that membership is recoverable for a filer that discloses NOTHING — from names, identifiers, or any other " +
			'signal already in the pipeline. Today the answer is no, and the number below is what "no" measures as, so ' +
			"that a later build with more evidence has something to beat.",
		"",
		"## The two runs",
		"",
		"Both runs build a real scratch `filer.db` from the same authored corpus with the same shipped code, and read " +
			"the prediction the same way. They differ in one field.",
		"",
		"- **withheld** — `holdingCompany` cleared on every Form 499 row and every provider-list row before the builder " +
			"sees it. The measurement.",
		"- **control** — the identical corpus, that field intact. The check on the harness.",
		"",
		renderControlSection(control),
		"",
		"### What counts as a prediction",
		"",
		"Two registrants are predicted to be the same family iff the built `filer.db` places them in a common family as " +
			`of ${EVAL_AS_OF}. Each membership is read with the shipped corporate-family reader, the one a product caller ` +
			"uses — but the eval composes it: that reader answers strictly per node, and a registrant can own several " +
			"nodes (its FRN registrations and its provider id), so the eval takes the union across them. The reader is " +
			"shipped; the union is this eval's own step, and it is why a parent disclosed on one of a registrant's two " +
			"filings still counts.\n\nMembership rows that exist only because two filers named the same MANAGEMENT " +
			"company are excluded from both the prediction and the truth: management is operational control, not " +
			"ownership; that field is not withheld here; and letting it answer would mean a field this eval hands over " +
			"deciding a question about the field it holds back. The corpus includes two filers reporting the same manager " +
			"so that exclusion has something to do.",
		"",
		"### What counts as a registrant",
		"",
		"The unit scored is the registrant, not the FRN. One operator can hold several FRN registrations — the corpus " +
			"has one that holds two, joined by a shared provider id — and a parent disclosed on one registration is a " +
			"fact about the company, not about that registration. Scoring FRNs individually would have let the truth " +
			"partition put a single legal entity in two different families at once.\n\nTreating a shared provider id as " +
			"proof of one registrant is a modelling choice, not a law: real provider-list rows sharing a provider id have " +
			"been observed reporting DIFFERENT parents, which would mean the fold is joining companies that ought to stay " +
			"apart. That failure is not silent here. Folding two registrants that belong to different families puts a " +
			"truth-negative pair inside one truth group, the control run cannot recover it, control recall drops below " +
			"1.000, and the test asserting a perfect control fails. The rule is load-bearing and wired to a tripwire.",
		"",
		"## Corpus",
		"",
		`${truthForm499Rows.length} Form 499 filers folded into ${registrants.length} registrants, authored rather than ` +
			"sampled so every truth fact is auditable here instead of trusted from an external source. Two multi-member " +
			"families whose members spell the parent name inconsistently; four standalone filers; a pair of unrelated " +
			"companies with identical canonical names; one registrant holding two FRNs where only the second discloses " +
			"the parent; and one filer that discloses no parent but names the same MANAGEMENT company as a member of the " +
			"first family, which the prediction has to decline to treat as ownership. Every row is in the table below; " +
			"the counts in this paragraph add up to it.",
		"",
		...renderCorpusTable(truthForm499Rows, registrants, truthGroupOf),
		"",
		"## Input record shape",
		"",
		"Every field the builder receives in the withheld run, and how much of it the corpus actually fills in. The " +
			"empty columns are worth reading, but not for the obvious reason: filling them in changes nothing, because " +
			'nothing on the family path reads them (see "What would move this number" below). They are listed so the ' +
			"corpus's sparsity is not mistaken for the reason the withheld run scores zero.",
		"",
		...renderInputShapeTables(withheldInputs, controlInputs),
		"",
		"## Results",
		"",
		...renderResultsTable(withheld, control),
		"",
		`F1 is reported as \`N/A\` for the withheld run rather than \`0.000\`, and that is not a rounding convention. ` +
			"Precision is undefined when a prediction makes no positive calls at all — there is no denominator — and an " +
			'F1 built on an undefined component is undefined too. "Recovered nothing because it claimed nothing" and ' +
			'"claimed things and got them all wrong" are different failures with different fixes, and the second one ' +
			"would read `precision 0.000`.",
		"",
		"### Same-family pairs, individually",
		"",
		`The ${withheld.score.truthPositivePairs} registrant pairs the withheld field puts together. Every other pair of ` +
			`the ${registrants.length} registrants (${withheld.score.totalPairs - withheld.score.truthPositivePairs} of ` +
			"them) is a truth negative, including the identical-name pair.",
		"",
		...renderPairsTable(withheld.truthPositivePairs, (pair) => {
			const inControl = control.truthPositivePairs.find((other) => other.a === pair.a && other.b === pair.b)

			return `withheld: ${pair.recovered ? "yes" : "no"} · control: ${inControl?.recovered ? "yes" : "no"}`
		}),
		"",
		"## What is actually in each artifact",
		"",
		"Counted from the two builds, not asserted about them. The withheld build contains no ownership node, no " +
			"ownership edge, no family row the prediction would score and no family row carrying a relationship this " +
			"eval cannot classify — that is the withholding, verified, and a runtime gate refuses to report a withheld " +
			`score if any of those four counts is non-zero. It DOES contain ${withheld.census.nonOwnershipFamilyRows} ` +
			"corporate-family rows, from the management-company disclosures the eval does not withhold; they are " +
			"namespaced separately from ownership families and the prediction skips them. An earlier version of this " +
			"page claimed no family row could exist here at all, which was wrong on its own artifact.\n\nThe family " +
			"counts are split by what the prediction does with a row, not by relationship name, into three buckets that " +
			'partition the total. "Scored" is every membership whose relationship asserts OWNERSHIP, so a `subsidiary` ' +
			"or `parent_company` row a future writer emits lands there rather than going uncounted. The second bucket " +
			"is the relationships this eval recognizes and deliberately does not score — `management_company` and " +
			"`same_entity`. " +
			"The third is anything else: a relationship string no shipped writer can produce, which the gate refuses " +
			"on rather than filing under either of the other two. The total is printed alongside all three so nothing " +
			"can hide between them.",
		"",
		...renderCensusTable(withheld, control),
		"",
		"## Why the withheld run recovers nothing",
		"",
		renderWhySection(withheld),
		"",
		"## What would move this number",
		"",
		renderWhatWouldMoveItSection(),
		"",
		"## Metric choice",
		"",
		"Precision, recall and F1 are PAIRWISE — over unordered registrant pairs, not over an alignment between " +
			"predicted and true clusters. A predicted family's id is derived from the canonicalized parent name, so " +
			"there is no correspondence problem to solve and no alignment step to get wrong; the only well-defined " +
			"question is whether two registrants are correctly judged together or apart, which pairs answer directly. " +
			"Empty denominators are reported as `N/A`, never as zero, throughout.",
		"",
		"## Reproducibility",
		"",
		`SHA-256 of the withheld run's inputs — the exact bytes the builder received: \`${withheld.inputsSHA256}\`.` +
			`\n\nSHA-256 of the control run's inputs: \`${control.inputsSHA256}\`.`,
		"",
		"The corpus is a fixed literal with no sampling and no randomness; the builder and the clustering pass are " +
			'deterministic; every date the runs depend on is a constant rather than "today". Re-running reproduces ' +
			"both scores and both hashes byte for byte. The test suite regenerates this entire page and compares it to " +
			"the committed copy, so editing the corpus without republishing fails, rather than quietly leaving the " +
			"numbers above stale.",
		"",
		"## Caveats",
		"",
		`This is a synthetic ${truthForm499Rows.length}-filer corpus, not a run against real FCC Form 499 data — no ` +
			"such corpus ships in this repo with a stable hash to pin to, so the eval buys exactness and reproducibility " +
			"at the cost of scale. What the withheld number does NOT say is that ownership is hard to recover in " +
			"general; it says that this build has exactly one way to learn a parent and that way was taken away. Scale " +
			"is the honest limitation, and it limits confidence rather than the mechanism: a larger corpus of the same " +
			"shape scores the same, for the reason given above. The control number says nothing about how often real " +
			"filers report a parent, or report it accurately — only that when they do, this pipeline groups them " +
			"correctly.",
		"",
	]

	return lines.join("\n")
}

/**
 * Options for {@linkcode filerLinkageEval}.
 */
export interface FilerLinkageEvalOptions {
	/**
	 * Also write the markdown report here.
	 */
	outMd?: string
	/**
	 * Overrides the report's dated H1 — for regenerating the committed scorecard on a later day, and for reproducibility
	 * tests that need byte-identical markdown across two runs that don't fall on the same wall-clock date. Without it the
	 * report cannot be regenerated without editing code. Defaults to today.
	 */
	date?: string
	/**
	 * Print the markdown to stdout. Defaults to `true` — the CLI's whole output. Tests pass `false`.
	 */
	printMarkdown?: boolean
}

/**
 * {@linkcode filerLinkageEval}'s return value — both runs, always. There is no single "the score": the withheld run is
 * the measurement and the control run is what makes it mean anything, and a caller that reports one without the other
 * is reporting half a result.
 */
export interface FilerLinkageEvalResult {
	markdown: string
	withheld: LinkageEvalRun
	control: LinkageEvalRun
	registrants: LinkageEvalRegistrant[]
	truthGroupOf: Map<FRN, string>
}

/**
 * Run the corporate-family recovery eval — see the module docstring for the experiment design. Builds two scratch
 * `filer.db` artifacts from the same corpus (one with `holdingCompany` withheld, one without), scores each against the
 * held-out truth, and renders the markdown scorecard.
 */
export async function filerLinkageEval(
	options: FilerLinkageEvalOptions = {},
	report?: (line: string) => void
): Promise<FilerLinkageEvalResult> {
	const progress = report ?? ((): void => {})
	const date = options.date ?? new Date().toISOString().slice(0, 10)

	const truthForm499Rows = buildLinkageEvalForm499Rows()
	const truthProviderRows = buildLinkageEvalProviderRows()
	const registrants = buildTruthRegistrants(truthForm499Rows, truthProviderRows)
	const truthGroupOf = buildTruthFamilyGroups(truthForm499Rows, truthProviderRows)

	const withheldInputs = buildFilteredEvalInputs()
	const controlInputs = buildControlEvalInputs()

	progress("building filer.db from the holdingCompany-stripped projection")

	const withheld = await runLinkagePass({
		inputs: withheldInputs,
		registrants,
		truthGroupOf,
		label: "withheld",
		holdingCompanyWithheld: true,
	})

	progress("building the control filer.db, truth field intact")

	const control = await runLinkagePass({
		inputs: controlInputs,
		registrants,
		truthGroupOf,
		label: "control",
		holdingCompanyWithheld: false,
	})

	const markdown = renderLinkageEvalReport({
		date,
		withheld,
		control,
		withheldInputs,
		controlInputs,
		registrants,
		truthForm499Rows,
		truthGroupOf,
	})

	if (options.printMarkdown !== false) {
		console.log(markdown)
	}

	if (options.outMd) {
		await writeFile(options.outMd, markdown)
		progress(`[written] ${options.outMd}`)
	}

	return { markdown, withheld, control, registrants, truthGroupOf }
}
