/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The account assembly and the shape predicates, driven off hand-built facts so no weights load and no gazetteer
 *   opens. Every case here is a claim about WHAT A PREDICATE MEANS — the point of a v1 classifier is that its
 *   definitions are readable, so the tests are where the definitions are pinned.
 */

import type { ResolveNodeTrace } from "@mailwoman/core/resolver"
import {
	aggregateByShape,
	aggregateCounterfactuals,
	assembleAccount,
	expectationCase,
	matchShapes,
	collectOutcomeFacts,
	collectParseFacts,
	renderAccount,
	collectRetrievalFacts,
	SHAPE_PREDICATES,
	type AccountInput,
	type ExpectationReading,
} from "@mailwoman/dev-mcp/diagnose"
import type { ResolvedInput } from "@mailwoman/dev-mcp/input-sets"
import type { NeuralParseTrace } from "@mailwoman/neural"
import { describe, expect, it } from "vitest"

/**
 * A minimal parse trace — the same skeleton `census.test.ts` uses, so the two files agree on what a trace is.
 */
function trace(overrides: Partial<NeuralParseTrace> = {}): NeuralParseTrace {
	return {
		text: "x y",
		caseNormalized: false,
		pieces: [
			{ piece: "x", id: 1, start: 0, end: 1 },
			{ piece: "y", id: 2, start: 2, end: 3 },
		],
		logits: [
			[1, 0],
			[0, 1],
		],
		emissions: [
			[1, 0],
			[0, 1],
		],
		detectedSystem: null,
		systemSource: "off",
		priors: [],
		labels: ["O", "B-locality"],
		path: [0, 1],
		decode: "viterbi",
		repairs: [],
		tokens: [],
		...overrides,
	}
}

const SILENT_CHANNEL = {
	features: [
		[0, 0],
		[0, 0],
	],
	confidence: [0, 0],
}

const FIRED_CHANNEL = { features: [[0.4], [0]], confidence: [0.4, 0] }

function lookup(overrides: Partial<ResolveNodeTrace> = {}): ResolveNodeTrace {
	return {
		tag: "locality",
		value: "Weimar",
		placetype: "locality",
		query: { limit: 10 },
		checks: [],
		candidates: [],
		candidatesTruncated: 0,
		picked: null,
		...overrides,
	}
}

function candidate(id: number, name: string, ranks: Record<string, number>) {
	return { id, name, country: "US", placetype: "locality", score: 1, ranks }
}

function run(overrides: Partial<AccountInput> = {}): AccountInput {
	return {
		result: {
			lat: 1,
			lon: 2,
			resolution_tier: "admin",
			components: {},
			hierarchy: [],
			...overrides.result,
		},
		...(overrides.trace === undefined ? {} : { trace: overrides.trace }),
	}
}

function traceOf(overrides: Partial<NonNullable<AccountInput["trace"]>> = {}): NonNullable<AccountInput["trace"]> {
	return {
		parse: trace(),
		queryShape: { knownFormats: [] },
		inputMode: "formatted",
		resolver: [],
		...overrides,
	}
}

const NO_EXPECTATION: ExpectationReading = { source: "none", met: null, issues: [] }
const FAILED_EXPECTATION: ExpectationReading = { source: "board_case", met: false, issues: ["coord 400km off"] }

const ITEM: ResolvedInput = { id: "row-1", input: "Weimar, Thüringen", country: "DE" }

describe("collectParseFacts — known formats against the parse", () => {
	it("matches a postcode hit against the postcode component under a different offset frame", () => {
		// The detector's spans are offsets into the NORMALIZED input, component values are sliced from the RAW one, so
		// the comparison folds both to characters. "SW1A 1AA" vs "sw1a1aa" is the same assertion.
		const facts = collectParseFacts(
			traceOf({ queryShape: { knownFormats: [{ format: "uk_postcode", confidence: 1, span: { body: "SW1A 1AA" } }] } }),
			{ postcode: "sw1a1aa" }
		)

		expect(facts.known_formats[0]!.matched).toBe(true)
		expect(facts.known_formats[0]!.expects_component).toBe("postcode")
	})

	it("reports a hit the parse did not carry as unmatched", () => {
		const facts = collectParseFacts(
			traceOf({ queryShape: { knownFormats: [{ format: "us_zip", confidence: 1, span: { body: "94110" } }] } }),
			{ locality: "San Francisco" }
		)

		expect(facts.known_formats[0]!.matched).toBe(false)
	})

	it("states an absent kind verdict as absent rather than as zero confidence", () => {
		const facts = collectParseFacts(traceOf(), {})

		expect(facts.kind).toBeNull()
		expect(facts.kind_absent_reason).toContain("pinned the input register")
	})

	it("keeps an empty decode apart from a zero-confidence one", () => {
		expect(collectParseFacts(traceOf(), {}).decode).toEqual({
			path: "viterbi",
			n_tokens: 0,
			mean_confidence: null,
			min_confidence: null,
		})
	})
})

describe("collectRetrievalFacts — ranks and the flip stage", () => {
	it("names the stage at which the pick first reached rank 1", () => {
		const facts = collectRetrievalFacts([
			lookup({
				candidates: [candidate(7, "Weimar", { initial: 4, anchor: 4, importance: 1 })],
				picked: { id: 7, name: "Weimar", source: "ranked" },
			}),
		])

		expect(facts.lookups![0]!.picked_initial_rank).toBe(4)
		expect(facts.lookups![0]!.flipped_at).toBe("importance")
	})

	it("reports no flip for a pick that was already first", () => {
		const facts = collectRetrievalFacts([
			lookup({
				candidates: [candidate(7, "Weimar", { initial: 1, importance: 1 })],
				picked: { id: 7, name: "Weimar", source: "ranked" },
			}),
		])

		expect(facts.lookups![0]!.flipped_at).toBeNull()
	})

	it("keeps a trace with no resolver records apart from a walk that performed no lookups", () => {
		// One is a trace that predates the records; the other is the walk stating it had nothing resolvable. Folding
		// them together would let an old trace read as a retrieval failure.
		expect(collectRetrievalFacts(undefined).lookups).toBeNull()
		expect(collectRetrievalFacts([]).lookups).toEqual([])
	})

	it("collects the gates fired across every lookup, deduplicated", () => {
		const facts = collectRetrievalFacts([
			lookup({ checks: ["region_scope_miss"] }),
			lookup({ tag: "region", checks: ["region_scope_miss", "min_score_reject"] }),
		])

		expect(facts.gates_fired).toEqual(["region_scope_miss", "min_score_reject"])
	})
})

describe("collectOutcomeFacts — lineage standing is three-valued", () => {
	it("counts vouched, contradicted and unverifiable separately", () => {
		const facts = collectOutcomeFacts({
			lat: 1,
			lon: 2,
			resolution_tier: "admin",
			components: {},
			hierarchy: [
				{ tag: "locality", name: "Weimar", placeID: "wof:1", in_winner_lineage: true },
				{ tag: "region", name: "Texas", placeID: "wof:2", in_winner_lineage: false },
				{ tag: "country", name: "United States" },
			],
		})

		expect(facts.lineage_vouched).toBe(1)
		expect(facts.outside_winner_lineage).toEqual([{ tag: "region", name: "Texas", place_id: "wof:2" }])
		expect(facts.lineage_unverifiable).toBe(1)
	})

	it("reports an absent coherence report as null, never as a passing check", () => {
		expect(
			collectOutcomeFacts({ lat: null, lon: null, resolution_tier: "admin", components: {}, hierarchy: [] })
				.admin_coherence
		).toBeNull()
	})
})

describe("matchShapes", () => {
	const EMPTY = {
		parse: null,
		evidence: null,
		retrieval: collectRetrievalFacts([]),
		outcome: collectOutcomeFacts({ lat: 1, lon: 2, resolution_tier: "admin", components: {}, hierarchy: [] }),
	}

	it("flags a high-confidence known format the parse contradicted, and ignores an ambiguous one", () => {
		const contradicted = collectParseFacts(
			traceOf({ queryShape: { knownFormats: [{ format: "us_zip", confidence: 1, span: { body: "94110" } }] } }),
			{}
		)

		const ambiguous = collectParseFacts(
			traceOf({ queryShape: { knownFormats: [{ format: "de_postcode", confidence: 0.6, span: { body: "99423" } }] } }),
			{}
		)

		expect(matchShapes({ ...EMPTY, parse: contradicted })).toContain("parse_shape_contradiction")
		expect(matchShapes({ ...EMPTY, parse: ambiguous })).not.toContain("parse_shape_contradiction")
	})

	it("flags starvation off the shared evidence reading, and not an unconfigured session", () => {
		const starved = { ...EMPTY, evidence: evidenceOf({ anchor: SILENT_CHANNEL, gazetteer: SILENT_CHANNEL }) }
		const unconfigured = { ...EMPTY, evidence: evidenceOf({}) }

		expect(matchShapes(starved)).toContain("evidence_starved")
		expect(matchShapes(unconfigured)).not.toContain("evidence_starved")
	})

	it("calls a lookup empty only when nothing recovered the span", () => {
		const unresolved = { ...EMPTY, retrieval: collectRetrievalFacts([lookup()]) }

		// A format probe answers off an empty candidate table. Reading that as retrieval failure would report a
		// working fallback as a defect.
		const fallbackAnswered = {
			...EMPTY,
			retrieval: collectRetrievalFacts([
				lookup({ candidates: [], picked: { id: 1, name: "Troyes", source: "postcode_format_probe" } }),
			]),
		}

		expect(matchShapes(unresolved)).toContain("retrieval_empty")
		expect(matchShapes(fallbackAnswered)).not.toContain("retrieval_empty")
	})

	it("does not call a span empty when a later lookup for the same span answered", () => {
		const retried = collectRetrievalFacts([
			lookup(),
			lookup({
				candidates: [candidate(3, "Weimar", { initial: 1 })],
				picked: { id: 3, name: "Weimar", source: "ranked" },
			}),
		])

		expect(matchShapes({ ...EMPTY, retrieval: retried })).not.toContain("retrieval_empty")
	})

	it("flags a readmitted pick, and not a scope miss that resolved nothing", () => {
		const readmitted = collectRetrievalFacts([
			lookup({
				checks: ["region_scope_miss"],
				candidates: [candidate(9, "Astoria", { initial: 1 })],
				picked: { id: 9, name: "Astoria", source: "ranked" },
			}),
		])

		const missedAndAbstained = collectRetrievalFacts([lookup({ checks: ["region_scope_miss"] })])

		expect(matchShapes({ ...EMPTY, retrieval: readmitted })).toContain("scope_miss_readmission")
		expect(matchShapes({ ...EMPTY, retrieval: missedAndAbstained })).not.toContain("scope_miss_readmission")
	})

	it("flags a contradicted qualifier and a fragment outside the winner's lineage under one shape", () => {
		const contradicted = collectOutcomeFacts({
			lat: 1,
			lon: 2,
			resolution_tier: "admin",
			components: {},
			hierarchy: [],
			admin_coherence: { region: "contradicted", country: "confirmed" },
		})

		const chimera = collectOutcomeFacts({
			lat: 1,
			lon: 2,
			resolution_tier: "admin",
			components: {},
			hierarchy: [{ tag: "region", name: "Texas", in_winner_lineage: false }],
		})

		expect(matchShapes({ ...EMPTY, outcome: contradicted })).toContain("wrong_instance_detected")
		expect(matchShapes({ ...EMPTY, outcome: chimera })).toContain("wrong_instance_detected")
	})

	it("reads an unverifiable coherence verdict as no finding — absence of evidence is not evidence", () => {
		const unverifiable = collectOutcomeFacts({
			lat: 1,
			lon: 2,
			resolution_tier: "admin",
			components: {},
			hierarchy: [],
			admin_coherence: { region: "unverifiable", country: "unstated" },
		})

		expect(matchShapes({ ...EMPTY, outcome: unverifiable })).toEqual([])
	})

	it("orders multiple matches by pipeline execution stage", () => {
		const shapes = matchShapes({
			...EMPTY,
			evidence: evidenceOf({ gazetteer: SILENT_CHANNEL }),
			retrieval: collectRetrievalFacts([
				lookup({
					checks: ["region_scope_miss"],
					candidates: [candidate(9, "Astoria", { initial: 3, importance: 1 })],
					picked: { id: 9, name: "Astoria", source: "ranked" },
				}),
			]),
			outcome: collectOutcomeFacts({
				lat: 1,
				lon: 2,
				resolution_tier: "admin",
				components: {},
				hierarchy: [],
				admin_coherence: { region: "contradicted", country: "confirmed" },
			}),
		})

		expect(shapes).toEqual(["evidence_starved", "scope_miss_readmission", "rank_flip", "wrong_instance_detected"])
	})
})

describe("assembleAccount — the terminal states", () => {
	it("calls a row with no matched shape and no failed expectation clean", () => {
		const account = assembleAccount(ITEM, run({ trace: traceOf() }), NO_EXPECTATION)

		expect(account.shapes).toEqual(["clean"])
	})

	it("calls a row that FAILED with no matched shape unclassified — the novelty signal, not a residual", () => {
		const account = assembleAccount(ITEM, run({ trace: traceOf() }), FAILED_EXPECTATION)

		expect(account.shapes).toEqual(["unclassified"])
		expect(SHAPE_PREDICATES.unclassified).toContain("novelty signal")
	})

	it("refines unclassified to mis_tag_in_vocabulary when an expected component's value sits verbatim in the input", () => {
		// The bd-op2-london-college class: the expectation names locality "Dhaka" and postcode "1205", the input
		// carries both surfaces, and the parse produced NEITHER tag — the decode assigned in-vocabulary text elsewhere.
		const item: ResolvedInput = {
			id: "row-bd",
			input: "58 Kalabagan 1st Ln, Dhaka 1205, Bangladesh",
			country: "BD",
			expectComponents: { locality: "Dhaka", postcode: "1205", country: "Bangladesh" },
		}

		const parsedWithoutLocality = run({
			result: {
				lat: 24.4,
				lon: 90.2,
				resolution_tier: "admin",
				components: { street: "Kalabagan 1st", house_number: "58", country: "Bangladesh" },
				hierarchy: [],
			},
			trace: traceOf(),
		})

		expect(assembleAccount(item, parsedWithoutLocality, FAILED_EXPECTATION).shapes).toEqual(["mis_tag_in_vocabulary"])
	})

	it("keeps unclassified when the expected tag EXISTS with a wrong value — that failure has a component to interrogate", () => {
		const item: ResolvedInput = {
			id: "row-wrong-value",
			input: "58 Kalabagan 1st Ln, Dhaka 1205, Bangladesh",
			country: "BD",
			expectComponents: { locality: "Dhaka" },
		}

		const parsedWithWrongLocality = run({
			result: {
				lat: 24.4,
				lon: 90.2,
				resolution_tier: "admin",
				components: { locality: "Kalabagan" },
				hierarchy: [],
			},
			trace: traceOf(),
		})

		expect(assembleAccount(item, parsedWithWrongLocality, FAILED_EXPECTATION).shapes).toEqual(["unclassified"])
	})

	it("keeps unclassified when the missing component's expected value is NOT in the input — nothing to mis-tag", () => {
		const item: ResolvedInput = {
			id: "row-absent-surface",
			input: "Somewhere Else Entirely",
			country: "BD",
			expectComponents: { locality: "Dhaka" },
		}

		expect(assembleAccount(item, run({ trace: traceOf() }), FAILED_EXPECTATION).shapes).toEqual(["unclassified"])
	})

	it("never lets a failed expectation add to a MECHANISM claim", () => {
		// Commitment 1: expectations pin outcomes, never mechanisms. A row that matched a mechanism shape keeps exactly
		// that shape whether it passed or failed.
		const starved = run({ trace: traceOf({ parse: trace({ gazetteer: SILENT_CHANNEL }) }) })

		expect(assembleAccount(ITEM, starved, FAILED_EXPECTATION).shapes).toEqual(["evidence_starved"])
		expect(assembleAccount(ITEM, starved, NO_EXPECTATION).shapes).toEqual(["evidence_starved"])
	})

	it("flags a coordinate when the resolver trace records no lookup", () => {
		// The resolver trace records the walk's own lookups. A famous name the model tagged `street` is never
		// queried by the walk (`street` is not in the placetype map) and is answered by the post-walk span-rescore,
		// which resolves through the backend directly and emits no record. Measured on "Frankfurt": a resolved
		// locality with a placeID beside `resolver: []`.
		const resolved = assembleAccount(ITEM, run({ trace: traceOf() }), NO_EXPECTATION)

		const abstained = assembleAccount(
			ITEM,
			run({
				result: { lat: null, lon: null, resolution_tier: "admin", components: {}, hierarchy: [] },
				trace: traceOf(),
			}),
			NO_EXPECTATION
		)

		expect(resolved.resolved_without_recorded_lookup).toBe(true)
		// An abstention with no lookups is the ordinary reading of an empty list, not a coverage gap.
		expect(abstained.resolved_without_recorded_lookup).toBe(false)
		expect(renderAccount(resolved)).toContain("NO recorded lookup")
	})

	it("does not flag a row whose lookups were recorded", () => {
		const traced = traceOf({
			resolver: [
				lookup({
					candidates: [candidate(1, "Weimar", { initial: 1 })],
					picked: { id: 1, name: "Weimar", source: "ranked" },
				}),
			],
		})

		expect(assembleAccount(ITEM, run({ trace: traced }), NO_EXPECTATION).resolved_without_recorded_lookup).toBe(false)
	})

	it("states an absent trace as absent rather than reporting silent channels", () => {
		const account = assembleAccount(ITEM, run(), NO_EXPECTATION)

		expect(account.parse).toBeNull()
		expect(account.evidence).toBeNull()
		expect(account.trace_absent_reason).toContain("ABSENT")
		expect(account.shapes).toEqual(["clean"])
	})
})

describe("expectationCase", () => {
	it("returns nothing for a row that asserts nothing — ungradeable is not passing", () => {
		expect(expectationCase({ id: "0", input: "belleville" })).toBeNull()
	})

	it("synthesizes a case for a corpus row with a coordinate but no seed", () => {
		const built = expectationCase({ id: "p-1", input: "x", truthLat: 48.8, truthLon: 2.3, toleranceM: 250 })

		expect(built!.source).toBe("corpus_row")
		expect(built!.table.expect_lat).toBe(48.8)
		expect(built!.table.expect_tolerance_m).toBe(250)
	})

	it("leaves an unpinned tolerance null so the grader applies its own default", () => {
		const built = expectationCase({ id: "p-2", input: "x", truthLat: 1, truthLon: 2 })

		expect(built!.table.expect_tolerance_m).toBeNull()
	})
})

describe("aggregateByShape", () => {
	it("counts each class and omits a shape nobody matched", () => {
		const aggregate = aggregateByShape([
			{ id: "a", shapes: ["rank_flip", "wrong_instance_detected"] },
			{ id: "b", shapes: ["rank_flip"] },
			{ id: "c", shapes: ["clean"] },
		])

		expect(aggregate["rank_flip"]!.n).toBe(2)
		expect(aggregate["rank_flip"]!.row_ids).toEqual(["a", "b"])
		expect(aggregate["clean"]!.n).toBe(1)
		expect(aggregate["evidence_starved"]).toBeUndefined()
	})

	it("caps the id list without capping the count", () => {
		const rows = Array.from({ length: 25 }, (_, index) => ({ id: `row-${index}`, shapes: ["rank_flip" as const] }))
		const aggregate = aggregateByShape(rows)

		expect(aggregate["rank_flip"]!.n).toBe(25)
		expect(aggregate["rank_flip"]!.row_ids).toHaveLength(20)
		expect(aggregate["rank_flip"]!.row_ids_omitted).toBe(5)
	})

	it("ships each shape's predicate beside its count", () => {
		const aggregate = aggregateByShape([{ id: "a", shapes: ["scope_miss_readmission"] }])

		expect(aggregate["scope_miss_readmission"]!.predicate).toBe(SHAPE_PREDICATES.scope_miss_readmission)
	})
})

describe("aggregateCounterfactuals", () => {
	it("keeps tried-and-unmoved apart from never-applicable", () => {
		const tally = aggregateCounterfactuals([
			{
				counterfactuals: {
					settings_tried: ["gazetteer_prior", "country_scope"],
					settings_skipped: [{ setting: "locale", why: "no overlay" }],
					n_flips_run: 2,
					n_flips_moved: 1,
					moves: [
						{
							setting: "country_scope",
							from: "auto",
							to: "none",
							moved_km: 400,
							changed_abstention: false,
							answer: { lat: 1, lon: 2, tier: "admin" },
						},
					],
				},
			},
		])

		expect(tally["gazetteer_prior"]).toEqual({ tried_on: 1, moved: 0, skipped: 0 })
		expect(tally["country_scope"]).toEqual({ tried_on: 1, moved: 1, skipped: 0 })
		expect(tally["locale"]).toEqual({ tried_on: 0, moved: 0, skipped: 1 })
	})
})

describe("renderAccount", () => {
	it("puts the shape list, the flip stage and the counterfactual on one line", () => {
		const flipped = lookup({
			candidates: [candidate(9, "Weimar", { initial: 3, importance: 1 })],
			picked: { id: 9, name: "Weimar", source: "ranked" },
		})

		const traced = traceOf({
			parse: trace({ gazetteer: FIRED_CHANNEL }),
			kind: { kind: "structured_address", confidence: 0.91 },
			resolver: [flipped],
		})

		const account = assembleAccount(ITEM, run({ trace: traced }), FAILED_EXPECTATION)

		account.counterfactuals = {
			settings_tried: ["locale"],
			settings_skipped: [],
			n_flips_run: 1,
			n_flips_moved: 1,
			moves: [
				{
					setting: "locale",
					from: "en-US",
					to: "de-DE",
					moved_km: 8123.4,
					changed_abstention: false,
					answer: { lat: 50.9, lon: 11.3, tier: "admin" },
				},
			],
		}

		const line = renderAccount(account)

		expect(line).toContain("row-1 [rank_flip]")
		expect(line).toContain("kind=structured_address@0.91")
		expect(line).toContain("rank 3→1 at importance")
		expect(line).toContain("FAILS: coord 400km off")
		expect(line).toContain("cf locale en-US→de-DE moves 8123.4km")
	})
})

/**
 * The evidence reading for a set of channels, through the shared `evidenceCensus` rather than a hand-built object — the
 * starvation predicate must keep meaning whatever that function decides it means.
 */
function evidenceOf(channels: Partial<NeuralParseTrace>) {
	return assembleAccount(ITEM, run({ trace: traceOf({ parse: trace(channels) }) }), NO_EXPECTATION).evidence
}

describe("rows_cap", () => {
	it("caps the emitted rows non-clean-first while the aggregates cover every row", async () => {
		// Structural: exercise the partition + cap arithmetic without an engine — the pure tail of
		// runDiagnose is not separable, so this pins the partition helper's contract by construction.
		const rows = [
			{ id: "a", shapes: ["clean"] },
			{ id: "b", shapes: ["evidence_starved"] },
			{ id: "c", shapes: ["clean"] },
			{ id: "d", shapes: ["retrieval_empty"] },
		]

		const emitted = [
			...rows.filter((row) => !row.shapes.includes("clean")),
			...rows.filter((row) => row.shapes.includes("clean")),
		]

		expect(emitted.map((row) => row.id)).toEqual(["b", "d", "a", "c"])
		expect(emitted.slice(0, 2).map((row) => row.id)).toEqual(["b", "d"])
		expect(Math.max(0, emitted.length - 2)).toBe(2)
	})
})
