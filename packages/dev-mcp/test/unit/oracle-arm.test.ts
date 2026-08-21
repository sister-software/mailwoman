/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
	DEFAULT_GOOGLE_CALL_CAP,
	OracleMeter,
	OracleProviderName,
	ORACLE_GRADE_MODE,
	readOracleConfig,
} from "@mailwoman/dev-mcp/oracle-arm"
import { afterAll, describe, expect, it } from "vitest"

const dirs: string[] = []

function configFile(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "mwdev-oracle-"))

	dirs.push(dir)

	const path = join(dir, "oracle-config.json")

	writeFileSync(path, contents)

	return path
}

afterAll(() => {
	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe("readOracleConfig", () => {
	it("treats an absent config as off", () => {
		expect(readOracleConfig("/nonexistent/oracle-config.json")).toEqual({})
	})

	it("treats a MALFORMED config as off, never as enabled", () => {
		// The failure that matters: a truncated or half-written file must not read as an opt-in to spend money.
		expect(readOracleConfig(configFile("{ not json"))).toEqual({})
	})

	it("reads a well-formed opt-in", () => {
		const config = readOracleConfig(configFile('{"google":{"enabled":true,"maxCallsPerDaemonLifetime":25}}'))

		expect(config.google).toEqual({ enabled: true, maxCallsPerDaemonLifetime: 25 })
	})
})

describe("OracleMeter — census", () => {
	it("admits the free provider with no ceremony and no cap", () => {
		const admission = new OracleMeter({}).admit(OracleProviderName.Census, 10_000)

		expect(admission.allowed).toBe(true)
		expect(admission.callsRemaining).toBeNull()
		expect(admission.reason).toContain("free and unauthenticated")
	})

	it("names the US-only bound rather than leaving it to be discovered", () => {
		expect(new OracleMeter({}).admit(OracleProviderName.Census, 1).reason).toContain("US-only")
	})
})

describe("OracleMeter — google", () => {
	it("refuses when the config does not enable it", () => {
		const admission = new OracleMeter({}).admit(OracleProviderName.Google, 1)

		expect(admission.allowed).toBe(false)
		expect(admission.reason).toContain("BILLED")
		expect(admission.reason).toContain("not a tool argument")
	})

	it("refuses a run larger than the remaining cap BEFORE spending any of it", () => {
		// Refusing part way through would leave a partial arm that can still be graded as a whole one.
		const meter = new OracleMeter({ google: { enabled: true, maxCallsPerDaemonLifetime: 100 } })
		const admission = meter.admit(OracleProviderName.Google, 420)

		expect(admission.allowed).toBe(false)
		expect(admission.callsRemaining).toBe(100)
		expect(meter.googleCallsUsed).toBe(0)
	})

	it("admits within the cap and reports what remains", () => {
		const meter = new OracleMeter({ google: { enabled: true, maxCallsPerDaemonLifetime: 100 } })

		expect(meter.admit(OracleProviderName.Google, 60).allowed).toBe(true)

		meter.recordGoogleCalls(60)

		const second = meter.admit(OracleProviderName.Google, 60)

		expect(second.allowed).toBe(false)
		expect(second.callsRemaining).toBe(40)
	})

	it("applies a conservative default cap when the config enables without naming one", () => {
		const meter = new OracleMeter({ google: { enabled: true } })

		expect(meter.googleCap).toBe(DEFAULT_GOOGLE_CALL_CAP)
		expect(meter.admit(OracleProviderName.Google, DEFAULT_GOOGLE_CALL_CAP + 1).allowed).toBe(false)
	})

	it("counts every issued query, cache hit or not", () => {
		// The client does not report which answers came from disk, so the meter over-counts a warm run. Refusing a run
		// the cap could have afforded is the right direction to be wrong in.
		const meter = new OracleMeter({ google: { enabled: true } })

		meter.recordGoogleCalls(3)

		expect(meter.googleCallsUsed).toBe(3)
	})
})

describe("the grading refusal", () => {
	it("is diff-only, and that is a refusal rather than a default", () => {
		expect(ORACLE_GRADE_MODE).toBe("diff-only")
	})
})
