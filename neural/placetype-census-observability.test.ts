/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The PCN1 census OBSERVABILITY rung (2026-08-05): the census rides the placetype-pair prior's
 *   parent-candidate probes and records what it knows on the trace, and that is the whole feature.
 *
 *   **The contract this file exists to hold is the NEGATIVE one.** A census present must produce a
 *   decode byte-identical to a census absent — same emission matrix, same transition adjustments, and
 *   (end-to-end, on real weights) the same emissions/path/tokens. The 2026-08-04 wiring assessment
 *   ruled that no decode wiring ships before a calibration rung measures a δ, and the artifact header
 *   deliberately carries none; these assertions are what makes an accidental wiring fail loudly
 *   instead of quietly moving a number nobody re-measured.
 *
 *   The doubles idiom is `placetype-pair-prior.test.ts`'s verbatim — hand-built pieces, a hand-built
 *   `PairIndexLike`. The census side uses the REAL `serializePlacetypeCensus` →
 *   `PlacetypeCensusResolver` round trip rather than a double, because the fold agreement between the
 *   two artifacts (`foldVersion`) is part of what's under test.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ComponentTag } from "@mailwoman/core/types"
import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { NeuralAddressClassifier } from "./classifier.ts"
import { STAGE2_BIO_LABELS } from "./labels.ts"
import type { PairEdge, PairIndexLike } from "./pair-index-resolver.ts"
import {
	PlacetypeCensusResolver,
	serializePlacetypeCensus,
	type PlacetypeCensusHeader,
	type PlacetypeCensusLike,
	type PlacetypeCensusNode,
} from "./placetype-census.ts"
import { buildPlacetypePairPriors, type PlacetypePairProbeTrace } from "./placetype-pair-prior.ts"

const LABELS = STAGE2_BIO_LABELS

/**
 * Comma-preserving piece builder — `placetype-pair-prior.test.ts`'s `makePiecesWithCommas`, copied rather than
 * exported: it is a fixture shape, and a shared export would tie two test files' input assumptions together.
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
 * Build a real PCN1 artifact and read it back — writer and reader both, so the fold and the base-rate denominator are
 * the shipped ones.
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

describe("census observability — the byte-identical-decode contract", () => {
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
				// share(dependent_locality) = 642/675 = 0.9511… over a 0.2 base rate.
				lift: { dependent_locality: 642 / 675 / 0.2, locality: 33 / 675 / 0.6 },
			},
		])

		// The pair prior still fired, unchanged — the census rides the probe, it doesn't replace it.
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

		// Both segments take the parent role in the other's iteration, so two distinct surfaces were looked up and the
		// census knew neither. An empty list with a positive denominator is coverage, not a claim.
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

// End-to-end on the real en-us bundle: the mechanism-level assertions above prove the prior's own
// output is unchanged, but only a full decode proves nothing downstream (the transition conversion,
// the repair passes, the tree build) reads the census. Gated on the dev weights being linked —
// `link-dev-weights.ts` puts both the model and `pair-index-us.bin` in place, and the pair index is
// load-bearing here: without it the prior never runs and there is no parent candidate to probe
// alongside. The census artifact is BUILT into a temp dir rather than resolved from the data root,
// which is read-only on the lab host; a fixture census is enough to prove the wiring.
const WEIGHTS_DIR = repoRootPath("neural-weights-en-us")
const havePackage = existsSync(join(WEIGHTS_DIR, "model.onnx")) && existsSync(join(WEIGHTS_DIR, "pair-index-us.bin"))

describe("census observability — end-to-end through loadFromWeights", () => {
	test.skipIf(!havePackage)(
		"a wired census fills the trace record and moves nothing else",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "mailwoman-census-"))
			const censusPath = join(dir, "placetype-census-us.bin")

			writeFileSync(
				censusPath,
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
				)
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

			// The unwired leg is shape-identical to every trace produced before this rung existed.
			expect(withoutCensus.priors.find((p) => p.kind === "placetypeCensus")).toEqual({
				kind: "placetypeCensus",
				applied: false,
			})
		},
		120_000
	)
})
