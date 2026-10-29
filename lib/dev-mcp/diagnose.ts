/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Mechanism accounts — per row, what the pipeline did, assembled from the facts it already exposes.
 *
 * Two commitments bind every line here. Expectations pin results rather than mechanisms.
 * Each account is recomputed from the current system on every call. Failure shapes describe
 * mechanisms rather than address forms. Each predicate reads pipeline facts: channels, constraints,
 * ranks and lineage.
 *
 * Classification is v1: transparent predicates over recorded pipeline facts, with no calibration — every
 * result records that in its own `calibration` field — and a row that matches no shape while failing its
 * expectation is reported `unclassified` rather than squeezed into the nearest match.
 *
 * Aggregation is by shape with each class's n, never by raw row count, because a rate over a mixture is a
 * number about the mixture.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import type { ResolveNodeTrace } from "@mailwoman/core/resolver"
import type { NeuralParseTrace, TracePriorKind } from "@mailwoman/neural"
import type { GeocodeTrace } from "mailwoman/geocode"
import { resolveCandidateDBPath } from "mailwoman/resolver-backend"
import {
	candidateBandProbe,
	type ComponentReachability,
	describeComponentReachability,
	describePlacetypeCounts,
	readExpectationReachability,
} from "mailwoman/tools/eval-harness/gauntlet/reachability"
import { OVERLAY_LOCALE_BY_COUNTRY, routeCountry } from "mailwoman/tools/eval-harness/gauntlet/routing"

import {
	BASE_LOCALE,
	COUNTERFACTUAL_SETTINGS,
	COUNTERFACTUAL_MOVED_KM,
	runCounterfactuals,
	type CounterfactualTarget,
	type RowCounterfactuals,
} from "#dev-mcp/counterfactual"
import { runConstraintAccountForArgs } from "#dev-mcp/diagnose/constraints"
import { gradeExpectation, type ExpectationReading } from "#dev-mcp/diagnose/expectation"
import type { EngineConfig, EngineRegistryLike } from "#dev-mcp/engine/registry"
import { evidenceCensus, priorSignals, type ChannelReading, type EvidenceCensus } from "#dev-mcp/evidence"
import { resolveInputSet, type InputSetRef, type ResolvedInput } from "#dev-mcp/input-sets"
import { openSealedArtifact } from "#dev-mcp/lookup"
import { describeObservedRate } from "#dev-mcp/power"
import { inputSetProvenance, provenanceFor } from "#dev-mcp/tool-kit"

export { expectationCase, type ExpectationReading } from "#dev-mcp/diagnose/expectation"

/**
 * The confidence at which a known-format hit is treated as a structural assertion
 * that a disagreeing parse contradicts.
 *
 * `KnownFormatHit.confidence` is deliberately damped where postcode shapes overlap
 * (`fr_postcode` / `de_postcode` against `us_zip` is the documented case),
 * A hit below this floor means the detector cannot tell the shapes apart.
 * Disagreement at that confidence would misreport ambiguity as a defect.
 */
const KNOWN_FORMAT_CONFIDENCE_FLOOR = 0.9

/**
 * Row ids listed per shape before the list is capped.
 *
 * The `n` beside it is always the real count, so this bounds the payload, never the measurement.
 */
const SHAPE_ID_CAP = 20

/**
 * Above this row count, counterfactuals run only on rows that matched a non-`clean` shape.
 *
 * A flip is one geocode per row per setting and the setting space is five wide, so a full
 * board would be thousands of extra resolves plus an engine build per distinct patch.
 * Every result that applies the narrowing records this and marks a clean row's
 * settings UNMEASURED rather than measured and found inert.
 */
export const COUNTERFACTUAL_FULL_RUN_MAX_ROWS = 20

/**
 * The v1 shape vocabulary, in pipeline execution order — parse, evidence, retrieval, ranking, result.
 *
 * A row can match several shapes.
 * Their order makes a multi-match readable: the earliest pipeline stage comes first,
 * so `[retrieval_empty, wrong_instance_detected]` reads as one story rather than two verdicts.
 *
 * The two terminal states are mutually exclusive with everything, including each other.
 */
export const DIAGNOSE_SHAPES = [
	"parse_shape_contradiction",
	"evidence_starved",
	"retrieval_empty",
	"band_miss",
	"expectation_unreachable",
	"scope_miss_readmission",
	"rank_flip",
	"wrong_instance_detected",
	"clean",
	"mis_tag_in_vocabulary",
	"unclassified",
] as const

export type DiagnoseShape = (typeof DIAGNOSE_SHAPES)[number]

/**
 * What each shape asserts, as the predicate reads it.
 *
 * Emitted with every result so a classification travels with its own definition,
 * because a shape name relayed without its predicate is the bare label this design refuses.
 */
export const SHAPE_PREDICATES: Record<DiagnoseShape, string> = {
	parse_shape_contradiction:
		`A known-format hit at confidence ≥ ${KNOWN_FORMAT_CONFIDENCE_FLOOR} covers text the parse assigned to no ` +
		"component of the matching tag — the structural detector and the model disagree about the same characters.",
	evidence_starved:
		"At least one of the five channels (anchor, gazetteer, country, street_type, locality_surface) was fed and " +
		"EVERY fed channel was fed zeros, so the parse was decided by the token embeddings alone. A channel the " +
		"input mode withheld or a caller pinned off counts as fed zeros; the census names both. Not a health " +
		"verdict: a correct parse can be starved.",
	retrieval_empty:
		"A lookup returned zero candidates and picked nothing, and no other lookup for the same span recovered a pick " +
		"— the deciding site had nothing to decide between.",
	band_miss:
		"An empty deciding lookup whose key the unreachable-band probe found in OTHER placetype bands, so the gazetteer " +
		"holds the name and the band the parse tag selected does not. The row's rendered line names those bands. " +
		"A wrong parse tag and a tag-to-band mapping that omits the key's placetype both produce this shape; the " +
		"expectation reading tells them apart.",
	expectation_unreachable:
		"An expected admin component of this row has no candidate row in the band its tag maps to for the row's " +
		"country, while rows of another placetype hold the value. No parse can satisfy the row through that " +
		"component, so a coordinate miss here is a data condition before it is a model one. Read beside the " +
		"per-component `expectation_reachability` list, which also marks values ABSENT from every placetype.",
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
 * The format union, pulled off the trace's own type so a format added to
 * `@mailwoman/query-shape` without an entry in {@link COMPONENT_FOR_KNOWN_FORMAT}
 * is a compile error rather than a silently unchecked detector.
 */
type KnownFormat = GeocodeTrace["queryShape"]["knownFormats"][number]["format"]

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
 * The subset of a {@link GeocodeRun}'s fields an account reads, declared structurally.
 *
 * A `GeocodeRun` satisfies this by shape, so `runDiagnose` passes one straight through
 * and the assembly stays testable without constructing a whole `GeocodeResult`,
 * which is twenty-five fields of which six matter here.
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
			placeID?: string | null | undefined
			in_winner_lineage?: boolean | null | undefined
		}>
		admin_coherence?: { region: string; country: string } | null | undefined
	}
	trace?:
		| {
				parse: NeuralParseTrace
				queryShape: { knownFormats: ReadonlyArray<{ format: string; confidence: number; span: { body: string } }> }
				kind?: { kind: string; confidence: number } | null | undefined
				inputMode: string
				resolver?: ReadonlyArray<ResolveNodeTrace> | null | undefined
		  }
		| null
		| undefined
}

// #region Facts

/**
 * The decode's own confidence, over the tokens the tree was built from; `n_tokens: 0` with
 * null statistics is a real state (an empty parse), kept apart from a mean of zero.
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
	 * The component tag this format asserts.
	 *
	 * `null` means the format maps to no component.
	 * A missing component assertion is not a contradiction.
	 */
	expects_component: string | null
	matched: boolean
}

export interface ParseFacts {
	kind: { verdict: string; confidence: number } | null
	/**
	 * Why {@link ParseFacts.kind} is null.
	 *
	 * The classifier skips it when a caller pins the register.
	 * This records the call configuration rather than a zero-confidence verdict.
	 */
	kind_absent_reason: string | null
	input_mode: string
	known_formats: KnownFormatReading[]
	priors_present: TracePriorKind[]
	priors_applied: TracePriorKind[]
	repairs: string[]
	decode: DecodeReading
}

/**
 * One backend lookup, reduced to the facts a shape reads.
 *
 * The candidate table itself is deliberately omitted, since `mwdev_trace` renders it
 * and an account that dumped it would be a trace with extra steps.
 */
interface LookupFact {
	tag: string
	value: string
	placetype: string
	scope: { country: string | null; parent: string | number | null; qualifier: string | null }
	n_candidates: number
	candidates_truncated: number
	checks: string[]
	picked: { name: string; source: string } | null
	/**
	 * The picked candidate's rank in the first recorded stage (the backend's own order),
	 * or `null` when no candidate was picked or the pick came from a path that never ranked.
	 */
	picked_initial_rank: number | null
	/**
	 * The first ranking stage at which the picked candidate reached rank 1, when it did not start there.
	 */
	flipped_at: string | null
	/**
	 * The other placetype bands the unreachable-band probe found the key in, when the lookup was probed.
	 *
	 * `null` when the probe did not run.
	 * An empty list is a probed key that no other band holds.
	 */
	reachable_in: Array<{ placetype: string; n: number }> | null
}

export interface RetrievalFacts {
	/**
	 * `null` when the trace contains no resolver records (a trace predating them);
	 * an empty array is the walk stating it performed no lookups, a different claim
	 * the shapes must not read as retrieval failure.
	 *
	 * Coverage bound for every retrieval shape below: the trace records the
	 * walk's own `#lookupAndPick` method.
	 * It records no other method.
	 *
	 * The resolver's post-walk recovery passes — span-rescore and postcode-compound
	 * recovery — query the backend directly and emit no record.
	 * A row can therefore include a resolved coordinate beside an empty lookup list.
	 * {@link RowAccount.resolved_without_recorded_lookup} records that case.
	 */
	lookups: LookupFact[] | null
	checks_fired: string[]
}

export interface ResultFacts {
	tier: string
	abstained: boolean
	/**
	 * `null` when the geocode resolved no winner to check against — the absence
	 * of a check, never a passing one.
	 */
	admin_coherence: { region: string; country: string } | null
	outside_winner_lineage: Array<{ tag: string; name: string; place_id: string | null }>
	lineage_vouched: number
	/**
	 * Hierarchy entries whose lineage standing could not be established (no sidecar, or no place identity);
	 * counted apart from `outside_winner_lineage` because unverifiable is not contradicted.
	 */
	lineage_unverifiable: number
}

export interface RowAccount {
	id: string
	input: string
	country: string | null
	shapes: DiagnoseShape[]
	/**
	 * `null` when the run produced no parse trace (the bundle could not produce one),
	 * distinct from a parse whose every channel is absent.
	 */
	parse: ParseFacts | null
	evidence: EvidenceCensus | null
	retrieval: RetrievalFacts
	result: ResultFacts
	expectation: ExpectationReading
	/**
	 * Per expected admin component, whether the resolver's band for its tag holds
	 * the value in the row's country.
	 *
	 * `null` when the row states no expected admin component or the candidate table was not opened.
	 * An unread condition is reported as unread rather than as reachable.
	 */
	expectation_reachability: ComponentReachability[] | null
	/**
	 * The engine the row ran under on the board-routed path, or `null` on the single-config path.
	 */
	routing: RowRouting | null
	/**
	 * A coordinate arrived and the resolver trace recorded no lookup, so the account's retrieval facts are
	 * blind for this row (see {@link RetrievalFacts.lookups} for which passes the trace does not cover);
	 * reported so the empty lookup list is not read as "retrieval had no work to do".
	 */
	resolved_without_recorded_lookup: boolean
	/**
	 * The trace's own stated absence, when there was none.
	 */
	trace_absent_reason: string | null
	counterfactuals: RowCounterfactuals | null
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
 * Known-format spans are offsets into the normalized input while component values
 * come from the RAW one, so folding away case and every non-alphanumeric character
 * compares the characters both frames agree on.
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
		const carried = expects ? components[expects] : null
		const wanted = foldForSpanMatch(hit.span.body)

		return {
			format: hit.format,
			confidence: hit.confidence,
			text: hit.span.body,
			expects_component: expects,
			matched: wanted.length > 0 && carried != null && foldForSpanMatch(carried).includes(wanted),
		}
	})

	return {
		kind: trace.kind ? { verdict: trace.kind.kind, confidence: trace.kind.confidence } : null,
		kind_absent_reason: trace.kind
			? null
			: "the kind classifier did not run — a caller pinned the input register, so there is no verdict rather " +
				"than a zero-confidence one",
		input_mode: trace.inputMode,
		known_formats: knownFormats,
		priors_present: priors.present,
		priors_applied: priors.applied,
		repairs: trace.parse.repairs.map((repair) => repair.pass),
		decode: decodeReading(trace.parse),
	}
}

export function collectRetrievalFacts(records: ReadonlyArray<ResolveNodeTrace> | null): RetrievalFacts {
	if (!records) return { lookups: null, checks_fired: [] }

	const lookups = records.map((record): LookupFact => {
		const picked = record.picked
		const pickedRow = picked ? record.candidates.find((candidate) => candidate.id === picked.id) : null
		// The rank vector's key order is the resolver's stage execution order,
		// because the recorder writes one entry per stage as it runs: the first key is
		// the backend's own order, the last the order the pick came from.
		const stages = pickedRow ? Object.keys(pickedRow.ranks) : []
		const firstStage = stages[0]
		const initialRank = pickedRow && firstStage ? (pickedRow.ranks[firstStage] ?? null) : null

		return {
			tag: record.tag,
			value: record.value,
			placetype: record.placetype,
			scope: {
				country: record.query.country ?? null,
				parent: record.query.parentID ?? null,
				qualifier: record.query.regionQualifier ?? null,
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
			reachable_in: record.reachableIn ?? null,
		}
	})

	const checks = new Set<string>()

	for (const lookup of lookups) {
		for (const check of lookup.checks) {
			checks.add(check)
		}
	}

	return { lookups, checks_fired: [...checks] }
}

export function collectResultFacts(result: AccountInput["result"]): ResultFacts {
	const outside: ResultFacts["outside_winner_lineage"] = []
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

// #endregion

// #region Shapes

/**
 * Match the mechanism-state predicates.
 *
 * This function does not decide the terminal states.
 * The row's expectation determines `clean` or `unclassified`.
 *
 * That expectation stays outside this function so it cannot influence a mechanism claim.
 */
export function matchShapes(facts: {
	parse: ParseFacts | null
	evidence: EvidenceCensus | null
	retrieval: RetrievalFacts
	result: ResultFacts
	/**
	 * The row's expected-component reachability, or `null` when the row stated no
	 * expected admin component or the candidate table was not opened.
	 */
	reachability?: ComponentReachability[] | null
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

	// A span is only empty AT the deciding site when no lookup resolved it: Both
	// `postcode_format_probe` and `empty_admin_pick` answer from an empty candidate table.
	// A retrieval-failure label for either case would report a working fallback as a defect.
	const emptyDeciding = lookups.some(
		(lookup) =>
			lookup.n_candidates === 0 &&
			!lookup.picked &&
			!lookups.some((other) => other.tag === lookup.tag && other.value === lookup.value && other.picked)
	)

	if (emptyDeciding) {
		shapes.push("retrieval_empty")
	}

	// The band probe runs only on a lookup with zero candidates.
	// A non-empty `reachable_in` on such a lookup is the gazetteer holding the key
	// under a placetype the selected band excludes.
	const bandMiss = lookups.some(
		(lookup) =>
			lookup.n_candidates === 0 &&
			!lookup.picked &&
			(lookup.reachable_in?.length ?? 0) > 0 &&
			!lookups.some((other) => other.tag === lookup.tag && other.value === lookup.value && other.picked)
	)

	if (bandMiss) {
		shapes.push("band_miss")
	}

	if (facts.reachability?.some((reading) => reading.state === "unreachable")) {
		shapes.push("expectation_unreachable")
	}

	// The rule fires only when the scoped probe missed across the whole cascade and the
	// unscoped fallback produced rows, so every candidate in that lookup is a re-admitted one.
	// The per-candidate `regionScopeMiss` stamp does not reach `ResolveCandidateTrace`,
	// so lookup granularity is all the trace can support.
	if (lookups.some((lookup) => lookup.checks.includes("region_scope_miss") && lookup.picked)) {
		shapes.push("scope_miss_readmission")
	}

	if (lookups.some((lookup) => lookup.picked_initial_rank !== null && lookup.picked_initial_rank > 1)) {
		shapes.push("rank_flip")
	}

	const contradicted =
		facts.result.admin_coherence?.region === "contradicted" || facts.result.admin_coherence?.country === "contradicted"

	if (contradicted || facts.result.outside_winner_lineage.length) {
		shapes.push("wrong_instance_detected")
	}

	return shapes
}

// #endregion

// #region Rendering

function channelMark(reading: ChannelReading): string {
	return reading.state
}

/**
 * One line per row — the tool-kit renderer pattern.
 *
 * The structured account is what a diff reads.
 * A human reads this in a transcript without an agent paraphrasing it.
 * Agent paraphrases can omit details.
 */
export function renderAccount(account: Omit<RowAccount, "rendered">): string {
	const parts: string[] = [`${account.id} [${account.shapes.join(",")}]`, `tier=${account.result.tier}`]

	if (account.result.abstained) {
		parts.push("ABSTAINED")
	}

	if (account.routing) {
		parts.push(
			`routed ${account.routing.locale ?? "base"}${account.routing.country_scope === "none" ? " unscoped" : ""}`
		)
	}

	if (account.parse?.kind) {
		parts.push(`kind=${account.parse.kind.verdict}@${account.parse.kind.confidence.toFixed(2)}`)
	}

	if (account.evidence) {
		const pinned = Object.keys(account.evidence.pins).length ? ` pins ${stringifyJSON(account.evidence.pins)}` : ""

		parts.push(
			`channels a:${channelMark(account.evidence.anchor)} g:${channelMark(account.evidence.gazetteer)} ` +
				`c:${channelMark(account.evidence.country)} st:${channelMark(account.evidence.street_type)} ` +
				`ls:${channelMark(account.evidence.locality_surface)} mode ${account.evidence.input_mode}${pinned}`
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
		parts.push(
			`0 candidates for ${empty
				.map((lookup) => {
					const elsewhere = lookup.reachable_in?.length
						? ` (key lives in ${describePlacetypeCounts(
								Object.fromEntries(lookup.reachable_in.map((band) => [band.placetype, band.n]))
							)})`
						: ""

					return `${lookup.tag} "${lookup.value}"${elsewhere}`
				})
				.join(", ")}`
		)
	}

	for (const reading of account.expectation_reachability ?? []) {
		const condition = describeComponentReachability(reading, account.country)

		if (condition) {
			parts.push(condition)
		}
	}

	const coherence = account.result.admin_coherence

	if (coherence && (coherence.region === "contradicted" || coherence.country === "contradicted")) {
		parts.push(`coherence region=${coherence.region} country=${coherence.country}`)
	}

	if (account.result.outside_winner_lineage.length) {
		parts.push(
			`outside winner lineage: ${account.result.outside_winner_lineage
				.map((entry) => `${entry.tag} ${entry.name}`)
				.join(", ")}`
		)
	}

	if (account.expectation.met === false) {
		parts.push(`FAILS: ${account.expectation.issues.join("; ")}`)
	}

	for (const move of account.counterfactuals?.moves ?? []) {
		parts.push(
			`cf ${move.setting} ${move.from}→${move.to} ` +
				(move.changed_abstention
					? `changes abstention (now ${move.answer.lat === null ? "no coordinate" : "resolved"})`
					: `moves ${move.moved_km!.toFixed(1)}km`)
		)
	}

	return parts.join(" · ")
}

// #endregion

// #region Aggregation

export interface ShapeAggregate {
	n: number
	row_ids: string[]
	/**
	 * Ids not listed because the list hit its cap — a display bound, never a
	 * measurement one; `n` is the whole class.
	 */
	row_ids_omitted: number
	predicate: string
}

/**
 * Per-shape counts and the rows in each class.
 *
 * Ordered by {@link DIAGNOSE_SHAPES} so two runs are diffable.
 * A shape that no row matched is omitted rather than reported as zero,
 * because a table of zeros reads as a measurement of them.
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

export interface SettingTally {
	tried_on: number
	moved: number
	skipped: number
}

/**
 * Per-setting counterfactual counts: rows tried, rows moved and rows where the setting did not apply.
 *
 * All three always, because a setting that changed no result on forty rows and one that
 * was never applicable are the same zero in a moved-only table but not the same fact.
 */
export function aggregateCounterfactuals(
	accounts: ReadonlyArray<{ counterfactuals: RowCounterfactuals | null }>
): Record<string, SettingTally> {
	const out: Record<string, SettingTally> = {}

	for (const setting of COUNTERFACTUAL_SETTINGS) {
		out[setting] = { tried_on: 0, moved: 0, skipped: 0 }
	}

	for (const account of accounts) {
		const reading = account.counterfactuals

		if (!reading) continue

		for (const setting of reading.settings_tried) {
			out[setting]!.tried_on++
		}

		for (const skip of reading.settings_skipped) {
			out[skip.setting]!.skipped++
		}

		for (const move of reading.moves) {
			out[move.setting]!.moved++
		}
	}

	return out
}

// #endregion

/**
 * The in-vocabulary mis-tag refinement of `unclassified`: an expected component
 * tag the parse never produced.
 *
 * Its expected value occurs verbatim in the input (the `Dhaka 1205` class,
 * where the decode assigned in-vocabulary text to other tags).
 *
 * A tag that exists with a wrong value is a different fact and stays out,
 * because that failure has a component to interrogate.
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
 * Assemble one row's account from its facts, matching shapes and terminal state.
 */
export function assembleAccount(
	item: ResolvedInput,
	run: AccountInput,
	expectation: ExpectationReading,
	reachability: ComponentReachability[] | null = null,
	routing: RowRouting | null = null
): Omit<RowAccount, "rendered"> {
	const trace = run.trace
	const parse = trace ? collectParseFacts(trace, run.result.components) : null
	const evidence = trace ? evidenceCensus(trace.parse) : null
	const retrieval = collectRetrievalFacts(trace?.resolver ?? null)
	const result = collectResultFacts(run.result)
	const shapes = matchShapes({ parse, evidence, retrieval, result, reachability })

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
		result,
		expectation,
		expectation_reachability: reachability,
		routing,
		resolved_without_recorded_lookup: !result.abstained && retrieval.lookups?.length === 0,
		trace_absent_reason: trace
			? null
			: "No trace was recorded for this run, so the parse, evidence and retrieval facts are ABSENT — not " +
				"silent. Either the session refused to trace, or the loaded bundle's classifier cannot produce one.",
		counterfactuals: null,
	}
}

type DiagnoseExecutionPath = "single-config" | "board-routed"

/**
 * The engine a row runs under on the board-routed path.
 *
 * A country with a weights overlay runs under that overlay's locale.
 * The locale also scopes the resolver to the country, as the board's routed arm does.
 *
 * A country without an overlay runs on the base weights with no country scope,
 * because the base locale scopes the resolver to its own region and would misroute the row.
 * The region the base locale declares keeps that scope.
 *
 * `default_country` is the board row's own resolver country when it states one.
 */
export interface RowRouting {
	country: string
	locale: string | null
	country_scope: "none" | null
	default_country: string | null
	/**
	 * The engine the registry served for this routing, filled in once the row has run.
	 */
	engine_id: string | null
}

/**
 * The routing a row takes, or `null` for a row that runs on the engine `config` describes:
 * every row on the single-config path, and a row without a country on the board-routed path.
 */
export function routingFor(item: ResolvedInput, executionPath: DiagnoseExecutionPath): RowRouting | null {
	if (executionPath === "single-config") return null

	const country = (item.routeCountry ?? item.country)?.toUpperCase() ?? null

	if (!country) return null

	const baseRegion = routeCountry({ locale: BASE_LOCALE })
	const overlay = OVERLAY_LOCALE_BY_COUNTRY[country] ?? (country === baseRegion ? BASE_LOCALE : null)

	return {
		country,
		locale: overlay,
		country_scope: overlay ? null : "none",
		default_country: item.defaultCountry ?? null,
		engine_id: null,
	}
}

function routingConfig(base: EngineConfig, routing: RowRouting): EngineConfig {
	return {
		...base,
		...(routing.locale ? { locale: routing.locale } : {}),
		...(routing.country_scope ? { country_scope: routing.country_scope } : {}),
		...(routing.default_country ? { default_country: routing.default_country } : {}),
	}
}

function routingKey(routing: RowRouting | null): string {
	return routing ? stringifyJSON([routing.locale, routing.country_scope, routing.default_country]) : "base"
}

/**
 * Run one traced geocode and assemble one account per row.
 * Then run the counterfactual sweep and aggregate by shape.
 */
export async function runDiagnose(registry: EngineRegistryLike, args: Record<string, unknown>): Promise<unknown> {
	if (args["account"] === "constraints") return runConstraintAccountForArgs(args)

	const ref = (args["inputs"] as InputSetRef | null) ?? { kind: "board" }
	const config = (args["config"] as EngineConfig | null) ?? {}
	const limit = args["limit"] as number | undefined
	const rowsCap = args["rows_cap"] as number | undefined
	const wantCounterfactuals = args["counterfactuals"] !== false
	const executionPath = (args["execution_path"] as DiagnoseExecutionPath | null) ?? "single-config"

	const set = await resolveInputSet(ref)
	// The account uses a traced parse as its full input.
	// The engine enables tracing regardless of caller configuration.
	const traced: EngineConfig = { ...config, trace: true, diagnose_unreachable: true }
	const engine = await registry.acquire(traced)
	const selected = limit ? set.inputs.slice(0, limit) : set.inputs

	// Reachability reads the same candidate table the engine resolves against.
	// A table that does not open leaves every reading `null`, and the summary states that it went unread.
	const candidateDB = await openSealedArtifact(
		await resolveCandidateDBPath(config.candidate_db, config.data_root ?? dataRootPath())
	)

	using candidateHandle = "db" in candidateDB ? candidateDB.db : null
	const probe = candidateHandle ? candidateBandProbe(candidateHandle) : null

	const startedAt = Date.now()
	const accounts: Array<Omit<RowAccount, "rendered">> = []
	const errors: Array<{ id: string; input: string; message: string }> = []
	const targets: CounterfactualTarget[] = []

	// Rows are run group by group, one engine per routing, so the registry rebuilds an engine
	// once per routing rather than once per row when rows of several countries interleave.
	const groups = new Map<string, { routing: RowRouting | null; items: Array<{ index: number; item: ResolvedInput }> }>()

	for (const [index, item] of selected.entries()) {
		const routing = routingFor(item, executionPath)
		const key = routingKey(routing)
		const group = groups.get(key) ?? { routing, items: [] }

		group.items.push({ index, item })
		groups.set(key, group)
	}

	const ordered: Array<{ index: number; account: Omit<RowAccount, "rendered"> }> = []
	const enginesByRouting: Array<{ routing: RowRouting | null; engine_id: string; rows: number }> = []

	for (const group of groups.values()) {
		const rowEngine = group.routing ? await registry.acquire(routingConfig(traced, group.routing)) : engine

		enginesByRouting.push({ routing: group.routing, engine_id: rowEngine.engineID, rows: group.items.length })

		for (const { index, item } of group.items) {
			try {
				const run = await rowEngine.session.geocode(item.input)
				const expected = item.seed?.expectComponents ?? item.expectComponents
				const reachability = probe && expected ? readExpectationReachability(expected, item.country, probe) : null
				const routing = group.routing ? { ...group.routing, engine_id: rowEngine.engineID } : null

				ordered.push({
					index,
					account: assembleAccount(item, run, gradeExpectation(item, run.result), reachability, routing),
				})

				// The sweep flips settings on the base engine, so a routed row's answer is no base to compare against.
				if (!routing) {
					targets.push({
						id: item.id,
						input: item.input,
						country: item.country,
						base: { lat: run.result.lat, lon: run.result.lon, tier: run.result.resolution_tier },
					})
				}
			} catch (error) {
				errors.push({ id: item.id, input: item.input, message: (error as Error).message })
			}
		}
	}

	accounts.push(...ordered.toSorted((a, b) => a.index - b.index).map((entry) => entry.account))

	const narrowed = accounts.length > COUNTERFACTUAL_FULL_RUN_MAX_ROWS
	const flipCandidates = narrowed ? accounts.filter((account) => !account.shapes.includes("clean")) : accounts
	const eligible = new Set(flipCandidates.map((account) => account.id))

	let counterfactualErrors: Array<{ id: string; setting: string; message: string }> = []

	if (wantCounterfactuals) {
		const { byRow, errors: flipErrors } = await runCounterfactuals(
			registry,
			config,
			engine.effective,
			targets.filter((target) => eligible.has(target.id))
		)

		counterfactualErrors = flipErrors

		for (const account of accounts) {
			account.counterfactuals = byRow.get(account.id) ?? null
		}
	}

	const rows: RowAccount[] = accounts.map((account) => ({ ...account, rendered: renderAccount(account) }))

	// Stable partition, non-clean first, for the emitted order only.
	// Every aggregate reads `rows` whole.
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
		populationN: set.populationN,
	})

	const unclassified = byShape["unclassified"]?.n ?? 0
	const blindRetrieval = rows.filter((row) => row.resolved_without_recorded_lookup).length
	const unreachableRows = rows.filter((row) => row.shapes.includes("expectation_unreachable")).length
	const routedRows = rows.filter((row) => row.routing?.locale).length
	const unscopedRows = rows.filter((row) => row.routing?.country_scope === "none").length

	const routingSentence =
		executionPath === "board-routed"
			? `Board-routed: ${routedRows} row(s) ran under their country's weights overlay and scope ` +
				`(${enginesByRouting
					.filter((entry) => entry.routing?.locale)
					.map((entry) => `${entry.routing!.locale} ${entry.rows}`)
					.join(", ")}), ${unscopedRows} ran on the base weights with no country scope because their country has ` +
				`no overlay, and ${rows.length - routedRows - unscopedRows} had no country and ran on the configured engine. ` +
				"The counterfactual sweep covers the configured-engine rows only."
			: ""

	const reachabilitySentence = !probe
		? `Expected-component reachability was NOT read (${"unavailable" in candidateDB ? candidateDB.unavailable : "no candidate table"}), ` +
			"so an expected admin component the resolver's band cannot reach is UNMEASURED here, never absent."
		: unreachableRows
			? `${unreachableRows} row(s) expect an admin component the candidate table holds only outside the band its tag ` +
				"selects — a data condition each row's line names. A model comparison over those rows grades the gazetteer's " +
				"typing rather than the model."
			: ""

	const counterfactualSentence = !wantCounterfactuals
		? "Counterfactuals were NOT run (counterfactuals: false), so no setting here is priced — a shape without one says " +
			"what the pipeline did, never that it decided the answer."
		: narrowed
			? `Above ${COUNTERFACTUAL_FULL_RUN_MAX_ROWS} rows the sweep narrows to rows that matched a non-clean shape, ` +
				`because a full sweep is one geocode per row per setting: ${eligible.size} of ${rows.length} row(s) ` +
				`qualified${eligible.size === rows.length ? " — every row here did" : ""}. A clean row's settings are ` +
				"UNMEASURED in this result, not measured and found inert."
			: `Counterfactuals ran on all ${rows.length} row(s) across the ${COUNTERFACTUAL_SETTINGS.length}-setting space; a ` +
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
			reachabilitySentence,
			routingSentence,
			counterfactualSentence,
		]
			.filter((sentence) => sentence.length)
			.join(" "),
		n_requested: selected.length,
		n_evaluated: rows.length,
		n_errored: errors.length,
		errors,
		power: reading,
		n_resolved_without_recorded_lookup: blindRetrieval,
		n_expectation_unreachable: unreachableRows,
		routing: {
			execution_path: executionPath,
			engines: enginesByRouting.map((entry) => ({
				locale: entry.routing?.locale ?? null,
				country_scope: entry.routing?.country_scope ?? null,
				default_country: entry.routing?.default_country ?? null,
				engine_id: entry.engine_id,
				rows: entry.rows,
			})),
		},
		by_shape: byShape,
		by_shape_note:
			"A row can match several shapes, so these counts OVERLAP and must never be summed. `n` is the whole class; " +
			`\`row_ids\` lists at most ${SHAPE_ID_CAP} of them and \`row_ids_omitted\` says how many it left out.`,
		counterfactual_settings: aggregateCounterfactuals(rows),
		counterfactuals_narrowed: narrowed,
		counterfactual_errors: counterfactualErrors,
		elapsed_ms: Date.now() - startedAt,
		// Under a cap the emitted rows lead with the non-clean ones and say what they left out.
		// The aggregates are computed over every row regardless.
		rows: !rowsCap ? emittedRows : emittedRows.slice(0, rowsCap),
		rows_omitted: !rowsCap ? 0 : Math.max(0, emittedRows.length - rowsCap),
	}
}
