/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { ARM_SPEC_SCHEMA, armLabel, normalizeArmSpec } from "./arms.ts"

describe("normalizeArmSpec", () => {
	it("reads a bare config as a mailwoman arm, so the two-config call keeps working", () => {
		expect(normalizeArmSpec({ locale: "en-GB" }, "b")).toEqual({ kind: "mailwoman", config: { locale: "en-GB" } })
	})

	it("defaults an omitted arm to the production configuration rather than to nothing", () => {
		expect(normalizeArmSpec(undefined, "a")).toEqual({ kind: "mailwoman", config: {} })
	})

	it("takes an external arm with its endpoint and version", () => {
		expect(
			normalizeArmSpec({ kind: "external", engine: "pelias", endpoint: "http://127.0.0.1:4000", version: "1.0" }, "b")
		).toEqual({ kind: "external", engine: "pelias", endpoint: "http://127.0.0.1:4000", version: "1.0" })
	})

	it("refuses an external arm with no endpoint instead of inventing a default", () => {
		expect(() => normalizeArmSpec({ kind: "external", engine: "photon" }, "b")).toThrow(/needs an `endpoint`/)
	})

	it("refuses an unknown engine by name", () => {
		expect(() => normalizeArmSpec({ kind: "external", engine: "geocodeearth", endpoint: "http://x" }, "b")).toThrow(
			/must be one of/
		)
	})

	it("refuses the deferred kinds by name rather than running the default configuration", () => {
		// The hazard this closes: with the bare-config shorthand in the union, an unhandled `kind` parses as an EMPTY
		// mailwoman config. The caller would get a full comparison against the production defaults and no signal at all
		// that the oracle they asked for was never consulted.
		expect(() => normalizeArmSpec({ kind: "oracle", provider: "google" }, "b")).toThrow(/oracle arms are not/)
		expect(() => normalizeArmSpec({ kind: "recorded", run_id: "abc" }, "b")).toThrow(/run store/)
		expect(() => normalizeArmSpec({ kind: "whatever" }, "b")).toThrow(/unknown kind/)
	})
})

describe("ARM_SPEC_SCHEMA", () => {
	it("keeps a deferred kind's discriminator intact, so the refusal can see it", () => {
		// Order-dependent: the bare-config branch accepts any object and strips unknown keys, so if it matched first
		// this would parse to `{}` and the refusal above would never fire.
		expect(ARM_SPEC_SCHEMA.parse({ kind: "oracle", provider: "census" })).toMatchObject({ kind: "oracle" })
	})

	it("still accepts a bare config", () => {
		expect(ARM_SPEC_SCHEMA.parse({ locale: "fr-FR" })).toMatchObject({ locale: "fr-FR" })
	})
})

describe("armLabel", () => {
	it("names the engine for an external arm and mailwoman for ours", () => {
		expect(armLabel({ kind: "mailwoman", config: {} })).toBe("mailwoman")
		expect(armLabel({ kind: "external", engine: "photon", endpoint: "http://127.0.0.1:2323" })).toBe("photon")
	})
})
