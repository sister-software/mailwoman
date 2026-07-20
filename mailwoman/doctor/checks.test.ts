/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the pure `mailwoman doctor` verdict logic. No filesystem, no Ink — every check is a
 *   function from an OBSERVATION to a {@link DoctorCheck}, so the ok/missing/degraded decisions and the
 *   exit-code discipline are covered here without standing up a data root.
 */

import { describe, expect, it } from "vitest"

import {
	assembleReport,
	CheckStatus,
	computeExitCode,
	dataRootCheck,
	formatBytes,
	gazetteerCheck,
	localeOverlayCheck,
	nodeVersionCheck,
	onnxRuntimeCheck,
	parseVersion,
	parseVersionFloor,
	poiCheck,
	versionMeetsFloor,
	weightsCheck,
	type DoctorCheck,
} from "./checks.ts"

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

describe("formatBytes", () => {
	it("scales to B / KB / MB", () => {
		expect(formatBytes(0)).toBe("0 B")
		expect(formatBytes(512)).toBe("512 B")
		expect(formatBytes(64_000)).toBe("64 KB")
		expect(formatBytes(35_800_000)).toBe("35.8 MB")
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
	it("ok on a discovered candidate.db", () => {
		const c = gazetteerCheck({
			found: { kind: "candidate", path: "/wof/candidate.db", sizeBytes: 1_400_000_000 },
			probed: ["/wof/candidate.db"],
		})
		expect(c.status).toBe(CheckStatus.OK)
		expect(c.detail).toContain("candidate.db")
		expect(c.detail).toContain("MB")
	})

	it("ok on a discovered WOF shard", () => {
		const c = gazetteerCheck({ found: { kind: "wof", path: "/wof/admin.db" }, probed: ["/wof/admin.db"] })
		expect(c.status).toBe(CheckStatus.OK)
		expect(c.detail).toContain("WOF admin shard")
	})

	it("missing with the download URL when nothing found", () => {
		const c = gazetteerCheck({ probed: ["/a", "/b"] })
		expect(c.status).toBe(CheckStatus.Missing)
		expect(c.fix).toContain("public.sister.software/mailwoman/gazetteer")
		expect(c.detail).toContain("2 paths")
	})
})

describe("poiCheck (optional)", () => {
	it("ok with manifest identity when the layer opens", () => {
		const c = poiCheck({
			path: "/poi/poi.db",
			exists: true,
			manifest: { name: "poi", version: "2026-07-20a", sourceVintage: "2026-07" },
		})
		expect(c.status).toBe(CheckStatus.OK)
		expect(c.detail).toContain("poi v2026-07-20a")
		expect(c.detail).toContain("vintage 2026-07")
	})

	it("missing with a build/download fix when absent", () => {
		const c = poiCheck({ path: "/poi/poi.db", exists: false })
		expect(c.status).toBe(CheckStatus.Missing)
		expect(c.fix).toContain("mailwoman gazetteer build poi")
		expect(c.fix).toContain("poi/2026-07-20a")
	})

	it("degraded when present but the manifest is unreadable", () => {
		const c = poiCheck({ path: "/poi/poi.db", exists: true, error: "layer manifest: expected exactly 1 row, found 0" })
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
