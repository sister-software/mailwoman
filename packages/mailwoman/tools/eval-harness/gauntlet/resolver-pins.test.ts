/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A dropped resolver pin does not throw: it produces a check log identical to the unpinned one, so every
 *   hop from run options to geocode deps is pinned here rather than by running the check.
 */

import { describe, expect, it } from "vitest"

import {
	describeResolverPins,
	type GauntletResolverPins,
	PRODUCTION_RESOLVER_PINS,
	resolverPinDeps,
} from "#tools/eval-harness/gauntlet/harness"
import { layerDepsOptions } from "#tools/eval-harness/gauntlet/regression"
import { runLayerOptions, runResolverPins } from "#tools/eval-harness/gauntlet/run"

/**
 * A full pin set that pins only the given switches.
 */
function pinned(pins: Partial<GauntletResolverPins>): GauntletResolverPins {
	return { ...PRODUCTION_RESOLVER_PINS, ...pins }
}

/**
 * The geocode deps a run's options reach after every hop.
 */
function depsFromRun(options: Parameters<typeof runLayerOptions>[0]): ReturnType<typeof resolverPinDeps> {
	return resolverPinDeps(layerDepsOptions(runLayerOptions(options)).pins ?? PRODUCTION_RESOLVER_PINS)
}

describe("resolverPinDeps — the pin set → geocodeAddress deps", () => {
	it("maps an ON pin onto the geocode dep of the same name", () => {
		expect(resolverPinDeps(pinned({ postcodeCountryCoherence: "on" }))).toEqual({ postcodeCountryCoherence: true })
	})

	it("maps an OFF pin, so a caller can force the library default's opposite", () => {
		expect(resolverPinDeps(pinned({ postcodeCountryCoherence: "off" }))).toEqual({ postcodeCountryCoherence: false })
	})

	it("carries the venue-tier pin, ON and OFF, so the routed board can grade #1684's POI half", () => {
		expect(resolverPinDeps(pinned({ poiVenueTier: "on" }))).toEqual({ poiVenueTier: true })
		expect(resolverPinDeps(pinned({ poiVenueTier: "off" }))).toEqual({ poiVenueTier: false })
	})

	it("emits no dep for the production pin set — production defaults stay in force", () => {
		expect(resolverPinDeps(PRODUCTION_RESOLVER_PINS)).toEqual({})
	})
})

describe("describeResolverPins — the run banner", () => {
	it("names the pinned pin and its state", () => {
		expect(describeResolverPins(pinned({ postcodeCountryCoherence: "on" }))).toBe(
			"resolver pins: postcodeCountryCoherence=ON"
		)

		expect(describeResolverPins(pinned({ postcodeCountryCoherence: "off" }))).toBe(
			"resolver pins: postcodeCountryCoherence=OFF"
		)
	})

	it("says so when nothing is pinned — an unlabeled log is not evidence about a pin", () => {
		expect(describeResolverPins(PRODUCTION_RESOLVER_PINS)).toBe("resolver pins: (none pinned — production defaults)")
	})
})

describe("runResolverPins — CLI options → pin set", () => {
	it("carries an ON pin", () => {
		expect(runResolverPins({ postcodeCountryCoherence: "on" })).toEqual(pinned({ postcodeCountryCoherence: "on" }))
	})

	// The on pin now restates production, so grading the pre-promotion configuration
	// requires an off pin that is believed.
	it("carries an OFF pin", () => {
		expect(runResolverPins({ postcodeCountryCoherence: "off" })).toEqual(pinned({ postcodeCountryCoherence: "off" }))
	})

	it("carries the venue-head prior pin and its bias scale", () => {
		expect(runResolverPins({ venueHeadPrior: "on", venueHeadBiasScale: 1.5, poiVenueTier: "on" })).toEqual(
			pinned({ venueHeadPrior: "on", venueHeadBiasScale: 1.5, poiVenueTier: "on" })
		)

		expect(describeResolverPins(pinned({ venueHeadPrior: "on", venueHeadBiasScale: 2 }))).toBe(
			"resolver pins: venueHeadPrior=ON, venueHeadBiasScale=2"
		)
	})

	it("is the production pin set when no flag is set", () => {
		expect(runResolverPins({})).toEqual(PRODUCTION_RESOLVER_PINS)
		expect(runResolverPins({ candidate: "./out/model.onnx" })).toEqual(PRODUCTION_RESOLVER_PINS)
	})
})

describe("runLayerOptions — the pin reaches every layer", () => {
	it("carries the pins alongside the model selection", () => {
		const options = runLayerOptions({ candidate: "./out/v9/model.onnx", postcodeCountryCoherence: "on" })

		expect(options.model).toBe("./out/v9/model.onnx")
		expect(options.pins).toEqual(pinned({ postcodeCountryCoherence: "on" }))
	})

	it("carries the production pin set when unpinned", () => {
		expect(runLayerOptions({}).pins).toEqual(PRODUCTION_RESOLVER_PINS)
	})
})

describe("layerDepsOptions — layer options → buildGauntletDeps argument", () => {
	const pins = pinned({ postcodeCountryCoherence: "on" })

	it("carries the pin on the shipped-default ladder (no candidate model)", () => {
		expect(layerDepsOptions({ pins })).toEqual({ pins })
	})

	it("carries the pin on the modelPath ladder", () => {
		expect(layerDepsOptions({ model: "./out/v9/model.onnx", pins })).toEqual({
			modelPath: "./out/v9/model.onnx",
			pins,
		})
	})

	it("carries the pin on the tokenizer-splice ladder", () => {
		const deps = layerDepsOptions({
			model: "./out/v9/model.onnx",
			tokenizer: "./out/v9/tokenizer.model",
			card: "./out/v9/model-card.json",
			pins,
		})

		expect(deps).toEqual({
			modelPath: "./out/v9/model.onnx",
			tokenizerPath: "./out/v9/tokenizer.model",
			modelCardPath: "./out/v9/model-card.json",
			pins,
		})
	})

	it("carries the pin on the weights-cache ladder, which takes precedence over the model", () => {
		const deps = layerDepsOptions({ weightsCacheRoot: "/tmp/cache", model: "./out/v9/model.onnx", pins })

		expect(deps).toEqual({ weightsCacheRoot: "/tmp/cache", pins })
	})

	it("leaves the argument pin-free when the layer carries no pins, on every ladder", () => {
		expect(layerDepsOptions({})).toEqual({})
		expect(layerDepsOptions({ model: "./out/v9/model.onnx" })).toEqual({ modelPath: "./out/v9/model.onnx" })
		expect(layerDepsOptions({ weightsCacheRoot: "/tmp/cache" })).toEqual({ weightsCacheRoot: "/tmp/cache" })
	})
})

describe("end-to-end plumbing: a CLI flag becomes a geocode dep", () => {
	it("survives every hop from run options to the resolve", () => {
		expect(depsFromRun({ postcodeCountryCoherence: "on" })).toEqual({ postcodeCountryCoherence: true })
	})

	it("survives every hop for the OFF pin too", () => {
		expect(depsFromRun({ postcodeCountryCoherence: "off" })).toEqual({ postcodeCountryCoherence: false })
	})

	it("stays empty across the same hops when no flag is set", () => {
		expect(depsFromRun({})).toEqual({})
	})
})

describe("gazetteerPrior pin (#1497)", () => {
	// The pin includes an artifact, so the pure `resolverPinDeps` cannot see it
	// and only the banner can announce it.
	it("is announced even though resolverPinDeps cannot carry it", () => {
		expect(describeResolverPins(pinned({ gazetteerPrior: "on" }))).toContain("gazetteerPrior=ON")
		expect(resolverPinDeps(pinned({ gazetteerPrior: "on" }))).toEqual({})
	})

	it("announces alongside a switch pin rather than replacing it", () => {
		const described = describeResolverPins(pinned({ gazetteerPrior: "on", postcodeCountryCoherence: "off" }))

		expect(described).toContain("gazetteerPrior=ON")
		expect(described).toContain("postcodeCountryCoherence=OFF")
	})

	it("announces an OFF pin, now that the production default is ON", () => {
		expect(describeResolverPins(pinned({ gazetteerPrior: "off" }))).toContain("gazetteerPrior=OFF")
	})

	it("prints nothing for the pin when it is production, so 'no flag' still reads as production", () => {
		expect(describeResolverPins(pinned({ postcodeCountryCoherence: "off" }))).not.toContain("gazetteerPrior")
	})

	// A one-sided forward that handles only the on half silently discards
	// `--gazetteer-prior off`, grading the default arm under an off label.
	it("is forwarded both ways by runResolverPins", () => {
		expect(runResolverPins({ gazetteerPrior: "off" }).gazetteerPrior).toBe("off")
		expect(runResolverPins({ gazetteerPrior: "on" }).gazetteerPrior).toBe("on")
		expect(runResolverPins({}).gazetteerPrior).toBe("production")
	})
})

describe("capitalTier and variantAliasExemption pins", () => {
	it("are announced by value and absent at production", () => {
		expect(describeResolverPins(pinned({ capitalTier: "required" }))).toContain("capitalTier=required")
		expect(describeResolverPins(pinned({ variantAliasExemption: "applied" }))).toContain("variantAliasExemption=ON")

		expect(describeResolverPins(pinned({ variantAliasExemption: "not_applied" }))).toContain(
			"variantAliasExemption=OFF"
		)
	})
})

describe("adminContainmentRerank pin (#1717 stage 2)", () => {
	it("maps the ON and OFF pins onto the geocode dep of the same name", () => {
		expect(resolverPinDeps(pinned({ adminContainmentRerank: "on" }))).toEqual({ adminContainmentRerank: true })
		expect(resolverPinDeps(pinned({ adminContainmentRerank: "off" }))).toEqual({ adminContainmentRerank: false })
	})

	it("is announced in the run banner, both ways", () => {
		expect(describeResolverPins(pinned({ adminContainmentRerank: "on" }))).toContain("adminContainmentRerank=ON")
		expect(describeResolverPins(pinned({ adminContainmentRerank: "off" }))).toContain("adminContainmentRerank=OFF")
	})

	it("survives every hop from run options to the resolve, both directions", () => {
		expect(depsFromRun({ adminContainmentRerank: "on" })).toEqual({ adminContainmentRerank: true })
		expect(depsFromRun({ adminContainmentRerank: "off" })).toEqual({ adminContainmentRerank: false })
	})

	it("composes with a sibling pin rather than replacing it", () => {
		expect(resolverPinDeps(pinned({ adminContainmentRerank: "on", postcodeCountryCoherence: "off" }))).toEqual({
			adminContainmentRerank: true,
			postcodeCountryCoherence: false,
		})
	})
})

describe("spanRescoreRequireContextRemainder — #2266's pin", () => {
	it("survives every hop from run options to the resolve, both directions", () => {
		expect(depsFromRun({ spanRescoreRequireContextRemainder: "on" })).toEqual({
			spanRescoreRequireContextRemainder: true,
		})

		expect(depsFromRun({ spanRescoreRequireContextRemainder: "off" })).toEqual({
			spanRescoreRequireContextRemainder: false,
		})
	})

	it("is named in the run banner, both directions, and absent at production", () => {
		expect(describeResolverPins(pinned({ spanRescoreRequireContextRemainder: "on" }))).toContain(
			"spanRescoreRequireContextRemainder=ON"
		)

		expect(describeResolverPins(pinned({ spanRescoreRequireContextRemainder: "off" }))).toContain(
			"spanRescoreRequireContextRemainder=OFF"
		)

		expect(describeResolverPins(pinned({ adminContainmentRerank: "on" }))).not.toContain(
			"spanRescoreRequireContextRemainder"
		)
	})
})

describe("spanRescoreWeakResolution — #2264's pin", () => {
	it("survives every hop from run options to the resolve, each reading", () => {
		for (const reading of ["score", "containment", "either"] as const) {
			expect(depsFromRun({ spanRescoreWeakResolution: reading })).toEqual({ spanRescoreWeakResolution: reading })
		}
	})

	it("names the READING in the run banner, not an ON", () => {
		expect(describeResolverPins(pinned({ spanRescoreWeakResolution: "score" }))).toContain(
			"spanRescoreWeakResolution=score"
		)

		expect(describeResolverPins(pinned({ adminContainmentRerank: "on" }))).not.toContain("spanRescoreWeakResolution")
	})

	it("has no OFF spelling — the production pin is the shipped brake", () => {
		expect(depsFromRun({ spanRescoreWeakResolution: "production" })).toEqual({})
	})
})
