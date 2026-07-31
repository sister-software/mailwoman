/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `filerLinkageEval` (3b Task 4, decisions 3 & 4) — the held-out record-linkage eval. Measures whether
 *   `filer/sdk/cluster-filers.ts`'s SHIPPED entity-clustering (`clusterAuthoritativeComponents` +
 *   `clusterInferredLinks`, run exactly as `buildFilerDatabase`'s callers would run them — same identifier
 *   veto, same `learnedScorer: false`, no config disabled or loosened to flatter the result) can recover
 *   corporate-family membership from a filer.db build that never saw the `holdingCompany` field at all.
 *
 *   **The experiment (decision 4).** Truth: two FRNs belong to the same corporate family iff their (real,
 *   never-stripped) `holdingCompany` fields canonicalize to the same value ({@linkcode mintFamilyID} — the
 *   WRITER's own derivation, so truth is stated in exactly the terms `buildFilerDatabase` would have used
 *   had the field survived). Input: the SAME corpus with `holdingCompany` cleared on every row
 *   ({@linkcode buildFilteredEvalInputs}) BEFORE `buildFilerDatabase` ever sees it — no `family_id`, no
 *   `HoldingCompany`-relationship edge, and no `filer_family` row can exist in the artifact this eval
 *   builds, because nothing in the input asserts one. `clusterAuthoritativeComponents`/
 *   `clusterInferredLinks` are then run unmodified against that artifact, and their output — two FRNs
 *   share a predicted "same family" verdict iff they land in the same AUTHORITATIVE cluster OR the same
 *   INFERRED cluster — is scored against the withheld truth via {@linkcode scorePairwiseGrouping}
 *   (`linkage-metrics.ts`).
 *
 *   **Why the corpus is synthetic, authored, and embedded (not sampled from a real FCC file).** Gate 4
 *   requires the SAME inputs to reproduce the SAME numbers on every run — a corpus drawn from
 *   `$MAILWOMAN_DATA_ROOT` at eval time would make that guarantee depend on a file this repo doesn't ship
 *   and can't pin a hash to in source control. Every row below is authored so every truth fact is
 *   auditable by reading this file, not by trusting a benchmark's provenance. See
 *   {@linkcode buildLinkageEvalForm499Rows}' own docstring for what the corpus deliberately covers (two
 *   real multi-FRN families with a spelling-drifted holding-company name each, four standalone filers, and
 *   a same-canonical-name/different-entity trap the identifier veto has to refuse to merge).
 *
 *   **Honest expectation, stated before the numbers (do not tune this away — task brief).**
 *   `clusterAuthoritativeComponents`'s `readAuthoritativeGroups` unions ONLY `relationship: "same_entity"`
 *   authoritative edges (task 3 fix round 1 — a `HoldingCompany`/`ManagementCompany` edge is never even a
 *   candidate), and `clusterInferredLinks`'s `hasSharedIdentifier` veto forces any pair with no shared
 *   `frn`/`form499ID`/`providerID` code to `-Infinity` regardless of name similarity — and two DIFFERENT
 *   FRNs structurally never share one of those codes (a shared code would mean a shared node, which the
 *   authoritative pass would already have unioned). So this linkage cannot, by its documented design,
 *   discover a link between two DIFFERENT FRNs from name/identifier signal alone — the two mechanisms that
 *   make the crosswalk safe against false-identity merges (Task 3's CRITICAL fix; the 3a review's
 *   identifier veto) are exactly the mechanisms that make family recovery structurally unreachable here.
 *   Report the number this produces, not a tuned one — see `docs/articles/evals/2026-07-31-filer-linkage.md`
 *   for what it actually is and why that's not a bug.
 */

import { createHash } from "node:crypto"
import { chmodSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"

import { FilerEdgeAssertion, FilerIdentifierType, type FilerDatabase } from "../schema.ts"
import { buildFilerDatabase } from "../sdk/build-filer.ts"
import { clusterFilers, type InferredClusterResult } from "../sdk/cluster-filers.ts"
import { mintFamilyID } from "../sdk/family-id.ts"
import type { Form499Row } from "../sdk/form499.ts"
import { toFRN, type FRN } from "../sdk/frn.ts"
import type { ProviderListRow } from "../sdk/provider-list.ts"
import { groupPredicateFromMap, scorePairwiseGrouping, type PairwiseGroupingScore } from "./linkage-metrics.ts"

/**
 * `sourceVintage`/`validFrom` for the eval's own `buildFilerDatabase`/`clusterFilers` calls — FIXED constants, never
 * "today", so a re-run at a different wall-clock date builds byte-identical `filer_edge`/`filer_family` provenance
 * columns (gate 4's reproducibility clause). Neither value affects this eval's SCORE either way: `filer_cluster` (what
 * this eval reads) carries no temporal columns at all (`schema.ts`), so nothing here is `asOf`-scoped.
 */
const EVAL_SOURCE_VINTAGE = "2026-eval-v1"
const EVAL_VALID_FROM = "2026-01-01"

/**
 * `buildFilerDatabase`'s `buildSHA` for this eval's artifact — a fixed label (not a real `git rev-parse`) since this is
 * a synthetic, in-repo corpus with no git-tracked source file of its own to attribute the build to.
 */
const EVAL_BUILD_SHA = "filer-linkage-eval"

const FRN_CASCADE_1 = toFRN("9100000001")!
const FRN_CASCADE_2 = toFRN("9100000002")!
const FRN_CASCADE_3 = toFRN("9100000003")!
const FRN_MERIDIAN_1 = toFRN("9100000004")!
const FRN_MERIDIAN_2 = toFRN("9100000005")!
const FRN_STANDALONE_1 = toFRN("9100000006")!
const FRN_STANDALONE_2 = toFRN("9100000007")!
const FRN_NAMESAKE_1 = toFRN("9100000008")!
const FRN_NAMESAKE_2 = toFRN("9100000009")!

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
 * The synthetic held-out corpus (3b Task 4, decisions 3 & 4) — 9 FRNs standing in for Form 499 filers, authored (never
 * sampled) so every truth fact is auditable by reading this file and the eval is exactly reproducible. Two real
 * corporate families:
 *
 * - "Cascade Fiber Holdings, Inc." — 3 members; one reports the holding company WITHOUT the trailing comma ("Cascade
 *   Fiber Holdings Inc"), so the truth construction ({@linkcode buildTruthFamilyGroups}) has to canonicalize via
 *   {@linkcode mintFamilyID} rather than string-match.
 * - "Meridian Communications Group LLC" — 2 members; one reports the WITH-comma variant ("Meridian Communications Group,
 *   LLC") — the same spelling-drift check, the other direction.
 *
 * Four standalone filers carry NO holding company — true negatives for the pairwise score. Two of them ("American Fiber
 * Partners LLC" / "American Fiber Partners, LLC") share a canonical legal name ON PURPOSE: a same-name/different-entity
 * trap. Nothing in this crosswalk may ever merge them (no shared `frn`/`form499ID`/`providerID`, no holding company on
 * either), and `cluster-filers.ts`'s identifier veto (`hasSharedIdentifier`) is exactly the mechanism that has to
 * refuse to — this is the one candidate pair in the whole corpus whose canonical organization names actually collide,
 * so it's the one pair that reaches the inferred pass's scorer rather than being blocked out at the exact-name-blocking
 * stage.
 *
 * No `legalNameOfCarrier`/`doingBusinessAs` value here contains another row's `holdingCompany` string — deliberately,
 * so the leakage decision 4 cares about (the matcher's INPUT never carrying the truth field) can't be defeated by
 * accident through a different field that happens to restate it.
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
	]
}

/**
 * Three BDC provider-list rows layered onto a subset of the corpus above — one `bdc_provider_id` node per FRN, never
 * shared across FRNs (a shared `providerID` would be a genuine same-entity fact, bridging two authoritative components
 * for real — a different question than the family-membership one this eval measures, so the corpus avoids it). Each
 * row's `holdingCompany` agrees with its FRN's Form 499 value (or `null`, for a standalone filer), so stripping it
 * later never creates an internal contradiction between the two sources' held-out truth.
 */
export function buildLinkageEvalProviderRows(): ProviderListRow[] {
	return [
		{ providerID: 700_001, frn: FRN_CASCADE_1, holdingCompany: "Cascade Fiber Holdings, Inc." },
		{ providerID: 700_002, frn: FRN_MERIDIAN_1, holdingCompany: "Meridian Communications Group LLC" },
		{ providerID: 700_003, frn: FRN_NAMESAKE_1, holdingCompany: null },
	]
}

/**
 * The eval's ENTIRE input to the matcher (3b Task 4, decision 4) — the corpus above with `holdingCompany` cleared on
 * every row, before anything reaches `buildFilerDatabase`. {@linkcode filerLinkageEval} calls exactly this function to
 * build what it hands the builder, so a test asserting the truth field's absence here is asserting it against the SAME
 * code path the eval actually runs — not a parallel copy that could drift out of sync with it.
 */
export function buildFilteredEvalInputs(): { form499Rows: Form499Row[]; providerRows: ProviderListRow[] } {
	const form499Rows = buildLinkageEvalForm499Rows().map((row) => ({ ...row, holdingCompany: "" }))
	const providerRows = buildLinkageEvalProviderRows().map((row) => ({ ...row, holdingCompany: null }))

	return { form499Rows, providerRows }
}

/**
 * The held-out ground truth (3b Task 4, decision 4): for every FRN in the corpus, which corporate family it REALLY
 * belongs to, per the (never-stripped) `holdingCompany` field — canonicalized via {@linkcode mintFamilyID}, the exact
 * rule `buildFilerDatabase` itself would apply had `holdingCompany` not been withheld, so the two spelling variants
 * above collapse onto the SAME truth group. An FRN with no holding company gets its OWN unique `singleton:<frn>` group
 * — distinct from every other FRN's placeholder, including another standalone filer's — so two unrelated standalone
 * filers (the namesake pair included) are never scored as a truth-positive pair with each other.
 */
export function buildTruthFamilyGroups(rows: readonly Form499Row[]): Map<FRN, string> {
	const truth = new Map<FRN, string>()

	for (const row of rows) {
		if (!row.frn) continue

		const familyID = row.holdingCompany
			? mintFamilyID(FilerIdentifierType.HoldingCompanyName, row.holdingCompany)
			: null

		truth.set(row.frn, familyID ?? `singleton:${row.frn}`)
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
 * SHA-256 over the EXACT bytes {@linkcode filerLinkageEval} hands to `buildFilerDatabase` (decision 4's "the scorecard
 * reports … the SHA of its inputs") — computed over a fixed field order (mirrors the real TSV/CSV column order), so the
 * hash is stable across Node versions and can never depend on an object-key-iteration-order accident.
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

/**
 * Reads `filer_cluster` rows for a set of node ids under one `assertion`, throwing if any `expectedNodeID` has none —
 * every node `clusterFilers` touches gets an assignment (a singleton cluster, at minimum), so a missing row means
 * `clusterFilers` didn't run against this artifact, not a legitimate "no opinion" case.
 */
async function readClusterAssignments(
	db: DatabaseClient<FilerDatabase>,
	expectedNodeIDs: readonly string[],
	assertion: string
): Promise<Map<string, string>> {
	const rows = await db
		.selectFrom("filer_cluster")
		.select(["node_id", "cluster_id"])
		.where("node_id", "in", expectedNodeIDs)
		.where("assertion", "=", assertion)
		.execute()

	const result = new Map(rows.map((row) => [row.node_id, row.cluster_id]))

	for (const nodeID of expectedNodeIDs) {
		if (!result.has(nodeID)) {
			throw new Error(
				`filerLinkageEval: no ${assertion} filer_cluster row for node ${nodeID} — clusterFilers did not run, or ` +
					"ran against a different artifact than the one this reader opened"
			)
		}
	}

	return result
}

/**
 * Maps each corpus FRN to the `form499_id:` node from ITS OWN Form 499 row — the only node type `clusterInferredLinks`
 * ever assigns an inferred `filer_cluster` row to (`cluster-filers.ts`'s own "Scope note": only `form499_id` nodes
 * carry a `legal_name` attribute, so those are the only nodes the inferred pass can name-match). Comparing two FRNs'
 * INFERRED predictions therefore has to go through this indirection — an FRN node itself never gets an inferred cluster
 * assignment at all, only its authoritative one.
 */
function form499NodeIDOfFRN(rows: readonly Form499Row[]): Map<FRN, string> {
	const result = new Map<FRN, string>()

	for (const row of rows) {
		if (row.frn) {
			result.set(row.frn, `${FilerIdentifierType.Form499ID}:${row.form499ID}`)
		}
	}

	return result
}

/**
 * One truth-positive pair (two FRNs the withheld `holdingCompany` field puts in the same real family) and whether the
 * linkage recovered it — the report's per-pair table.
 */
export interface TruthPositivePairOutcome {
	a: FRN
	b: FRN
	familyID: string
	recoveredByAuthoritative: boolean
	recoveredByInferred: boolean
}

function findTruthPositivePairs(
	frns: readonly FRN[],
	truthGroupOf: ReadonlyMap<FRN, string>,
	authoritativeClusterOf: ReadonlyMap<FRN, string>,
	inferredClusterOf: ReadonlyMap<FRN, string>
): TruthPositivePairOutcome[] {
	const outcomes: TruthPositivePairOutcome[] = []

	for (let i = 0; i < frns.length; i++) {
		for (let j = i + 1; j < frns.length; j++) {
			const a = frns[i]!
			const b = frns[j]!
			const familyID = truthGroupOf.get(a)

			if (familyID === undefined || familyID !== truthGroupOf.get(b) || familyID.startsWith("singleton:")) continue

			outcomes.push({
				a,
				b,
				familyID,
				recoveredByAuthoritative: authoritativeClusterOf.get(a) === authoritativeClusterOf.get(b),
				recoveredByInferred: inferredClusterOf.get(a) === inferredClusterOf.get(b),
			})
		}
	}

	return outcomes
}

function formatScoreValue(value: number | null): string {
	return value === null ? "N/A" : value.toFixed(3)
}

const FORM_499_INPUT_FIELDS: ReadonlyArray<{ field: keyof Form499Row; included: boolean; note: string }> = [
	{ field: "form499ID", included: true, note: "" },
	{ field: "frn", included: true, note: "the truth key, never itself withheld" },
	{ field: "lastFiledAt", included: true, note: "" },
	{ field: "usfContributor", included: true, note: "" },
	{ field: "legalNameOfCarrier", included: true, note: "the inferred pass's blocking key + score input" },
	{ field: "doingBusinessAs", included: true, note: "" },
	{ field: "principalCommType", included: true, note: "" },
	{ field: "holdingCompany", included: false, note: '**HELD OUT** — cleared to `""` on every row' },
	{
		field: "managementCompany",
		included: true,
		note: "a separate ownership-vs-control field; never set equal to holdingCompany in this corpus",
	},
	{ field: "hqAddress", included: true, note: "" },
	{ field: "customerInquiriesTelephone", included: true, note: "" },
	{ field: "customerInquiriesAddress", included: true, note: "" },
	{ field: "dcAgentDisplayName", included: true, note: "attribute only — never an edge input (DC-agent doctrine)" },
	{ field: "dcAgentOrganizationName", included: true, note: "attribute only — never an edge input" },
	{ field: "dcAgentTelephone", included: true, note: "" },
	{ field: "dcAgentEmailAddress", included: true, note: "" },
	{ field: "dcAgentAddress", included: true, note: "" },
]

function renderInputShapeTable(): string[] {
	const lines = ["| Form499Row field | given to the matcher? | note |", "|---|---|---|"]

	for (const row of FORM_499_INPUT_FIELDS) {
		lines.push(`| \`${row.field}\` | ${row.included ? "yes" : "**no**"} | ${row.note} |`)
	}

	lines.push("")
	lines.push("| ProviderListRow field | given to the matcher? | note |")
	lines.push("|---|---|---|")
	lines.push("| `providerID` | yes | |")
	lines.push("| `frn` | yes | the truth key, never itself withheld |")
	lines.push("| `holdingCompany` | **no** | **HELD OUT** — cleared to `null` on every row |")

	return lines
}

function renderCorpusTable(truthForm499Rows: readonly Form499Row[], truthGroupOf: ReadonlyMap<FRN, string>): string[] {
	const lines = [
		"| FRN | legal name (given to the matcher) | real holding company (withheld) | truth family |",
		"|---|---|---|---|",
	]

	for (const row of truthForm499Rows) {
		const frn = row.frn!
		const group = truthGroupOf.get(frn) ?? ""
		const familyLabel = group.startsWith("singleton:") ? "_(standalone — no truth family)_" : `\`${group}\``

		lines.push(`| ${frn} | ${row.legalNameOfCarrier} | ${row.holdingCompany || "_(none)_"} | ${familyLabel} |`)
	}

	return lines
}

function renderResultsTable(score: PairwiseGroupingScore, inferred: InferredClusterResult): string[] {
	return [
		"| metric | value |",
		"|---|---|",
		`| precision | ${formatScoreValue(score.precision)} |`,
		`| recall | ${formatScoreValue(score.recall)} |`,
		`| F1 | ${score.f1.toFixed(3)} |`,
		`| true-positive pairs | ${score.truePositivePairs} |`,
		`| false-positive pairs | ${score.falsePositivePairs} |`,
		`| false-negative pairs | ${score.falseNegativePairs} |`,
		`| truth-positive pairs (pairs the withheld field puts together) | ${score.truthPositivePairs} |`,
		`| predicted-positive pairs (pairs the linkage puts together) | ${score.predictedPositivePairs} |`,
		`| total pairs scored | ${score.totalPairs} |`,
		`| inferred pass: form499_id records considered | ${inferred.recordsConsidered} |`,
		`| inferred pass: linked clusters (size > 1) | ${inferred.linkedClusters} |`,
		`| inferred pass: \`filer_edge\` rows written | ${inferred.links} |`,
	]
}

function renderPairsTable(pairs: readonly TruthPositivePairOutcome[]): string[] {
	const lines = [
		"| FRN A | FRN B | truth family | recovered (authoritative)? | recovered (inferred)? |",
		"|---|---|---|---|---|",
	]

	for (const pair of pairs) {
		lines.push(
			`| ${pair.a} | ${pair.b} | \`${pair.familyID}\` | ${pair.recoveredByAuthoritative ? "yes" : "no"} | ${pair.recoveredByInferred ? "yes" : "no"} |`
		)
	}

	return lines
}

interface RenderLinkageEvalReportInput {
	date: string
	score: PairwiseGroupingScore
	inputsSHA256: string
	inferred: InferredClusterResult
	truthForm499Rows: readonly Form499Row[]
	truthGroupOf: ReadonlyMap<FRN, string>
	truthPositivePairs: readonly TruthPositivePairOutcome[]
}

function renderLinkageEvalReport(input: RenderLinkageEvalReportInput): string {
	const { date, score, inputsSHA256, inferred, truthForm499Rows, truthGroupOf, truthPositivePairs } = input

	const lines: string[] = [
		`# ${date} — filer.db record linkage vs held-out FRN↔holdingCompany truth (3b task 4)`,
		"",
		"**Verdict: the shipped entity linkage does not recover corporate-family membership when `holdingCompany` is " +
			`withheld — F1 ${score.f1.toFixed(3)} (precision ${formatScoreValue(score.precision)}, recall ` +
			`${formatScoreValue(score.recall)}) over ${score.truthPositivePairs} held-out truth-positive pairs.** This is ` +
			"not a tuning miss: the two mechanisms that make `cluster-filers.ts` safe against false-identity merges — " +
			"the `relationship: same_entity` filter on authoritative clustering (Task 3's CRITICAL fix) and the hard " +
			"identifier veto on the inferred pass (the 3a review's fix) — are exactly the mechanisms that make family " +
			"recovery from name/identifier signal alone structurally unreachable. `filer_family` gets its membership by " +
			"reading a disclosed field (`build-filer.ts`), never by inferring one; this eval measures what happens when " +
			"that field is the thing under test instead of the thing on the table.",
		"",
		"## The experiment",
		"",
		"Truth: two FRNs belong to the same corporate family iff their real (never-stripped) `holdingCompany` values " +
			"canonicalize to the same string, via `mintFamilyID` — the identical rule `buildFilerDatabase` itself uses to " +
			"derive `filer_family.family_id`, so truth is stated in exactly the terms the writer would have used had the " +
			"field survived. Input: the SAME corpus with `holdingCompany` cleared on every row " +
			"(`buildFilteredEvalInputs`, `filer/tools/linkage-eval.ts`) BEFORE `buildFilerDatabase` ever runs — no " +
			"`family_id`, no `HoldingCompany`-relationship edge, and no `filer_family` row can exist in the artifact this " +
			"eval builds, because nothing in the input asserts one. `clusterAuthoritativeComponents`/`clusterInferredLinks` " +
			"then run UNMODIFIED against that artifact (same identifier veto over `frn`/`form499ID`/`providerID`, same " +
			"`learnedScorer: false`, same exact-canonical-name blocking) — nothing about the matcher's configuration " +
			"changes for this eval. Two FRNs are predicted the same family iff they land in the same authoritative " +
			"`filer_cluster` OR the same inferred `filer_cluster`.",
		"",
		"## Corpus",
		"",
		"9 FRNs, authored (not sampled from a real FCC file) so every truth fact is auditable here rather than trusted " +
			"from an external source. Two real multi-FRN families, each with one member reporting a spelling-drifted " +
			"holding-company name; four standalone filers with no holding company, two of which (the last two rows) " +
			"share a canonical legal name on purpose — a same-name/different-entity trap the identifier veto has to " +
			"refuse to merge.",
		"",
		...renderCorpusTable(truthForm499Rows, truthGroupOf),
		"",
		"## Input record shape",
		"",
		"Every field `buildFilteredEvalInputs()` hands to `buildFilerDatabase`, and whether the matcher sees it:",
		"",
		...renderInputShapeTable(),
		"",
		"## Results",
		"",
		...renderResultsTable(score, inferred),
		"",
		"### Truth-positive pairs, individually",
		"",
		"The only pairs the withheld field asserts are the same family — every other pair of the 9 FRNs (" +
			`${score.totalPairs - score.truthPositivePairs} of them) is a truth negative:`,
		"",
		...renderPairsTable(truthPositivePairs),
		"",
		"## Why the score is what it is",
		"",
		"`clusterAuthoritativeComponents`'s `readAuthoritativeGroups` (`cluster-filers.ts`) unions ONLY " +
			'`relationship: "same_entity"` authoritative edges — a `HoldingCompany`/`ManagementCompany` edge is never even ' +
			"a candidate for entity clustering (Task 3's CRITICAL fix; see that module's own docstring). With " +
			"`holdingCompany` stripped, no such edge exists in this build anyway, so the point is moot for THIS run — but " +
			"it means the authoritative pass was never capable of recovering family membership even when the field is " +
			"present, which is the honest reason `filer_family` is populated by direct field extraction " +
			"(`build-filer.ts`'s `insertFamilyMembership`) and not by this linkage. `clusterInferredLinks`'s " +
			"`hasSharedIdentifier` veto forces any candidate pair with no shared `frn`/`form499ID`/`providerID` code to " +
			"`-Infinity`, unconditionally, before name similarity is consulted — and two DIFFERENT FRNs structurally never " +
			"share one of those codes (a shared code would mean a shared node, which the authoritative pass would already " +
			"have merged). The corpus's namesake pair (`American Fiber Partners LLC` / `American Fiber Partners, LLC`) is " +
			"the one candidate whose canonical organization names actually collide — it reaches the veto rather than being " +
			"blocked out at the exact-name-blocking stage, and the veto correctly refuses to merge it (no shared identifier " +
			"on either side). That refusal is precision working as designed, not a coincidence: this eval's " +
			`${score.predictedPositivePairs} predicted-positive pairs is a DIRECT consequence of the veto and the ` +
			`relationship filter, over ${inferred.recordsConsidered} form499_id records the inferred pass actually scored.`,
		"",
		"## Metric choice",
		"",
		"Precision/recall/F1 here are PAIRWISE — over unordered FRN pairs, not over cluster-to-cluster alignment (B-cubed, " +
			"the Hungarian algorithm) — the same choice `registry/tools/train-gbt.ts`'s (unexported) `clusterF1` makes for " +
			"an analogous problem (does `resolveEntities`'s clustering recover the true NPI grouping?). It is not reused " +
			"here: it hard-codes an NPI/`SourceRecord`-shaped input, and — more importantly — its convention of defaulting " +
			'an empty denominator to `0` would have reported this eval\'s `predictedPositivePairs === 0` as "0% precision" ' +
			"indistinguishably from a linkage that confidently merged the wrong records everywhere. `linkage-metrics.ts`'s " +
			"`scorePairwiseGrouping` (written for this task, exported) reports `null` for that case instead — see its " +
			"docstring for the full rationale. Pairwise agreement is the right shape here specifically because an " +
			"authoritative cluster's `cluster_id` is content-derived and has no aligned counterpart in the truth partition " +
			"to match against; the only well-defined question is whether two records are correctly judged together or " +
			"apart, which pairwise agreement answers without an alignment step.",
		"",
		"## Leakage and reproducibility",
		"",
		`SHA-256 of the matcher's inputs (the exact, holdingCompany-stripped \`form499Rows\`/\`providerRows\` bytes ` +
			`\`buildFilerDatabase\` received): \`${inputsSHA256}\`.`,
		"",
		"The exclusion is structural, not a runtime check: `buildFilteredEvalInputs()` is the ONE function that builds " +
			"what reaches `buildFilerDatabase`, and `linkage-eval.test.ts` asserts every row it returns carries a blank " +
			'(`""`/`null`) `holdingCompany` — the same function this eval itself calls, not a parallel copy that could ' +
			"drift. Re-running `filerLinkageEval` reproduces byte-identical scores and the identical SHA every time: the " +
			"corpus is a fixed, authored literal (no sampling, no randomness), `buildFilerDatabase`/`clusterFilers` are " +
			"already deterministic by construction (content-derived cluster ids, no reliance on row-iteration order — see " +
			"`cluster-filers.ts`'s own idempotency discipline), and `sourceVintage`/`validFrom` are fixed constants rather " +
			'than "today". `linkage-eval.test.ts` pins this by running the eval twice and asserting the two score objects ' +
			"and SHAs are identical.",
		"",
		"## Honest caveats",
		"",
		"This is a synthetic, small (9-FRN) corpus, not a run against real FCC Form 499 data — no such corpus is " +
			"available in this repo with a stable hash to pin to, so the eval is exact and reproducible at the cost of " +
			"being small. The outcome is STRUCTURALLY determined by `cluster-filers.ts`'s current design (the relationship " +
			"filter, the identifier veto), not sample-dependent — a larger or differently-drawn corpus of the same shape " +
			"would score identically for the same reason, so more data would not change this finding, only its N. " +
			"Recovering corporate family from evidence OTHER than a disclosed `holdingCompany` field — a normalized HQ " +
			"address, a shared contact phone/email, once CORES/EDGAR data lands — is out of scope for this task and for " +
			"`cluster-filers.ts` as it exists today; that gap is already named in that module's own \"Degenerate discovery " +
			'scope" note (3a Task 6) as deferred, not overlooked.',
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
	 * Overrides the report's dated H1 — for reproducibility tests that need byte-identical markdown across two runs that
	 * don't happen on the same wall-clock day. Defaults to today.
	 */
	date?: string
}

/**
 * {@linkcode filerLinkageEval}'s return value.
 */
export interface FilerLinkageEvalResult {
	markdown: string
	score: PairwiseGroupingScore
	inputsSHA256: string
}

/**
 * Run the held-out record-linkage eval — see the module docstring for the full experiment design. Builds a scratch
 * `filer.db` from the holdingCompany-stripped corpus, runs the SHIPPED `clusterFilers` against it unmodified, scores
 * the result against the withheld truth, and emits the markdown scorecard to stdout (and to `options.outMd`, if
 * given).
 */
export async function filerLinkageEval(
	options: FilerLinkageEvalOptions = {},
	report?: (line: string) => void
): Promise<FilerLinkageEvalResult> {
	const progress = report ?? ((): void => {})
	const date = options.date ?? new Date().toISOString().slice(0, 10)

	const truthForm499Rows = buildLinkageEvalForm499Rows()
	const truthGroupOf = buildTruthFamilyGroups(truthForm499Rows)
	const frns = [...truthGroupOf.keys()]

	const inputs = buildFilteredEvalInputs()
	const inputsSHA256 = hashLinkageEvalInputs(inputs)

	const scratch = await mkdtemp(join(tmpdir(), "filer-linkage-eval-"))
	const out = join(scratch, "filer.db")

	try {
		progress("building filer.db from the holdingCompany-stripped projection")

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

		progress("running the shipped record linkage (clusterAuthoritativeComponents + clusterInferredLinks), unmodified")
		const { inferred } = await clusterFilers(db, { sourceVintage: EVAL_SOURCE_VINTAGE, validFrom: EVAL_VALID_FROM })

		// The authoritative pass assigns every filer_node (including FRN nodes) a cluster — read directly. The
		// inferred pass only ever assigns form499_id nodes (see form499NodeIDOfFRN's docstring), so an FRN's inferred
		// prediction has to go through its own form499_id node instead.
		const form499NodeIDOf = form499NodeIDOfFRN(truthForm499Rows)

		const authoritativeByNodeID = await readClusterAssignments(
			db,
			frns.map((frn) => `${FilerIdentifierType.FRN}:${frn}`),
			FilerEdgeAssertion.Authoritative
		)

		const inferredByForm499NodeID = await readClusterAssignments(
			db,
			frns.map((frn) => form499NodeIDOf.get(frn)!),
			FilerEdgeAssertion.Inferred
		)

		const authoritativeClusterOf = new Map(
			frns.map((frn) => [frn, authoritativeByNodeID.get(`${FilerIdentifierType.FRN}:${frn}`)!] as const)
		)

		const inferredClusterOf = new Map(
			frns.map((frn) => [frn, inferredByForm499NodeID.get(form499NodeIDOf.get(frn)!)!] as const)
		)

		const predictedSame = (a: FRN, b: FRN): boolean =>
			authoritativeClusterOf.get(a) === authoritativeClusterOf.get(b) ||
			inferredClusterOf.get(a) === inferredClusterOf.get(b)

		const score = scorePairwiseGrouping(frns, groupPredicateFromMap(truthGroupOf), predictedSame)
		const truthPairs = findTruthPositivePairs(frns, truthGroupOf, authoritativeClusterOf, inferredClusterOf)

		const markdown = renderLinkageEvalReport({
			date,
			score,
			inputsSHA256,
			inferred,
			truthForm499Rows,
			truthGroupOf,
			truthPositivePairs: truthPairs,
		})

		console.log(markdown)

		if (options.outMd) {
			await writeFile(options.outMd, markdown)
			progress(`[written] ${options.outMd}`)
		}

		return { markdown, score, inputsSHA256 }
	} finally {
		await rm(scratch, { recursive: true, force: true })
	}
}
