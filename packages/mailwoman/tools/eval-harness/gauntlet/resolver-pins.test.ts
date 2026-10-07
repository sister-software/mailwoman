/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A dropped resolver pin does not throw: it produces a check log identical to the unpinned one, so every
 *   hop from run options to geocode deps is pinned here rather than by running the check.
 */

import { describe, expect, it } from "vitest"

import { describeResolverPins, resolverPinDeps } from "#tools/eval-harness/gauntlet/harness"
import { layerDepsOptions } from "#tools/eval-harness/gauntlet/regression"
import { runLayerOptions, runResolverPins } from "#tools/eval-harness/gauntlet/run"

describe("resolverPinDeps — the pin set → geocodeAddress deps", () => {
	it("maps an ON pin onto the geocode dep of the same name", () => {
		expect(resolverPinDeps({ postcodeCountryCoherence: true })).toEqual({ postcodeCountryCoherence: true })
	})

	it("maps an explicit OFF pin, so a caller can force the library default's opposite", () => {
		expect(resolverPinDeps({ postcodeCountryCoherence: false })).toEqual({ postcodeCountryCoherence: false })
	})

	it("carries the venue-tier pin, ON and OFF, so the routed board can grade #1684's POI half", () => {
		expect(resolverPinDeps({ poiVenueTier: true })).toEqual({ poiVenueTier: true })
		expect(resolverPinDeps({ poiVenueTier: false })).toEqual({ poiVenueTier: false })
	})

	it("emits NOTHING for an absent pin set — production defaults stay in force", () => {
		expect(resolverPinDeps(null)).toEqual({})
		expect(resolverPinDeps({})).toEqual({})
	})
})

describe("describeResolverPins — the run banner", () => {
	it("names the pinned pin and its state", () => {
		expect(describeResolverPins({ postcodeCountryCoherence: true })).toBe("resolver pins: postcodeCountryCoherence=ON")

		expect(describeResolverPins({ postcodeCountryCoherence: false })).toBe(
			"resolver pins: postcodeCountryCoherence=OFF"
		)
	})

	it("says so when nothing is pinned — an unlabeled log is not evidence about a pin", () => {
		expect(describeResolverPins(null)).toBe("resolver pins: (none pinned — production defaults)")
	})
})

describe("runResolverPins — CLI options → pin set", () => {
	it("carries an ON pin", () => {
		expect(runResolverPins({ postcodeCountryCoherence: true })).toEqual({ postcodeCountryCoherence: true })
	})

	// The on pin now restates production, so grading the pre-promotion configuration
	// requires an off pin that is believed.
	it("carries an OFF pin", () => {
		expect(runResolverPins({ postcodeCountryCoherence: false })).toEqual({ postcodeCountryCoherence: false })
	})

	it("returns null when the flag was never set", () => {
		expect(runResolverPins({})).toBeNull()
		expect(runResolverPins({ candidate: "./out/model.onnx" })).toBeNull()
	})
})

describe("runLayerOptions — the pin reaches every layer", () => {
	it("carries the pins alongside the model selection", () => {
		const options = runLayerOptions({ candidate: "./out/v9/model.onnx", postcodeCountryCoherence: true })

		expect(options.model).toBe("./out/v9/model.onnx")
		expect(options.pins).toEqual({ postcodeCountryCoherence: true })
	})

	it("omits `pins` entirely when unpinned", () => {
		expect(runLayerOptions({}).pins).toBeUndefined()
	})
})

describe("layerDepsOptions — layer options → buildGauntletDeps argument", () => {
	it("carries the pin on the shipped-default ladder (no candidate model)", () => {
		expect(layerDepsOptions({ pins: { postcodeCountryCoherence: true } })).toEqual({
			pins: { postcodeCountryCoherence: true },
		})
	})

	it("carries the pin on the modelPath ladder", () => {
		const deps = layerDepsOptions({ model: "./out/v9/model.onnx", pins: { postcodeCountryCoherence: true } })

		expect(deps).toEqual({ modelPath: "./out/v9/model.onnx", pins: { postcodeCountryCoherence: true } })
	})

	it("carries the pin on the tokenizer-splice ladder", () => {
		const deps = layerDepsOptions({
			model: "./out/v9/model.onnx",
			tokenizer: "./out/v9/tokenizer.model",
			card: "./out/v9/model-card.json",
			pins: { postcodeCountryCoherence: true },
		})

		expect(deps).toEqual({
			modelPath: "./out/v9/model.onnx",
			tokenizerPath: "./out/v9/tokenizer.model",
			modelCardPath: "./out/v9/model-card.json",
			pins: { postcodeCountryCoherence: true },
		})
	})

	it("carries the pin on the weights-cache ladder, which takes precedence over the model", () => {
		const deps = layerDepsOptions({
			weightsCacheRoot: "/tmp/cache",
			model: "./out/v9/model.onnx",
			pins: { postcodeCountryCoherence: true },
		})

		expect(deps).toEqual({ weightsCacheRoot: "/tmp/cache", pins: { postcodeCountryCoherence: true } })
	})

	it("leaves the argument pin-free when unpinned, on every ladder", () => {
		expect(layerDepsOptions({})).toEqual({})
		expect(layerDepsOptions({ model: "./out/v9/model.onnx" })).toEqual({ modelPath: "./out/v9/model.onnx" })
		expect(layerDepsOptions({ weightsCacheRoot: "/tmp/cache" })).toEqual({ weightsCacheRoot: "/tmp/cache" })
	})
})

describe("end-to-end plumbing: a CLI flag becomes a geocode dep", () => {
	it("survives every hop from run options to the resolve", () => {
		const deps = resolverPinDeps(layerDepsOptions(runLayerOptions({ postcodeCountryCoherence: true })).pins)

		expect(deps).toEqual({ postcodeCountryCoherence: true })
	})

	it("survives every hop for the OFF pin too", () => {
		const deps = resolverPinDeps(layerDepsOptions(runLayerOptions({ postcodeCountryCoherence: false })).pins)

		expect(deps).toEqual({ postcodeCountryCoherence: false })
	})

	it("stays empty across the same hops when the flag is absent", () => {
		expect(resolverPinDeps(layerDepsOptions(runLayerOptions({})).pins)).toEqual({})
	})
})

describe("gazetteerPrior pin (#1497)", () => {
	// The pin includes an artifact, so the pure `resolverPinDeps` cannot see it
	// and only the banner can announce it.
	it("is announced even though resolverPinDeps cannot carry it", () => {
		expect(describeResolverPins({ gazetteerPrior: true })).toContain("gazetteerPrior=ON")
	})

	it("still reports production defaults when nothing is pinned", () => {
		expect(describeResolverPins(null)).toContain("none pinned")
	})

	it("announces alongside a boolean pin rather than replacing it", () => {
		const described = describeResolverPins({ gazetteerPrior: true, postcodeCountryCoherence: false })

		expect(described).toContain("gazetteerPrior=ON")
		expect(described).toContain("postcodeCountryCoherence=OFF")
	})

	it("announces an OFF pin, now that the production default is ON", () => {
		// The production default is ON.
		// `false` therefore sets a real pin.
		expect(describeResolverPins({ gazetteerPrior: false })).toContain("gazetteerPrior=OFF")
	})

	it("prints nothing for the pin when it is unset, so 'no flag' still reads as production", () => {
		expect(describeResolverPins({ postcodeCountryCoherence: false })).not.toContain("gazetteerPrior")
	})
})

describe("runResolverPins forwards BOTH halves of the prior tri-state", () => {
	// A one-sided forward that handles only the truthy half silently discards
	// `--gazetteer-prior-off`, grading the default arm under an off label.
	it("keeps an explicit false", () => {
		expect(runResolverPins({ gazetteerPrior: false })).toEqual({ gazetteerPrior: false })
	})

	it("keeps an explicit true", () => {
		expect(runResolverPins({ gazetteerPrior: true })).toEqual({ gazetteerPrior: true })
	})

	it("leaves an unset pin absent, not pinned", () => {
		expect(runResolverPins({})).toBeNull()
	})
})

describe("adminContainmentRerank pin (#1717 stage 2)", () => {
	// The pin must flow through both paths.
	// One-sided forwarding compiles and passes every other test.
	// It also produces an off-labeled log that graded the default arm.
	it("maps the ON pin onto the geocode dep of the same name", () => {
		expect(resolverPinDeps({ adminContainmentRerank: true })).toEqual({ adminContainmentRerank: true })
	})

	it("maps the explicit OFF pin — grading the production default under an OFF label must be true", () => {
		expect(resolverPinDeps({ adminContainmentRerank: false })).toEqual({ adminContainmentRerank: false })
	})

	it("is announced in the run banner, both ways", () => {
		expect(describeResolverPins({ adminContainmentRerank: true })).toContain("adminContainmentRerank=ON")
		expect(describeResolverPins({ adminContainmentRerank: false })).toContain("adminContainmentRerank=OFF")
	})

	it("prints nothing when unset, so 'no flag' still reads as production", () => {
		expect(describeResolverPins({ postcodeCountryCoherence: false })).not.toContain("adminContainmentRerank")
	})

	it("survives every hop from run options to the resolve, both directions", () => {
		expect(resolverPinDeps(layerDepsOptions(runLayerOptions({ adminContainmentRerank: true })).pins)).toEqual({
			adminContainmentRerank: true,
		})

		expect(resolverPinDeps(layerDepsOptions(runLayerOptions({ adminContainmentRerank: false })).pins)).toEqual({
			adminContainmentRerank: false,
		})
	})

	it("composes with a sibling pin rather than replacing it", () => {
		expect(resolverPinDeps({ adminContainmentRerank: true, postcodeCountryCoherence: false })).toEqual({
			adminContainmentRerank: true,
			postcodeCountryCoherence: false,
		})
	})
})

describe("spanRescoreRequireContextRemainder — #2266's pin", () => {
	it("survives every hop from run options to the resolve, both directions", () => {
		expect(
			resolverPinDeps(layerDepsOptions(runLayerOptions({ spanRescoreRequireContextRemainder: true })).pins)
		).toEqual({ spanRescoreRequireContextRemainder: true })

		expect(
			resolverPinDeps(layerDepsOptions(runLayerOptions({ spanRescoreRequireContextRemainder: false })).pins)
		).toEqual({ spanRescoreRequireContextRemainder: false })
	})

	it("is named in the run banner, both directions, and absent when unset", () => {
		// An off/on pair whose logs are indistinguishable is not evidence about the pin.
		expect(describeResolverPins({ spanRescoreRequireContextRemainder: true })).toContain(
			"spanRescoreRequireContextRemainder=ON"
		)

		expect(describeResolverPins({ spanRescoreRequireContextRemainder: false })).toContain(
			"spanRescoreRequireContextRemainder=OFF"
		)

		expect(describeResolverPins({ adminContainmentRerank: true })).not.toContain("spanRescoreRequireContextRemainder")
	})

	it("composes with a sibling pin rather than replacing it", () => {
		expect(resolverPinDeps({ spanRescoreRequireContextRemainder: true, adminContainmentRerank: false })).toEqual({
			spanRescoreRequireContextRemainder: true,
			adminContainmentRerank: false,
		})
	})
})

describe("spanRescoreWeakResolution — #2264's pin", () => {
	it("survives every hop from run options to the resolve, each reading", () => {
		for (const reading of ["score", "containment", "either"] as const) {
			expect(resolverPinDeps(layerDepsOptions(runLayerOptions({ spanRescoreWeakResolution: reading })).pins)).toEqual({
				spanRescoreWeakResolution: reading,
			})
		}
	})

	it("names the READING in the run banner, not an ON", () => {
		// The three readings grade different configurations, so collapsing them to a
		// single on/off value is how two arms produce identical pin logs.
		expect(describeResolverPins({ spanRescoreWeakResolution: "score" })).toContain("spanRescoreWeakResolution=score")

		expect(describeResolverPins({ spanRescoreWeakResolution: "containment" })).toContain(
			"spanRescoreWeakResolution=containment"
		)

		expect(describeResolverPins({ adminContainmentRerank: true })).not.toContain("spanRescoreWeakResolution")
	})

	it("has no OFF spelling — an unset pin is the shipped brake", () => {
		expect(resolverPinDeps(layerDepsOptions(runLayerOptions({})).pins)).toEqual({})
		expect(describeResolverPins(null)).toContain("production defaults")
	})

	it("composes with a sibling pin rather than replacing it", () => {
		expect(resolverPinDeps({ spanRescoreWeakResolution: "either", spanRescoreRequireContextRemainder: true })).toEqual({
			spanRescoreWeakResolution: "either",
			spanRescoreRequireContextRemainder: true,
		})
	})
})
