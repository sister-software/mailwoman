/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the Gauntlet's RESOLVER-lever pin (#42, 2026-08-05) — the plumbing that lets the gate grade a resolver
 *   configuration, not just a model.
 *
 *   These assert a mapping, deliberately: `run options → layer options → geocode deps`. The gate itself needs the ~9 GB
 *   shard set and a loaded ONNX, so a test that ran it would be an integration run, not a check — and the failure mode
 *   this surface exists to prevent is silent. A dropped pin does not throw; it produces a gate log identical to the
 *   unpinned one, which reads exactly like "the lever changed nothing". Every hop is therefore pinned here.
 */

import { describe, expect, it } from "vitest"

import { describeResolverLevers, resolverLeverDeps } from "./harness.ts"
import { layerDepsOptions } from "./regression.ts"
import { runLayerOptions, runResolverLevers } from "./run.ts"

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

	it("stays empty across the same hops when the flag is absent", () => {
		expect(resolverLeverDeps(layerDepsOptions(runLayerOptions({})).levers)).toEqual({})
	})
})
