/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalFile, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { missingWeightsCacheArtifacts, readGateReport, summarizeGateReport } from "@mailwoman/dev-mcp/gate-report"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { join } from "@mailwoman/platform/path"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function outDir(verdict?: unknown, provenance?: string): Promise<string> {
	const dir = fixtures.use(await temporaryDirectory("mwdev-gate-report-")).path

	if (verdict !== undefined) {
		await writeLocalJSONFile(verdict, join(dir, "verdict.json"))
	}

	if (provenance !== undefined) {
		await writeLocalFile(provenance, join(dir, "provenance.txt"))
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

describe("readGateReport", () => {
	it("reads floors with their margins", async () => {
		const report = await readGateReport(await outDir(PASSING), "", "")

		expect(report.verdict).toBe("PASS")
		expect(report.floors).toHaveLength(2)
		expect(report.floors[0]).toMatchObject({ metric: "us.street", floor: 80.4, observed: 82.1, pass: true })
		expect(report.floors[0]!.margin).toBeCloseTo(1.7, 5)
	})

	it("distinguishes an unmeasured floor from one that missed the bar", async () => {
		// The gate marks an unmeasured floor failing so it cannot pass by default. Reading that as "missed the bar"
		// sends someone tuning a metric that never ran.
		const report = await readGateReport(
			await outDir({
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

	it("reports an absent verdict.json as not-graded, never as FAIL", async () => {
		const report = await readGateReport(await outDir(), "", "")

		expect(report.verdict).toBeNull()
		expect(report.notes.join(" ")).toContain("different outcomes")
	})

	it("surfaces the ledger command and refuses to imply it was run", async () => {
		const log =
			"ledger (#885): on promote, append this run —\n" +
			"  node packages/mailwoman/out/cli.js eval ledger-append \\\n" +
			"    --out-dir /tmp/x --model-version <npm-semver>\n"

		const report = await readGateReport(await outDir(PASSING), log, "")

		expect(report.ledger_command).toContain("eval ledger-append")
		expect(report.ledger_command).toContain("--out-dir /tmp/x")
		expect(report.ledger_note).toContain("REPORTED, never run")
	})

	it("passes the lore-guard refusal through verbatim rather than working around it", async () => {
		const report = await readGateReport(
			await outDir(),
			"",
			"✗ recompile packages/core/out before evaluating — it is stale\n"
		)

		expect(report.lore_guard_refusal).toContain("recompile")
	})

	it("carries provenance when the run wrote it, and says so when it did not", async () => {
		expect((await readGateReport(await outDir(PASSING, "md5 abc123\n"), "", "")).provenance).toContain("md5 abc123")
		expect((await readGateReport(await outDir(PASSING), "", "")).notes.join(" ")).toContain("md5s are unrecorded")
	})
})

describe("summarizeGateReport", () => {
	it("names the graded artifact before the verdict", async () => {
		// A verdict diffed without this field attributes a quantization delta to the model — it said "fp32" for a
		// verifiably int8 cache on 2026-07-16.
		const summary = summarizeGateReport(await readGateReport(await outDir(PASSING), "", ""))

		expect(summary).toContain("graded the weights-cache artifact")
		expect(summary).toContain("PASS")
		expect(summary).toContain("All 2 floors met")
	})

	it("says UNRECORDED rather than guessing when the artifact is unknown", async () => {
		const summary = summarizeGateReport(
			await readGateReport(await outDir({ ...PASSING, graded_artifact: undefined }), "", "")
		)

		expect(summary).toContain("UNRECORDED")
	})

	it("counts missed and unmeasured floors separately", async () => {
		const summary = summarizeGateReport(
			await readGateReport(
				await outDir({
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
	it("names every artifact a package-shaped root is missing", async () => {
		await using rootDirectory = await temporaryDirectory("mwdev-wc-")
		const root = rootDirectory.path

		const missing = await missingWeightsCacheArtifacts(root)

		expect(missing.kind).toBe("wrong-shape")
		expect(missing.paths).toHaveLength(3)
		expect(missing.paths.join(" ")).toContain("model.onnx")
		expect(missing.paths.join(" ")).toContain("node_modules")
	})

	it("catches a cache missing what its OWN card declares", async () => {
		// The #1516 failure has no signal of its own: the channel resolves off, the run scores lower, and the operator
		// reads a model regression. Measured 2026-08-16 — a hand-staged three-file cache graded to completion and
		// reported us.country_homograph_f1 at 0.0 against a 64.8 floor.
		await using rootDirectory = await temporaryDirectory("mwdev-wc-")
		const root = rootDirectory.path

		const packageDir = weightsCachePackageDir(root, "en-us")

		await makeDirectories(packageDir)
		await writeLocalTextFile("x", join(packageDir, "model.onnx"))
		await writeLocalTextFile("x", join(packageDir, "tokenizer.model"))

		await writeLocalJSONFile(
			{ files_md5: { $comment: "ignored", "model.onnx": "a", "street-type-lexicon-v3.json": "b" } },
			join(packageDir, "model-card.json")
		)

		const missing = await missingWeightsCacheArtifacts(root)

		expect(missing.kind).toBe("under-staged")
		expect(missing.paths).toHaveLength(1)
		expect(missing.paths[0]).toContain("street-type-lexicon-v3.json")
	})

	it("does not treat the card's $comment key as an artifact", async () => {
		await using rootDirectory = await temporaryDirectory("mwdev-wc-")
		const root = rootDirectory.path

		const packageDir = weightsCachePackageDir(root, "en-us")

		await makeDirectories(packageDir)

		for (const artifact of ["model.onnx", "tokenizer.model"]) {
			await writeLocalTextFile("x", join(packageDir, artifact))
		}

		await writeLocalJSONFile({ files_md5: { $comment: "docs only" } }, join(packageDir, "model-card.json"))

		expect((await missingWeightsCacheArtifacts(root)).kind).toBe("ok")
	})

	it("passes a well-formed cache", async () => {
		await using rootDirectory = await temporaryDirectory("mwdev-wc-")
		const root = rootDirectory.path

		const packageDir = weightsCachePackageDir(root, "en-us")

		await makeDirectories(packageDir)

		for (const artifact of ["model.onnx", "tokenizer.model"]) {
			await writeLocalTextFile("x", join(packageDir, artifact))
		}

		await writeLocalJSONFile(
			{ files_md5: { "model.onnx": "a", "tokenizer.model": "b" } },
			join(packageDir, "model-card.json")
		)

		expect((await missingWeightsCacheArtifacts(root)).kind).toBe("ok")
	})
})
