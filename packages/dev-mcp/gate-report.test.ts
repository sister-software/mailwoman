/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { afterAll, describe, expect, it } from "vitest"

import { missingWeightsCacheArtifacts, readGateReport, summarizeGateReport } from "./gate-report.ts"

const dirs: string[] = []

function outDir(verdict?: unknown, provenance?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "mwdev-gate-report-"))

	dirs.push(dir)

	if (verdict !== undefined) {
		writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict))
	}

	if (provenance !== undefined) {
		writeFileSync(join(dir, "provenance.txt"), provenance)
	}

	return dir
}

const PASSING = {
	label: "v9.0.0-base",
	graded_artifact: "weights-cache",
	verdict: "PASS",
	results: {
		"us.street": { floor: 80.4, actual: 82.1, pass: true },
		"fr.postcode": { floor: 99.5, actual: 99.7, pass: true },
	},
	int8_vs_fp32_deltas: {},
}

afterAll(() => {
	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe("readGateReport", () => {
	it("reads floors with their margins", () => {
		const report = readGateReport(outDir(PASSING), "", "")

		expect(report.verdict).toBe("PASS")
		expect(report.floors).toHaveLength(2)
		expect(report.floors[0]).toMatchObject({ metric: "us.street", floor: 80.4, observed: 82.1, pass: true })
		expect(report.floors[0]!.margin).toBeCloseTo(1.7, 5)
	})

	it("distinguishes an unmeasured floor from one that missed the bar", () => {
		// The gate marks an unmeasured floor failing so it cannot pass by default. Reading that as "missed the bar"
		// sends someone tuning a metric that never ran.
		const report = readGateReport(
			outDir({
				...PASSING,
				verdict: "FAIL",
				results: {
					"us.street": { floor: 80.4, actual: 78, pass: false },
					"nl.postcode": { floor: 99, actual: undefined, pass: false },
				},
			}),
			"",
			""
		)

		const missed = report.floors.find((floor) => floor.metric === "us.street")!
		const unmeasured = report.floors.find((floor) => floor.metric === "nl.postcode")!

		expect(missed).toMatchObject({ measured: true, pass: false })
		expect(missed.margin).toBeCloseTo(-2.4, 5)
		expect(unmeasured).toMatchObject({ measured: false, observed: null, margin: null, pass: false })
		expect(report.notes.join(" ")).toContain("never ran")
	})

	it("reports an absent verdict.json as not-graded, never as FAIL", () => {
		const report = readGateReport(outDir(), "", "")

		expect(report.verdict).toBeNull()
		expect(report.notes.join(" ")).toContain("different outcomes")
	})

	it("surfaces the ledger command and refuses to imply it was run", () => {
		const log =
			"ledger (#885): on promote, append this run —\n" +
			"  node packages/mailwoman/out/cli.js eval ledger-append \\\n" +
			"    --out-dir /tmp/x --model-version <npm-semver>\n"

		const report = readGateReport(outDir(PASSING), log, "")

		expect(report.ledger_command).toContain("eval ledger-append")
		expect(report.ledger_command).toContain("--out-dir /tmp/x")
		expect(report.ledger_note).toContain("REPORTED, never run")
	})

	it("passes the lore-guard refusal through verbatim rather than working around it", () => {
		const report = readGateReport(outDir(), "", "✗ recompile packages/core/out before evaluating — it is stale\n")

		expect(report.lore_guard_refusal).toContain("recompile")
	})

	it("carries provenance when the run wrote it, and says so when it did not", () => {
		expect(readGateReport(outDir(PASSING, "md5 abc123\n"), "", "").provenance).toContain("md5 abc123")
		expect(readGateReport(outDir(PASSING), "", "").notes.join(" ")).toContain("md5s are unrecorded")
	})
})

describe("summarizeGateReport", () => {
	it("names the graded artifact before the verdict", () => {
		// A verdict diffed without this field attributes a quantization delta to the model — it said "fp32" for a
		// verifiably int8 cache on 2026-07-16.
		const summary = summarizeGateReport(readGateReport(outDir(PASSING), "", ""))

		expect(summary).toContain("graded the weights-cache artifact")
		expect(summary).toContain("PASS")
		expect(summary).toContain("All 2 floors met")
	})

	it("says UNRECORDED rather than guessing when the artifact is unknown", () => {
		const summary = summarizeGateReport(readGateReport(outDir({ ...PASSING, graded_artifact: undefined }), "", ""))

		expect(summary).toContain("UNRECORDED")
	})

	it("counts missed and unmeasured floors separately", () => {
		const summary = summarizeGateReport(
			readGateReport(
				outDir({
					...PASSING,
					verdict: "FAIL",
					results: {
						"us.street": { floor: 80.4, actual: 78, pass: false },
						"nl.postcode": { floor: 99, actual: undefined, pass: false },
					},
				}),
				"",
				""
			)
		)

		expect(summary).toContain("1 floor missed and 1 unmeasured")
	})
})

describe("missingWeightsCacheArtifacts", () => {
	it("names every artifact a package-shaped root is missing", () => {
		const root = mkdtempSync(join(tmpdir(), "mwdev-wc-"))

		dirs.push(root)

		const missing = missingWeightsCacheArtifacts(root)

		expect(missing.kind).toBe("wrong-shape")
		expect(missing.paths).toHaveLength(3)
		expect(missing.paths.join(" ")).toContain("model.onnx")
		expect(missing.paths.join(" ")).toContain("node_modules")
	})

	it("catches a cache missing what its OWN card declares", () => {
		// The #1516 failure has no signal of its own: the channel resolves off, the run scores lower, and the operator
		// reads a model regression. Measured 2026-08-16 — a hand-staged three-file cache graded to completion and
		// reported us.country_homograph_f1 at 0.0 against a 64.8 floor.
		const root = mkdtempSync(join(tmpdir(), "mwdev-wc-"))

		dirs.push(root)

		const packageDir = weightsCachePackageDir(root, "en-us")

		mkdirSync(packageDir, { recursive: true })
		writeFileSync(join(packageDir, "model.onnx"), "x")
		writeFileSync(join(packageDir, "tokenizer.model"), "x")

		writeFileSync(
			join(packageDir, "model-card.json"),
			JSON.stringify({ files_md5: { $comment: "ignored", "model.onnx": "a", "street-type-lexicon-v3.json": "b" } })
		)

		const missing = missingWeightsCacheArtifacts(root)

		expect(missing.kind).toBe("under-staged")
		expect(missing.paths).toHaveLength(1)
		expect(missing.paths[0]).toContain("street-type-lexicon-v3.json")
	})

	it("does not treat the card's $comment key as an artifact", () => {
		const root = mkdtempSync(join(tmpdir(), "mwdev-wc-"))

		dirs.push(root)

		const packageDir = weightsCachePackageDir(root, "en-us")

		mkdirSync(packageDir, { recursive: true })

		for (const artifact of ["model.onnx", "tokenizer.model"]) {
			writeFileSync(join(packageDir, artifact), "x")
		}

		writeFileSync(join(packageDir, "model-card.json"), JSON.stringify({ files_md5: { $comment: "docs only" } }))

		expect(missingWeightsCacheArtifacts(root).kind).toBe("ok")
	})

	it("passes a well-formed cache", () => {
		const root = mkdtempSync(join(tmpdir(), "mwdev-wc-"))

		dirs.push(root)

		const packageDir = weightsCachePackageDir(root, "en-us")

		mkdirSync(packageDir, { recursive: true })

		for (const artifact of ["model.onnx", "tokenizer.model"]) {
			writeFileSync(join(packageDir, artifact), "x")
		}

		writeFileSync(
			join(packageDir, "model-card.json"),
			JSON.stringify({ files_md5: { "model.onnx": "a", "tokenizer.model": "b" } })
		)

		expect(missingWeightsCacheArtifacts(root).kind).toBe("ok")
	})
})
