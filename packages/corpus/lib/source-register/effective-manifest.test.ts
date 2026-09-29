/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	deriveEffectiveTrainingManifest,
	effectiveManifestDigest,
	ExclusionReason,
	provenanceDisagreement,
	provenanceRefusals,
	type EpochMixtureAudit,
	type TrainingManifest,
} from "@mailwoman/corpus/source-register"
import { describe, expect, it } from "vitest"

const corpusManifest: TrainingManifest = {
	manifestID: "corpus-training-manifest",
	schemaVersion: 1,
	corpusVersion: "v0.0.0-test",
	builtAt: "2026-09-28T00:00:00.000Z",
	profile: "exploratory",
	sources: [
		{ source: "drawn", rows: 1000, license: "CC0-1.0", decision: null },
		{ source: "weighted-zero", rows: 2000, license: "CC-BY-4.0", decision: null },
		{ source: "unweighted", rows: 3000, license: "ODbL-1.0", decision: null },
		{ source: "weighted-undrawn", rows: 4000, license: "CC0-1.0", decision: null },
	],
	refused: {},
	totalRows: 10_000,
	contentDigest: "base-digest",
}

const audit: EpochMixtureAudit = {
	draw_level: {
		totals: { drawn: 700, overlay: 200 },
		admitted_countries_drawn: { FR: 500, DE: 400, PL: 0 },
		admitted_countries_drawing_nothing: ["PL"],
	},
	emitted_level: { totals: { drawn: 800, overlay: 200 } },
	meta: { seed: 43, draws_requested: 1000, draws_realized: 1000, config: "configs/arm-a.yaml" },
}

const config = {
	sourceWeights: { drawn: 1, "weighted-zero": 0, "weighted-undrawn": 2, overlay: 1 },
	augmentExcludeSources: ["drawn"],
}

const derive = () =>
	deriveEffectiveTrainingManifest({ corpusManifest, audit, config, configPath: "configs/arm-a.yaml" })

describe("deriveEffectiveTrainingManifest", () => {
	it("separates a source the config never weighted from one weighted at zero and one that drew zero", () => {
		const manifest = derive()
		const bySource = new Map(manifest.sources.map((record) => [record.source, record]))

		expect(bySource.get("unweighted")?.excludedBecause).toBe(ExclusionReason.UnweightedSource)
		expect(bySource.get("weighted-zero")?.excludedBecause).toBe(ExclusionReason.ZeroWeight)
		expect(bySource.get("weighted-undrawn")?.excludedBecause).toBe(ExclusionReason.DrewZeroRows)
		expect(bySource.get("drawn")?.excludedBecause).toBeNull()

		// The three reasons are different facts.
		// A single absence would read as three sources the sampler failed to reach,
		// where two were excluded by the config before any draw.
		expect(manifest.excludedSources).toEqual({
			unweighted: ExclusionReason.UnweightedSource,
			"weighted-zero": ExclusionReason.ZeroWeight,
			"weighted-undrawn": ExclusionReason.DrewZeroRows,
		})
	})

	it("reports an emitted source the corpus manifest does not name rather than dropping it", () => {
		const manifest = derive()

		// `overlay` is emitted and absent from the frozen manifest.
		// That is what an overlay merged after the build looks like.
		// Over `v0.6.0-register-surface` that set is 39 sources and 890,666 of 1,000,000 rows.
		expect(manifest.emittedButUnrecorded).toEqual({ overlay: 200 })
		expect(manifest.trainingSources).toEqual(["drawn"])
	})

	it("carries the seed and draw count, because the counts hold for that epoch alone", () => {
		const manifest = derive()

		expect(manifest.seed).toBe(43)
		expect(manifest.drawsRequested).toBe(1000)
		expect(manifest.drawsRealized).toBe(1000)
		expect(manifest.corpusManifestDigest).toBe("base-digest")
		expect(manifest.totalEmittedRows).toBe(1000)
	})

	it("counts the admitted countries that drew a row against those admitted", () => {
		const manifest = derive()

		expect(manifest.admittedCountries).toBe(3)
		expect(manifest.countriesDrawingRows).toBe(2)
		expect(manifest.admittedCountriesDrawingZero).toEqual(["PL"])
	})

	it("carries a digest over its own contents", () => {
		const manifest = derive()

		expect(manifest.contentDigest).toBe(effectiveManifestDigest(manifest))
		expect(manifest.contentDigest).toHaveLength(64)
	})

	it("refuses an audit with no emitted totals rather than deriving from the draw counts", () => {
		expect(() =>
			deriveEffectiveTrainingManifest({
				corpusManifest,
				audit: { draw_level: audit.draw_level, meta: audit.meta },
				config,
				configPath: "configs/arm-a.yaml",
			})
		).toThrow(/emitted_level\.totals/)
	})

	it("refuses an audit produced under a different config, which is a second training arm", () => {
		expect(() =>
			deriveEffectiveTrainingManifest({ corpusManifest, audit, config, configPath: "configs/arm-b.yaml" })
		).toThrow(/two training arms/)
	})
})

describe("provenanceDisagreement", () => {
	it("names both directions, because each overstates or understates a different thing", () => {
		const manifest = derive()

		expect(provenanceDisagreement(manifest, ["drawn", "unweighted"])).toEqual({
			declaredButNotTrained: ["unweighted"],
			trainedButNotDeclared: [],
		})

		expect(provenanceDisagreement(manifest, [])).toEqual({
			declaredButNotTrained: [],
			trainedButNotDeclared: ["drawn"],
		})
	})
})

describe("provenanceRefusals", () => {
	it("refuses a release that read no effective manifest, rather than reading its absence as agreement", () => {
		const refusals = provenanceRefusals({ manifest: null, declared: ["drawn"], packageName: "pkg" })

		expect(refusals).toHaveLength(1)
		expect(refusals[0]).toMatch(/no effective training manifest was read/)
	})

	it("refuses while an emitted source carries no entry in the frozen manifest", () => {
		const refusals = provenanceRefusals({ manifest: derive(), declared: ["drawn"], packageName: "pkg" })

		expect(refusals.some((line) => line.includes("the corpus's frozen manifest does not name"))).toBe(true)
	})

	it("names a declared source the epoch drew zero rows from", () => {
		const refusals = provenanceRefusals({
			manifest: derive(),
			declared: ["drawn", "weighted-undrawn"],
			packageName: "pkg",
		})

		expect(refusals.some((line) => line.includes("drew zero rows from: weighted-undrawn"))).toBe(true)
	})

	it("names an emitted source the record omits", () => {
		const refusals = provenanceRefusals({ manifest: derive(), declared: [], packageName: "pkg" })

		expect(refusals.some((line) => line.includes("omits 1 source(s) the audited epoch emitted: drawn"))).toBe(true)
	})
})
