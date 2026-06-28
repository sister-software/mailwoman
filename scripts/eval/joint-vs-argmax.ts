import { readFileSync, writeFileSync } from "node:fs"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Route A Phase I (#423) — joint-decode vs argmax A/B harness.
 *
 *   The joint-decode path (Stage-5 reconcile/concordance beam) is already BUILT but opt-in
 *   (`forceJointReconcile`). This runs the SAME runtime pipeline twice per address — default
 *   (argmax sort) vs `forceJointReconcile: true` — and records, per case: locality/region match vs
 *   gold, wall-clock latency, and whether the joint path regressed or improved the structured
 *   output. The aggregate (regression rate, accuracy delta, latency p99 multiplier) feeds the #424
 *   decision gate.
 *
 *   Run (compile core first — the pipeline loads compiled out/): node --experimental-strip-types
 *   scripts/eval/joint-vs-argmax.ts\
 *   --eval data/eval/external/openaddresses-de-sample.jsonl --limit 500\
 *   --model /tmp/v094-eval/model.onnx --model-card neural-weights-en-us/model-card.json\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --default-country DE --out-json /tmp/joint-de.json
 */
import { decodeAsJson } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseAnchorLookup } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { createWofResolver } from "@mailwoman/resolver"
import { createRuntimePipeline } from "mailwoman"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)

	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

interface GoldRow {
	input: string
	expected: { locality?: string | null; region?: string | null; postcode?: string | null }
	state?: string
}

const norm = (s: string | undefined | null): string =>
	(s ?? "")
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()

/**
 * Did the projected output match gold on a field (subset-tolerant: gold token-subset of resolved or vice-versa)?
 */
function fieldMatch(resolved: string | undefined, gold: string | undefined | null): boolean {
	const r = norm(resolved)
	const g = norm(gold)

	if (!g) return true

	// nothing to match → not a miss
	if (!r) return false

	if (r === g) return true
	const rt = new Set(r.split(" "))
	const gt = g.split(" ")

	return gt.every((t) => rt.has(t)) || r.split(" ").every((t) => new Set(gt).has(t))
}

function pct(n: number, d: number): string {
	return d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`
}

function percentile(xs: number[], p: number): number {
	if (xs.length === 0) return 0
	const sorted = [...xs].sort((a, b) => a - b)

	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

async function main(): Promise<void> {
	const evalPath = arg("eval")
	const limit = Number(arg("limit", "0")) || Infinity
	const dc = arg("default-country", "")
	const modelPath = arg("model")
	const cardPath = arg("model-card")
	const tokPath = arg("tokenizer", dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model"))
	const anchorPath = arg("model-anchor-lookup")
	const wof = arg(
		"wof",
		`${dataRootPath("wof", "admin-global-priority.db")},${dataRootPath("wof", "postcode-locality-intl.db")}`
	)

	if (!evalPath || !modelPath || !cardPath) throw new Error("need --eval, --model, --model-card")

	const card = JSON.parse(readFileSync(cardPath, "utf8"))
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(tokPath),
		OnnxRunner.create(modelPath),
	])
	const postcodeAnchorLookup = anchorPath ? parseAnchorLookup(JSON.parse(readFileSync(anchorPath, "utf8"))) : undefined
	const classifier = new NeuralAddressClassifier({ tokenizer, runner, labels: card.labels, postcodeAnchorLookup })

	const { WofSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const wofPaths = wof.split(",").map((s) => s.trim())
	const backend = new WofSqlitePlaceLookup({ databasePath: wofPaths.length === 1 ? wofPaths[0]! : wofPaths })
	const resolver = createWofResolver(backend as never)

	const pipeline = createRuntimePipeline({ classifier, resolver })
	const resolveOpts = dc && dc.toLowerCase() !== "none" ? { defaultCountry: dc } : {}

	const rows = readFileSync(evalPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.slice(0, limit === Infinity ? undefined : limit)
		.map((l) => JSON.parse(l) as GoldRow)

	// Warm the model + JIT before timing so the first rows don't eat ONNX cold-start (which would
	// unfairly penalize whichever path runs first). Alternate first-path per row too (below).
	for (let w = 0; w < 3 && rows[w]; w++) {
		await pipeline(rows[w]!.input, { forceJointReconcile: false, resolveOpts })
		await pipeline(rows[w]!.input, { forceJointReconcile: true, resolveOpts })
	}

	let argmaxLocOk = 0
	let jointLocOk = 0
	let argmaxRegOk = 0
	let jointRegOk = 0
	let regressed = 0
	let improved = 0
	let changed = 0
	const argmaxLat: number[] = []
	const jointLat: number[] = []

	const dumpReg = !!process.env.MW_DUMP_REGRESSIONS

	for (const row of rows) {
		const score = async (
			forceJointReconcile: boolean
		): Promise<{ loc: boolean; reg: boolean; ms: number; locVal?: string }> => {
			const t0 = performance.now()
			let json: Partial<Record<string, string>> = {}

			try {
				const result = await pipeline(row.input, { forceJointReconcile, resolveOpts })
				json = decodeAsJson(result.tree)
			} catch {
				/* leave json empty → miss */
			}
			const ms = performance.now() - t0

			return {
				loc: fieldMatch(json.locality, row.expected.locality),
				reg: fieldMatch(json.region, row.expected.region),
				ms,
				locVal: json.locality,
			}
		}
		// Alternate which path runs first so any per-input cache warmth doesn't favor one path.
		const argmaxFirst = argmaxLat.length % 2 === 0
		let a: { loc: boolean; reg: boolean; ms: number; locVal?: string }
		let j: { loc: boolean; reg: boolean; ms: number; locVal?: string }

		if (argmaxFirst) {
			a = await score(false)
			j = await score(true)
		} else {
			j = await score(true)
			a = await score(false)
		}
		argmaxLat.push(a.ms)
		jointLat.push(j.ms)

		if (a.loc) argmaxLocOk++

		if (j.loc) jointLocOk++

		if (a.reg) argmaxRegOk++

		if (j.reg) jointRegOk++
		// Per-FIELD regression/improvement: did joint make a field WORSE (or better) than argmax had it?
		// Per-field (not combined loc&&reg) so a low overall region-match doesn't mask a locality change.
		const locRegressed = a.loc && !j.loc
		const regRegressed = a.reg && !j.reg
		const locImproved = !a.loc && j.loc
		const regImproved = !a.reg && j.reg

		if (locRegressed || regRegressed || locImproved || regImproved) changed++

		if (locRegressed || regRegressed) regressed++

		if (locImproved || regImproved) improved++

		if (dumpReg && locRegressed) {
			console.error(
				`[REG] gold="${row.expected.locality}"  argmax="${a.locVal ?? ""}"  joint="${j.locVal ?? ""}"  | ${row.input}`
			)
		}
	}

	const n = rows.length
	const report = {
		eval: evalPath,
		n,
		argmax: {
			localityMatch: argmaxLocOk / n,
			regionMatch: argmaxRegOk / n,
			latP50: percentile(argmaxLat, 50),
			latP99: percentile(argmaxLat, 99),
		},
		joint: {
			localityMatch: jointLocOk / n,
			regionMatch: jointRegOk / n,
			latP50: percentile(jointLat, 50),
			latP99: percentile(jointLat, 99),
		},
		regressionRate: regressed / n,
		improvementRate: improved / n,
		accuracyDeltaPp: (100 * (jointLocOk + jointRegOk - argmaxLocOk - argmaxRegOk)) / (2 * n),
		latencyP99Multiplier: percentile(argmaxLat, 99) > 0 ? percentile(jointLat, 99) / percentile(argmaxLat, 99) : 0,
	}

	console.log(`\n=== joint-decode vs argmax — ${evalPath} (n=${n}) ===`)
	console.log(
		`  argmax: loc ${pct(argmaxLocOk, n)}  reg ${pct(argmaxRegOk, n)}  p50 ${report.argmax.latP50.toFixed(1)}ms  p99 ${report.argmax.latP99.toFixed(1)}ms`
	)
	console.log(
		`  joint : loc ${pct(jointLocOk, n)}  reg ${pct(jointRegOk, n)}  p50 ${report.joint.latP50.toFixed(1)}ms  p99 ${report.joint.latP99.toFixed(1)}ms`
	)
	console.log(
		`  changed=${changed}  regressed=${regressed} (${pct(regressed, n)})  improved=${improved} (${pct(improved, n)})`
	)
	console.log(
		`  accuracy delta = ${report.accuracyDeltaPp >= 0 ? "+" : ""}${report.accuracyDeltaPp.toFixed(2)}pp  ·  latency p99 ×${report.latencyP99Multiplier.toFixed(2)}`
	)

	const outJson = arg("out-json")

	if (outJson) {
		writeFileSync(outJson, JSON.stringify(report, null, 2))
		console.error(`wrote ${outJson}`)
	}
	;(backend as { close?: () => void }).close?.()
}

main()
