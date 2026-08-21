/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ARM_SPEC_SCHEMA, armLabel, normalizeArmSpec } from "@mailwoman/dev-mcp/arms"
import { describe, expect, it } from "vitest"

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

	it("takes an oracle arm by provider", () => {
		expect(normalizeArmSpec({ kind: "oracle", provider: "census" }, "b")).toEqual({
			kind: "oracle",
			provider: "census",
		})
	})

	it("refuses an unknown oracle provider rather than reaching for a default one", () => {
		expect(() => normalizeArmSpec({ kind: "oracle", provider: "here" }, "b")).toThrow(/must be one of/)
	})

	it("takes a recorded arm and defaults which side it replays", () => {
		expect(normalizeArmSpec({ kind: "recorded", run_id: "abc" }, "b")).toEqual({
			kind: "recorded",
			runID: "abc",
			arm: "mailwoman",
		})
	})

	it("refuses a recorded arm with no run_id", () => {
		expect(() => normalizeArmSpec({ kind: "recorded" }, "b")).toThrow(/needs a `run_id`/)
	})

	it("refuses an unknown kind rather than running the default configuration", () => {
		// The hazard this closes: with the bare-config shorthand in the union, an unhandled `kind` parses as an EMPTY
		// mailwoman config. The caller would get a full comparison against the production defaults and no signal at all
		// that the arm they asked for was never consulted.
		expect(() => normalizeArmSpec({ kind: "whatever" }, "b")).toThrow(/unknown kind/)
	})
})

describe("ARM_SPEC_SCHEMA", () => {
	it("keeps each kind's discriminator intact rather than letting the shorthand swallow it", () => {
		// Order-dependent: the bare-config branch accepts any object and strips unknown keys, so if it matched first
		// these would parse to `{}` and the caller would silently get the production defaults on both sides.
		expect(ARM_SPEC_SCHEMA.parse({ kind: "oracle", provider: "census" })).toMatchObject({ kind: "oracle" })
		expect(ARM_SPEC_SCHEMA.parse({ kind: "recorded", run_id: "abc" })).toMatchObject({ kind: "recorded" })
	})

	it("still accepts a bare config", () => {
		expect(ARM_SPEC_SCHEMA.parse({ locale: "fr-FR" })).toMatchObject({ locale: "fr-FR" })
	})
})

describe("armLabel", () => {
	it("names what each arm actually is, so two labels in one result cannot collide", () => {
		expect(armLabel({ kind: "mailwoman", config: {} })).toBe("mailwoman")
		expect(armLabel({ kind: "external", engine: "photon", endpoint: "http://127.0.0.1:2323" })).toBe("photon")
		expect(armLabel({ kind: "oracle", provider: "google" })).toBe("oracle:google")
		expect(armLabel({ kind: "recorded", runID: "abc", arm: "mailwoman" })).toBe("recorded:abc/mailwoman")
	})
})
