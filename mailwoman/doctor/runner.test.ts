/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `runDoctor` orchestration tests — driven entirely through injected {@link DoctorDeps} seams, so no
 *   filesystem, weights package, or ONNX binding is touched. Verifies the fact-gathering (weights,
 *   gazetteer discovery order, POI manifest, runtime) and the exit-code discipline end-to-end.
 */

import { describe, expect, it } from "vitest"

import { CheckStatus, type DoctorCheck } from "./checks.ts"
import { runDoctor, type DoctorDeps } from "./runner.ts"

/** A fully-healthy set of seams; individual tests override just the fields they exercise. */
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
		loadOnnx: async () => {},
		nodeVersion: "24.18.0",
		enginesFloor: ">=24.18.0",
		overlayLocales: ["fr-fr"],
	}
}

const byId = (checks: DoctorCheck[], id: string): DoctorCheck => {
	const c = checks.find((x) => x.id === id)

	if (!c) throw new Error(`no check ${id}`)

	return c
}

describe("runDoctor (injected seams)", () => {
	it("all-healthy → every check ok, exit 0, 7 checks in render order", async () => {
		const report = await runDoctor(healthyDeps())
		expect(report.exitCode).toBe(0)
		expect(report.checks.map((c) => c.id)).toEqual([
			"weights",
			"node-version",
			"onnxruntime",
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
		expect(byId(report.checks, "weights").status).toBe(CheckStatus.Missing)
		// A core failure must not suppress the optional-layer diagnostics.
		expect(byId(report.checks, "gazetteer").status).toBe(CheckStatus.OK)
	})

	it("ONNX binding unavailable → core degraded, exit 1", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			loadOnnx: async () => {
				throw new Error("Cannot find module 'onnxruntime-node'")
			},
		})
		expect(report.exitCode).toBe(1)
		expect(byId(report.checks, "onnxruntime").status).toBe(CheckStatus.Degraded)
	})

	it("gazetteer discovery falls back to a WOF shard when no env candidate.db", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			envCandidatePath: () => undefined,
			existsSync: (p) => p === "/data/wof/admin.db",
		})
		const gaz = byId(report.checks, "gazetteer")
		expect(gaz.status).toBe(CheckStatus.OK)
		expect(gaz.detail).toContain("WOF admin shard")
	})

	it("THE TRAP: candidate.db on disk at the convention path + env unset + no WOF shards → degraded, exit still 0", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			// Env resolves nothing (no $MAILWOMAN_CANDIDATE_DB), no WOF shard exists, but the file sits at the convention path.
			envCandidatePath: () => undefined,
			existsSync: () => false,
			conventionCandidatePath: () => "/data/wof/candidate.db",
			readPOIManifest: async () => {
				throw new Error("unreachable — poi path does not exist")
			},
		})
		const gaz = byId(report.checks, "gazetteer")
		expect(gaz.status).toBe(CheckStatus.Degraded)
		expect(gaz.detail).toContain("$MAILWOMAN_CANDIDATE_DB unset")
		expect(gaz.fix).toBe("export MAILWOMAN_CANDIDATE_DB=/data/wof/candidate.db")
		// A convention-only candidate is not a core failure — parse still runs.
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
		expect(byId(report.checks, "gazetteer").status).toBe(CheckStatus.Missing)
		expect(byId(report.checks, "poi-layer").status).toBe(CheckStatus.Missing)
	})

	it("poi.db present but manifest unreadable → degraded (not a hard error)", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			readPOIManifest: async () => {
				throw new Error("layer manifest: expected exactly 1 row, found 0")
			},
		})
		expect(report.exitCode).toBe(0)
		expect(byId(report.checks, "poi-layer").status).toBe(CheckStatus.Degraded)
	})
})
