/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the Gauntlet's RESOLVER-lever pin (#42, 2026-08-05) — the plumbing that lets the gate grade a resolver
 *   configuration, not just a model.
 *
 *   These assert a mapping, deliberately: `run options → layer options → geocode deps`. The gate itself needs the ~9 GB
 *   database set and a loaded ONNX, so a test that ran it would be an integration run, not a check — and the failure mode
 *   this surface exists to prevent is silent. A dropped pin does not throw; it produces a gate log identical to the
 *   unpinned one, which reads exactly like "the lever changed nothing". Every hop is therefore pinned here.
 */

import { describeResolverLevers, resolverLeverDeps } from "mailwoman/eval-harness/gauntlet/harness"
import { layerDepsOptions } from "mailwoman/eval-harness/gauntlet/regression"
import { runLayerOptions, runResolverLevers } from "mailwoman/eval-harness/gauntlet/run"
import { describe, expect, it } from "vitest"

describe("resolverLeverDeps — the lever set → geocodeAddress deps", () => {
	it("maps an ON pin onto the geocode dep of the same name", () => {
		expect(resolverLeverDeps({ postcodeCountryCoherence: true })).toEqual({ postcodeCountryCoherence: true })
	})

	it("maps an explicit OFF pin, so a caller can force the library default's opposite", () => {
		expect(resolverLeverDeps({ postcodeCountryCoherence: false })).toEqual({ postcodeCountryCoherence: false })
	})

	it("emits NOTHING for an absent lever set — production defaults stay in force", () => {
		expect(resolverLeverDeps(undefined)).toEqual({})
		expect(resolverLeverDeps({})).toEqual({})
	})
})

describe("describeResolverLevers — the run banner", () => {
	it("names the pinned lever and its state", () => {
		expect(describeResolverLevers({ postcodeCountryCoherence: true })).toBe(
			"resolver levers: postcodeCountryCoherence=ON"
		)

		expect(describeResolverLevers({ postcodeCountryCoherence: false })).toBe(
			"resolver levers: postcodeCountryCoherence=OFF"
		)
	})

	it("says so when nothing is pinned — an unlabelled log is not evidence about a lever", () => {
		expect(describeResolverLevers(undefined)).toBe("resolver levers: (none pinned — production defaults)")
	})
})

describe("runResolverLevers — CLI options → lever set", () => {
	it("carries an ON pin", () => {
		expect(runResolverLevers({ postcodeCountryCoherence: true })).toEqual({ postcodeCountryCoherence: true })
	})

	// The pin that carries evidence since the 2026-08-05 default-on flip: the ON pin now restates production,
	// so a run that means to grade the pre-promotion configuration has to be able to say OFF and be believed.
	it("carries an OFF pin", () => {
		expect(runResolverLevers({ postcodeCountryCoherence: false })).toEqual({ postcodeCountryCoherence: false })
	})

	it("returns undefined when the flag was never set", () => {
		expect(runResolverLevers({})).toBeUndefined()
		expect(runResolverLevers({ candidate: "./out/model.onnx" })).toBeUndefined()
	})
})

describe("runLayerOptions — the pin reaches every layer", () => {
	it("carries the levers alongside the model selection", () => {
		const options = runLayerOptions({ candidate: "./out/v9/model.onnx", postcodeCountryCoherence: true })

		expect(options.model).toBe("./out/v9/model.onnx")
		expect(options.levers).toEqual({ postcodeCountryCoherence: true })
	})

	it("omits `levers` entirely when unpinned", () => {
		expect(runLayerOptions({}).levers).toBeUndefined()
	})
})

describe("layerDepsOptions — layer options → buildGauntletDeps argument", () => {
	it("carries the pin on the shipped-default ladder (no candidate model)", () => {
		expect(layerDepsOptions({ levers: { postcodeCountryCoherence: true } })).toEqual({
			levers: { postcodeCountryCoherence: true },
		})
	})

	it("carries the pin on the modelPath ladder", () => {
		const deps = layerDepsOptions({ model: "./out/v9/model.onnx", levers: { postcodeCountryCoherence: true } })

		expect(deps).toEqual({ modelPath: "./out/v9/model.onnx", levers: { postcodeCountryCoherence: true } })
	})

	it("carries the pin on the tokenizer-splice ladder", () => {
		const deps = layerDepsOptions({
			model: "./out/v9/model.onnx",
			tokenizer: "./out/v9/tokenizer.model",
			card: "./out/v9/model-card.json",
			levers: { postcodeCountryCoherence: true },
		})

		expect(deps).toEqual({
			modelPath: "./out/v9/model.onnx",
			tokenizerPath: "./out/v9/tokenizer.model",
			modelCardPath: "./out/v9/model-card.json",
			levers: { postcodeCountryCoherence: true },
		})
	})

	it("carries the pin on the weights-cache ladder, which takes precedence over the model", () => {
		const deps = layerDepsOptions({
			weightsCacheRoot: "/tmp/cache",
			model: "./out/v9/model.onnx",
			levers: { postcodeCountryCoherence: true },
		})

		expect(deps).toEqual({ weightsCacheRoot: "/tmp/cache", levers: { postcodeCountryCoherence: true } })
	})

	it("leaves the argument lever-free when unpinned, on every ladder", () => {
		expect(layerDepsOptions({})).toEqual({})
		expect(layerDepsOptions({ model: "./out/v9/model.onnx" })).toEqual({ modelPath: "./out/v9/model.onnx" })
		expect(layerDepsOptions({ weightsCacheRoot: "/tmp/cache" })).toEqual({ weightsCacheRoot: "/tmp/cache" })
	})
})

describe("end-to-end plumbing: a CLI flag becomes a geocode dep", () => {
	it("survives every hop from run options to the resolve", () => {
		const deps = resolverLeverDeps(layerDepsOptions(runLayerOptions({ postcodeCountryCoherence: true })).levers)

		expect(deps).toEqual({ postcodeCountryCoherence: true })
	})

	it("survives every hop for the OFF pin too", () => {
		const deps = resolverLeverDeps(layerDepsOptions(runLayerOptions({ postcodeCountryCoherence: false })).levers)

		expect(deps).toEqual({ postcodeCountryCoherence: false })
	})

	it("stays empty across the same hops when the flag is absent", () => {
		expect(resolverLeverDeps(layerDepsOptions(runLayerOptions({})).levers)).toEqual({})
	})
})

describe("gazetteerPrior lever (#1497)", () => {
	// The pin carries an artifact, so `resolverLeverDeps` — which is pure — cannot see it. That is exactly how a pinned
	// run printed as "production defaults" on its first outing while quietly changing the board by one case.
	it("is announced even though resolverLeverDeps cannot carry it", () => {
		expect(describeResolverLevers({ gazetteerPrior: true })).toContain("gazetteerPrior=ON")
	})

	it("still reports production defaults when nothing is pinned", () => {
		expect(describeResolverLevers(undefined)).toContain("none pinned")
	})

	it("announces alongside a boolean pin rather than replacing it", () => {
		const described = describeResolverLevers({ gazetteerPrior: true, postcodeCountryCoherence: false })

		expect(described).toContain("gazetteerPrior=ON")
		expect(described).toContain("postcodeCountryCoherence=OFF")
	})

	it("announces an OFF pin, now that the production default is ON", () => {
		// Promoted default-on 2026-08-16, which makes `false` a real pin rather than the incumbent behaviour.
		expect(describeResolverLevers({ gazetteerPrior: false })).toContain("gazetteerPrior=OFF")
	})

	it("prints nothing for the lever when it is unset, so 'no flag' still reads as production", () => {
		expect(describeResolverLevers({ postcodeCountryCoherence: false })).not.toContain("gazetteerPrior")
	})
})

describe("runResolverLevers forwards BOTH halves of the prior tri-state", () => {
	// The bug this pins: while the prior was opt-in, the builder forwarded only the truthy half
	// (`...(options.gazetteerPrior ? { gazetteerPrior: true } : {})`). After the default-on flip that silently
	// discarded `--gazetteer-prior-off`, so the OFF arm graded the DEFAULT configuration while its log said
	// `gazetteerPrior=OFF` — the exact "two gate logs that differ only in a flag someone typed" failure the levers
	// line exists to prevent. Caught by running the off arm and reading the board, not by a test.
	it("keeps an explicit false", () => {
		expect(runResolverLevers({ gazetteerPrior: false })).toEqual({ gazetteerPrior: false })
	})

	it("keeps an explicit true", () => {
		expect(runResolverLevers({ gazetteerPrior: true })).toEqual({ gazetteerPrior: true })
	})

	it("leaves an unset lever absent, not pinned", () => {
		expect(runResolverLevers({})).toBeUndefined()
	})
})

describe("adminContainmentRerank lever (#1717 stage 2)", () => {
	// Two-sided from day one — the #1706 class: a one-sided forwarding compiles, passes every other test, and
	// produces an OFF-labelled log that graded the default arm.
	it("maps the ON pin onto the geocode dep of the same name", () => {
		expect(resolverLeverDeps({ adminContainmentRerank: true })).toEqual({ adminContainmentRerank: true })
	})

	it("maps the explicit OFF pin — grading the production default under an OFF label must be true", () => {
		expect(resolverLeverDeps({ adminContainmentRerank: false })).toEqual({ adminContainmentRerank: false })
	})

	it("is announced in the run banner, both ways", () => {
		expect(describeResolverLevers({ adminContainmentRerank: true })).toContain("adminContainmentRerank=ON")
		expect(describeResolverLevers({ adminContainmentRerank: false })).toContain("adminContainmentRerank=OFF")
	})

	it("prints nothing when unset, so 'no flag' still reads as production", () => {
		expect(describeResolverLevers({ postcodeCountryCoherence: false })).not.toContain("adminContainmentRerank")
	})

	it("survives every hop from run options to the resolve, both directions", () => {
		expect(resolverLeverDeps(layerDepsOptions(runLayerOptions({ adminContainmentRerank: true })).levers)).toEqual({
			adminContainmentRerank: true,
		})

		expect(resolverLeverDeps(layerDepsOptions(runLayerOptions({ adminContainmentRerank: false })).levers)).toEqual({
			adminContainmentRerank: false,
		})
	})

	it("composes with a sibling pin rather than replacing it", () => {
		expect(resolverLeverDeps({ adminContainmentRerank: true, postcodeCountryCoherence: false })).toEqual({
			adminContainmentRerank: true,
			postcodeCountryCoherence: false,
		})
	})
})
