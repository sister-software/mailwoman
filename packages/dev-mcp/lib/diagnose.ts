/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Mechanism accounts (#1722) — per row, what the pipeline DID, assembled from the facts it already exposes.
 *
 *   Two commitments from the epic bind every line here.
 *
 *   1. **Expectations pin OUTCOMES, never mechanisms.** Nothing in an account is asserted by a board row, and nothing
 *      here is cached. Every account is recomputed from the current system on every call, so an explanation is free to
 *      dissolve the moment the system stops working that way. (The anti-Pelias rule: no mechanistic belief accumulates
 *      that a truer understanding of addresses could break against.)
 *   2. **Failure shapes are MECHANISM-STATES, never address shapes.** Every predicate below reads pipeline facts —
 *      channels, constraints, ranks, lineage — and none reads what KIND of address the row is. A shape makes a claim about
 *      what the system did on this input; it cannot fossilize a wrong belief about how addresses work.
 *
 *   Classification is v1: transparent predicates over recorded pipeline facts, with NO calibration. Every result says so in its
 *   own `calibration` field. A row that matches no shape and still fails its expectation is reported `unclassified`
 *   rather than squeezed into the nearest match, because a label applied to it now is the thing a calibrated v2 would
 *   have to un-learn.
 *
 *   What v2 is, stated precisely (the loose earlier wording — "shapes get a calibrated posterior, novelty mints a
 *   class" — was wrong twice over, and the correction is worth carrying here rather than rediscovering):
 *
 *   1. **Class-conditional (Mondrian) SPLIT CONFORMAL** over held-out diagnosed rows, calibrated per shape, so a
 *      minority shape is not judged by a threshold a majority shape set. It yields PREDICTION SETS and p-values with
 *      an empirical coverage guarantee — NOT a posterior. A p of 0.82 is not "82% likely to be this shape", and any
 *      surface that reads it that way is lying about what conformal gives.
 *   2. **A separate conformal novelty detector** whose job is to ABSTAIN when no known shape fits.
 *   3. **Minting a new shape is a downstream clustering-and-review step**, not an operation conformal performs.
 *      Standard Mondrian CP assumes the taxonomy already exists; open-set conformal can flag that an observation
 *      belongs to no known class, and what to do about that is our architecture, not the method's.
 *
 *   Two measured obstacles stand between v1 and that v2, both visible in this tool's own census and neither solved by
 *   more code:
 *
 *   - **Resolution is bounded by class size.** A conformal p-value moves in steps of 1/(n+1), so a class needs
 *     n >= 1/alpha - 1 calibration rows before a threshold at error rate alpha exists at all (19 rows for alpha=0.05).
 *     On the 2026-08-19 board slice the shapes ran evidence_starved 113, retrieval_empty 95, scope_miss_readmission
 *     75, wrong_instance_detected 38, rank_flip 10, parse_shape_contradiction 3, mis_tag_in_vocabulary 1. The first
 *     four could carry calibration; the last three cannot, and splitting them into train/calibration halves makes it
 *     worse.
 *   - **These shapes are MULTI-LABEL and Mondrian partitions.** `by_shape` counts overlap by construction and the
 *     result says never to sum them, so "the class" a row calibrates under has to be defined first — earliest pipeline stage,
 *     full label set, or something else — and that choice is a modelling decision, not a detail.
 *
 *   Exchangeability is the third question and the least comfortable one: calibration rows drawn from the tracked board
 *   are actively drained by the fixes this tool motivates (five promoted in one night), so yesterday's diagnosed
 *   population is not exchangeable with tomorrow's failures.
 *
 *   Aggregation is BY SHAPE with each class's n, never by raw row count: the n=64 city-only aggregate at p=0.084 that
 *   motivated this issue concealed a six-row single-mechanism finding, and a rate over a mixture is a number about the
 *   mixture.
 */

import type { ResolveNodeTrace } from "@mailwoman/core/resolver"
import type { NeuralParseTrace, TracePriorKind } from "@mailwoman/neural"
import { checkCase } from "mailwoman/eval-harness/gauntlet/check-case"
import { toGauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import type { GauntletCaseTable } from "mailwoman/eval-harness/gauntlet/schema"
import type { GeocodeRun, GeocodeTrace } from "mailwoman/geocode"

import {
	COUNTERFACTUAL_LEVERS,
	COUNTERFACTUAL_MOVED_KM,
	runCounterfactuals,
	type CounterfactualTarget,
	type RowCounterfactuals,
} from "#counterfactual"
import type { EngineConfig, EngineRegistryLike } from "#engine-registry"
import { evidenceCensus, priorSignals, type ChannelReading, type EvidenceCensus } from "#evidence"
import { caseCarriesTruth, seedToCaseTable } from "#grade"
import { resolveInputSet, type InputSetRef, type ResolvedInput } from "#input-sets"
import { describeObservedRate } from "#power"
import { inputSetProvenance, provenanceFor } from "#tool-kit"

/**
 * The confidence at which a known-format hit is treated as a structural assertion worth contradicting.
 *
 * `KnownFormatHit.confidence` is deliberately damped where postcode shapes overlap (`fr_postcode` / `de_postcode`
 * against `us_zip` is the documented case), so a hit below this floor is the detector saying it cannot tell the shapes
 * apart — disagreeing with the parse there would report that ambiguity as a defect.
 */
const KNOWN_FORMAT_CONFIDENCE_FLOOR = 0.9

/**
 * Row ids listed per shape before the list is capped. The `n` beside it is always the real count; this bounds the
 * PAYLOAD, never the measurement.
 */
const SHAPE_ID_CAP = 20

/**
 * Above this many rows, counterfactuals run only on rows that matched a non-`clean` shape.
 *
 * A flip is one geocode per row per lever and the lever space is five wide, so a full board would be thousands of extra
 * resolves plus an engine build per distinct patch. Every result that applies the narrowing says so, and says that a
 * clean row's levers are then UNMEASURED rather than measured and found inert.
 */
export const COUNTERFACTUAL_FULL_RUN_MAX_ROWS = 20

/**
 * The v1 shape vocabulary, in PIPELINE EXECUTION ORDER — parse, evidence, retrieval, ranking, outcome.
 *
 * A row can match several, and the order is what makes a multi-match readable: the earliest pipeline stage comes first,
 * so `[retrieval_empty, wrong_instance_detected]` reads as one story rather than two verdicts. The two terminal states
 * are mutually exclusive with everything, including each other.
 */
export const DIAGNOSE_SHAPES = [
	"parse_shape_contradiction",
	"evidence_starved",
	"retrieval_empty",
	"scope_miss_readmission",
	"rank_flip",
	"wrong_instance_detected",
	"clean",
	"mis_tag_in_vocabulary",
	"unclassified",
] as const

export type DiagnoseShape = (typeof DIAGNOSE_SHAPES)[number]

/**
 * What each shape asserts, as the predicate actually reads it. Emitted with every result so a classification travels
 * with its own definition — a shape name relayed without its predicate is the bare label this design refuses.
 */
export const SHAPE_PREDICATES: Record<DiagnoseShape, string> = {
	parse_shape_contradiction:
		`A known-format hit at confidence ≥ ${KNOWN_FORMAT_CONFIDENCE_FLOOR} covers text the parse assigned to no ` +
		"component of the matching tag — the structural detector and the model disagree about the same characters.",
	evidence_starved:
		"At least one evidence channel was fed and EVERY fed channel was fed zeros, so the parse was decided by the " +
		"token embeddings alone. Not a health verdict: a correct parse can be starved.",
	retrieval_empty:
		"A lookup returned zero candidates and picked nothing, and no other lookup for the same span recovered a pick " +
		"— the deciding site had nothing to decide between.",
	scope_miss_readmission:
		"The backend's region scope missed and its unscoped fallback produced the rows the pick came from — the " +
		"re-admission path where a wrong-instance namesake enters.",
	rank_flip:
		"The picked candidate was not rank 1 in the backend's own order; the named stage is where it first reached " +
		"rank 1.",
	wrong_instance_detected:
		"Admin coherence CONTRADICTED a parsed qualifier, or a hierarchy entry resolved outside the winner's stamped " +
		"lineage — the answer names a place the address's own text does not contain.",
	clean: "No mechanism-state predicate matched, and the row did not fail an expectation.",
	mis_tag_in_vocabulary:
		"No mechanism-state predicate matched; the row failed on an expected component the parse never produced, whose " +
		"expected value occurs verbatim in the input — the decode assigned in-vocabulary text to other tags, so the " +
		"component never existed for any downstream mechanism to act on. A TERMINAL state like `unclassified` (it reads " +
		"the expectation, which mechanism shapes may not); the fix path is model/corpus, not decode or retrieval.",
	unclassified:
		"No mechanism-state predicate matched and the row FAILED its expectation. The novelty signal, not a verdict: " +
		"v1 has no shape for whatever happened here.",
}

/**
 * The format union, pulled off the trace's own type so a format added to `@mailwoman/query-shape` without an entry in
 * {@link COMPONENT_FOR_KNOWN_FORMAT} is a compile error rather than a silently unchecked detector.
 */
type KnownFormat = GeocodeTrace["queryShape"]["knownFormats"][number]["format"]

/**
 * The component tag each known-format hit asserts the presence of.
 */
const COMPONENT_FOR_KNOWN_FORMAT = {
	us_zip: "postcode",
	us_zip4: "postcode",
	uk_postcode: "postcode",
	fr_postcode: "postcode",
	ca_postcode: "postcode",
	de_postcode: "postcode",
	jp_postcode: "postcode",
	nl_postcode: "postcode",
	cz_postcode: "postcode",
	sk_postcode: "postcode",
	se_postcode: "postcode",
	gr_postcode: "postcode",
	po_box: "po_box",
} as const satisfies Record<KnownFormat, string>

/**
 * The slice of a {@link GeocodeRun} an account reads, declared structurally.
 *
 * A `GeocodeRun` satisfies this by shape, so `runDiagnose` passes one straight through — and the assembly stays
 * testable without constructing a whole `GeocodeResult`, which is twenty-five fields of which six matter here.
 */
export interface AccountInput {
	result: {
		lat: number | null
		lon: number | null
		resolution_tier: string
		components: Record<string, string | undefined>
		hierarchy: ReadonlyArray<{
			tag: string
			name: string
			placeID?: string | undefined
			in_winner_lineage?: boolean | undefined
		}>
		admin_coherence?: { region: string; country: string } | undefined
	}
	trace?:
		| {
				parse: NeuralParseTrace
				queryShape: { knownFormats: ReadonlyArray<{ format: string; confidence: number; span: { body: string } }> }
				kind?: { kind: string; confidence: number } | undefined
				inputMode: string
				resolver?: ReadonlyArray<ResolveNodeTrace> | undefined
		  }
		| undefined
}

//#region Facts

/**
 * The decode's own confidence, over the tokens the tree was built from.
 *
 * `n_tokens: 0` with null statistics is a real state (an empty parse), kept apart from a mean of zero — one says
 * nothing was decoded, the other says everything was decoded with no confidence.
 */
interface DecodeReading {
	path: "viterbi" | "argmax"
	n_tokens: number
	mean_confidence: number | null
	min_confidence: number | null
}

interface KnownFormatReading {
	format: string
	confidence: number
	text: string
	/**
	 * The component tag this format asserts. `null` means the format maps to no component — the detector saw a shape the
	 * schema has no slot for, which is not a contradiction.
	 */
	expects_component: string | null
	matched: boolean
}

export interface ParseFacts {
	kind: { verdict: string; confidence: number } | null
	/**
	 * Why {@link ParseFacts.kind} is null, when it is. The classifier is skipped when a caller pinned the register, which
	 * is a fact about the call — not a zero-confidence verdict.
	 */
	kind_absent_reason?: string
	input_mode: string
	known_formats: KnownFormatReading[]
	priors_present: TracePriorKind[]
	priors_applied: TracePriorKind[]
	repairs: string[]
	decode: DecodeReading
}

/**
 * One backend lookup, reduced to the facts a shape reads. The candidate table itself is deliberately NOT carried —
 * `mwdev_trace` renders it, and an account that dumped it would be a trace with extra steps.
 */
interface LookupFact {
	tag: string
	value: string
	placetype: string
	scope: { country?: string; parent?: string | number; qualifier?: string }
	n_candidates: number
	candidates_truncated: number
	checks: string[]
	picked: { name: string; source: string } | null
	/**
	 * The picked candidate's rank in the FIRST recorded stage (the backend's own order), or `null` when nothing was
	 * picked or the pick came from a path that never ranked.
	 */
	picked_initial_rank: number | null
	/**
	 * The first ranking stage at which the picked candidate reached rank 1, when it did not start there.
	 */
	flipped_at: string | null
}

export interface RetrievalFacts {
	/**
	 * `null` when the trace carries no resolver records at all (a trace predating them). An EMPTY array is the walk
	 * stating it performed no lookups — a different claim, and one the shapes must not read as retrieval failure.
	 *
	 * COVERAGE BOUND, and it is required for every retrieval shape below: the trace records the WALK's own
	 * `#lookupAndPick` and nothing else. The resolver's post-walk recovery passes — span-rescore (a famous name the model
	 * tagged `street`, which the walk never queries because `street` is not in the placetype map) and the
	 * postcode-compound recovery — query the backend directly and emit no record. So a row can carry a resolved
	 * coordinate beside an EMPTY lookup list; {@link RowAccount.resolved_without_recorded_lookup} states exactly that
	 * case rather than leaving the reader to read the empty list as "no retrieval happened".
	 */
	lookups: LookupFact[] | null
	gates_fired: string[]
}

export interface OutcomeFacts {
	tier: string
	abstained: boolean
	/**
	 * `null` when the geocode resolved no winner to check against — the absence of a check, never a passing one.
	 */
	admin_coherence: { region: string; country: string } | null
	outside_winner_lineage: Array<{ tag: string; name: string; place_id: string | null }>
	lineage_vouched: number
	/**
	 * Hierarchy entries whose lineage standing could not be established (no sidecar, or no place identity). Counted apart
	 * from `outside_winner_lineage`: unverifiable is not contradicted.
	 */
	lineage_unverifiable: number
}

/**
 * How the row was graded, and against what. `met: null` means the row asserts nothing — never that it passed.
 */
export interface ExpectationReading {
	source: "board_case" | "corpus_row" | "none"
	met: boolean | null
	issues: string[]
}

export interface RowAccount {
	id: string
	input: string
	country?: string | undefined
	shapes: DiagnoseShape[]
	/**
	 * `null` when the run carried no parse trace — the bundle could not produce one. Distinct from a parse whose every
	 * channel is absent.
	 */
	parse: ParseFacts | null
	evidence: EvidenceCensus | null
	retrieval: RetrievalFacts
	outcome: OutcomeFacts
	expectation: ExpectationReading
	/**
	 * A coordinate arrived and the resolver trace recorded NO lookup — the account's retrieval facts are blind for this
	 * row. See {@link RetrievalFacts.lookups} for which passes are outside the trace's coverage. Reported so the empty
	 * lookup list is not read as "retrieval had nothing to do": the retrieval shapes cannot fire here, and their silence
	 * is a coverage bound rather than a finding.
	 */
	resolved_without_recorded_lookup: boolean
	/**
	 * The trace's own stated absence, when there was none.
	 */
	trace_absent_reason?: string
	counterfactuals?: RowCounterfactuals | undefined
	rendered: string
}

function decodeReading(parse: NeuralParseTrace): DecodeReading {
	const confidences = parse.tokens.map((token) => token.confidence)

	return {
		path: parse.decode,
		n_tokens: confidences.length,
		mean_confidence: confidences.length
			? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
			: null,
		min_confidence: confidences.length ? Math.min(...confidences) : null,
	}
}

/**
 * Fold a detector span and a component value to the same comparable form.
 *
 * Known-format spans are offsets into the NORMALIZED input while component values are sliced from the RAW one, so the
 * two frames cannot be compared by offset. Folding away case and every non-alphanumeric character compares what both
 * frames do agree on — the characters — which is what the contradiction is about.
 */
function foldForSpanMatch(value: string): string {
	return value.toLowerCase().replaceAll(/[^\da-z]/g, "")
}

export function collectParseFacts(
	trace: NonNullable<AccountInput["trace"]>,
	components: Record<string, string | undefined>
): ParseFacts {
	const priors = priorSignals(trace.parse)

	const knownFormats = trace.queryShape.knownFormats.map((hit): KnownFormatReading => {
		const expects = (COMPONENT_FOR_KNOWN_FORMAT as Record<string, string | undefined>)[hit.format] ?? null
		const carried = expects === null ? undefined : components[expects]
		const wanted = foldForSpanMatch(hit.span.body)

		return {
			format: hit.format,
			confidence: hit.confidence,
			text: hit.span.body,
			expects_component: expects,
			matched: wanted.length > 0 && carried !== undefined && foldForSpanMatch(carried).includes(wanted),
		}
	})

	return {
		kind: trace.kind ? { verdict: trace.kind.kind, confidence: trace.kind.confidence } : null,
		...(trace.kind
			? {}
			: {
					kind_absent_reason:
						"the kind classifier did not run — a caller pinned the input register, so there is no verdict rather " +
						"than a zero-confidence one",
				}),
		input_mode: trace.inputMode,
		known_formats: knownFormats,
		priors_present: priors.present,
		priors_applied: priors.applied,
		repairs: trace.parse.repairs.map((repair) => repair.pass),
		decode: decodeReading(trace.parse),
	}
}

export function collectRetrievalFacts(records: ReadonlyArray<ResolveNodeTrace> | undefined): RetrievalFacts {
	if (!records) return { lookups: null, gates_fired: [] }

	const lookups = records.map((record): LookupFact => {
		const picked = record.picked
		const pickedRow = picked ? record.candidates.find((candidate) => candidate.id === picked.id) : undefined
		// The rank vector's key order IS the resolver's stage execution order — the recorder writes one entry per stage
		// as it runs — so the first key is the backend's own order and the last is the order the pick came from.
		const stages = pickedRow ? Object.keys(pickedRow.ranks) : []
		const firstStage = stages[0]
		const initialRank = pickedRow && firstStage ? (pickedRow.ranks[firstStage] ?? null) : null

		return {
			tag: record.tag,
			value: record.value,
			placetype: record.placetype,
			scope: {
				...(record.query.country === undefined ? {} : { country: record.query.country }),
				...(record.query.parentID === undefined ? {} : { parent: record.query.parentID }),
				...(record.query.regionQualifier === undefined ? {} : { qualifier: record.query.regionQualifier }),
			},
			n_candidates: record.candidates.length,
			candidates_truncated: record.candidatesTruncated,
			checks: record.checks,
			picked: picked ? { name: picked.name, source: picked.source } : null,
			picked_initial_rank: initialRank,
			flipped_at:
				initialRank !== null && initialRank > 1
					? (stages.find((stage) => pickedRow!.ranks[stage] === 1) ?? null)
					: null,
		}
	})

	const checks = new Set<string>()

	for (const lookup of lookups) {
		for (const gate of lookup.checks) {
			checks.add(gate)
		}
	}

	return { lookups, gates_fired: [...checks] }
}

export function collectOutcomeFacts(result: AccountInput["result"]): OutcomeFacts {
	const outside: OutcomeFacts["outside_winner_lineage"] = []
	let vouched = 0
	let unverifiable = 0

	for (const entry of result.hierarchy) {
		if (entry.in_winner_lineage === true) {
			vouched++
		} else if (entry.in_winner_lineage === false) {
			outside.push({ tag: entry.tag, name: entry.name, place_id: entry.placeID ?? null })
		} else {
			unverifiable++
		}
	}

	return {
		tier: result.resolution_tier,
		abstained: result.lat === null || result.lon === null,
		admin_coherence: result.admin_coherence ?? null,
		outside_winner_lineage: outside,
		lineage_vouched: vouched,
		lineage_unverifiable: unverifiable,
	}
}

//#endregion

//#region Shapes

/**
 * Match the mechanism-state predicates.
 *
 * The terminal states are NOT decided here: `clean` vs `unclassified` needs the row's expectation, and keeping that out
 * of this function is what stops an expectation from ever influencing a MECHANISM claim (commitment 1).
 */
export function matchShapes(facts: {
	parse: ParseFacts | null
	evidence: EvidenceCensus | null
	retrieval: RetrievalFacts
	outcome: OutcomeFacts
}): DiagnoseShape[] {
	const shapes: DiagnoseShape[] = []
	const lookups = facts.retrieval.lookups ?? []

	if (
		facts.parse?.known_formats.some(
			(hit) => hit.confidence >= KNOWN_FORMAT_CONFIDENCE_FLOOR && hit.expects_component !== null && !hit.matched
		)
	) {
		shapes.push("parse_shape_contradiction")
	}

	if (facts.evidence?.silent) {
		shapes.push("evidence_starved")
	}

	// A span is only empty AT THE DECIDING SITE when nothing resolved it: a `postcode_format_probe` and an
	// `empty_admin_pick` both answer off an empty candidate table, and reading those as retrieval failure would report
	// a working fallback as a defect.
	const emptyDeciding = lookups.some(
		(lookup) =>
			lookup.n_candidates === 0 &&
			!lookup.picked &&
			!lookups.some((other) => other.tag === lookup.tag && other.value === lookup.value && other.picked)
	)

	if (emptyDeciding) {
		shapes.push("retrieval_empty")
	}

	// The rule fires only when the scoped probe missed across the whole cascade AND the unscoped fallback produced
	// rows — so every candidate in that lookup is a re-admitted one, and a pick under the eval is a re-admitted pick.
	// The per-candidate `regionScopeMiss` stamp does not reach `ResolveCandidateTrace`, so lookup granularity is all
	// the trace can support; it suffices here because the rule's own condition covers the whole row set.
	if (lookups.some((lookup) => lookup.checks.includes("region_scope_miss") && lookup.picked)) {
		shapes.push("scope_miss_readmission")
	}

	if (lookups.some((lookup) => lookup.picked_initial_rank !== null && lookup.picked_initial_rank > 1)) {
		shapes.push("rank_flip")
	}

	const contradicted =
		facts.outcome.admin_coherence?.region === "contradicted" ||
		facts.outcome.admin_coherence?.country === "contradicted"

	if (contradicted || facts.outcome.outside_winner_lineage.length) {
		shapes.push("wrong_instance_detected")
	}

	return shapes
}

//#endregion

//#region Expectations

/**
 * The case table this row is graded against, or `null` when it asserts nothing.
 *
 * A board row carries a `SeedCase` and grades through the board's own `checkCase`. A panel / holdout / golden / parity
 * row carries expectations without a seed, so one is SYNTHESIZED around what its corpus actually pinned — the same
 * grader then reads both, which is what keeps a second grading path from appearing here.
 */
export function expectationCase(
	item: ResolvedInput
): { table: GauntletCaseTable; source: "board_case" | "corpus_row" } | null {
	if (item.seed) {
		return caseCarriesTruth(item.seed) ? { table: seedToCaseTable(item.seed), source: "board_case" } : null
	}

	const hasCoordinate = typeof item.truthLat === "number" && typeof item.truthLon === "number"

	if (!hasCoordinate && !item.expectComponents) return null

	return {
		source: "corpus_row",
		table: {
			id: item.id,
			input: item.input,
			source: "dev-mcp:diagnose",
			address_kind: item.addressKind ?? "unknown",
			country: item.country ?? "",
			status: "pass",
			expect_components: item.expectComponents ? JSON.stringify(item.expectComponents) : null,
			expect_component_renderings: null,
			expect_place_id: null,
			expect_place_name: null,
			expect_lat: item.truthLat ?? null,
			expect_lon: item.truthLon ?? null,
			// Null where the corpus pinned none, so `checkCase` applies its own default rather than this module
			// inventing a tolerance no corpus agreed to.
			expect_tolerance_m: item.toleranceM ?? null,
			expect_tier: null,
			default_country: null,
			added_at: "",
			bug_ref: null,
			note: null,
			ablation_expect: null,
			locale: null,
			expect_abstain: null,
		},
	}
}

/**
 * Grade one row against whatever its corpus pinned.
 *
 * Typed against the real `GeocodeResult` rather than {@link AccountInput}: `checkCase` reads the gauntlet projection,
 * and projecting twice is how a recorded answer and the live one it came from stop agreeing.
 */
function gradeExpectation(item: ResolvedInput, result: GeocodeRun["result"]): ExpectationReading {
	const expectation = expectationCase(item)

	if (!expectation) return { source: "none", met: null, issues: [] }

	const issues = checkCase(expectation.table, toGauntletResult(result))

	return { source: expectation.source, met: issues.length === 0, issues }
}

//#endregion

//#region Rendering

function channelMark(reading: ChannelReading): string {
	return reading.state
}

/**
 * One line per row — the tool-kit renderer pattern. The structured account is what a diff reads; this is what a human
 * reads in a transcript without an agent paraphrasing it, which is where detail goes missing.
 */
export function renderAccount(account: Omit<RowAccount, "rendered">): string {
	const parts: string[] = [`${account.id} [${account.shapes.join(",")}]`, `tier=${account.outcome.tier}`]

	if (account.outcome.abstained) {
		parts.push("ABSTAINED")
	}

	if (account.parse?.kind) {
		parts.push(`kind=${account.parse.kind.verdict}@${account.parse.kind.confidence.toFixed(2)}`)
	}

	if (account.evidence) {
		parts.push(
			`channels a:${channelMark(account.evidence.anchor)} g:${channelMark(account.evidence.gazetteer)} ` +
				`c:${channelMark(account.evidence.country)}`
		)
	}

	const flipped = (account.retrieval.lookups ?? []).find((lookup) => lookup.flipped_at !== null)

	if (flipped) {
		parts.push(
			`${flipped.tag} "${flipped.picked?.name ?? "?"}" rank ${flipped.picked_initial_rank}→1 at ${flipped.flipped_at}`
		)
	}

	if (account.resolved_without_recorded_lookup) {
		parts.push("resolved with NO recorded lookup (the resolver trace does not cover this result)")
	}

	const empty = (account.retrieval.lookups ?? []).filter((lookup) => lookup.n_candidates === 0 && !lookup.picked)

	if (empty.length) {
		parts.push(`0 candidates for ${empty.map((lookup) => `${lookup.tag} "${lookup.value}"`).join(", ")}`)
	}

	const coherence = account.outcome.admin_coherence

	if (coherence && (coherence.region === "contradicted" || coherence.country === "contradicted")) {
		parts.push(`coherence region=${coherence.region} country=${coherence.country}`)
	}

	if (account.outcome.outside_winner_lineage.length) {
		parts.push(
			`outside winner lineage: ${account.outcome.outside_winner_lineage
				.map((entry) => `${entry.tag} ${entry.name}`)
				.join(", ")}`
		)
	}

	if (account.expectation.met === false) {
		parts.push(`FAILS: ${account.expectation.issues.join("; ")}`)
	}

	for (const move of account.counterfactuals?.moves ?? []) {
		parts.push(
			`cf ${move.lever} ${move.from}→${move.to} ` +
				(move.changed_abstention
					? `changes abstention (now ${move.answer.lat === null ? "no coordinate" : "resolved"})`
					: `moves ${move.moved_km!.toFixed(1)}km`)
		)
	}

	return parts.join(" · ")
}

//#endregion

//#region Aggregation

export interface ShapeAggregate {
	n: number
	row_ids: string[]
	/**
	 * Ids not listed because the list hit its cap. A display bound, never a measurement one — `n` is the whole class.
	 */
	row_ids_omitted: number
	predicate: string
}

/**
 * Per-shape counts and the rows in each class.
 *
 * Ordered by {@link DIAGNOSE_SHAPES} so two runs are diffable, and a shape no row matched is OMITTED rather than
 * reported as zero — a class with no members is not a class anyone can describe, and a table of zeros reads as a
 * measurement of them.
 */
export function aggregateByShape(
	accounts: ReadonlyArray<{ id: string; shapes: DiagnoseShape[] }>
): Record<string, ShapeAggregate> {
	const out: Record<string, ShapeAggregate> = {}

	for (const shape of DIAGNOSE_SHAPES) {
		const matched = accounts.filter((account) => account.shapes.includes(shape))

		if (!matched.length) continue

		out[shape] = {
			n: matched.length,
			row_ids: matched.slice(0, SHAPE_ID_CAP).map((account) => account.id),
			row_ids_omitted: Math.max(0, matched.length - SHAPE_ID_CAP),
			predicate: SHAPE_PREDICATES[shape],
		}
	}

	return out
}

export interface LeverTally {
	tried_on: number
	moved: number
	skipped: number
}

/**
 * Per-lever counterfactual counts: how many rows the lever was tried on, how many it moved, how many it could not apply
 * to.
 *
 * All three, always. A lever that moved nothing on forty rows and a lever that was never applicable are the same zero
 * in a moved-only table, and they are not the same fact.
 */
export function aggregateCounterfactuals(
	accounts: ReadonlyArray<{ counterfactuals?: RowCounterfactuals | undefined }>
): Record<string, LeverTally> {
	const out: Record<string, LeverTally> = {}

	for (const lever of COUNTERFACTUAL_LEVERS) {
		out[lever] = { tried_on: 0, moved: 0, skipped: 0 }
	}

	for (const account of accounts) {
		const reading = account.counterfactuals

		if (!reading) continue

		for (const lever of reading.levers_tried) {
			out[lever]!.tried_on++
		}

		for (const skip of reading.levers_skipped) {
			out[skip.lever]!.skipped++
		}

		for (const move of reading.moves) {
			out[move.lever]!.moved++
		}
	}

	return out
}

//#endregion

/**
 * The in-vocabulary mis-tag refinement of `unclassified` (#1722 v2 — the `bd-op2-london-college` class, where `Dhaka
 * 1205` decoded as street + house_number and the expected locality/postcode never existed): an expected component tag
 * the parse never produced, whose expected VALUE occurs verbatim in the input. A tag that exists with a WRONG value is
 * a different fact and stays out — that failure has a component to interrogate; this one does not.
 */
function misTaggedInVocabulary(
	item: ResolvedInput,
	components: Record<string, string | undefined> | undefined
): boolean {
	const expected = item.seed?.expectComponents ?? item.expectComponents

	if (!expected) return false

	const input = item.input.toLowerCase()

	return Object.entries(expected).some(
		([tag, value]) => Boolean(value) && components?.[tag] === undefined && input.includes(String(value).toLowerCase())
	)
}

/**
 * Assemble one row's account: the facts, the shapes they match, and the terminal state.
 */
export function assembleAccount(
	item: ResolvedInput,
	run: AccountInput,
	expectation: ExpectationReading
): Omit<RowAccount, "rendered"> {
	const trace = run.trace
	const parse = trace ? collectParseFacts(trace, run.result.components) : null
	const evidence = trace ? evidenceCensus(trace.parse) : null
	const retrieval = collectRetrievalFacts(trace?.resolver)
	const outcome = collectOutcomeFacts(run.result)
	const shapes = matchShapes({ parse, evidence, retrieval, outcome })

	if (!shapes.length) {
		if (expectation.met === false) {
			shapes.push(misTaggedInVocabulary(item, run.result.components) ? "mis_tag_in_vocabulary" : "unclassified")
		} else {
			shapes.push("clean")
		}
	}

	return {
		id: item.id,
		input: item.input,
		country: item.country,
		shapes,
		parse,
		evidence,
		retrieval,
		outcome,
		expectation,
		resolved_without_recorded_lookup: !outcome.abstained && retrieval.lookups?.length === 0,
		...(trace
			? {}
			: {
					trace_absent_reason:
						"No trace was recorded for this run, so the parse, evidence and retrieval facts are ABSENT — not " +
						"silent. Either the session refused to trace, or the loaded bundle's classifier cannot produce one.",
				}),
	}
}

/**
 * Run the diagnosis: one traced geocode per row, an account per row, the counterfactual sweep, aggregated by shape.
 */
export async function runDiagnose(registry: EngineRegistryLike, args: Record<string, unknown>): Promise<unknown> {
	const ref = (args["inputs"] as InputSetRef | undefined) ?? { kind: "board" }
	const config = (args["config"] as EngineConfig | undefined) ?? {}
	const limit = args["limit"] as number | undefined
	const rowsCap = args["rows_cap"] as number | undefined
	const wantCounterfactuals = args["counterfactuals"] !== false

	const set = await resolveInputSet(ref)
	// Tracing is the account's entire input, so it is forced on regardless of what the caller passed.
	const engine = await registry.acquire({ ...config, trace: true, diagnose_unreachable: true })
	const selected = limit ? set.inputs.slice(0, limit) : set.inputs

	const startedAt = Date.now()
	const accounts: Array<Omit<RowAccount, "rendered">> = []
	const errors: Array<{ id: string; input: string; message: string }> = []
	const targets: CounterfactualTarget[] = []

	for (const item of selected) {
		try {
			const run = await engine.session.geocode(item.input)

			accounts.push(assembleAccount(item, run, gradeExpectation(item, run.result)))

			targets.push({
				id: item.id,
				input: item.input,
				country: item.country,
				base: { lat: run.result.lat, lon: run.result.lon, tier: run.result.resolution_tier },
			})
		} catch (error) {
			errors.push({ id: item.id, input: item.input, message: (error as Error).message })
		}
	}

	const narrowed = accounts.length > COUNTERFACTUAL_FULL_RUN_MAX_ROWS
	const flipCandidates = narrowed ? accounts.filter((account) => !account.shapes.includes("clean")) : accounts
	const eligible = new Set(flipCandidates.map((account) => account.id))

	let counterfactualErrors: Array<{ id: string; lever: string; message: string }> = []

	if (wantCounterfactuals) {
		const { byRow, errors: flipErrors } = await runCounterfactuals(
			registry,
			config,
			engine.effective,
			targets.filter((target) => eligible.has(target.id))
		)

		counterfactualErrors = flipErrors

		for (const account of accounts) {
			account.counterfactuals = byRow.get(account.id)
		}
	}

	const rows: RowAccount[] = accounts.map((account) => ({ ...account, rendered: renderAccount(account) }))

	// Stable partition, non-clean first — only the EMITTED order; every aggregate reads `rows` whole.
	const emittedRows = [
		...rows.filter((row) => !row.shapes.includes("clean")),
		...rows.filter((row) => row.shapes.includes("clean")),
	]

	const byShape = aggregateByShape(rows)
	const nonClean = rows.filter((row) => !row.shapes.includes("clean")).length

	const reading = describeObservedRate({
		events: nonClean,
		n: rows.length,
		selection: set.selection,
		eventLabel: "matched at least one mechanism-state shape",
		...(set.populationN === undefined ? {} : { populationN: set.populationN }),
	})

	const unclassified = byShape["unclassified"]?.n ?? 0
	const blindRetrieval = rows.filter((row) => row.resolved_without_recorded_lookup).length

	const counterfactualSentence = !wantCounterfactuals
		? "Counterfactuals were NOT run (counterfactuals: false), so no lever here is priced — a shape without one says " +
			"what the pipeline did, never that it decided the answer."
		: narrowed
			? `Above ${COUNTERFACTUAL_FULL_RUN_MAX_ROWS} rows the sweep narrows to rows that matched a non-clean shape, ` +
				`because a full sweep is one geocode per row per lever: ${eligible.size} of ${rows.length} row(s) ` +
				`qualified${eligible.size === rows.length ? " — every row here did" : ""}. A clean row's levers are ` +
				"UNMEASURED in this result, not measured and found inert."
			: `Counterfactuals ran on all ${rows.length} row(s) across the ${COUNTERFACTUAL_LEVERS.length}-lever space; a ` +
				`flip is reported when it moved the answer more than ${COUNTERFACTUAL_MOVED_KM}km or changed abstention.`

	return {
		provenance: provenanceFor(engine, set),
		input_set: inputSetProvenance(set),
		calibration: "none — v1 fact set-fact matching",
		calibration_note:
			"Shapes here are PREDICATE MATCHES over pipeline facts, carrying no coverage guarantee: there is no confidence, " +
			"no abstention band and no guarantee attached to any of them. Each shape's predicate travels beside its " +
			"count so the claim is checkable by reading it.",
		summary: [
			reading.sentence,
			`Shapes matched: ${
				Object.entries(byShape)
					.map(([shape, entry]) => `${shape} ${entry.n}`)
					.join(", ") || "none"
			}.`,
			unclassified
				? `${unclassified} row(s) FAILED an expectation and matched no mechanism-state shape — the NOVELTY signal, ` +
					"not a residual: v1 has no predicate for whatever those rows did."
				: "",
			blindRetrieval
				? `${blindRetrieval} row(s) resolved with NO recorded lookup — the resolver trace covers the walk's own ` +
					"lookups, so a span-rescore or postcode-compound recovery answers off the record. The retrieval shapes " +
					"cannot fire on those rows, and their silence there is a coverage bound, not a finding."
				: "",
			counterfactualSentence,
		]
			.filter((sentence) => sentence.length > 0)
			.join(" "),
		n_requested: selected.length,
		n_evaluated: rows.length,
		n_errored: errors.length,
		errors,
		power: reading,
		n_resolved_without_recorded_lookup: blindRetrieval,
		by_shape: byShape,
		by_shape_note:
			"A row can match several shapes, so these counts OVERLAP and must never be summed. `n` is the whole class; " +
			`\`row_ids\` lists at most ${SHAPE_ID_CAP} of them and \`row_ids_omitted\` says how many it left out.`,
		counterfactual_levers: aggregateCounterfactuals(rows),
		counterfactuals_narrowed: narrowed,
		counterfactual_errors: counterfactualErrors,
		elapsed_ms: Date.now() - startedAt,
		// Under a cap the emitted slice leads with non-clean rows — the ones every aggregate above points
		// at — and says what it left out. The aggregates are computed over EVERY row regardless.
		rows: rowsCap === undefined ? emittedRows : emittedRows.slice(0, rowsCap),
		rows_omitted: rowsCap === undefined ? 0 : Math.max(0, emittedRows.length - rowsCap),
	}
}
