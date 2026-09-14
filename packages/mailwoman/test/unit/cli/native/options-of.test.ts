/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `OptionsOf` derives a command's options object from its own `spec`, and the router writes each flag's value to
 *   the property `optionPropertyName` derives. Those two derivations must agree exactly: a property spelled any
 *   other way is never written to, so the flag parses, validates, and does nothing.
 *
 *   Both halves are asserted against ONE list of expected property names — the type through `expectTypeOf`, the
 *   runtime through `optionPropertyName`. Either drifting breaks this file, which is the point; matched tables in
 *   two modules would not catch it, because they diverge at the points a constant cannot express.
 */

import { OPTION_INITIALISMS, optionPropertyName } from "@mailwoman/core/scripting/arguments"
import type { CommandSpec, OptionsOf } from "mailwoman/cli-native/spec"
import { describe, expect, expectTypeOf, test } from "vitest"

const fixture = {
	name: "probe",
	description: "Every option shape the derivation must carry.",
	options: {
		// `default` present: the router always supplies a value, so the property is required.
		locale: { type: "string", default: "en-US", description: "Weights package locale" },
		json: { type: "boolean", default: false, description: "Print JSON" },
		failing: { type: "number", default: 0, description: "List the first N disagreements" },
		// `required` without a default.
		needed: { type: "string", required: true, description: "Must be supplied" },
		// No default and not required: absent unless the user passes it.
		"weights-cache": { type: "string", description: "Candidate weights dir" },
		// Acronym segments, which is where a hand-written property most often disagreed.
		"resolve-db": { type: "string", description: "WOF admin databases" },
		"out-json": { type: "string", description: "Wall-time attribution JSON" },
		"gb-ids": { type: "string", description: "Two acronym segments in one flag" },
		// `choices` narrows the property past `string`.
		mode: { type: "string", choices: ["bulk", "featureserver"], description: "Fetch mode" },
		// `multiple` widens it to an array.
		tags: { type: "string", multiple: true, description: "Repeatable tag" },
	},
} as const satisfies CommandSpec

type Options = OptionsOf<typeof fixture>

/**
 * The property each flag binds to. The type and the runtime are both checked against this list rather than against each
 * other, so a test failure names which half moved.
 */
const EXPECTED_PROPERTIES = [
	"locale",
	"json",
	"failing",
	"needed",
	"weightsCache",
	"resolveDB",
	"outJSON",
	"gbIDs",
	"mode",
	"tags",
] as const

describe("OptionsOf", () => {
	test("derives the same property names the router writes to", () => {
		const derived = Object.keys(fixture.options).map((flag) => optionPropertyName(flag))

		expect(derived).toStrictEqual([...EXPECTED_PROPERTIES])
		expectTypeOf<keyof Options>().toEqualTypeOf<(typeof EXPECTED_PROPERTIES)[number]>()
	})

	test("a flag carrying a default or marked required is present", () => {
		expectTypeOf<Options["locale"]>().toEqualTypeOf<string>()
		expectTypeOf<Options["json"]>().toEqualTypeOf<boolean>()
		expectTypeOf<Options["failing"]>().toEqualTypeOf<number>()
		expectTypeOf<Options["needed"]>().toEqualTypeOf<string>()
	})

	test("a flag with neither is optional", () => {
		expectTypeOf<Options["weightsCache"]>().toEqualTypeOf<string | undefined>()
		expectTypeOf<Options["resolveDB"]>().toEqualTypeOf<string | undefined>()
		expectTypeOf<Options["outJSON"]>().toEqualTypeOf<string | undefined>()
	})

	test("choices narrow the property and multiple widens it", () => {
		expectTypeOf<Options["mode"]>().toEqualTypeOf<"bulk" | "featureserver" | undefined>()
		expectTypeOf<Options["tags"]>().toEqualTypeOf<string[] | undefined>()
	})

	test("a spec declaring no options derives an empty object", () => {
		const bare = { name: "bare", description: "No flags." } as const satisfies CommandSpec

		expectTypeOf<OptionsOf<typeof bare>>().toEqualTypeOf<Record<string, never>>()
	})

	test("every initialism capitalizes the whole segment", () => {
		for (const [segment, spelling] of Object.entries(OPTION_INITIALISMS)) {
			expect(optionPropertyName(`flag-${segment}`)).toBe(`flag${spelling}`)
		}
	})
})
