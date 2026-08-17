/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { checkCLIAllowlist } from "./cli-allowlist.ts"

describe("checkCLIAllowlist", () => {
	it("allows the read-only verbs", () => {
		for (const args of [
			["parse", "350 5th Ave"],
			["geocode", "Paris", "--json"],
			["reverse", "48.85", "2.35"],
			["doctor"],
			["eval", "gauntlet", "--layer", "regression"],
			["gazetteer", "stats"],
			["poi", "search", "cafe"],
		]) {
			expect(checkCLIAllowlist(args).allowed, args.join(" ")).toBe(true)
		}
	})

	it("refuses the ledger write even though `eval` is allowed", () => {
		// The one that matters: it is nested under an allowed verb and it writes the score ledger. mwdev_gate reports
		// this command pre-filled precisely so an operator runs it; the passthrough must not be the back door.
		const verdict = checkCLIAllowlist(["eval", "ledger-append", "--out-dir", "/tmp/x"])

		expect(verdict.allowed).toBe(false)
		expect(verdict.reason).toContain("route around that")
	})

	it("refuses state-changing verbs", () => {
		for (const args of [
			["gazetteer", "build", "candidate"],
			["coverage", "build"],
			["tiles", "publish"],
			["data", "pull"],
			["release", "hf"],
			["corpus", "ingest"],
		]) {
			expect(checkCLIAllowlist(args).allowed, args.join(" ")).toBe(false)
		}
	})

	it("refuses an unknown verb rather than permitting it", () => {
		// Allowlist, not denylist: a verb nobody has vetted is refused. The day someone adds `gazetteer nuke`, this is
		// what keeps it out.
		const verdict = checkCLIAllowlist(["nuke", "--everything"])

		expect(verdict.allowed).toBe(false)
		expect(verdict.reason).toContain("allowlist rather than a denylist")
	})

	it("cannot be bypassed by putting a flag first", () => {
		expect(checkCLIAllowlist(["--verbose", "eval", "ledger-append"]).allowed).toBe(false)
		expect(checkCLIAllowlist(["--json", "geocode", "Paris"]).allowed).toBe(true)
	})

	it("allows bare help", () => {
		expect(checkCLIAllowlist(["--help"]).allowed).toBe(true)
		expect(checkCLIAllowlist([]).allowed).toBe(true)
	})

	it("does not let a prefix match a longer unrelated verb", () => {
		// `gazetteer stats` is allowed; `gazetteer` alone is not, because the allowed thing is the pair.
		expect(checkCLIAllowlist(["gazetteer"]).allowed).toBe(false)
	})

	it("states the applied boundary on an allow, not only on a refusal", () => {
		expect(checkCLIAllowlist(["parse", "x"]).reason).toContain("read-only allowlist")
	})
})

describe("checkCLIAllowlist — the sync carve-out", () => {
	it("refuses the repository sync even though its inspect siblings only read", () => {
		const verdict = checkCLIAllowlist(["gazetteer", "inspect", "sync", "--countries", "tr"])

		expect(verdict.allowed).toBe(false)
		expect(verdict.reason).toContain("65 GB")
	})

	it("refuses it with a flag in front, since flags never identify the verb", () => {
		expect(checkCLIAllowlist(["--dry-run", "gazetteer", "inspect", "sync"]).allowed).toBe(false)
	})
})
