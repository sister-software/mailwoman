import { buildRoutedMailwomanArm, type RoutedMailwomanArmDeps } from "@mailwoman/dev-mcp/routed-mailwoman-arm"
import type { ResolvedWeights } from "@mailwoman/neural/weights"
import type { GauntletDeps, GauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import { describe, expect, it, vi } from "vitest"

// `tier` carries a real value because `toGauntletResult` passes `resolution_tier` straight through and that field is
// non-nullable — a null here modelled a row production cannot produce, which is what the assertion through `unknown`
// was hiding. Everything else stays absent: this stands for an arm that answered without resolving anything.
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
		modelCardPath: `${packageDir}/model-card.json`,
		source: `cache:@mailwoman/neural-weights-${locale.toLowerCase()}`,
		packageDir,
		artifacts: [
			{ name: "model.onnx", path: model, origin: "base" },
			{ name: "model-card.json", path: `${packageDir}/model-card.json`, origin: "package" },
		],
	}
}

function fakeDeps(overrides: Partial<RoutedMailwomanArmDeps> = {}): RoutedMailwomanArmDeps {
	// Typed throwing stubs, not a cast: the arm under test drives `runOne`, so the gauntlet's own
	// geocode/diagnoseParse must never be reached — and reaching one should fail the test loudly.
	const gauntlet: GauntletDeps = {
		geocode: vi.fn(async () => {
			throw new Error("routed-arm tests drive runOne, never deps.geocode")
		}),
		geocodeTraced: vi.fn(async () => {
			throw new Error("routed-arm tests drive runOne, never deps.geocodeTraced")
		}),
		diagnoseParse: vi.fn(async () => {
			throw new Error("routed-arm tests drive runOne, never deps.diagnoseParse")
		}),
		[Symbol.dispose]: vi.fn(),
	}

	return {
		buildDeps: vi.fn(async () => gauntlet),
		resolveWeights: vi.fn(({ locale }) => resolved(locale)),
		realpath: (path) => path,
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
			levers: { gazetteerPrior: false },
		})

		expect(deps.runOne).toHaveBeenCalledWith("10 Downing Street, London SW1A 2AA", expect.anything(), {
			defaultCountry: "US",
			caseCountry: "GB",
		})
	})

	it("forwards every SUPPORTED config key into buildDeps — a key accepted but dropped grades the wrong configuration silently", async () => {
		// The #1882 incident this pins: `candidate_db` joined the SUPPORTED list without joining this
		// spread, so both arms of a staged-artifact comparison ran the LIVE artifact and reported
		// 0 of 649 rows differed — a zero indistinguishable from a real no-effect.
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
			levers: {
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
			resolveWeights: ({ locale }) => ({
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
			resolveWeights: ({ locale }) =>
				locale === "en-GB"
					? resolved(locale, "/candidate/node_modules/@mailwoman/neural-weights-en-gb/model.onnx")
					: resolved(locale),
		})

		await expect(
			buildRoutedMailwomanArm({ weights_cache: "/candidate" }, [{ id: "gb", input: "SW1A 1AA", country: "GB" }], deps)
		).rejects.toThrow(/must share the en-US model/)
	})
})
