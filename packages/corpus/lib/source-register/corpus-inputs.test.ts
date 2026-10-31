/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the join from corpus source ids to register rows, and the refusal every build and launch runs.
 *
 *   Two failures here are silent in opposite directions. A table that maps a source to a row whose decision is elected
 *   when the source reads another publication admits rows whose terms the project has not reviewed. A table that misses a source
 *   leaves it to the build to discover hours later. Both pass a type check, so the committed table is pinned here.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { beforeAll, describe, expect, it } from "vitest"

import { BUILTIN_ADAPTERS } from "#adapters"
import { CARRIED_SOURCES, RECIPE_SOURCES } from "#recipes/sources"
import { readAddressSourceRegister } from "#source-register"
import {
	auditCorpusSourceInputs,
	createSourceRightsAdmission,
	indexCorpusSourceInputs,
	readCorpusSourceInputs,
	SourceRightsError,
	sourceRightsGaps,
	type CorpusSourceInputs,
	type CorpusSourceInputsFile,
} from "#source-register/corpus-inputs"
import type { AddressSourceRegister } from "#source-register/types"

let register: AddressSourceRegister
let inputs: CorpusSourceInputs

beforeAll(async () => {
	register = await readAddressSourceRegister()
	inputs = await readCorpusSourceInputs(register)
})

describe("the committed corpus-source table", () => {
	it("maps every source an adapter, recipe or carried overlay can emit, under either spelling", () => {
		const declared = [
			...BUILTIN_ADAPTERS.map((adapter) => adapter.id),
			...RECIPE_SOURCES.flatMap((entry) => [entry.current, entry.retired]),
			...CARRIED_SOURCES,
		]

		expect(declared.filter((source) => !inputs.resolve(source))).toEqual([])
	})

	it.each(["v0.7.0-de-holdout.effective.json", "v0.7.2-address-systems.effective.json", "v0.7.7-no-ppd.json"])(
		"maps every source the committed training manifest %s records",
		async (name) => {
			const effective = await readLocalJSONFile<{ sources: Array<{ source: string }> }>(
				resolveModulePath(`@mailwoman/corpus/data/training-manifests/${name}`)
			)

			expect(effective.sources.map((entry) => entry.source).filter((source) => !inputs.resolve(source))).toEqual([])
		}
	)

	it("refuses an input whose license disagrees with the register row it names", () => {
		const file: CorpusSourceInputsFile = {
			sources: {
				ban: {
					inputs: [{ registerSource: "fr-property-building-1", license: "not-the-register-license", reads: "x" }],
				},
			},
		}

		expect(auditCorpusSourceInputs(file, register)).toEqual([
			expect.stringMatching(/records license.*for fr-property-building-1/),
		])
	})

	it("refuses an input naming a register row the register does not carry", () => {
		const file: CorpusSourceInputsFile = {
			sources: { invented: { inputs: [{ registerSource: "zz-nothing-1", license: "x", reads: "x" }] } },
		}

		expect(auditCorpusSourceInputs(file, register)).toEqual([expect.stringMatching(/does not carry/)])
	})
})

describe("sourceRightsGaps", () => {
	it("refuses rendered-gb on the refused Price Paid Data row, naming both operations", () => {
		const gaps = sourceRightsGaps("rendered-gb", inputs, register)
		const ppd = gaps.find((gap) => gap.registerSource === "gb-property-building-1")

		expect(ppd).toMatchObject({ state: "refused", missing: ["transform", "train"] })
		expect(ppd?.because).toMatch(/refused/)
	})

	it("refuses an unmapped source with no register row to name", () => {
		expect(sourceRightsGaps("never-mapped-source", inputs, register)).toEqual([
			expect.objectContaining({ source: "never-mapped-source", registerSource: null, missing: ["transform", "train"] }),
		])
	})

	it("admits a source whose every register row is elected and permits transform and train", () => {
		expect(sourceRightsGaps("ban-gp", inputs, register)).toEqual([])
		expect(sourceRightsGaps("rendered-ch", inputs, register)).toEqual([])
		expect(sourceRightsGaps("gb-os-open", inputs, register)).toEqual([])
	})

	it("reads rendered-gb-os-open's OS OpenData rows as permitted and never the Price Paid Data row", () => {
		const blocking = sourceRightsGaps("rendered-gb-os-open", inputs, register).map((gap) => gap.registerSource)

		const osRows = inputs.resolve("gb-os-open")!.mapping.inputs.map((input) => input.registerSource)

		expect(osRows.filter((row) => blocking.includes(row))).toEqual([])
		expect(blocking).not.toContain("gb-property-building-1")
	})

	it("resolves a retired spelling to the same entry as the current one", () => {
		expect(inputs.resolve("synth-german")?.id).toBe("rendered-de")
	})

	it("reads spliced-sub-venue against Price Paid Data only for the corpus built before #2637", () => {
		const today = sourceRightsGaps("spliced-sub-venue", inputs, register).map((gap) => gap.registerSource)

		const v072 = sourceRightsGaps("spliced-sub-venue", inputs, register, "v0.7.2-address-systems").map(
			(gap) => gap.registerSource
		)

		expect(today).not.toContain("gb-property-building-1")
		expect(v072).toContain("gb-property-building-1")
	})
})

describe("createSourceRightsAdmission", () => {
	it("throws naming the source, the register row and the missing permission", () => {
		const rights = createSourceRightsAdmission(register, inputs, { context: "test build" })

		expect(() => rights.admitAll(["ban", "rendered-gb"])).toThrow(SourceRightsError)

		expect(() => rights.admit("rendered-gb")).toThrow(
			/test build refuses 1 corpus source.*rendered-gb reads register source gb-property-building-1.*refused.*transform and train/s
		)
	})

	it("records a permitted build as shippable", () => {
		const rights = createSourceRightsAdmission(register, inputs, { context: "test build" })

		rights.admitAll(["ban", "ban-gp"])

		expect(rights.record()).toEqual({
			shippable: true,
			unshippable_reason: null,
			sources_checked: ["ban", "ban-gp"],
			gaps: [],
			unverified: [],
		})
	})

	it("admits under an override, logs each gap once and records the output as not shippable", () => {
		const lines: string[] = []

		const rights = createSourceRightsAdmission(register, inputs, {
			context: "test build",
			unshippableReason: "local experiment",
			log: (line) => lines.push(line),
		})

		rights.admit("rendered-gb")
		rights.admit("rendered-gb")

		const record = rights.record()

		expect(record.shippable).toBe(false)
		expect(record.unshippable_reason).toBe("local experiment")
		expect(lines.filter((line) => line.includes("gb-property-building-1"))).toHaveLength(1)
		expect(lines[0]).toMatch(/^UNSHIPPABLE test build: .*override: local experiment/)
	})

	it("judges a source by the inputs of the corpus version it is given, and names the override hint", () => {
		const today = createSourceRightsAdmission(register, inputs, { context: "test run" })

		expect(today.admit("spliced-sub-venue").map((gap) => gap.registerSource)).not.toContain("gb-property-building-1")

		const built = createSourceRightsAdmission(register, inputs, {
			context: "test run",
			corpusVersion: "v0.7.2-address-systems",
			overrideHint: "a config's data.unshippable_reason for a training run",
		})

		expect(() => built.admit("spliced-sub-venue")).toThrow(
			/gb-property-building-1.*--unshippable-reason <why> \(a config's data.unshippable_reason for a training run\)/s
		)
	})

	it("refuses a blank override, which says nothing about why", () => {
		expect(() =>
			createSourceRightsAdmission(register, inputs, { context: "test build", unshippableReason: " " })
		).toThrow(/must say why/)
	})

	it("refuses an input it cannot read unless the override marks the output", () => {
		const strict = createSourceRightsAdmission(register, inputs, { context: "test build" })

		expect(() => strict.admitUnverified("a base with unnamed files")).toThrow(/cannot check/)

		const lenient = createSourceRightsAdmission(register, inputs, {
			context: "test build",
			unshippableReason: "local experiment",
			log: () => undefined,
		})

		lenient.admitUnverified("a base with unnamed files")

		expect(lenient.record()).toMatchObject({ shippable: false, unverified: ["a base with unnamed files"] })
	})
})

describe("indexCorpusSourceInputs", () => {
	it("refuses two entries claiming one spelling", () => {
		expect(() =>
			indexCorpusSourceInputs({
				sources: { a: { inputs: [], aliases: ["shared"] }, b: { inputs: [], aliases: ["shared"] } },
			})
		).toThrow(/claimed by both a and b/)
	})
})
