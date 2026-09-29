/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { COMPONENT_TAGS } from "@mailwoman/codex/component"
import { expect, test } from "vitest"

import { buildDefaultPolicies, defaultPolicyFor } from "#policy/defaults"

test("buildDefaultPolicies: one entry per ComponentTag, all neural_only by default", () => {
	const policies = buildDefaultPolicies()
	expect(policies).toHaveLength(COMPONENT_TAGS.length)
	expect(policies.map((p) => p.component)).toEqual([...COMPONENT_TAGS]) // covers every tag, in order
	expect(policies.every((p) => p.mode === "neural_only")).toBe(true)
})

test("buildDefaultPolicies: honors a non-default mode for the whole table", () => {
	const policies = buildDefaultPolicies("both")
	expect(policies).toHaveLength(COMPONENT_TAGS.length)
	expect(policies.every((p) => p.mode === "both")).toBe(true)
})

test("buildDefaultPolicies: returns a fresh, mutable array each call", () => {
	const a = buildDefaultPolicies()
	const b = buildDefaultPolicies()
	expect(a).not.toBe(b) // distinct references — callers may mutate freely
	a[0]!.mode = "both"
	expect(b[0]!.mode).toBe("neural_only") // mutating one does not leak into another
})

test("defaultPolicyFor: a single component default (neural_only unless overridden)", () => {
	expect(defaultPolicyFor("street")).toEqual({ component: "street", mode: "neural_only" })
	expect(defaultPolicyFor("postcode", "both")).toEqual({ component: "postcode", mode: "both" })
})
