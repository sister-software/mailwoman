/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { COMPONENT_TAGS } from "@mailwoman/core/types"
import { expect, test } from "vitest"

import { buildDefaultPolicies, defaultPolicyFor } from "./defaults.js"

test("buildDefaultPolicies: one entry per ComponentTag, all rule_only by default", () => {
	const policies = buildDefaultPolicies()
	expect(policies).toHaveLength(COMPONENT_TAGS.length)
	expect(policies.map((p) => p.component)).toEqual([...COMPONENT_TAGS]) // covers every tag, in order
	expect(policies.every((p) => p.mode === "rule_only")).toBe(true)
})

test("buildDefaultPolicies: honors a non-default mode for the whole table", () => {
	const policies = buildDefaultPolicies("neural_preferred")
	expect(policies).toHaveLength(COMPONENT_TAGS.length)
	expect(policies.every((p) => p.mode === "neural_preferred")).toBe(true)
})

test("buildDefaultPolicies: returns a fresh, mutable array each call", () => {
	const a = buildDefaultPolicies()
	const b = buildDefaultPolicies()
	expect(a).not.toBe(b) // distinct references — callers may mutate freely
	a[0]!.mode = "both"
	expect(b[0]!.mode).toBe("rule_only") // mutating one does not leak into another
})

test("defaultPolicyFor: a single component default (rule_only unless overridden)", () => {
	expect(defaultPolicyFor("street")).toEqual({ component: "street", mode: "rule_only" })
	expect(defaultPolicyFor("postcode", "both")).toEqual({ component: "postcode", mode: "both" })
})
