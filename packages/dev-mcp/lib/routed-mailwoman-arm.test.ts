import type { ResolvedWeights } from "@mailwoman/neural/weights"
import type { GauntletDeps, GauntletResult } from "mailwoman/tools/eval-harness/gauntlet/harness"
import { resolvePathBuilder } from "path-ts"
import { describe, expect, it, vi } from "vitest"

import { buildRoutedMailwomanArm, type RoutedMailwomanArmDeps } from "#routed-mailwoman-arm"

// `tier` has a real value because `toGauntletResult` passes `resolution_tier`
// straight through and that field is non-nullable.
// Everything else stays absent: this stands for an arm that answered without resolving anything.
const EMPTY_RESULT = {
	components: {},
	lat: null,
	lon: null,
	tier: "admin",
	locality: null,
	region: null,
	country: null,
	postcode: null,
	house_number: null,
	street: null,
	venue: null,
	dependent_locality: null,
	unit: null,
	postcode_country_scope: null,
	hierarchy: [],
} as GauntletResult

function resolved(
	locale: string,
	model = "/candidate/node_modules/@mailwoman/neural-weights-en-us/model.onnx"
): ResolvedWeights {
	const packageDir = `/candidate/node_modules/@mailwoman/neural-weights-${locale.toLowerCase()}`

	return {
		modelPath: model,
		tokenizerPath: "/candidate/node_modules/@mailwoman/neural-weights-en-us/tokenizer.model",
		encoder: { kind: "sentencepiece" },
		modelCardPath: `${packageDir}/model-card.json`,
		source: `cache:@mailwoman/neural-weights-${locale.toLowerCase()}`,
		packageDir: resolvePathBuilder(packageDir),
		artifacts: [
			{ name: "model.onnx", path: model, origin: "base" },
			{ name: "model-card.json", path: `${packageDir}/model-card.json`, origin: "package" },
		],
	}
}

function fakeDeps(overrides: Partial<RoutedMailwomanArmDeps> = {}): RoutedMailwomanArmDeps {
	// The arm under test drives `runOne`, so the gauntlet's own geocode/diagnoseParse must not run.
	// Typed throwing stubs make the test fail if either method runs.
	const gauntlet: GauntletDeps = {
		geocode: vi.fn(async () => {
			throw new Error("routed-arm tests drive runOne, never deps.geocode")
		}),
		geocodeTraced: vi.fn(async () => {
			throw new Error("routed-arm tests drive runOne, never deps.geocodeTraced")
		}),
		// Every overlay loaded.
		// The arm under test makes no promote suggestion.
		// Therefore, a truthful `false` keeps the stub from implying a degraded instrument.
		gradedBaseOnly: vi.fn(() => false),
		diagnoseParse: vi.fn(async () => {
			throw new Error("routed-arm tests drive runOne, never deps.diagnoseParse")
		}),
		[Symbol.dispose]: vi.fn(),
	}

	return {
		buildDeps: vi.fn(async () => gauntlet),
		resolveWeights: vi.fn(async ({ locale }) => resolved(locale)),
		realpath: async (path) => path.toString(),
		// The default digest is the path, so a test that cares about bytes overrides it
		// and every other test reads a stable value without writing a file.
		sha256File: async (path) => `digest-of:${path.toString()}`,
		runOne: vi.fn(async () => EMPTY_RESULT),
		...overrides,
	}
}

describe("buildRoutedMailwomanArm", () => {
	it("preflights every selected route and exposes its artifact provenance", async () => {
		const deps = fakeDeps()

		const arm = await buildRoutedMailwomanArm(
			{ weights_cache: "/candidate" },
			[
				{ id: "gb", input: "SW1A 1AA", country: "GB" },
				{ id: "de", input: "99423 Weimar", country: "DE" },
				{ id: "us", input: "90210", country: "US" },
			],
			deps
		)

		expect(deps.resolveWeights).toHaveBeenCalledTimes(3)
		expect(deps.resolveWeights).toHaveBeenCalledWith({ locale: "en-US", cacheRoot: "/candidate" })
		expect(deps.resolveWeights).toHaveBeenCalledWith({ locale: "en-GB", cacheRoot: "/candidate" })
		expect(deps.resolveWeights).toHaveBeenCalledWith({ locale: "de-DE", cacheRoot: "/candidate" })
		expect(arm.provenance.routes).toEqual({ GB: "en-GB", DE: "de-DE", US: "en-US" })
		expect(arm.provenance.artifacts_by_locale).toHaveLength(3)
	})

	it("records a digest for every artifact it resolved, so a comparison reads the bytes", async () => {
		const deps = fakeDeps()

		const arm = await buildRoutedMailwomanArm(
			{ weights_cache: "/candidate" },
			[{ id: "us", input: "90210", country: "US" }],
			deps
		)

		const artifacts = arm.provenance.artifacts_by_locale[0]!.artifacts
		const card = artifacts.find((artifact) => artifact.name === "model-card.json")!

		expect(card.digest).toBe(`digest-of:${card.path}`)
		expect(artifacts.every((artifact) => (artifact.path === null) === (artifact.digest === null))).toBe(true)
	})

	it("digests one path once, so several locales sharing a base artifact read it a single time", async () => {
		// Every routed locale resolves the same en-US `model.onnx`, so a digest per
		// locale would read the shared bytes once per route.
		const seen: string[] = []

		const deps = fakeDeps({
			sha256File: async (path) => {
				seen.push(path.toString())

				return `digest-of:${path.toString()}`
			},
		})

		await buildRoutedMailwomanArm(
			{ weights_cache: "/candidate" },
			[
				{ id: "gb", input: "SW1A 1AA", country: "GB" },
				{ id: "de", input: "99423 Weimar", country: "DE" },
				{ id: "us", input: "90210", country: "US" },
			],
			deps
		)

		expect(seen).toHaveLength(new Set(seen).size)
	})

	it("forwards the row country as the Gauntlet route", async () => {
		const deps = fakeDeps()

		const arm = await buildRoutedMailwomanArm(
			{ weights_cache: "/candidate", default_country: "US", gazetteer_prior: false },
			[{ id: "gb", input: "10 Downing Street, London SW1A 2AA", country: "gb" }],
			deps
		)

		await arm.geocode({ id: "gb", input: "10 Downing Street, London SW1A 2AA", country: "gb" })

		expect(deps.buildDeps).toHaveBeenCalledWith({
			weightsCacheRoot: "/candidate",
			pins: { gazetteerPrior: false },
		})

		expect(deps.runOne).toHaveBeenCalledWith("10 Downing Street, London SW1A 2AA", expect.anything(), {
			defaultCountry: "US",
			caseCountry: "GB",
		})
	})

	it("forwards every SUPPORTED config key into buildDeps — a key accepted but dropped grades the wrong configuration silently", async () => {
		const deps = fakeDeps()

		await buildRoutedMailwomanArm(
			{
				weights_cache: "/candidate",
				candidate_db: "/staging/candidate-variant.db",
				postcode_country_coherence: false,
				gazetteer_prior: false,
				admin_containment_rerank: true,
				capital_tier: true,
				variant_alias_exemption: true,
			},
			[{ id: "us", input: "1 Main St", country: "us" }],
			deps
		)

		expect(deps.buildDeps).toHaveBeenCalledWith({
			weightsCacheRoot: "/candidate",
			candidateDB: "/staging/candidate-variant.db",
			pins: {
				postcodeCountryCoherence: false,
				gazetteerPrior: false,
				adminContainmentRerank: true,
				capitalTier: true,
				variantAliasExemption: true,
			},
		})
	})

	it("prefers the board's runtime route over its truth country", async () => {
		const deps = fakeDeps()
		const row = { id: "route", input: "Douglas, Isle of Man", country: "GB", routeCountry: "IM" }
		const arm = await buildRoutedMailwomanArm({ weights_cache: "/candidate" }, [row], deps)

		await arm.geocode(row)

		expect(arm.provenance.routes).toEqual({ IM: "en-US" })
		expect(deps.runOne).toHaveBeenCalledWith(row.input, expect.anything(), { caseCountry: "IM" })
	})

	it("refuses EngineConfig fields the Gauntlet cannot honor", async () => {
		await expect(
			buildRoutedMailwomanArm({ weights_cache: "/candidate", country_scope: "locale" }, [], fakeDeps())
		).rejects.toThrow(/country_scope/)
	})

	it("refuses an overlay artifact that escapes the candidate cache", async () => {
		const deps = fakeDeps({
			resolveWeights: async ({ locale }) => ({
				...resolved(locale),
				artifacts: [{ name: "pair-index-gb.bin", path: "/installed/pair-index-gb.bin", origin: "package" }],
			}),
		})

		await expect(
			buildRoutedMailwomanArm({ weights_cache: "/candidate" }, [{ id: "gb", input: "SW1A 1AA", country: "GB" }], deps)
		).rejects.toThrow(/outside weights_cache/)
	})

	it("refuses an overlay that resolves a model other than candidate en-US", async () => {
		const deps = fakeDeps({
			resolveWeights: async ({ locale }) =>
				locale === "en-GB"
					? resolved(locale, "/candidate/node_modules/@mailwoman/neural-weights-en-gb/model.onnx")
					: resolved(locale),
		})

		await expect(
			buildRoutedMailwomanArm({ weights_cache: "/candidate" }, [{ id: "gb", input: "SW1A 1AA", country: "GB" }], deps)
		).rejects.toThrow(/must share the en-US model/)
	})
})
