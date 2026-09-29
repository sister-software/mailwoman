/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	artifactSetWarnings,
	assertComparableField,
	VariableIsolation,
	checkConfounds,
	worktreePairReading,
} from "@mailwoman/dev-mcp/confound"
import { describe, expect, it } from "vitest"

describe("checkConfounds", () => {
	it("reports clean isolation when exactly the declared key moved", () => {
		const reading = checkConfounds(
			{ locale: "en-US", gazetteerPrior: false },
			{ locale: "en-US", gazetteerPrior: true },
			["gazetteerPrior"]
		)

		expect(reading.variable_isolation).toBe(VariableIsolation.Clean)
		expect(reading.variable_effective).toEqual(["gazetteerPrior"])
		expect(reading.warnings).toHaveLength(0)
	})

	it("catches the documented backend/country-scope confound", () => {
		// resolver-backends.mdx: under --country-scope auto, switching backend also switches country scoping.
		// Its table shows the same Paris address landing in Texas or France, depending on which variable moved.
		const reading = checkConfounds(
			{ backend: "fts", countryScope: "locale" },
			{ backend: "candidate", countryScope: "none" },
			["backend"]
		)

		expect(reading.variable_isolation).toBe(VariableIsolation.Ambiguous)
		expect(reading.moved_but_undeclared).toEqual(["countryScope"])
		expect(reading.warnings[0]).toContain("countryScope")
	})

	it("warns rather than refusing, so the comparison still returns", () => {
		// The decided behaviour (spec §6.3).
		// A refusal an agent cannot override is a reason to bypass the tool.
		expect(() => checkConfounds({ a: 1 }, { a: 2, b: 3 }, ["a"])).not.toThrow()
	})

	it("flags a declared key that did not actually move", () => {
		const reading = checkConfounds({ locale: "en-US" }, { locale: "en-US" }, ["locale"])

		expect(reading.declared_but_unmoved).toEqual(["locale"])
	})

	it("names identical arms as such rather than calling it clean", () => {
		const reading = checkConfounds({ locale: "en-US" }, { locale: "en-US" }, ["locale"])

		expect(reading.variable_isolation).toBe(VariableIsolation.NoVariable)
		expect(reading.warnings.join(" ")).toContain("identical effective configurations")
	})

	it("compares by value, so an unchanged nested object is not a difference", () => {
		const reading = checkConfounds({ opts: { x: 1 } }, { opts: { x: 1 } }, [])

		expect(reading.variable_effective).toHaveLength(0)
	})
})

describe("assertComparableField", () => {
	it("refuses the cross-backend score fields", () => {
		// Refusal rather than a warning: within either backend the wrong answers' range sits inside
		// the correct answers' range with a higher mean, so no threshold on it means anything.
		expect(() => assertComparableField("resolver_score")).toThrow(/not comparable/)
		expect(() => assertComparableField("prominence")).toThrow(/not comparable/)
	})

	it("allows an ordinary field", () => {
		expect(() => assertComparableField("lat")).not.toThrow()
	})
})

describe("the declared vocabulary", () => {
	it("grades a correctly-declared single change CLEAN, not ambiguous", () => {
		// The tool schema documents `variable: ["place_country"]`.
		// The effective configs differ at `placeCountry`.
		// Compared raw, the same change was counted twice under two spellings —
		// once as declared-but-unmoved, once as moved-but-undeclared — so every honest
		// single-change comparison reported attribution ambiguous.
		const reading = checkConfounds({ placeCountry: true }, { placeCountry: false }, ["place_country"])

		expect(reading.variable_isolation).toBe("clean")
		expect(reading.moved_but_undeclared).toEqual([])
		expect(reading.declared_but_unmoved).toEqual([])
	})

	it("still reports the caller's own spelling back to them", () => {
		// Filtered on the translated key, reported in the spelling they typed —
		// naming a key they never wrote is its own small confusion.
		const reading = checkConfounds({ placeCountry: true }, { placeCountry: true }, ["place_country"])

		expect(reading.declared_but_unmoved).toEqual(["place_country"])
	})

	it("still catches a genuine undeclared difference", () => {
		const reading = checkConfounds(
			{ placeCountry: true, countryScope: "auto" },
			{ placeCountry: false, countryScope: "none" },
			["place_country"]
		)

		expect(reading.variable_isolation).toBe("ambiguous")
		expect(reading.moved_but_undeclared).toEqual(["countryScope"])
	})
})

describe("worktreePairReading", () => {
	it("states the measured tree delta instead of the unbounded cross-engine wording", () => {
		const reading = worktreePairReading("worktree:main", "worktree:fix", ["capital_tier"], {
			commits: 1,
			files: 9,
			range: "3e6a3bf75041 643c92b7787b",
		})

		expect(reading.variable_isolation).toBe("cross_engine")
		expect(reading.warnings).toHaveLength(1)
		expect(reading.warnings[0]).toContain("1 commit touching 9 files")
		expect(reading.warnings[0]).toContain("git diff 3e6a3bf75041 643c92b7787b")
		expect(reading.warnings[0]).not.toContain("different geocoders")
	})

	it("falls back to the unbounded wording when the delta could not be measured", () => {
		const reading = worktreePairReading("worktree:main", "worktree:WORKTREE", [], null)

		expect(reading.warnings[0]).toContain("different geocoders over different indexes")
	})
})

describe("artifactSetWarnings", () => {
	const locale = (name: string, artifacts: Array<[string, string | null]>) => ({
		locale: name,
		artifacts: artifacts.map(([artifact, path]) => ({
			name: artifact,
			path,
			origin: path === null ? null : "cache",
		})),
	})

	it("stays silent when both arms resolved the same artifact names", () => {
		const armA = {
			artifacts_by_locale: [
				locale("en-US", [
					["model.onnx", "/a/model.onnx"],
					["fst-en-us.bin", "/a/fst.bin"],
				]),
			],
		}

		const armB = {
			artifacts_by_locale: [
				locale("en-US", [
					["model.onnx", "/b/model.onnx"],
					["fst-en-us.bin", "/b/fst.bin"],
				]),
			],
		}

		expect(artifactSetWarnings(armA, armB)).toEqual([])
	})

	it("names the channels one arm fed that the other left unresolved", () => {
		// The shape that made 24 of 1029 board rows differ under byte-identical model graphs
		// (#2396): the workspace rung contained 13 of its 15 declared artifacts.
		// The two FST channels therefore resolved on one side only.
		const workspaceArm = {
			artifacts_by_locale: [
				locale("en-US", [
					["model.onnx", "/repo/model.onnx"],
					["fst-en-us.bin", null],
					["fst-street-morphology.bin", null],
				]),
			],
		}

		const cacheArm = {
			artifacts_by_locale: [
				locale("en-US", [
					["model.onnx", "/cache/model.onnx"],
					["fst-en-us.bin", "/cache/fst-en-us.bin"],
					["fst-street-morphology.bin", "/cache/fst-street-morphology.bin"],
				]),
			],
		}

		const warnings = artifactSetWarnings(workspaceArm, cacheArm)

		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("en-US: arm B fed fst-en-us.bin, fst-street-morphology.bin")
		expect(warnings[0]).toContain("stage-weights-cache")
	})

	it("treats an artifact absent from both arms as agreement rather than divergence", () => {
		// Every routed arm gives `crf-transitions.json` a null path, because CRF is inference-only.
		const armA = { artifacts_by_locale: [locale("de-DE", [["crf-transitions.json", null]])] }
		const armB = { artifacts_by_locale: [locale("de-DE", [["crf-transitions.json", null]])] }

		expect(artifactSetWarnings(armA, armB)).toEqual([])
	})

	it("reports a locale only one arm routed", () => {
		const armA = { artifacts_by_locale: [locale("en-US", [["model.onnx", "/a/model.onnx"]])] }

		const armB = {
			artifacts_by_locale: [
				locale("en-US", [["model.onnx", "/b/model.onnx"]]),
				locale("de-DE", [["model.onnx", "/b/model.onnx"]]),
			],
		}

		expect(artifactSetWarnings(armA, armB)[0]).toContain("de-DE is routed by arm B alone")
	})

	it("states no artifact difference for an arm whose provenance records none", () => {
		// External geocoders and oracles have no routed artifact record.
		// Runs recorded before the record existed have no such record either.
		const external = { engine: "pelias", endpoint: "http://127.0.0.1:4000" }
		const routed = { artifacts_by_locale: [locale("en-US", [["model.onnx", "/a/model.onnx"]])] }

		expect(artifactSetWarnings(external, routed)).toEqual([])
		expect(artifactSetWarnings(routed, external)).toEqual([])
	})
})
