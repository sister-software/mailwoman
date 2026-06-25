/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end resolver eval (Direction C, Phase 1) — the first "address string -> correct WOF place"
 *   benchmark, and the kill/continue gate for the routing thesis.
 *
 *   Per eval row it parses the input BOTH ways — neural (NeuralAddressClassifier) and v0-via-adapter
 *   (rule parser -> v0RecordToTree) — resolves each tree ONCE through the shared WOF resolver, and
 *   records each resolution (most-specific resolved node + its resolver score). All baselines are
 *   then derived from those two resolutions (no extra passes):
 *
 *   - Neural-only : the neural resolution
 *   - V0-via-adapter : the v0 resolution
 *   - Arbiter : pick the higher resolver-score resolution (resolvability as the router)
 *   - Oracle : correct if EITHER resolved correctly (the routing ceiling)
 *
 *   Metrics per canonical/perturbed subset: hierarchy-tolerant Place-Match Acc@1 (resolved id in the
 *   label's acceptable_ids) + great-circle coordinate error.
 *
 *   KILL/CONTINUE: arbiter must beat the better single parser by >=5pp on clean,
 *
 * > =3pp overall, with no perturbed regression -> build routing; else pivot to coverage.
 *
 *   Run (against the CUSTOM gazetteer — never an off-the-shelf dump): node --experimental-strip-types
 *   scripts/eval/resolver-eval.ts\
 *   --eval /tmp/wof-bootstrap/eval.jsonl\
 *   --model /tmp/v072-eval/model.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card /tmp/v072-eval/model-card.json\
 *   --wof
 *   $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db,$MAILWOMAN_DATA_ROOT/wof/postalcode-us.db
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { createWofResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { type ClassificationRecord, createAddressParser } from "mailwoman"
import { readFileSync, writeFileSync } from "node:fs"
import { v0RecordToTree } from "./v0-tree-adapter.ts"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

interface EvalRow {
	input: string
	expected_id: number
	acceptable_ids: number[]
	specificity: string
	lat: number
	lon: number
	perturb: string
	template?: string
}

/** Most-specific placetype wins when several nodes resolved (locality beats region beats country). */
const PLACETYPE_RANK: Record<string, number> = {
	venue: 7,
	building: 7,
	address: 7,
	postalcode: 6,
	locality: 5,
	localadmin: 4,
	borough: 4,
	county: 3,
	region: 2,
	macroregion: 1,
	country: 0,
}

interface Resolution {
	id: number
	lat: number
	lon: number
	score: number
	placetype: string
}

/** Walk a resolved tree, return the most-specific resolver-attributed node (or null). */
function extractResolution(tree: AddressTree): Resolution | null {
	let best: Resolution | null = null
	const visit = (n: AddressNode): void => {
		if (n.placeId?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			const placetype = String(n.sourceId ?? "").split(":")[0] ?? ""
			const cand: Resolution = {
				id: Number(n.placeId.slice(4)),
				lat: n.lat,
				lon: n.lon,
				score: Number((n.metadata as Record<string, unknown> | undefined)?.["resolver_score"] ?? 0),
				placetype,
			}
			if (!best || (PLACETYPE_RANK[placetype] ?? -1) > (PLACETYPE_RANK[best.placetype] ?? -1)) best = cand
		}
		for (const c of n.children) visit(c)
	}
	for (const r of tree.roots) visit(r)
	return best
}

function pct(x: number, n: number): string {
	return n ? `${((100 * x) / n).toFixed(1)}%` : "—"
}
function percentile(xs: number[], p: number): number | null {
	if (xs.length === 0) return null
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

interface RowResult {
	perturb: string
	neural: { id: number | null; matched: boolean; err: number | null; score: number; resolved: boolean }
	v0: { id: number | null; matched: boolean; err: number | null; score: number; resolved: boolean }
}

async function main(): Promise<void> {
	const evalPath = arg("eval", "/tmp/wof-bootstrap/eval.jsonl")
	const limit = Number(arg("limit", "0")) || Infinity
	const wofPaths = arg("wof", dataRootPath("wof", "admin-global-priority.db"))
		.split(",")
		.map((s) => s.trim())

	const rows: EvalRow[] = readFileSync(evalPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l))
		.slice(0, limit === Infinity ? undefined : limit)

	// --- load parsers + resolver ---
	const { NeuralAddressClassifier } = await import("@mailwoman/neural")
	const modelPath = arg("model")
	let neural: InstanceType<typeof NeuralAddressClassifier>
	if (modelPath) {
		const { OnnxRunner } = await import("@mailwoman/neural/onnx-runner")
		const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
		const modelCard = JSON.parse(readFileSync(arg("model-card"), "utf8"))
		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(arg("tokenizer")),
			OnnxRunner.create(modelPath),
		])
		neural = new NeuralAddressClassifier({ tokenizer, runner, labels: modelCard.labels })
	} else {
		neural = await NeuralAddressClassifier.loadFromWeights()
	}
	const v0 = createAddressParser()
	const { WofSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	// PR1 A/B flags: `--exact-tiering false` / `--parent-fallback false` restore the pre-PR1 baseline
	// so the before/after table is one toggle apart.
	const exactTiering = arg("exact-tiering", "true") !== "false"
	const parentFallback = arg("parent-fallback", "true") !== "false"
	const backend = new WofSqlitePlaceLookup(
		{ databasePath: wofPaths.length === 1 ? wofPaths[0]! : wofPaths },
		{ exactMatchTiering: exactTiering }
	)
	const resolver = createWofResolver(backend as never)

	const parseOpts = { postcodeRepair: true } as Parameters<typeof neural.parse>[1]
	const country = arg("country", "US")
	const resolveOpts = { defaultCountry: country, parentFallback }
	console.error(`exactMatchTiering=${exactTiering} parentFallback=${parentFallback}`)
	const results: RowResult[] = []
	let i = 0
	for (const row of rows) {
		i++
		if (i % 250 === 0) console.error(`  ${i}/${rows.length}`)
		// neural
		let nRes: Resolution | null = null
		try {
			nRes = extractResolution(await resolver.resolveTree(await neural.parse(row.input, parseOpts), resolveOpts))
		} catch {
			/* parse/resolve failure → unresolved */
		}
		// v0-via-adapter
		let vRes: Resolution | null = null
		try {
			const sol = await v0.parse(row.input)
			const rec = (sol[0]?.classifications ?? {}) as ClassificationRecord
			vRes = extractResolution(
				(await resolver.resolveTree(v0RecordToTree(row.input, rec).tree, resolveOpts)) as AddressTree
			)
		} catch {
			/* unresolved */
		}
		const score = (res: Resolution | null) => {
			const matched = !!res && row.acceptable_ids.includes(res.id)
			const err = res ? haversineKm(res.lat, res.lon, row.lat, row.lon) : null
			return { id: res?.id ?? null, matched, err, score: res?.score ?? -Infinity, resolved: !!res }
		}
		results.push({ perturb: row.perturb, neural: score(nRes), v0: score(vRes) })
	}

	// --- derive baselines per subset ---
	const subsets = {
		canonical: results.filter((r) => r.perturb === "canonical"),
		perturbed: results.filter((r) => r.perturb !== "canonical"),
		all: results,
	}
	const accOf = (rs: RowResult[], pick: (r: RowResult) => boolean) => rs.filter(pick).length
	const baselines: Record<string, (r: RowResult) => boolean> = {
		"neural-only": (r) => r.neural.matched,
		"v0-via-adapter": (r) => r.v0.matched,
		arbiter: (r) => (r.neural.score >= r.v0.score ? r.neural.matched : r.v0.matched),
		oracle: (r) => r.neural.matched || r.v0.matched,
	}

	console.log(`# Resolver end-to-end eval (${results.length} rows, WOF=${wofPaths.length} shard(s))\n`)
	console.log("| baseline | canonical Acc@1 | perturbed Acc@1 | all Acc@1 |")
	console.log("|---|--:|--:|--:|")
	for (const [name, pick] of Object.entries(baselines)) {
		const c = subsets.canonical,
			p = subsets.perturbed,
			a = subsets.all
		console.log(
			`| ${name} | ${pct(accOf(c, pick), c.length)} | ${pct(accOf(p, pick), p.length)} | ${pct(accOf(a, pick), a.length)} |`
		)
	}

	// coordinate error (neural-only vs arbiter) on resolved rows
	const errNeural = results.map((r) => r.neural.err).filter((e): e is number => e !== null)
	const errArb = results
		.map((r) => (r.neural.score >= r.v0.score ? r.neural.err : r.v0.err))
		.filter((e): e is number => e !== null)
	console.log(
		`\ncoord error km (neural-only): p50=${percentile(errNeural, 50)?.toFixed(1)} p90=${percentile(errNeural, 90)?.toFixed(1)} (resolved ${errNeural.length}/${results.length})`
	)
	console.log(
		`coord error km (arbiter):     p50=${percentile(errArb, 50)?.toFixed(1)} p90=${percentile(errArb, 90)?.toFixed(1)}`
	)
	console.log(
		`(coord error is the ADMIN-CENTROID tier: a city centroid is legitimately tens of km from edge ` +
			`addresses, so a sub-10km bar belongs to a future street-level tier — not this one)`
	)

	// Two-tier failure attribution: separate PARSER-side errors (produced nothing resolvable) from
	// RESOLVER-side errors (resolved to a place, but the wrong one). PR1's exact-match tiering targets
	// the resolver-side bucket — wrong-state cascades from a mis-resolved 2-letter region abbrev.
	const attribution = (pick: (r: RowResult) => RowResult["neural"]) => {
		let matched = 0
		let unresolved = 0
		let wrong = 0
		for (const r of results) {
			const x = pick(r)
			if (x.matched) matched++
			else if (!x.resolved) unresolved++
			else wrong++
		}
		return { matched, unresolved, wrong }
	}
	console.log(`\n## Failure attribution (parser vs resolver)`)
	console.log(`| baseline | matched | unresolved (parser) | resolved-but-wrong (resolver) |`)
	console.log(`|---|--:|--:|--:|`)
	for (const [name, pick] of [
		["neural", (r: RowResult) => r.neural],
		["v0-via-adapter", (r: RowResult) => r.v0],
	] as const) {
		const a = attribution(pick)
		console.log(`| ${name} | ${a.matched} | ${a.unresolved} | ${a.wrong} |`)
	}

	// kill/continue gate
	const acc = (sub: keyof typeof subsets, b: keyof typeof baselines) =>
		(100 * accOf(subsets[sub]!, baselines[b]!)) / subsets[sub]!.length
	const cleanBestSingle = Math.max(acc("canonical", "neural-only"), acc("canonical", "v0-via-adapter"))
	const allBestSingle = Math.max(acc("all", "neural-only"), acc("all", "v0-via-adapter"))
	const cleanGain = acc("canonical", "arbiter") - cleanBestSingle
	const allGain = acc("all", "arbiter") - allBestSingle
	const perturbedReg =
		acc("perturbed", "arbiter") - Math.max(acc("perturbed", "neural-only"), acc("perturbed", "v0-via-adapter"))
	console.log(`\n## Kill/continue gate`)
	console.log(
		`- arbiter vs best single — clean: ${cleanGain >= 0 ? "+" : ""}${cleanGain.toFixed(1)}pp (gate ≥5) | all: ${allGain >= 0 ? "+" : ""}${allGain.toFixed(1)}pp (gate ≥3) | perturbed Δ: ${perturbedReg.toFixed(1)}pp (gate ≥ -2)`
	)
	const pass = cleanGain >= 5 && allGain >= 3 && perturbedReg >= -2
	console.log(
		`- VERDICT: ${pass ? "CONTINUE — build the router" : "does not clear the gate — investigate / pivot to coverage"}`
	)

	if (arg("out-json")) {
		writeFileSync(arg("out-json"), JSON.stringify(results, null, 2))
		console.error(`wrote ${results.length} rows → ${arg("out-json")}`)
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
