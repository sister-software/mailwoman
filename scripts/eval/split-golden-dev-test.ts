/**
 * Split-golden-dev-test.ts — Task #34 (v0.7 P0)
 *
 * Splits the golden eval set into a held-out DEV/TEST partition so the calibration experiment (#31)
 * can report per-tag recall on data the model's recipe never tuned against. The methodology
 * contract (v0.7 plan):
 *
 * - 90/10 dev/test, stratified per source file (us / fr / adversarial) so each split preserves the
 *   country/category mix.
 * - DETERMINISTIC: a fixed seed + mulberry32 + Fisher-Yates means re-running reproduces
 *   byte-identical splits. The TEST partition is "read exactly once per release" — it must
 *   therefore be stable and committed.
 * - BACKWARD-COMPATIBLE: writes `dev/` and `test/` SUBDIRECTORIES under the golden dir.
 *   `loadGolden()` in harness-postcode.ts / eval-matrix.ts uses a non-recursive `readdirSync` that
 *   only picks up `*.jsonl`, so the existing `--golden data/eval/golden/v0.1.2` call is unaffected;
 *   the new splits are reached via `--golden data/eval/golden/v0.1.2/{dev,test}`.
 *
 * Run: node --experimental-strip-types scripts/eval/split-golden-dev-test.ts\
 * [--golden data/eval/golden/v0.1.2] [--test-ratio 0.1] [--seed 20260529]
 *
 * Output: <golden>/dev/<file>.jsonl, <golden>/test/<file>.jsonl, and <golden>/SPLIT-MANIFEST.json
 * (counts + sha256 + seed for repro).
 */

import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// -------------------------------------------------------------------------------------------------
// Args
// -------------------------------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const GOLDEN_DIR = arg("golden", "data/eval/golden/v0.1.2")
const TEST_RATIO = Number(arg("test-ratio", "0.1"))
const SEED = Number(arg("seed", "20260529"))

// -------------------------------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) + Fisher-Yates
// -------------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/**
 * Returns a shuffled COPY of indices [0..n). Seed is mixed per-file so the three files don't share
 * an identical permutation.
 */
function shuffledIndices(n: number, rng: () => number): number[] {
	const idx = Array.from({ length: n }, (_, i) => i)
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1))
		;[idx[i], idx[j]] = [idx[j], idx[i]]
	}
	return idx
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex")
}

// -------------------------------------------------------------------------------------------------
// Split
// -------------------------------------------------------------------------------------------------

interface FileSplit {
	source: string
	total: number
	dev: number
	test: number
	devSha256: string
	testSha256: string
	sourceSha256: string
}

function splitFile(name: string, fileSeed: number): FileSplit {
	const raw = readFileSync(join(GOLDEN_DIR, name), "utf8")
	const lines = raw.split("\n").filter((l) => l.trim().length > 0)
	const n = lines.length

	const order = shuffledIndices(n, mulberry32(fileSeed))
	const testCount = Math.round(n * TEST_RATIO)
	const testSet = new Set(order.slice(0, testCount))

	// Emit in ORIGINAL order within each split → reviewable diffs, stable output.
	const devLines: string[] = []
	const testLines: string[] = []
	for (let i = 0; i < n; i++) {
		if (testSet.has(i)) testLines.push(lines[i])
		else devLines.push(lines[i])
	}

	const devText = devLines.join("\n") + "\n"
	const testText = testLines.join("\n") + "\n"
	writeFileSync(join(GOLDEN_DIR, "dev", name), devText)
	writeFileSync(join(GOLDEN_DIR, "test", name), testText)

	return {
		source: name,
		total: n,
		dev: devLines.length,
		test: testLines.length,
		devSha256: sha256(devText),
		testSha256: sha256(testText),
		sourceSha256: sha256(raw),
	}
}

function main(): void {
	mkdirSync(join(GOLDEN_DIR, "dev"), { recursive: true })
	mkdirSync(join(GOLDEN_DIR, "test"), { recursive: true })

	const files = readdirSync(GOLDEN_DIR)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()

	const splits: FileSplit[] = []
	// Per-file seed = base seed mixed with a stable hash of the filename, so
	// each file gets a distinct-but-reproducible permutation.
	for (const f of files) {
		const fileSeed = (SEED ^ Number.parseInt(sha256(f).slice(0, 8), 16)) >>> 0
		splits.push(splitFile(f, fileSeed))
	}

	const totalDev = splits.reduce((a, s) => a + s.dev, 0)
	const totalTest = splits.reduce((a, s) => a + s.test, 0)

	const manifest = {
		created_at: new Date().toISOString(),
		method: "per-file stratified 90/10, mulberry32 + Fisher-Yates, seeded",
		seed: SEED,
		test_ratio: TEST_RATIO,
		totals: { dev: totalDev, test: totalTest, all: totalDev + totalTest },
		files: Object.fromEntries(
			splits.map((s) => [
				s.source,
				{
					total: s.total,
					dev: s.dev,
					test: s.test,
					dev_sha256: s.devSha256,
					test_sha256: s.testSha256,
					source_sha256: s.sourceSha256,
				},
			])
		),
	}
	writeFileSync(join(GOLDEN_DIR, "SPLIT-MANIFEST.json"), JSON.stringify(manifest, null, "\t") + "\n")

	console.log(`Split ${GOLDEN_DIR} (seed=${SEED}, test_ratio=${TEST_RATIO})`)
	for (const s of splits) {
		console.log(`  ${s.source.padEnd(20)} total=${s.total}  dev=${s.dev}  test=${s.test}`)
	}
	console.log(`  ${"TOTAL".padEnd(20)} dev=${totalDev}  test=${totalTest}`)
	console.log(`Wrote ${GOLDEN_DIR}/{dev,test}/*.jsonl + SPLIT-MANIFEST.json`)
}

main()
