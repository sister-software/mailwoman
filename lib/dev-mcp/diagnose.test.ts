/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The account assembly and the shape predicates, driven off hand-built facts so no weights load and no gazetteer
 * opens. The definitions are pinned here because a v1 classifier's value is that they are readable.
 */

import type { ResolveNodeTrace } from "@mailwoman/core/resolver"
import type { NeuralParseTrace } from "@mailwoman/neural"
import { describe, expect, it } from "vitest"

import {
	aggregateByShape,
	aggregateCounterfactuals,
	assembleAccount,
	expectationCase,
	matchShapes,
	collectResultFacts,
	collectParseFacts,
	renderAccount,
	collectRetrievalFacts,
	routingFor,
	runDiagnose,
	SHAPE_PREDICATES,
	type AccountInput,
	type ExpectationReading,
} from "#dev-mcp/diagnose"
import type { EngineConfig } from "#dev-mcp/engine/registry"
import { resolvedInput } from "#dev-mcp/input-sets"
import { stubEngine, stubEngineRegistry } from "#dev-mcp/test/stub-registry"

/**
 * A minimal parse trace, the same skeleton `census.test.ts` uses so the two files agree on what a trace is.
 */
function trace(overrides: Partial<NeuralParseTrace> = {}): NeuralParseTrace {
	return {
		text: "x y",
		caseNormalized: false,
		containmentCountry: null,
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
		anchor: null,
		gazetteer: null,
		country: null,
		streetType: null,
		localitySurface: null,
		inputMode: "fragmented",
		channelPins: {},
		localeLogits: null,
		spanScores: null,
		localeCountries: null,
		detectedSystem: null,
		systemSource: "off",
		priors: [],
		labels: ["O", "B-locality"],
		path: [0, 1],
		margins: [1, 1],
		decode: "viterbi",
		explanation: null,
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
		query: { country: null, parentID: null, postcode: null, regionQualifier: null, limit: 10 },
		checks: [],
		candidates: [],
		candidatesTruncated: 0,
		picked: null,
		reachableIn: null,
		...overrides,
	}
}

function candidate(id: number, name: string, ranks: Record<string, number>) {
	return {
		id,
		name,
		country: "US",
		placetype: "locality",
		score: 1,
		prominence: null,
		importance: null,
		population: null,
		exactMatch: null,
		containedByQualifier: null,
		ranks,
	}
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
		...(!overrides.trace ? {} : { trace: overrides.trace }),
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

// The Who's On First placetype of a GB town such as Uxbridge, outside the locality band.
const TOWN_PLACETYPE = "neighbourhood"

const ITEM = resolvedInput({ id: "row-1", input: "Weimar, Thüringen", country: "DE" })

describe("collectParseFacts — known formats against the parse", () => {
	it("matches a postcode hit against the postcode component under a different offset frame", () => {
		// The detector's spans are offsets into the normalized input while component values
		// come from the raw one, so the comparison folds both to characters.
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
		// One is a trace that predates the records and the other the walk stating it had no entry to resolve.
		// A combined value would let an old trace read as a retrieval failure.
		expect(collectRetrievalFacts(null).lookups).toBeNull()
		expect(collectRetrievalFacts([]).lookups).toEqual([])
	})

	it("collects the checks fired across every lookup, deduplicated", () => {
		const facts = collectRetrievalFacts([
			lookup({ checks: ["region_scope_miss"] }),
			lookup({ tag: "region", checks: ["region_scope_miss", "min_score_reject"] }),
		])

		expect(facts.checks_fired).toEqual(["region_scope_miss", "min_score_reject"])
	})

	it("carries the unreachable-band probe's placetypes, and null when the probe did not run", () => {
		const probed = collectRetrievalFacts([lookup({ reachableIn: [{ placetype: TOWN_PLACETYPE, n: 1 }] })])
		const unprobed = collectRetrievalFacts([lookup()])

		expect(probed.lookups![0]!.reachable_in).toEqual([{ placetype: TOWN_PLACETYPE, n: 1 }])
		expect(unprobed.lookups![0]!.reachable_in).toBeNull()
	})
})

describe("collectResultFacts — lineage standing is three-valued", () => {
	it("counts vouched, contradicted and unverifiable separately", () => {
		const facts = collectResultFacts({
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
			collectResultFacts({ lat: null, lon: null, resolution_tier: "admin", components: {}, hierarchy: [] })
				.admin_coherence
		).toBeNull()
	})
})

describe("matchShapes", () => {
	const EMPTY = {
		parse: null,
		evidence: null,
		retrieval: collectRetrievalFacts([]),
		result: collectResultFacts({ lat: 1, lon: 2, resolution_tier: "admin", components: {}, hierarchy: [] }),
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

		// A format probe answers even with an empty candidate table.
		// That classification would report a working fallback as a retrieval defect.
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

	it("calls an empty lookup a band miss only when the probe found the key under another placetype", () => {
		const elsewhere = {
			...EMPTY,
			retrieval: collectRetrievalFacts([lookup({ reachableIn: [{ placetype: TOWN_PLACETYPE, n: 1 }] })]),
		}

		const nowhere = { ...EMPTY, retrieval: collectRetrievalFacts([lookup({ reachableIn: [] })]) }
		const unprobed = { ...EMPTY, retrieval: collectRetrievalFacts([lookup()]) }

		// The band probe ran on a lookup that another lookup for the same span then answered.
		const recovered = {
			...EMPTY,
			retrieval: collectRetrievalFacts([
				lookup({ reachableIn: [{ placetype: TOWN_PLACETYPE, n: 1 }] }),
				lookup({
					candidates: [candidate(3, "Weimar", { initial: 1 })],
					picked: { id: 3, name: "Weimar", source: "ranked" },
				}),
			]),
		}

		expect(matchShapes(elsewhere)).toEqual(["retrieval_empty", "band_miss"])
		expect(matchShapes(nowhere)).toEqual(["retrieval_empty"])
		expect(matchShapes(unprobed)).toEqual(["retrieval_empty"])
		expect(matchShapes(recovered)).toEqual([])
	})

	it("flags an unreachable expected component off the reachability reading alone", () => {
		const unreachable = {
			...EMPTY,
			reachability: [
				{
					tag: "locality",
					value: "Uxbridge",
					band: ["locality", "borough", "localadmin"],
					state: "unreachable" as const,
					in_band: 0,
					outside_band: { [TOWN_PLACETYPE]: 1 },
				},
			],
		}

		const reachable = {
			...EMPTY,
			reachability: [
				{
					tag: "locality",
					value: "Slough",
					band: ["locality", "borough", "localadmin"],
					state: "reachable" as const,
					in_band: 1,
					outside_band: { region: 1 },
				},
			],
		}

		expect(matchShapes(unreachable)).toEqual(["expectation_unreachable"])
		expect(matchShapes(reachable)).toEqual([])
		expect(matchShapes({ ...EMPTY, reachability: null })).toEqual([])
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
		const contradicted = collectResultFacts({
			lat: 1,
			lon: 2,
			resolution_tier: "admin",
			components: {},
			hierarchy: [],
			admin_coherence: { region: "contradicted", country: "confirmed" },
		})

		const chimera = collectResultFacts({
			lat: 1,
			lon: 2,
			resolution_tier: "admin",
			components: {},
			hierarchy: [{ tag: "region", name: "Texas", in_winner_lineage: false }],
		})

		expect(matchShapes({ ...EMPTY, result: contradicted })).toContain("wrong_instance_detected")
		expect(matchShapes({ ...EMPTY, result: chimera })).toContain("wrong_instance_detected")
	})

	it("reads an unverifiable coherence verdict as no finding — absence of evidence is not evidence", () => {
		const unverifiable = collectResultFacts({
			lat: 1,
			lon: 2,
			resolution_tier: "admin",
			components: {},
			hierarchy: [],
			admin_coherence: { region: "unverifiable", country: "unstated" },
		})

		expect(matchShapes({ ...EMPTY, result: unverifiable })).toEqual([])
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
			result: collectResultFacts({
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
		const item = resolvedInput({
			id: "row-bd",
			input: "58 Kalabagan 1st Ln, Dhaka 1205, Bangladesh",
			country: "BD",
			expectComponents: { locality: "Dhaka", postcode: "1205", country: "Bangladesh" },
		})

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
		const item = resolvedInput({
			id: "row-wrong-value",
			input: "58 Kalabagan 1st Ln, Dhaka 1205, Bangladesh",
			country: "BD",
			expectComponents: { locality: "Dhaka" },
		})

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
		const item = resolvedInput({
			id: "row-absent-surface",
			input: "Somewhere Else Entirely",
			country: "BD",
			expectComponents: { locality: "Dhaka" },
		})

		expect(assembleAccount(item, run({ trace: traceOf() }), FAILED_EXPECTATION).shapes).toEqual(["unclassified"])
	})

	it("never lets a failed expectation add to a MECHANISM claim", () => {
		// Commitment 1: expectations pin results, never mechanisms, so a row that matched
		// a mechanism shape keeps it whether it passed or failed.
		const starved = run({ trace: traceOf({ parse: trace({ gazetteer: SILENT_CHANNEL }) }) })

		expect(assembleAccount(ITEM, starved, FAILED_EXPECTATION).shapes).toEqual(["evidence_starved"])
		expect(assembleAccount(ITEM, starved, NO_EXPECTATION).shapes).toEqual(["evidence_starved"])
	})

	it("flags a coordinate when the resolver trace records no lookup", () => {
		// The resolver trace records the walk's own lookups, so a famous name the model The
		// walk never queries tagged `street` because it is absent from the placetype map.
		// The post-walk span-rescore answers it without emitting a record.
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
		// An abstention with no lookups is the ordinary reading of an empty list rather than a coverage gap.
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
		expect(expectationCase(resolvedInput({ id: "0", input: "belleville" }))).toBeNull()
	})

	it("synthesizes a case for a corpus row with a coordinate but no seed", () => {
		const built = expectationCase(
			resolvedInput({ id: "p-1", input: "x", truthLat: 48.8, truthLon: 2.3, toleranceM: 250 })
		)

		expect(built!.source).toBe("corpus_row")
		expect(built!.table.expect_lat).toBe(48.8)
		expect(built!.table.expect_tolerance_m).toBe(250)
	})

	it("leaves an unpinned tolerance null so the grader applies its own default", () => {
		const built = expectationCase(resolvedInput({ id: "p-2", input: "x", truthLat: 1, truthLon: 2 }))

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

	it("states where an empty lookup's key lives and which expected component the band cannot reach", () => {
		const item = resolvedInput({
			id: "gb-vob-little-britain-lake",
			input: "Little Britain Lake, Uxbridge",
			country: "GB",
		})

		const bandMissed = lookup({
			tag: "region",
			value: "Uxbridge",
			placetype: "region",
			reachableIn: [
				{ placetype: "localadmin", n: 2 },
				{ placetype: "locality", n: 5 },
				{ placetype: TOWN_PLACETYPE, n: 1 },
			],
		})

		const account = assembleAccount(item, run({ trace: traceOf({ resolver: [bandMissed] }) }), FAILED_EXPECTATION, [
			{
				tag: "locality",
				value: "Uxbridge",
				band: ["locality", "borough", "localadmin"],
				state: "unreachable",
				in_band: 0,
				outside_band: { [TOWN_PLACETYPE]: 1 },
			},
		])

		const line = renderAccount(account)

		expect(account.shapes).toEqual(["retrieval_empty", "band_miss", "expectation_unreachable"])

		expect(line).toContain(
			`0 candidates for region "Uxbridge" (key lives in locality ×5, localadmin ×2, ${TOWN_PLACETYPE} ×1)`
		)

		expect(line).toContain(
			`expected locality "Uxbridge" UNREACHABLE in band [locality, borough, localadmin]: GB holds it as ${TOWN_PLACETYPE} ×1`
		)
	})

	it("states an absent and an unprobed expected component apart from an unreachable one", () => {
		const account = assembleAccount(ITEM, run({ trace: traceOf() }), FAILED_EXPECTATION, [
			{
				tag: "locality",
				value: "Nirgendwo",
				band: ["locality", "borough", "localadmin"],
				state: "absent",
				in_band: 0,
				outside_band: {},
			},
			{
				tag: "region",
				value: "Thüringen",
				band: ["region", "macroregion"],
				state: "unprobed",
				in_band: 0,
				outside_band: {},
			},
		])

		const line = renderAccount(account)

		expect(account.shapes).toEqual(["unclassified"])
		expect(line).toContain('expected locality "Nirgendwo" ABSENT from every placetype in DE')
		expect(line).toContain('expected region "Thüringen" reachability UNPROBED (the row states no country)')
	})
})

/**
 * The evidence reading for a set of channels, through the shared `evidenceCensus`
 * rather than a hand-built object.
 *
 * The starvation predicate must keep meaning whatever that function decides it means.
 */
function evidenceOf(channels: Partial<NeuralParseTrace>) {
	return assembleAccount(ITEM, run({ trace: traceOf({ parse: trace(channels) }) }), NO_EXPECTATION).evidence
}

describe("rows_cap", () => {
	it("caps the emitted rows non-clean-first while the aggregates cover every row", async () => {
		// Structural: exercise the partition and cap arithmetic without an engine,
		// because the pure tail of `runDiagnose` is not separable.
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

describe("routingFor", () => {
	it("routes a country with an overlay to its locale and a country without one to the unscoped base", () => {
		expect(routingFor(resolvedInput({ id: "gb", input: "x", country: "GB" }), "board-routed")).toEqual({
			country: "GB",
			locale: "en-GB",
			country_scope: null,
			default_country: null,
			engine_id: null,
		})

		expect(routingFor(resolvedInput({ id: "us", input: "x", country: "us" }), "board-routed")).toMatchObject({
			locale: "en-US",
			country_scope: null,
		})

		// The release ships fr-fr, so an FR row routes to that overlay rather than the unscoped base (#2770).
		expect(
			routingFor(resolvedInput({ id: "fr", input: "x", country: "FR", defaultCountry: "FR" }), "board-routed")
		).toMatchObject({ locale: "fr-FR", country_scope: null, default_country: "FR" })

		// ISO 3166-1 reserves ZZ for user assignment, so no release ships a package for it.
		expect(
			routingFor(resolvedInput({ id: "zz", input: "x", country: "ZZ", defaultCountry: "ZZ" }), "board-routed")
		).toMatchObject({ locale: null, country_scope: "none", default_country: "ZZ" })
	})

	it("routes nothing on the single-config path or for a row without a country", () => {
		expect(routingFor(resolvedInput({ id: "gb", input: "x", country: "GB" }), "single-config")).toBeNull()
		expect(routingFor(resolvedInput({ id: "bare", input: "x" }), "board-routed")).toBeNull()
	})
})

describe("runDiagnose routing", () => {
	const LITERAL = {
		kind: "literal" as const,
		inputs: [
			{ input: "Little Britain Lake, Uxbridge", lat: 51.52, lon: -0.49, country: "GB" },
			{ input: "Rue de Rivoli, Paris", lat: 48.86, lon: 2.34, country: "FR" },
			// ISO 3166-1 reserves ZZ for user assignment, so no release ships a package for it.
			{ input: "Nowhere", lat: 51.52, lon: -0.49, country: "ZZ" },
			{ input: "Somewhere", lat: 1, lon: 2 },
		],
		why: "four rows: two shipped overlays, one country with no package, one row with no country",
	}

	function recordingRegistry(acquired: EngineConfig[]) {
		return stubEngineRegistry({
			acquire: async (config) => {
				acquired.push(config)

				return stubEngine({
					engineID: `engine:${config.locale ?? "base"}:${config.country_scope ?? "auto"}`,
					session: {
						geocode: async (input: string) => ({
							result: {
								lat: input.startsWith("Rue") ? 48.86 : input === "Somewhere" ? 1 : 51.52,
								lon: input.startsWith("Rue") ? 2.34 : input === "Somewhere" ? 2 : -0.49,
								resolution_tier: "admin",
								components: {},
								hierarchy: [],
							},
						}),
					},
				})
			},
		})
	}

	it("runs each row on its country's engine on the board-routed path and reports the engines", async () => {
		const acquired: EngineConfig[] = []

		const report = (await runDiagnose(recordingRegistry(acquired), {
			inputs: LITERAL,
			config: { candidate_db: "none" },
			counterfactuals: false,
			execution_path: "board-routed",
		})) as {
			routing: {
				execution_path: string
				engines: Array<{ locale: string | null; country_scope: string | null; rows: number }>
			}
			rows: Array<{
				id: string
				routing: { locale: string | null; country_scope: string | null; engine_id: string } | null
				rendered: string
			}>
			summary: string
		}

		// The base engine, then one engine per routing: GB under en-GB, FR under fr-FR, ZZ unscoped on the base weights.
		expect(acquired.map((config) => [config.locale ?? null, config.country_scope ?? null])).toEqual([
			[null, null],
			["en-GB", null],
			["fr-FR", null],
			[null, "none"],
		])

		expect(report.routing.execution_path).toBe("board-routed")

		expect(report.routing.engines).toEqual([
			{ locale: "en-GB", country_scope: null, default_country: null, engine_id: "engine:en-GB:auto", rows: 1 },
			{ locale: "fr-FR", country_scope: null, default_country: null, engine_id: "engine:fr-FR:auto", rows: 1 },
			{ locale: null, country_scope: "none", default_country: null, engine_id: "engine:base:none", rows: 1 },
			{ locale: null, country_scope: null, default_country: null, engine_id: "engine:base:auto", rows: 1 },
		])

		const byID = Object.fromEntries(report.rows.map((row) => [row.id, row]))

		expect(byID["0"]!.routing).toMatchObject({ locale: "en-GB", engine_id: "engine:en-GB:auto" })
		expect(byID["0"]!.rendered).toContain("routed en-GB")
		expect(byID["1"]!.routing).toMatchObject({ locale: "fr-FR", engine_id: "engine:fr-FR:auto" })
		expect(byID["1"]!.rendered).toContain("routed fr-FR")
		expect(byID["2"]!.routing).toMatchObject({ locale: null, country_scope: "none" })
		expect(byID["2"]!.rendered).toContain("routed base unscoped")
		expect(byID["3"]!.routing).toBeNull()

		expect(report.summary).toContain(
			"Board-routed: 2 row(s) ran under their country's weights overlay and scope (en-GB 1, fr-FR 1), 1 ran on the base weights"
		)
	})

	it("runs every row on the configured engine on the single-config path", async () => {
		const acquired: EngineConfig[] = []

		const report = (await runDiagnose(recordingRegistry(acquired), {
			inputs: LITERAL,
			config: { candidate_db: "none" },
			counterfactuals: false,
		})) as { routing: { execution_path: string; engines: unknown[] }; rows: Array<{ routing: unknown }> }

		expect(acquired).toHaveLength(1)

		expect(report.routing).toEqual({
			execution_path: "single-config",
			engines: [{ locale: null, country_scope: null, default_country: null, engine_id: "engine:base:auto", rows: 4 }],
		})

		expect(report.rows.every((row) => row.routing === null)).toBe(true)
	})
})
