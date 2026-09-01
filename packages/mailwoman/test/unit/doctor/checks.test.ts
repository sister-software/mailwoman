/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the pure `mailwoman doctor` verdict logic. No filesystem, no Ink — every check is a
 *   function from an OBSERVATION to a {@link DoctorCheck}, so the ok/missing/degraded decisions and the
 *   exit-code discipline are covered here without standing up a data root.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import {
	assembleReport,
	checkPOI,
	CheckStatus,
	computeExitCode,
	dataRootCheck,
	gazetteerCheck,
	localeOverlayCheck,
	nodeVersionCheck,
	onnxRuntimeCheck,
	parseVersion,
	parseVersionFloor,
	versionMeetsFloor,
	weightsCheck,
	type DoctorCheck,
} from "mailwoman/doctor"
import { describe, expect, it } from "vitest"

describe("version parsing + floor comparison", () => {
	it("parses a floor out of an engines range", () => {
		expect(parseVersionFloor(">=24.18.0")).toEqual({ major: 24, minor: 18, patch: 0 })
		expect(parseVersionFloor(">= 24")).toEqual({ major: 24, minor: 0, patch: 0 })
		expect(parseVersionFloor("^20.5")).toEqual({ major: 20, minor: 5, patch: 0 })
	})

	it("parses a bare runtime version", () => {
		expect(parseVersion("24.18.2")).toEqual({ major: 24, minor: 18, patch: 2 })
		expect(parseVersion("v24")).toBeUndefined()
	})

	it("compares major → minor → patch", () => {
		expect(versionMeetsFloor("24.18.0", ">=24.18.0")).toBe(true)
		expect(versionMeetsFloor("24.18.2", ">=24.18.0")).toBe(true)
		expect(versionMeetsFloor("25.0.0", ">=24.18.0")).toBe(true)
		expect(versionMeetsFloor("24.17.9", ">=24.18.0")).toBe(false)
		expect(versionMeetsFloor("23.99.99", ">=24.18.0")).toBe(false)
		expect(versionMeetsFloor("24.18.0", ">=24.18.5")).toBe(false)
	})
})

describe("weightsCheck (core)", () => {
	it("ok when both files resolve non-empty", () => {
		const c = weightsCheck({
			resolved: { source: "package:@mailwoman/neural-weights-en-us", modelPath: "/m", tokenizerPath: "/t" },
			modelSize: 35_800_000,
			tokenizerSize: 800_000,
		})

		expect(c.status).toBe(CheckStatus.OK)
		expect(c.core).toBe(true)
		expect(c.fix).toBeUndefined()
		expect(c.detail).toContain("35.8 MB")
	})

	it("missing when resolution threw", () => {
		const c = weightsCheck({ error: "Could not resolve @mailwoman/neural-weights-en-us\nInstall it via ..." })
		expect(c.status).toBe(CheckStatus.Missing)
		expect(c.fix).toContain("npm install @mailwoman/neural-weights-en-us")
		// The detail is trimmed to the first line of the error.
		expect(c.detail).toBe("Could not resolve @mailwoman/neural-weights-en-us")
	})

	it("degraded when a resolved file is empty", () => {
		const c = weightsCheck({
			resolved: { source: "package:x", modelPath: "/m", tokenizerPath: "/t" },
			modelSize: 0,
			tokenizerSize: 800_000,
		})

		expect(c.status).toBe(CheckStatus.Degraded)
		expect(c.fix).toBeDefined()
	})
})

describe("localeOverlayCheck (informational, never core)", () => {
	it("ok + no fix when resolvable", () => {
		const c = localeOverlayCheck({
			locale: "fr-fr",
			packageName: "@mailwoman/neural-weights-fr-fr",
			resolved: true,
			source: "package:@mailwoman/neural-weights-fr-fr+base",
		})

		expect(c.status).toBe(CheckStatus.OK)
		expect(c.core).toBe(false)
		expect(c.fix).toBeUndefined()
	})

	it("missing + install fix when absent", () => {
		const c = localeOverlayCheck({ locale: "fr-fr", packageName: "@mailwoman/neural-weights-fr-fr", resolved: false })
		expect(c.status).toBe(CheckStatus.Missing)
		expect(c.core).toBe(false)
		expect(c.fix).toBe("npm install @mailwoman/neural-weights-fr-fr")
	})
})

describe("dataRootCheck (optional)", () => {
	it("ok when exists + writable", () => {
		const c = dataRootCheck({ path: "/data", exists: true, writable: true, fromEnv: true })
		expect(c.status).toBe(CheckStatus.OK)
		expect(c.detail).toContain("$MAILWOMAN_DATA_ROOT")
	})

	it("missing when the dir does not exist", () => {
		const c = dataRootCheck({ path: "/data", exists: false, writable: false, fromEnv: false })
		expect(c.status).toBe(CheckStatus.Missing)
		expect(c.fix).toContain("mkdir -p /data")
		expect(c.detail).toContain("default")
	})

	it("degraded when present but not writable", () => {
		const c = dataRootCheck({ path: "/data", exists: true, writable: false, fromEnv: false })
		expect(c.status).toBe(CheckStatus.Degraded)
		expect(c.fix).toContain("chmod")
	})
})

describe("gazetteerCheck (optional)", () => {
	it("ok on an env-resolved candidate.db", () => {
		const c = gazetteerCheck({
			envCandidate: { path: "/wof/candidate.db", sizeBytes: 1_400_000_000 },
			probed: ["/wof/candidate.db"],
		})

		expect(c.status).toBe(CheckStatus.OK)
		expect(c.detail).toContain("candidate.db")
		// That the size is rendered at all, not how: a literal would pin the runner's locale rather than this check.
		expect(c.detail).toContain(ByteFormatter.formatSI(1_400_000_000))
	})

	it("ok on a discovered WOF database", () => {
		const c = gazetteerCheck({ wofDatabase: { path: "/wof/admin.db" }, probed: ["/wof/admin.db"] })
		expect(c.status).toBe(CheckStatus.OK)
		expect(c.detail).toContain("WOF admin database")
	})

	it("ok on a convention-path candidate.db with no env set", () => {
		// A fresh consumer runs `data pull candidate` and never exports anything. That used to be the
		// documented TRAP — the file on disk, every tool ignoring it — and the fix was an export line.
		// resolveCandidateDBPath reaches the convention path now, so the same observation is healthy,
		// and telling the reader to export something would be advice that changes nothing.
		const c = gazetteerCheck({
			conventionCandidate: "/data/wof/candidate.db",
			probed: ["/data/wof/admin.db", "/data/wof/candidate.db"],
		})

		expect(c.status).toBe(CheckStatus.OK)
		expect(c.detail).toContain("/data/wof/candidate.db")
		expect(c.fix).toBeUndefined()
	})

	it("prefers a convention-path candidate.db over a WOF database, matching resolution precedence", () => {
		const c = gazetteerCheck({
			conventionCandidate: "/data/wof/candidate.db",
			wofDatabase: { path: "/data/wof/admin.db" },
			probed: ["/data/wof/admin.db", "/data/wof/candidate.db"],
		})

		expect(c.status).toBe(CheckStatus.OK)
		expect(c.detail).toContain("candidate.db")
		expect(c.detail).not.toContain("WOF admin database")
	})

	it("missing with the data-pull hint when nothing found", () => {
		const c = gazetteerCheck({ probed: ["/a", "/b"] })
		expect(c.status).toBe(CheckStatus.Missing)
		expect(c.fix).toContain("mailwoman data pull candidate")
		expect(c.detail).toContain("2 paths")
	})
})

describe("checkPOI (optional)", () => {
	it("ok with manifest identity when the layer opens", () => {
		const c = checkPOI({
			path: "/poi/poi.db",
			exists: true,
			manifest: { name: "poi", version: "2026-07-20a", sourceVintage: "2026-07" },
		})

		expect(c.status).toBe(CheckStatus.OK)
		expect(c.detail).toContain("poi v2026-07-20a")
		expect(c.detail).toContain("vintage 2026-07")
	})

	it("missing with a build/download fix when absent", () => {
		const c = checkPOI({ path: "/poi/poi.db", exists: false })
		expect(c.status).toBe(CheckStatus.Missing)
		expect(c.fix).toContain("mailwoman gazetteer build poi")
		expect(c.fix).toContain("mailwoman data pull poi")
	})

	it("degraded when present but the manifest is unreadable", () => {
		const c = checkPOI({ path: "/poi/poi.db", exists: true, error: "layer manifest: expected exactly 1 row, found 0" })
		expect(c.status).toBe(CheckStatus.Degraded)
		expect(c.detail).toContain("unreadable")
	})
})

describe("runtime checks (core)", () => {
	it("nodeVersionCheck ok at/above the floor", () => {
		const c = nodeVersionCheck({ nodeVersion: "24.18.0", enginesFloor: ">=24.18.0" })
		expect(c.status).toBe(CheckStatus.OK)
		expect(c.core).toBe(true)
	})

	it("nodeVersionCheck degraded below the floor", () => {
		const c = nodeVersionCheck({ nodeVersion: "22.0.0", enginesFloor: ">=24.18.0" })
		expect(c.status).toBe(CheckStatus.Degraded)
		expect(c.core).toBe(true)
		expect(c.fix).toContain(">=24.18.0")
	})

	it("onnxRuntimeCheck ok when loadable", () => {
		const c = onnxRuntimeCheck({ loadable: true })
		expect(c.status).toBe(CheckStatus.OK)
		expect(c.core).toBe(true)
	})

	it("onnxRuntimeCheck degraded when the binding fails", () => {
		const c = onnxRuntimeCheck({ loadable: false, error: "Cannot find module 'onnxruntime-node'" })
		expect(c.status).toBe(CheckStatus.Degraded)
		expect(c.core).toBe(true)
		expect(c.fix).toContain("onnxruntime-node")
	})
})

describe("computeExitCode + assembleReport (meaning-of-zero)", () => {
	const ok = (id: string, core: boolean): DoctorCheck => ({ id, label: id, status: CheckStatus.OK, detail: "", core })

	const bad = (id: string, core: boolean, status: CheckStatus): DoctorCheck => ({
		id,
		label: id,
		status,
		detail: "",
		fix: "x",
		core,
	})

	it("exits 0 when every core check is ok — optional gaps are ignored", () => {
		const checks = [
			ok("weights", true),
			ok("node-version", true),
			ok("onnxruntime", true),
			bad("gazetteer", false, CheckStatus.Missing),
			bad("poi-layer", false, CheckStatus.Degraded),
		]

		expect(computeExitCode(checks)).toBe(0)
		expect(assembleReport(checks).exitCode).toBe(0)
	})

	it("exits 1 when a core check is missing", () => {
		const checks = [bad("weights", true, CheckStatus.Missing), ok("node-version", true), ok("onnxruntime", true)]
		expect(computeExitCode(checks)).toBe(1)
	})

	it("exits 1 when a core check is degraded", () => {
		const checks = [ok("weights", true), bad("onnxruntime", true, CheckStatus.Degraded)]
		expect(computeExitCode(checks)).toBe(1)
	})
})

describe("every failing check states its consequence (#1577)", () => {
	// The point of `consequence` is that a reader can decide whether a red line is worth acting on
	// TODAY. A check that fails without one has silently opted out of that contract, and nothing else
	// in the tree would notice — so enumerate the failing branch of every check here rather than
	// spot-checking one.
	const failing: Array<[string, DoctorCheck]> = [
		["weights absent", weightsCheck({ error: "Could not resolve @mailwoman/neural-weights-en-us" })],
		[
			"weights empty",
			weightsCheck({
				resolved: { source: "package:x", modelPath: "/m", tokenizerPath: "/t" },
				modelSize: 0,
				tokenizerSize: 0,
			}),
		],
		["node below floor", nodeVersionCheck({ nodeVersion: "20.0.0", enginesFloor: ">=24.18.0" })],
		["onnx unloadable", onnxRuntimeCheck({ loadable: false, error: "boom" })],
		["data root absent", dataRootCheck({ path: "/nope", exists: false, writable: false, fromEnv: false })],
		["data root read-only", dataRootCheck({ path: "/ro", exists: true, writable: false, fromEnv: true })],
		["gazetteer absent", gazetteerCheck({ probed: ["/a", "/b"] })],
		["poi absent", checkPOI({ path: "/poi.db", exists: false })],
		["poi unreadable", checkPOI({ path: "/poi.db", exists: true, error: "not a database" })],
		[
			"overlay absent",
			localeOverlayCheck({ locale: "fr-fr", packageName: "@mailwoman/neural-weights-fr-fr", resolved: false }),
		],
	]

	for (const [name, check] of failing) {
		it(`${name} → consequence + fix`, () => {
			expect(check.status).not.toBe(CheckStatus.OK)
			expect(check.consequence).toBeTruthy()
			expect(check.fix).toBeTruthy()
		})
	}

	it("names the POI layer's consequence in product terms, verbatim from the ask", () => {
		expect(checkPOI({ path: "/poi.db", exists: false }).consequence).toContain(
			"A Point of Interest (POI) database is necessary to geocode businesses and landmarks."
		)
	})

	it("a passing check carries no consequence — there is nothing to lose", () => {
		const c = nodeVersionCheck({ nodeVersion: "24.18.0", enginesFloor: ">=24.18.0" })
		expect(c.status).toBe(CheckStatus.OK)
		expect(c.consequence).toBeUndefined()
	})
})
