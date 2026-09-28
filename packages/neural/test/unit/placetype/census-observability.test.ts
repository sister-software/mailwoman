/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The census rides the placetype-pair prior's parent-candidate probes and records what it knows on
 *   the trace.
 *
 *   The interface this file holds is the negative one: a census present must produce a decode
 *   byte-identical to a census absent — same emission matrix and transition adjustments, and on real
 *   weights the same emissions, path and tokens — so an accidental wiring fails loudly.
 *
 *   The census side uses the real `serializePlacetypeCensus` → `PlacetypeCensusResolver` round trip
 *   because the fold agreement between the two artifacts (`foldVersion`) is part of what is under
 *   test.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { NeuralAddressClassifier } from "@mailwoman/neural/classifier"
import { STAGE2_BIO_LABELS } from "@mailwoman/neural/labels"
import type { PairEdge, PairIndexLike } from "@mailwoman/neural/pair"
import {
	PlacetypeCensusResolver,
	serializePlacetypeCensus,
	type PlacetypeCensusHeader,
	type PlacetypeCensusLike,
	type PlacetypeCensusNode,
	buildPlacetypePairPriors,
	type PlacetypePairProbeTrace,
} from "@mailwoman/neural/placetype"
import { resolveWeights } from "@mailwoman/neural/weights"
import { afterAll, describe, expect, test } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const LABELS = STAGE2_BIO_LABELS

/**
 * Comma-preserving piece builder; copied rather than exported so a shared export
 * cannot tie two test files' input assumptions together.
 */
function makePiecesWithCommas(text: string): Array<{ piece: string; start: number; end: number }> {
	const tokens = text.match(/[^\s,]+|,/g) ?? []
	const pieces: Array<{ piece: string; start: number; end: number }> = []
	let cursor = 0

	for (const tok of tokens) {
		const start = text.indexOf(tok, cursor)
		const end = start + tok.length

		pieces.push({ piece: tok === "," ? "," : `▁${tok}`, start, end })
		cursor = end
	}

	return pieces
}

function mockPairIndex(entries: Record<string, PairEdge>, delta = 5): PairIndexLike {
	return {
		delta,
		country: "gb",
		probe: (child, parent) => entries[`${child}|${parent}`],
	}
}

/**
 * Build a real PCN1 artifact and read it back, so the fold and the base-rate
 * denominator are the shipped ones.
 */
function makeCensus(
	nodes: Array<{ parent: string; counts: Partial<Record<ComponentTag, number>> }>,
	baseRates: Partial<Record<ComponentTag, number>>
): PlacetypeCensusResolver {
	const header: PlacetypeCensusHeader = {
		country: "gb",
		schemaVersion: 1,
		foldVersion: 1,
		sourceMD5s: ["test"],
		buildDate: "2026-08-05",
		baseRates,
	}

	const full: PlacetypeCensusNode[] = nodes.map((n) => ({
		parent: n.parent,
		counts: n.counts,
		total: Object.values(n.counts).reduce((a, b) => a + b, 0),
	}))

	return new PlacetypeCensusResolver(serializePlacetypeCensus(header, full))
}

const GB_CENSUS = makeCensus(
	[
		{ parent: "london", counts: { dependent_locality: 642, locality: 33 } },
		{ parent: "stocktonontees", counts: { dependent_locality: 12 } },
	],
	{ dependent_locality: 0.2, locality: 0.6 }
)

const PAIR_INDEX = mockPairIndex({
	"shoreditch|london": { tag: "dependent_locality", parentTag: "locality" },
	"fishburn|stocktonontees": { tag: "dependent_locality", parentTag: "locality" },
})

describe("census observability — the byte-identical-decode interface", () => {
	test.each([
		["segment path (comma-delimited)", "Shoreditch, London"],
		["anchored path (comma-free)", "Fishburn Stockton-on-Tees"],
		["no pair hit at all", "Nowhere, Elsewhere"],
	])("%s decodes identically with the census present and absent", (_name, text) => {
		const pieces = makePiecesWithCommas(text)

		const without = buildPlacetypePairPriors({ index: PAIR_INDEX, inputText: text, probeTrace: {} }, pieces, LABELS)

		const with_ = buildPlacetypePairPriors(
			{ index: PAIR_INDEX, inputText: text, probeTrace: {}, census: GB_CENSUS },
			pieces,
			LABELS
		)

		expect(with_.matrix).toEqual(without.matrix)
		expect(with_.transitionAdjustments).toEqual(without.transitionAdjustments)
	})
})

describe("census observability — what lands on the trace", () => {
	test("records the parent surface, its present child tags, and the lift", () => {
		const text = "Shoreditch, London"
		const probeTrace: PlacetypePairProbeTrace = {}

		buildPlacetypePairPriors(
			{ index: PAIR_INDEX, inputText: text, probeTrace, census: GB_CENSUS },
			makePiecesWithCommas(text),
			LABELS
		)

		expect(probeTrace.censusObservations).toEqual([
			{
				parent: "london",
				// Artifact order: descending count, so the dominant class is first.
				childTagsPresent: ["dependent_locality", "locality"],
				lift: { dependent_locality: 642 / 675 / 0.2, locality: 33 / 675 / 0.6 },
			},
		])

		// The census rides the probe rather than replacing it.
		expect(probeTrace.firedPath).toBe("segment")
		expect(probeTrace.firedChildTags).toEqual(["dependent_locality"])
	})

	test("the concat fold form probes too (a hyphenated parent the census stores as one token)", () => {
		const text = "Fishburn Stockton-on-Tees"
		const probeTrace: PlacetypePairProbeTrace = {}

		buildPlacetypePairPriors(
			{ index: PAIR_INDEX, inputText: text, probeTrace, census: GB_CENSUS },
			makePiecesWithCommas(text),
			LABELS
		)

		expect(probeTrace.censusObservations?.map((o) => o.parent)).toContain("stocktonontees")
	})

	test("a probed parent the census doesn't know records nothing but still counts (meaning of zero)", () => {
		const text = "Nowhere, Elsewhere"
		const probeTrace: PlacetypePairProbeTrace = {}

		buildPlacetypePairPriors(
			{ index: PAIR_INDEX, inputText: text, probeTrace, census: GB_CENSUS },
			makePiecesWithCommas(text),
			LABELS
		)

		// An empty list with a positive denominator is coverage rather than a claim.
		expect(probeTrace.censusObservations).toEqual([])
		expect(probeTrace.censusProbedParents).toBe(2)
	})

	test("no trace out-record ⇒ not one census lookup (the production path pays nothing)", () => {
		const text = "Shoreditch, London"
		const probes: string[] = []

		const spy: PlacetypeCensusLike = {
			probe: (parent) => {
				probes.push(parent)

				return GB_CENSUS.probe(parent)
			},
			lift: (parent, tag) => GB_CENSUS.lift(parent, tag),
		}

		buildPlacetypePairPriors({ index: PAIR_INDEX, inputText: text, census: spy }, makePiecesWithCommas(text), LABELS)

		expect(probes).toEqual([])
	})
})

// End-to-end on the real en-us bundle: the mechanism-level assertions prove the prior's own
// output is unchanged, but only a full decode proves no downstream code reads the census.
// The pair index is required because without it the prior never runs, the census
// artifact is built into a temp dir because the data root is read-only on the lab host,
// and weights resolve through `resolveWeights` because a skip-guard keyed on the wrong
// directory would skip and report success while testing no assertion.
const resolved = await (async () => {
	try {
		return await resolveWeights({ locale: "en-us" })
	} catch {
		return undefined
	}
})()

const havePackage =
	resolved !== undefined && resolved.artifacts.some((a) => a.name === "pair-index-us.bin" && a.path !== null)

describe("census observability — end-to-end through loadFromWeights", () => {
	test.skipIf(!havePackage)(
		"a wired census fills the trace record and moves nothing else",
		async () => {
			const dir = fixtures.use(await temporaryDirectory("mailwoman-census-")).path
			const censusPath = dir("placetype-census-us.bin")

			await writeLocalFile(
				serializePlacetypeCensus(
					{
						country: "us",
						schemaVersion: 1,
						foldVersion: 1,
						sourceMD5s: ["test"],
						buildDate: "2026-08-05",
						baseRates: { dependent_locality: 0.2 },
					},
					[{ parent: "new york", counts: { dependent_locality: 40 }, total: 40 }]
				),
				censusPath
			)

			const cls = await NeuralAddressClassifier.loadFromWeights({
				locale: "en-us",
				placetypeCensusPath: censusPath,
			})

			const text = "brooklyn, new york, ny"
			const withCensus = await cls.traceParse(text)
			const withoutCensus = await cls.traceParse(text, { placetypeCensus: false })

			expect(withCensus.emissions).toEqual(withoutCensus.emissions)
			expect(withCensus.path).toEqual(withoutCensus.path)
			expect(withCensus.tokens).toEqual(withoutCensus.tokens)

			const wired = withCensus.priors.find((p) => p.kind === "placetypeCensus")

			expect(wired?.applied).toBe(false)
			expect(wired?.censusProbedParents).toBeGreaterThan(0)
			expect(wired?.census?.map((o) => o.parent)).toContain("new york")

			expect(withoutCensus.priors.find((p) => p.kind === "placetypeCensus")).toEqual({
				kind: "placetypeCensus",
				applied: false,
			})
		},
		120_000
	)
})
