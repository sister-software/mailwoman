/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #220 diagnostic — WHERE did the anchor-absorption shard cost house_number? eval-error-analysis
 *   showed v192 95.8 -> A2 92.8 (51 more FN) but its capped example list never surfaces the
 *   house_number FNs. This diffs two models ROW-BY-ROW over the golden US rows: for every gold
 *   house_number, parse with BOTH (anchor-ON, the production config), collect the rows where the
 *   BASE model is right and the CANDIDATE is wrong, and report WHAT the candidate labeled the
 *   house-number value instead (postcode / street / dropped). Both run anchor-ON + gazetteer +
 *   suppression, exactly as production.
 *
 *   Run: node --experimental-strip-types --expose-gc scripts/eval/hn-regression-diff.ts\
 *   --base <v192 int8> --candidate <A2 int8> [--golden data/eval/golden/v0.1.2]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import type { ComponentTag } from "@mailwoman/core/types"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)

	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const BASE = arg("base", dataRootPath("models", "quantized", "model-v192-step-40000-int8.onnx"))
const CAND = arg("candidate", "./out/v193a2/model.onnx")
const GOLDEN = arg("golden", "data/eval/golden/v0.1.2")
const TOK = arg("tokenizer", dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model"))
const CARD = arg("model-card", "neural-weights-en-us/model-card.json")
const ANCHOR = arg("anchor", dataRootPath("anchor", "pilot-anchor-lookup.json"))
const GAZ = arg("gazetteer-lexicon", "data/gazetteer/anchor-lexicon-v1.json")

interface Row {
	raw: string
	components: Partial<Record<ComponentTag, string>>
	country?: string
}
const norm = (v: string | undefined): string => (v ?? "").trim().toLowerCase()

async function build(model: string) {
	const card = JSON.parse(readFileSync(CARD, "utf8"))
	const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create(model)])

	return new NeuralAddressClassifier({
		tokenizer,
		runner,
		labels: card.labels,
		postcodeAnchorLookup: existsSync(ANCHOR) ? parseAnchorLookup(JSON.parse(readFileSync(ANCHOR, "utf8"))) : undefined,
		gazetteerLexicon: existsSync(GAZ) ? parseGazetteerLexicon(JSON.parse(readFileSync(GAZ, "utf8"))) : undefined,
		suppressGazetteerNearPostcode: true,
	})
}

/**
 * Which tag did the model assign the gold house-number VALUE to? (postcode / street / … / "DROPPED").
 */
function whereDidItGo(pred: Record<string, string>, goldHn: string): string {
	const g = norm(goldHn)

	for (const [tag, val] of Object.entries(pred)) {
		if (tag === "house_number") continue

		if (norm(val).split(/\s+/).includes(g) || norm(val) === g) return tag
	}

	return "DROPPED/O"
}

function loadUsRows(dir: string): Row[] {
	const out: Row[] = []

	for (const sub of ["dev", "test", "."]) {
		const d = join(dir, sub)

		if (!existsSync(d)) continue

		for (const f of readdirSync(d)) {
			if (!f.endsWith(".jsonl")) continue

			if (!/us|en-us/i.test(f) && f !== "us.jsonl") continue

			for (const line of readFileSync(join(d, f), "utf8").split("\n")) {
				if (!line.trim()) continue
				const r = JSON.parse(line) as Row

				if (r.components?.house_number) out.push(r)
			}
		}
	}

	return out
}

async function main() {
	const base = await build(BASE)
	const cand = await build(CAND)
	const rows = loadUsRows(GOLDEN)
	console.error(`Diffing ${rows.length} golden US rows with a gold house_number…`)

	let baseRight = 0
	let candRight = 0
	const regressions: { raw: string; gold: string; went: string }[] = []
	const wentCounts: Record<string, number> = {}
	let i = 0

	for (const row of rows) {
		if (++i % 50 === 0) (globalThis as { gc?: () => void }).gc?.()
		const gold = norm(row.components.house_number)
		const pB = decodeAsJSON(await base.parse(row.raw, {})) as Record<string, string>
		const pC = decodeAsJSON(await cand.parse(row.raw, {})) as Record<string, string>
		const bOk = norm(pB.house_number) === gold
		const cOk = norm(pC.house_number) === gold

		if (bOk) baseRight++

		if (cOk) candRight++

		if (bOk && !cOk) {
			const went = whereDidItGo(pC, row.components.house_number!)
			wentCounts[went] = (wentCounts[went] ?? 0) + 1

			if (regressions.length < 40) regressions.push({ raw: row.raw, gold, went })
		}
	}

	console.log(
		`\n=== house_number: base ${baseRight}/${rows.length} right, candidate ${candRight}/${rows.length} right ===`
	)
	console.log(
		`REGRESSIONS (base right, candidate wrong): ${baseRight - candRight} net; ${regressions.length}+ examples`
	)
	console.log(`Where the candidate sent the house number instead:`, JSON.stringify(wentCounts))
	console.log(`\n--- regressed rows (gold house_number → what the candidate called it) ---`)

	for (const r of regressions) console.log(`  [${r.went}]  gold.hn=${r.gold}  raw=${JSON.stringify(r.raw)}`)
}

void main()
