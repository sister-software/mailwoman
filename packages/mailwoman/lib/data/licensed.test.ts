/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LicenseKeyPayload, LicenseKeyVerification } from "@mailwoman/core/license"
import { describe, expect, it } from "vitest"

import type { DataBundle } from "#data/bundles"
import { licensedPullDecision } from "#data/licensed"

const free: DataBundle = {
	name: "candidate",
	description: "the free admin gazetteer",
	artifacts: [
		{ remotePath: "gazetteer/x/candidate.db", localPath: "wof/candidate.db", md5Sidecar: false, approxBytes: 1 },
	],
	rights: { publishers: [], expression: "CC0-1.0", terms: [], conditions: [], unresolved: [] },
}

const licensed: DataBundle = {
	...free,
	name: "gb-streets",
	description: "GB street-level atlas tier",
	access: "licensed",
	tier: "tier:gb-streets",
	countries: ["GB"],
}

const payload: LicenseKeyPayload = {
	v: 1,
	kid: "v9-00000000",
	licensee: "Example Project",
	issued: "2026-10-21",
	expires: "2027-03-11",
	scope: "all",
	terms: "AGPL-3.0-only",
	lid: "lic_0123456789abcdefghijkl",
	intent: "open-source",
	seq: 1,
}

const valid: LicenseKeyVerification = { status: "valid", kid: payload.kid, payload }

describe("licensedPullDecision", () => {
	it("leaves a free bundle free with or without a key", () => {
		expect(licensedPullDecision(free, null)).toEqual({ kind: "free" })
		expect(licensedPullDecision(free, { token: "mwl1.a.b", verification: valid })).toEqual({ kind: "free" })
	})

	it("refuses a licensed bundle without a key and prints the three routes", () => {
		const decision = licensedPullDecision(licensed, null)

		expect(decision.kind).toBe("refused")

		if (decision.kind !== "refused") return

		expect(decision.lines[0]).toBe("`gb-streets` is a licensed artifact. Get a token by one of:")
		expect(decision.lines.join("\n")).toContain("mailwoman license declare --intent open-source --project <url>")
		expect(decision.lines.join("\n")).toContain("mailwoman license evaluate --email <address>")
		expect(decision.lines.join("\n")).toContain("https://mailwoman.ai/license")
	})

	it("adds the refresh command when the configured key has expired", () => {
		const expired: LicenseKeyVerification = {
			status: "expired",
			kid: payload.kid,
			payload: { ...payload, expires: "2026-10-01" },
		}

		const decision = licensedPullDecision(licensed, { token: "mwl1.a.b", verification: expired })

		expect(decision.kind).toBe("refused")

		if (decision.kind !== "refused") return

		expect(decision.lines.join("\n")).toContain("Your key expired on 2026-10-01: mailwoman license refresh")
	})

	it("grants a licensed bundle to a valid key whose scope admits it, and refuses one whose scope excludes it", () => {
		expect(licensedPullDecision(licensed, { token: "mwl1.a.b", verification: valid })).toEqual({
			kind: "granted",
			token: "mwl1.a.b",
		})

		const narrow: LicenseKeyVerification = {
			status: "valid",
			kid: payload.kid,
			payload: { ...payload, scope: ["@mailwoman/neural-weights-en-gb"] },
		}

		const decision = licensedPullDecision(licensed, { token: "mwl1.a.b", verification: narrow })

		expect(decision.kind).toBe("refused")

		if (decision.kind !== "refused") return

		expect(decision.lines.join("\n")).toContain("scope")
		expect(decision.lines.join("\n")).toContain("tier:gb-streets")
	})
})
