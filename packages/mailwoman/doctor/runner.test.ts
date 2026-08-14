/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `runDoctor` orchestration tests — driven entirely through injected {@link DoctorDeps} seams, so no
 *   filesystem, weights package, or ONNX binding is touched. Verifies the fact-gathering (weights,
 *   gazetteer discovery order, POI manifest, runtime) and the exit-code discipline end-to-end.
 *
 *   The last describe is the deliberate exception: `defaultDoctorDeps`'s engines floor is the one seam
 *   that resolves a real file, so nothing above it can catch a broken resolution.
 */

import { readFileSync } from "node:fs"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { describe, expect, it } from "vitest"

import { CheckStatus, type DoctorCheck } from "./checks.ts"
import { defaultDoctorDeps, describeEnvironment, runDoctor, type DoctorDeps } from "./runner.ts"

/**
 * A fully-healthy set of seams; individual tests override just the fields they exercise.
 */
function healthyDeps(): DoctorDeps {
	return {
		existsSync: () => true,
		fileSize: () => 40_000_000,
		isWritable: () => true,
		resolveWeights: (locale) => ({
			source: `package:@mailwoman/neural-weights-${locale}`,
			modelPath: `/w/${locale}/model.onnx`,
			tokenizerPath: `/w/${locale}/tokenizer.model`,
		}),
		weightsPackageName: (locale) => `@mailwoman/neural-weights-${locale}`,
		dataRoot: () => ({ path: "/data", fromEnv: true }),
		envCandidatePath: () => "/data/wof/candidate.db",
		conventionCandidatePath: () => "/data/wof/candidate.db",
		wofShardPaths: () => ["/data/wof/admin.db"],
		poiPath: () => "/data/poi/poi.db",
		readPOIManifest: async () => ({ name: "poi", version: "2026-07-20a", sourceVintage: "2026-07" }),
		loadONNX: async () => {},
		nodeVersion: "24.18.0",
		enginesFloor: ">=24.18.0",
		overlayLocales: ["fr-fr"],
	}
}

const byID = (checks: DoctorCheck[], id: string): DoctorCheck => {
	const c = checks.find((x) => x.id === id)

	if (!c) throw new Error(`no check ${id}`)

	return c
}

describe("runDoctor (injected seams)", () => {
	it("all-healthy → every check ok, exit 0, 7 checks in render order", async () => {
		const report = await runDoctor(healthyDeps())
		expect(report.exitCode).toBe(0)

		// RUNTIME FIRST (#1577): a stale node or an unloadable native binding explains every later line,
		// so it has to be read first. Weights follow, then the optional data layers, then the overlays.
		expect(report.checks.map((c) => c.id)).toEqual([
			"node-version",
			"onnxruntime",
			"weights",
			"data-root",
			"gazetteer",
			"poi-layer",
			"locale-overlay-fr-fr",
		])

		expect(report.checks.every((c) => c.status === CheckStatus.OK)).toBe(true)
	})

	it("missing weights → core failure, exit 1, but optional layers still reported", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			resolveWeights: (locale) => {
				if (locale === "en-us") throw new Error("Could not resolve @mailwoman/neural-weights-en-us")

				return {
					source: "package:x",
					modelPath: "/m",
					tokenizerPath: "/t",
				}
			},
		})

		expect(report.exitCode).toBe(1)
		expect(byID(report.checks, "weights").status).toBe(CheckStatus.Missing)
		// A core failure must not suppress the optional-layer diagnostics.
		expect(byID(report.checks, "gazetteer").status).toBe(CheckStatus.OK)
	})

	it("ONNX binding unavailable → core degraded, exit 1", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			loadONNX: async () => {
				throw new Error("Cannot find module 'onnxruntime-node'")
			},
		})

		expect(report.exitCode).toBe(1)
		expect(byID(report.checks, "onnxruntime").status).toBe(CheckStatus.Degraded)
	})

	it("gazetteer discovery falls back to a WOF shard only when NO candidate.db is reachable", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			envCandidatePath: () => undefined,
			conventionCandidatePath: () => undefined,
			existsSync: (p) => p === "/data/wof/admin.db",
		})

		const gaz = byID(report.checks, "gazetteer")
		expect(gaz.status).toBe(CheckStatus.OK)
		expect(gaz.detail).toContain("WOF admin shard")
	})

	it("candidate.db at the convention path with no env set → ok (the trap this used to report is closed)", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			// Env resolves nothing (no $MAILWOMAN_CANDIDATE_DB), no WOF shard exists, the file sits at the convention path.
			envCandidatePath: () => undefined,
			existsSync: () => false,
			conventionCandidatePath: () => "/data/wof/candidate.db",
			readPOIManifest: async () => {
				throw new Error("unreachable — poi path does not exist")
			},
		})

		const gaz = byID(report.checks, "gazetteer")
		expect(gaz.status).toBe(CheckStatus.OK)
		expect(gaz.detail).toContain("/data/wof/candidate.db")
		expect(gaz.fix).toBeUndefined()
		expect(report.exitCode).toBe(0)
	})

	it("no gazetteer at all → optional missing, exit still 0 (core intact)", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			envCandidatePath: () => undefined,
			conventionCandidatePath: () => undefined,
			existsSync: () => false,
			readPOIManifest: async () => {
				throw new Error("unreachable — poi path does not exist")
			},
		})

		expect(report.exitCode).toBe(0)
		expect(byID(report.checks, "gazetteer").status).toBe(CheckStatus.Missing)
		expect(byID(report.checks, "poi-layer").status).toBe(CheckStatus.Missing)
	})

	it("poi.db present but manifest unreadable → degraded (not a hard error)", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			readPOIManifest: async () => {
				throw new Error("layer manifest: expected exactly 1 row, found 0")
			},
		})

		expect(report.exitCode).toBe(0)
		expect(byID(report.checks, "poi-layer").status).toBe(CheckStatus.Degraded)
	})
})

// The one seam that is NOT injected in the suite above: `defaultDoctorDeps` reads `engines.node` from mailwoman's own
// manifest, located by self-reference (`import.meta.resolve("mailwoman/package.json")`). It touches the filesystem by
// construction — that is the thing under test — and it degrades to ">=0" on any failure, so a broken resolution would
// otherwise show up only as a doctor report that silently stops enforcing the Node floor.
describe("defaultDoctorDeps — engines floor via package self-reference", () => {
	it("reads the real engines.node, not the >=0 fallback", () => {
		const manifest = parseJSONStrict<{ engines?: { node?: string } }>(
			readFileSync(new URL("../package.json", import.meta.url), "utf8")
		)

		expect(manifest.engines?.node).toBeTruthy()
		expect(defaultDoctorDeps().enginesFloor).toBe(manifest.engines!.node)
	})
})

describe("describeEnvironment (--verbose)", () => {
	it("reports the resolved paths through the same seams the checks used", () => {
		const entries = describeEnvironment(healthyDeps())
		const byKey = new Map(entries.map((entry) => [entry.key, entry]))

		expect(byKey.get("data root (resolved)")?.value).toBe("/data")
		expect(byKey.get("POI layer")?.value).toBe("/data/poi/poi.db")
		expect(byKey.get("weights model.onnx")?.value).toBe("/w/en-us/model.onnx")
		expect(byKey.get("weights tokenizer.model")?.value).toBe("/w/en-us/tokenizer.model")
		expect(byKey.get("node")?.value).toBe("v24.18.0")
		// Every shard the gazetteer check probed is listed, tagged on-disk or absent.
		expect(byKey.get("WOF shard [0]")).toEqual({ key: "WOF shard [0]", value: "/data/wof/admin.db", source: "on disk" })
	})

	it("keys with no value are present and marked, never dropped", () => {
		// The dump exists to tell "set to something surprising" apart from "never set". A row that
		// disappears when the variable is unset answers neither question.
		const entries = describeEnvironment({ ...healthyDeps(), conventionCandidatePath: () => undefined })
		const convention = entries.find((entry) => entry.key === "candidate.db (convention)")

		expect(convention).toBeDefined()
		expect(convention?.value).toBeUndefined()
	})

	it("an unresolvable weights package is reported, not thrown", () => {
		const entries = describeEnvironment({
			...healthyDeps(),
			resolveWeights: () => {
				throw new Error("Could not resolve @mailwoman/neural-weights-en-us")
			},
		})

		const weights = entries.find((entry) => entry.key === "weights")
		expect(weights?.value).toBeUndefined()
		expect(weights?.source).toContain("unresolvable")
	})
})
