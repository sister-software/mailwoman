/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the Gauntlet's RESOLVER-pin pin (#42, 2026-08-05) — the plumbing that lets the check grade a resolver
 *   configuration, not just a model.
 *
 *   These assert a mapping, deliberately: `run options → layer options → geocode deps`. The check itself needs the ~9 GB
 *   database set and a loaded ONNX, so a test that ran it would be an integration run, not a check — and the failure mode
 *   this surface exists to prevent is silent. A dropped pin does not throw; it produces a check log identical to the
 *   unpinned one, which reads exactly like "the pin changed nothing". Every hop is therefore pinned here.
 */

import { describeResolverPins, resolverPinDeps } from "mailwoman/eval-harness/gauntlet/harness"
import { layerDepsOptions } from "mailwoman/eval-harness/gauntlet/regression"
import { runLayerOptions, runResolverPins } from "mailwoman/eval-harness/gauntlet/run"
import { describe, expect, it } from "vitest"

describe("resolverPinDeps — the pin set → geocodeAddress deps", () => {
	it("maps an ON pin onto the geocode dep of the same name", () => {
		expect(resolverPinDeps({ postcodeCountryCoherence: true })).toEqual({ postcodeCountryCoherence: true })
	})

	it("maps an explicit OFF pin, so a caller can force the library default's opposite", () => {
		expect(resolverPinDeps({ postcodeCountryCoherence: false })).toEqual({ postcodeCountryCoherence: false })
	})

	it("emits NOTHING for an absent pin set — production defaults stay in force", () => {
		expect(resolverPinDeps(undefined)).toEqual({})
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

	it("says so when nothing is pinned — an unlabelled log is not evidence about a pin", () => {
		expect(describeResolverPins(undefined)).toBe("resolver pins: (none pinned — production defaults)")
	})
})

describe("runResolverPins — CLI options → pin set", () => {
	it("carries an ON pin", () => {
		expect(runResolverPins({ postcodeCountryCoherence: true })).toEqual({ postcodeCountryCoherence: true })
	})

	// The pin that carries evidence since the 2026-08-05 default-on flip: the ON pin now restates production,
	// so a run that means to grade the pre-promotion configuration has to be able to say OFF and be believed.
	it("carries an OFF pin", () => {
		expect(runResolverPins({ postcodeCountryCoherence: false })).toEqual({ postcodeCountryCoherence: false })
	})

	it("returns undefined when the flag was never set", () => {
		expect(runResolverPins({})).toBeUndefined()
		expect(runResolverPins({ candidate: "./out/model.onnx" })).toBeUndefined()
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
	// The pin carries an artifact, so `resolverPinDeps` — which is pure — cannot see it. That is exactly how a pinned
	// run printed as "production defaults" on its first outing while quietly changing the board by one case.
	it("is announced even though resolverPinDeps cannot carry it", () => {
		expect(describeResolverPins({ gazetteerPrior: true })).toContain("gazetteerPrior=ON")
	})

	it("still reports production defaults when nothing is pinned", () => {
		expect(describeResolverPins(undefined)).toContain("none pinned")
	})

	it("announces alongside a boolean pin rather than replacing it", () => {
		const described = describeResolverPins({ gazetteerPrior: true, postcodeCountryCoherence: false })

		expect(described).toContain("gazetteerPrior=ON")
		expect(described).toContain("postcodeCountryCoherence=OFF")
	})

	it("announces an OFF pin, now that the production default is ON", () => {
		// Promoted default-on 2026-08-16, which makes `false` a real pin rather than the incumbent behaviour.
		expect(describeResolverPins({ gazetteerPrior: false })).toContain("gazetteerPrior=OFF")
	})

	it("prints nothing for the pin when it is unset, so 'no flag' still reads as production", () => {
		expect(describeResolverPins({ postcodeCountryCoherence: false })).not.toContain("gazetteerPrior")
	})
})

describe("runResolverPins forwards BOTH halves of the prior tri-state", () => {
	// The bug this pins: while the prior was opt-in, the builder forwarded only the truthy half
	// (`...(options.gazetteerPrior ? { gazetteerPrior: true } : {})`). After the default-on flip that silently
	// discarded `--gazetteer-prior-off`, so the OFF arm graded the DEFAULT configuration while its log said
	// `gazetteerPrior=OFF` — the exact "two pin logs that differ only in a flag someone typed" failure the pins
	// line exists to prevent. Caught by running the off arm and reading the board, not by a test.
	it("keeps an explicit false", () => {
		expect(runResolverPins({ gazetteerPrior: false })).toEqual({ gazetteerPrior: false })
	})

	it("keeps an explicit true", () => {
		expect(runResolverPins({ gazetteerPrior: true })).toEqual({ gazetteerPrior: true })
	})

	it("leaves an unset pin absent, not pinned", () => {
		expect(runResolverPins({})).toBeUndefined()
	})
})

describe("adminContainmentRerank pin (#1717 stage 2)", () => {
	// Two-sided from day one — the #1706 class: a one-sided forwarding compiles, passes every other test, and
	// produces an OFF-labelled log that graded the default arm.
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
