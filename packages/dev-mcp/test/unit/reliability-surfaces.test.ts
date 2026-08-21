/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The decode surface's fold, against a stub engine.
 *
 *   Three decisions in this fold are silent when wrong and change the resulting curve: which tokens count toward a
 *   component's confidence, how they are folded to one number, and what happens to a component the truth row never
 *   mentions. The last one has a tempting wrong answer in BOTH directions — grade it wrong and a partial-truth corpus
 *   scores correct output as hallucination; drop it silently and the curve covers a fraction of the parse without
 *   saying so — which is why it is reported as its own cohort and pinned here.
 */

import type { DecoderToken } from "@mailwoman/core/decoder"
import type { ResolvedInput } from "@mailwoman/dev-mcp/input-sets"
import {
	ComponentAggregate,
	decodeReliabilitySample,
	UnassertedPolicy,
	type EngineLike,
	type GeocodeRunLike,
} from "@mailwoman/dev-mcp/reliability-surfaces"
import { describe, expect, it } from "vitest"

function token(label: string, confidence: number): DecoderToken {
	return { piece: "x", start: 0, end: 1, label: label as DecoderToken["label"], confidence }
}

/**
 * An engine that answers one canned run for every input — enough to exercise the fold without several gigabytes of
 * gazetteer.
 */
function stubEngine(run: GeocodeRunLike): EngineLike {
	return { session: { geocode: async () => run } }
}

const ROW: ResolvedInput = {
	id: "row-1",
	input: "1 Main St, Springfield, IL",
	country: "US",
	expectComponents: { street: "Main St", locality: "Springfield" },
}

describe("decodeReliabilitySample", () => {
	it("folds a span with min by default and mean on request", async () => {
		const run: GeocodeRunLike = {
			result: { components: { street: "Main St" } },
			trace: { parse: { tokens: [token("B-street", 0.9), token("I-street", 0.5)] } },
		}

		const min = await decodeReliabilitySample(stubEngine(run), [ROW], ComponentAggregate.Min)
		const mean = await decodeReliabilitySample(stubEngine(run), [ROW], ComponentAggregate.Mean)

		expect(min.observations[0]?.confidence).toBeCloseTo(0.5, 10)
		expect(mean.observations[0]?.confidence).toBeCloseTo(0.7, 10)
		expect(min.observations[0]?.correct).toBe(true)
	})

	const WITH_UNASSERTED: GeocodeRunLike = {
		result: { components: { street: "Main St", venue: "Some Cafe" } },
		trace: { parse: { tokens: [token("B-street", 0.9), token("I-street", 0.9), token("B-venue", 0.95)] } },
	}

	it("keeps a produced tag the truth row never mentions OUT of the curve, and counts it", async () => {
		// The measured reason (2026-08-21): no wired corpus asserts every component — the board asserts a median of one
		// key per row. Grading the unasserted ones as hallucinations put a 120-row board curve at 0.238 accuracy in its
		// top bin, which described the rule and not the model.
		const sample = await decodeReliabilitySample(stubEngine(WITH_UNASSERTED), [ROW], ComponentAggregate.Min)

		expect(sample.observations.map((observation) => observation.strata["tag"])).toEqual(["street"])
		expect(sample.unasserted).toMatchObject({ n: 1, by_tag: { venue: 1 } })
		expect(sample.unasserted?.mean_confidence).toBeCloseTo(0.95, 10)
	})

	it("grades it as WRONG only when the caller asks for the strict rule", async () => {
		// The strict rule stays reachable for a corpus that genuinely asserts every component; it is the DEFAULT that
		// was wrong, not the option.
		const sample = await decodeReliabilitySample(
			stubEngine(WITH_UNASSERTED),
			[ROW],
			ComponentAggregate.Min,
			UnassertedPolicy.Wrong
		)

		const venue = sample.observations.find((observation) => observation.strata["tag"] === "venue")

		expect(venue?.correct).toBe(false)
		expect(venue?.confidence).toBeCloseTo(0.95, 10)
		// The cohort is inside `observations` now, so a separate count would double-report it.
		expect(sample.unasserted).toBeNull()
	})

	it("grades case-insensitively, matching the harness rule rather than a local fold", async () => {
		const run: GeocodeRunLike = {
			result: { components: { street: "MAIN ST" } },
			trace: { parse: { tokens: [token("B-street", 0.8)] } },
		}

		const sample = await decodeReliabilitySample(stubEngine(run), [ROW], ComponentAggregate.Min)

		expect(sample.observations[0]?.correct).toBe(true)
	})

	it("carries the row's strata onto every observation", async () => {
		const run: GeocodeRunLike = {
			result: { components: { street: "Main St" } },
			trace: { parse: { tokens: [token("B-street", 0.8)] } },
		}

		const sample = await decodeReliabilitySample(
			stubEngine(run),
			[{ ...ROW, addressKind: "structured_address" }],
			ComponentAggregate.Min
		)

		expect(sample.observations[0]?.strata).toMatchObject({
			tag: "street",
			country: "US",
			address_kind: "structured_address",
		})
	})

	it("EXCLUDES a row with no component truth rather than grading it", async () => {
		// A literal input carries no truth. Counting it as wrong would manufacture errors out of rows nobody asserted
		// anything about; counting it as right would do the opposite. Both are worse than saying so.
		const run: GeocodeRunLike = {
			result: { components: { street: "Main St" } },
			trace: { parse: { tokens: [token("B-street", 0.8)] } },
		}

		const sample = await decodeReliabilitySample(
			stubEngine(run),
			[{ id: "bare", input: "somewhere" }],
			ComponentAggregate.Min
		)

		expect(sample.observations).toHaveLength(0)
		expect(sample.excluded[0]?.n).toBe(1)
		expect(sample.excluded[0]?.examples).toEqual(["bare"])
	})

	it("EXCLUDES a row the engine could not trace", async () => {
		const sample = await decodeReliabilitySample(
			stubEngine({ result: { components: { street: "Main St" } } }),
			[ROW],
			ComponentAggregate.Min
		)

		expect(sample.observations).toHaveLength(0)
		expect(sample.excluded[0]?.reason).toMatch(/no parse trace/)
	})

	it("ignores a component whose tokens are not in the trace, and says the row scored nothing", async () => {
		// The result and the trace can disagree: a component assembled by a repair after the decode has no token
		// carrying its tag. There is no confidence to grade there, and inventing one would be the whole defect.
		const sample = await decodeReliabilitySample(
			stubEngine({
				result: { components: { locality: "Springfield" } },
				trace: { parse: { tokens: [token("O", 0.99)] } },
			}),
			[ROW],
			ComponentAggregate.Min
		)

		expect(sample.observations).toHaveLength(0)
		expect(sample.excluded[0]?.reason).toMatch(/locatable in the trace/)
	})
})
