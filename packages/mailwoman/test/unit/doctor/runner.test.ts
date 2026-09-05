/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `runDoctor` orchestration tests — driven entirely through injected {@link DoctorDeps} dependencies, so no
 *   filesystem, weights package, or ONNX binding is touched. Verifies the fact-gathering (weights,
 *   gazetteer discovery order, POI manifest, runtime) and the exit-code discipline end-to-end.
 *
 *   The last describe is the deliberate exception: `defaultDoctorDeps`'s engines floor is the one dependency
 *   that resolves a real file, so nothing above it can catch a broken resolution.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import {
	CheckStatus,
	defaultDoctorDeps,
	describeEnvironment,
	runDoctor,
	type DoctorDeps,
	type DoctorCheck,
} from "mailwoman/doctor"
import { describe, expect, it } from "vitest"

/**
 * A fully-healthy set of dependencies; individual tests override just the fields they exercise.
 */
function healthyDeps(): DoctorDeps {
	return {
		exists: async () => true,
		fileSize: async () => 40_000_000,
		isWritable: async () => true,
		resolveWeights: async (locale) => ({
			source: `package:@mailwoman/neural-weights-${locale}`,
			modelPath: `/w/${locale}/model.onnx`,
			tokenizerPath: `/w/${locale}/tokenizer.model`,
		}),
		weightsPackageName: (locale) => `@mailwoman/neural-weights-${locale}`,
		dataRoot: () => ({ path: "/data", fromEnv: true }),
		envCandidatePath: async () => "/data/wof/candidate.db",
		conventionCandidatePath: async () => "/data/wof/candidate.db",
		wofExtractPaths: () => ["/data/wof/admin.db"],
		poiPath: () => "/data/poi/poi.db",
		readLayerIdentity: async () => ({
			name: "poi",
			version: "2026-07-20a",
			sourceVintage: "2026-07",
			license: "CDLA-Permissive-2.0",
			attribution: "Overture Maps Foundation",
		}),
		layerDatabases: () => [{ id: "poi", label: "POI layer", path: "/data/poi/poi.db" }],
		layerAlternates: async () => [],
		runtimeLicense: async () => "AGPL-3.0-only OR LicenseRef-Commercial",
		licenseKey: async () => undefined,
		confirmLicenseKeyPublished: async () => "unreachable",
		checkLicenseStatus: async () => "unknown",
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

describe("runDoctor (injected boundaries)", () => {
	it("all-healthy → every check ok, exit 0, 9 checks in render order", async () => {
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
			"license-mailwoman",
			"license-poi",
			"locale-overlay-fr-fr",
		])

		expect(report.checks.every((c) => c.status === CheckStatus.OK)).toBe(true)
	})

	it("missing weights → core failure, exit 1, but optional layers still reported", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			resolveWeights: async (locale) => {
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

	it("gazetteer discovery falls back to a WOF database only when NO candidate.db is reachable", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			envCandidatePath: async () => undefined,
			conventionCandidatePath: async () => undefined,
			exists: async (p) => p === "/data/wof/admin.db",
		})

		const gaz = byID(report.checks, "gazetteer")
		expect(gaz.status).toBe(CheckStatus.OK)
		expect(gaz.detail).toContain("WOF admin database")
	})

	it("candidate.db at the convention path with no env set → ok (the trap this used to report is closed)", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			// Env resolves nothing (no $MAILWOMAN_CANDIDATE_DB), no WOF database exists, the file sits at the convention path.
			envCandidatePath: async () => undefined,
			exists: async () => false,
			conventionCandidatePath: async () => "/data/wof/candidate.db",
			readLayerIdentity: async () => {
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
			envCandidatePath: async () => undefined,
			conventionCandidatePath: async () => undefined,
			exists: async () => false,
			readLayerIdentity: async () => {
				throw new Error("unreachable — poi path does not exist")
			},
		})

		expect(report.exitCode).toBe(0)
		expect(byID(report.checks, "gazetteer").status).toBe(CheckStatus.Missing)
		expect(byID(report.checks, "poi-layer").status).toBe(CheckStatus.Missing)
	})

	it("license posture: the open-source branch applies without a commercial agreement, and a layer's recorded license is summarized", async () => {
		const report = await runDoctor(healthyDeps())
		const runtime = byID(report.checks, "license-mailwoman")
		const poi = byID(report.checks, "license-poi")

		expect(runtime.license).toEqual({
			subject: "mailwoman",
			expression: "AGPL-3.0-only OR LicenseRef-Commercial",
			applied: "AGPL-3.0-only",
			obligations: ["attribution", "share_alike", "source_offer"],
			recognized: true,
		})

		expect(poi.license).toEqual({
			subject: "poi",
			expression: "CDLA-Permissive-2.0",
			applied: "CDLA-Permissive-2.0",
			obligations: ["attribution"],
			recognized: true,
			attribution: "Overture Maps Foundation",
		})
	})

	it("license posture: a valid key applies the commercial branch, names the licensee, and records the freshness answer", async () => {
		const valid = {
			status: "valid" as const,
			kid: "v9-deadbeef",
			payload: {
				v: 1 as const,
				kid: "v9-deadbeef",
				licensee: "Example Ltd",
				issued: "2026-09-03",
				expires: "2027-09-03",
				scope: "all" as const,
				terms: "LicenseRef-Commercial" as const,
			},
		}

		const asked: string[] = []

		const report = await runDoctor({
			...healthyDeps(),
			licenseKey: async () => valid,
			confirmLicenseKeyPublished: async (kid) => {
				asked.push(kid)

				return "listed"
			},
		})

		const check = byID(report.checks, "license-mailwoman")

		expect(asked).toEqual(["v9-deadbeef"])
		expect(check.status).toBe(CheckStatus.OK)

		expect(check.license).toMatchObject({
			applied: "LicenseRef-Commercial",
			obligations: ["attribution"],
			licensee: "Example Ltd",
			keyID: "v9-deadbeef",
			keyStatus: "valid",
		})

		expect(check.detail).toContain("confirmed by mailwoman.ai")
	})

	it("license posture: a self-service key reports the license's status as its own word; revoked degrades the check, unreachable does not, and a hand-issued key never asks", async () => {
		const lid = `lic_${"a".repeat(22)}`

		const selfService = {
			status: "valid" as const,
			kid: "v9-deadbeef",
			payload: {
				v: 1 as const,
				kid: "v9-deadbeef",
				licensee: "Example Ltd",
				issued: "2026-10-01",
				expires: "2026-11-15",
				scope: "all" as const,
				terms: "LicenseRef-Commercial" as const,
				lid,
				agreement: "commercial-2026-10",
			},
		}

		const asked: string[] = []

		const active = await runDoctor({
			...healthyDeps(),
			licenseKey: async () => selfService,
			confirmLicenseKeyPublished: async () => "listed",
			checkLicenseStatus: async (id) => {
				asked.push(id)

				return "active"
			},
		})

		const activeCheck = byID(active.checks, "license-mailwoman")

		expect(asked).toEqual([lid])
		expect(activeCheck.status).toBe(CheckStatus.OK)
		expect(activeCheck.detail).toContain("license active")
		expect(activeCheck.license).toMatchObject({ applied: "LicenseRef-Commercial", lid, lidStatus: "active" })

		const revoked = await runDoctor({
			...healthyDeps(),
			licenseKey: async () => selfService,
			confirmLicenseKeyPublished: async () => "listed",
			checkLicenseStatus: async () => "revoked",
		})

		const revokedCheck = byID(revoked.checks, "license-mailwoman")

		expect(revokedCheck.status).toBe(CheckStatus.Degraded)
		expect(revokedCheck.detail).toContain("online this license is revoked")
		expect(revokedCheck.consequence).toContain("offline")
		expect(revokedCheck.fix).toBe("mailwoman license refresh")
		// The branch is the offline token's: the stamp and the doctor keep agreeing on it.
		expect(revokedCheck.license).toMatchObject({ applied: "LicenseRef-Commercial", lidStatus: "revoked" })

		const unreachable = await runDoctor({
			...healthyDeps(),
			licenseKey: async () => selfService,
			confirmLicenseKeyPublished: async () => "unreachable",
			checkLicenseStatus: async () => "unreachable",
		})

		const unreachableCheck = byID(unreachable.checks, "license-mailwoman")

		expect(unreachableCheck.status).toBe(CheckStatus.OK)
		expect(unreachableCheck.detail).toContain("license status unreachable")

		const handIssued = await runDoctor({
			...healthyDeps(),
			licenseKey: async () => ({
				...selfService,
				payload: { ...selfService.payload, lid: undefined, agreement: undefined },
			}),
			confirmLicenseKeyPublished: async () => "listed",
			checkLicenseStatus: async () => {
				throw new Error("a hand-issued key names no license")
			},
		})

		expect(byID(handIssued.checks, "license-mailwoman").license).not.toHaveProperty("lidStatus")
	})

	it("license posture: an expired, unknown or retired key reports its reason and the open-source branch applies", async () => {
		const payload = {
			v: 1 as const,
			kid: "v9-deadbeef",
			licensee: "Example Ltd",
			issued: "2025-09-03",
			expires: "2026-09-01",
			scope: "all" as const,
			terms: "LicenseRef-Commercial" as const,
		}

		const expired = await runDoctor({
			...healthyDeps(),
			licenseKey: async () => ({ status: "expired", kid: "v9-deadbeef", payload }),
		})

		const expiredCheck = byID(expired.checks, "license-mailwoman")

		expect(expiredCheck.status).toBe(CheckStatus.Degraded)
		expect(expiredCheck.license?.applied).toBe("AGPL-3.0-only")
		expect(expiredCheck.detail).toContain("expired on 2026-09-01")
		expect(expired.exitCode).toBe(0)

		const unknown = await runDoctor({
			...healthyDeps(),
			licenseKey: async () => ({
				status: "unknown_key",
				kid: "v9-00000000",
				reason: "signed by key id v9-00000000, which this build does not trust",
			}),
		})

		expect(byID(unknown.checks, "license-mailwoman").license).toMatchObject({
			applied: "AGPL-3.0-only",
			keyStatus: "unknown_key",
		})

		const retired = await runDoctor({
			...healthyDeps(),
			licenseKey: async () => ({ status: "valid", kid: "v9-deadbeef", payload: { ...payload, expires: "2030-01-01" } }),
			confirmLicenseKeyPublished: async () => "retired",
		})

		expect(byID(retired.checks, "license-mailwoman").license).toMatchObject({
			applied: "AGPL-3.0-only",
			keyStatus: "retired",
		})
	})

	it("license posture: the well-known register is never asked when no key is configured", async () => {
		let asked = 0

		await runDoctor({
			...healthyDeps(),
			confirmLicenseKeyPublished: async () => {
				asked++

				return "listed"
			},
		})

		expect(asked).toBe(0)
	})

	it("license posture: an absent layer gets no license line; a layer recording NOASSERTION is degraded, not guessed", async () => {
		const absent = await runDoctor({
			...healthyDeps(),
			layerDatabases: () => [
				{ id: "poi", label: "POI layer", path: "/data/poi/poi.db" },
				{ id: "zoning", label: "Zoning (Ireland)", path: "/data/zoning/zoning-ireland.db" },
			],
			exists: async (path) => path !== "/data/zoning/zoning-ireland.db",
		})

		expect(absent.checks.some((c) => c.id === "license-zoning")).toBe(false)

		const unasserted = await runDoctor({
			...healthyDeps(),
			readLayerIdentity: async () => ({
				name: "zoning-ie-gzt",
				version: "2026-08",
				sourceVintage: "2026-08",
				license: "NOASSERTION",
				attribution: null,
			}),
		})

		const check = byID(unasserted.checks, "license-poi")

		expect(check.status).toBe(CheckStatus.Degraded)
		expect(check.license?.recognized).toBe(false)
		expect(unasserted.exitCode).toBe(0)
	})

	it("poi.db present but manifest unreadable → degraded (not a hard error)", async () => {
		const report = await runDoctor({
			...healthyDeps(),
			readLayerIdentity: async () => {
				throw new Error("layer manifest: expected exactly 1 row, found 0")
			},
		})

		expect(report.exitCode).toBe(0)
		expect(byID(report.checks, "poi-layer").status).toBe(CheckStatus.Degraded)
	})
})

// The one dependency that is NOT injected in the suite above: `defaultDoctorDeps` reads `engines.node` from mailwoman's own
// manifest, located by self-reference (`resolvePackageDirectory("mailwoman")("package.json")`). It touches the filesystem by
// construction — that is the thing under test — and it degrades to ">=0" on any failure, so a broken resolution would
// otherwise show up only as a doctor report that silently stops enforcing the Node floor.
describe("defaultDoctorDeps — engines floor via package self-reference", () => {
	it("reads the real engines.node, not the >=0 fallback", async () => {
		const manifest = await readLocalJSONFile<{ engines?: { node?: string } }>(
			new URL("../../../package.json", import.meta.url)
		)

		expect(manifest.engines?.node).toBeTruthy()
		expect((await defaultDoctorDeps()).enginesFloor).toBe(manifest.engines!.node)
	})
})

describe("describeEnvironment (--verbose)", () => {
	it("reports the resolved paths through the same boundaries the checks used", async () => {
		const entries = await describeEnvironment(healthyDeps())
		const byKey = new Map(entries.map((entry) => [entry.key, entry]))

		expect(byKey.get("data root (resolved)")?.value).toBe("/data")
		expect(byKey.get("POI layer")?.value).toBe("/data/poi/poi.db")
		expect(byKey.get("weights model.onnx")?.value).toBe("/w/en-us/model.onnx")
		expect(byKey.get("weights tokenizer.model")?.value).toBe("/w/en-us/tokenizer.model")
		expect(byKey.get("node")?.value).toBe("v24.18.0")

		// Every database the gazetteer check probed is listed, tagged on-disk or absent.
		expect(byKey.get("WOF database [0]")).toEqual({
			key: "WOF database [0]",
			value: "/data/wof/admin.db",
			source: "on disk",
		})
	})

	it("keys with no value are present and marked, never dropped", async () => {
		// The dump exists to tell "set to something surprising" apart from "never set". A row that
		// disappears when the variable is unset answers neither question.
		const entries = await describeEnvironment({ ...healthyDeps(), conventionCandidatePath: async () => undefined })
		const convention = entries.find((entry) => entry.key === "candidate.db (convention)")

		expect(convention).toBeDefined()
		expect(convention?.value).toBeUndefined()
	})

	it("an unresolvable weights package is reported, not thrown", async () => {
		const entries = await describeEnvironment({
			...healthyDeps(),
			resolveWeights: async () => {
				throw new Error("Could not resolve @mailwoman/neural-weights-en-us")
			},
		})

		const weights = entries.find((entry) => entry.key === "weights")
		expect(weights?.value).toBeUndefined()
		expect(weights?.source).toContain("unresolvable")
	})
})
