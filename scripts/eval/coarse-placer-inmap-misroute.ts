/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #244 default-ON gate — the across-11-countries MISROUTING eval the homograph set under-tests.
 *   The country-disambiguation gate proved the open-set prior WINS on ambiguous namesakes; this
 *   checks the opposite risk: does turning the prior ON ever push an IN-MAP address to the WRONG
 *   IN-MAP country (the placer confidently guesses NL for a German address → the re-rank pulls
 *   resolution to NL)? Default-on is only defensible if that misrouting is rare and unsystematic.
 *
 *   Per the resolver's country-inheritance (resolve.ts): when an address carries an explicit country
 *   token, the locality query is CONSTRAINED to that country and the prior is a no-op. The misroute
 *   risk lives on country-LESS addresses (locality/region only), so we STRIP trailing country
 *   tokens to concentrate the signal — every row becomes the "hard", country-must-be-inferred
 *   case.
 *
 *   Per row: parse once, resolve the SAME tree twice (NO defaultCountry), read the most-specific
 *   resolved node's `spr.country`:
 *
 *   - OFF: no prior - ON: open-set prior (1 - P(OTHER) reject, in-map argmax route) Each row is
 *       classified bothRight / bothWrong / WIN (off wrong → on right) / REGRESSION (off right → on
 *       wrong). Regressions are bucketed by the wrong country the prior introduced — a SYSTEMATIC
 *       bucket (e.g. many DE→NL) is the misroute class that would block default-on.
 *
 *   Run: node --experimental-strip-types scripts/eval/coarse-placer-inmap-misroute.ts\
 *   [--per-country 200] [--abstain-below 0.9] [--out-md <path>]
 */

import { CoarsePlacer, inMapPosterior } from "@mailwoman/core/coarse-placer"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { createWofResolver, type ResolveOpts } from "@mailwoman/resolver"
import { readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

/** The 11 in-map countries; TW is excluded — the WOF admin DB has 0 TW locality/region rows. */
const COUNTRIES = ["US", "FR", "GB", "CN", "NL", "IT", "DE", "JP", "ES", "KR"]
const ANCHOR_WEIGHT = Number(arg("anchor-weight", "1.0"))
const ABSTAIN_BELOW = Number(arg("abstain-below", "0.9"))
const PER_COUNTRY = Number(arg("per-country", "200"))
// `--distribution` feeds the full in-map posterior (vs one-hot argmax) as anchorPosterior (#244 residual).
const DISTRIBUTION = process.argv.includes("--distribution")

// Trailing explicit country tokens to strip so the country must be inferred (where the prior bites).
const COUNTRY_TOKENS =
	/[,\s]+(germany|deutschland|spain|espana|españa|italy|italia|italie|france|netherlands|nederland|holland|united\s+kingdom|great\s+britain|england|scotland|wales|uk|china|中国|japan|日本|korea|south\s+korea|대한민국|united\s+states|usa|u\.s\.a\.|america)\.?\s*$/iu

function stripCountry(raw: string): string {
	let s = raw
	for (let i = 0; i < 2; i++) s = s.replace(COUNTRY_TOKENS, "").trim()
	return s
}

const PLACETYPE_RANK: Record<string, number> = {
	postalcode: 6,
	locality: 5,
	localadmin: 4,
	borough: 4,
	county: 3,
	region: 2,
	macroregion: 1,
	country: 0,
}

function resolvedWofNodes(tree: AddressTree): Array<{ id: number; rank: number }> {
	const out: Array<{ id: number; rank: number }> = []
	const visit = (n: AddressNode): void => {
		if (n.placeId?.startsWith("wof:")) {
			const placetype = String(n.sourceId ?? "").split(":")[0] ?? ""
			out.push({ id: Number(n.placeId.slice(4)), rank: PLACETYPE_RANK[placetype] ?? -1 })
		}
		for (const c of n.children) visit(c)
	}
	for (const r of tree.roots) visit(r)
	return out
}

async function main(): Promise<void> {
	const evalPath = arg("eval", "data/coarse-placer/test.jsonl")
	const wofPath = arg("wof", dataRootPath("wof", "admin-global-priority.db"))
	const modelPath = arg("model", "neural-weights-en-us/model.onnx")
	const tokPath = arg("tokenizer", "neural-weights-en-us/tokenizer.model")
	const cardPath = arg("model-card", "neural-weights-en-us/model-card.json")
	const outMd = arg("out-md", "")

	// Deterministic per-country sample (first PER_COUNTRY rows of each country, stable order).
	const all = readFileSync(evalPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { raw: string; country: string })
	const sample: Array<{ raw: string; country: string }> = []
	const taken: Record<string, number> = {}
	for (const r of all) {
		if (!COUNTRIES.includes(r.country)) continue
		if ((taken[r.country] ?? 0) >= PER_COUNTRY) continue
		const stripped = stripCountry(r.raw)
		if (!stripped) continue // nothing left after stripping → skip
		taken[r.country] = (taken[r.country] ?? 0) + 1
		sample.push({ raw: stripped, country: r.country })
	}

	const card = JSON.parse(readFileSync(cardPath, "utf8")) as { labels: string[]; version?: string }
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(tokPath),
		OnnxRunner.create(modelPath),
	])
	const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: card.labels })

	const { WofSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const backend = new WofSqlitePlaceLookup({ databasePath: wofPath })
	const resolver = createWofResolver(backend as never)
	const placer = await CoarsePlacer.fromBundled({ abstainBelow: ABSTAIN_BELOW, openSet: true })

	const db = new DatabaseSync(wofPath, { readOnly: true })
	const countryStmt = db.prepare("SELECT country FROM spr WHERE id = ?")
	const countryCache = new Map<number, string>()
	const countryOf = (id: number): string => {
		let c = countryCache.get(id)
		if (c === undefined) {
			const r = countryStmt.get(id) as { country?: string } | undefined
			c = (r?.country ?? "").toUpperCase()
			countryCache.set(id, c)
		}
		return c
	}
	const resolvedCountry = async (parsed: AddressTree, opts: ResolveOpts): Promise<string> => {
		const resolved = await resolver.resolveTree(structuredClone(parsed), opts)
		const nodes = resolvedWofNodes(resolved)
		if (nodes.length === 0) return ""
		nodes.sort((a, b) => b.rank - a.rank)
		return countryOf(nodes[0]!.id)
	}

	interface Row {
		gold: string
		placer: string | null
		off: string
		on: string
	}
	const rows: Row[] = []
	let done = 0
	for (const s of sample) {
		const parsed = await neural.parse(s.raw, { postcodeRepair: true })
		const pred = placer.predict(s.raw)
		const usePrior = !!pred.country && pred.country !== "OTHER"
		const posterior = usePrior ? (DISTRIBUTION ? inMapPosterior(pred) : { [pred.country!]: pred.confidence }) : null
		const onOpts: ResolveOpts = posterior ? { anchorPosterior: posterior, anchorWeight: ANCHOR_WEIGHT } : {}
		const off = await resolvedCountry(parsed, {})
		const on = await resolvedCountry(parsed, onOpts)
		rows.push({ gold: s.country, placer: pred.country, off, on })
		if (++done % 200 === 0) console.error(`  ${done}/${sample.length}`)
	}

	// Per-country + global tallies.
	const perCountry: Record<string, { n: number; offR: number; onR: number; win: number; reg: number }> = {}
	const regressionBuckets: Record<string, number> = {} // `${gold}->${onWrong}` → count
	for (const r of rows) {
		const pc = (perCountry[r.gold] ??= { n: 0, offR: 0, onR: 0, win: 0, reg: 0 })
		pc.n++
		const offRight = r.off === r.gold
		const onRight = r.on === r.gold
		if (offRight) pc.offR++
		if (onRight) pc.onR++
		if (!offRight && onRight) pc.win++
		if (offRight && !onRight) {
			pc.reg++
			regressionBuckets[`${r.gold}→${r.on || "—"}`] = (regressionBuckets[`${r.gold}→${r.on || "—"}`] ?? 0) + 1
		}
	}

	const totN = rows.length
	const totOff = rows.filter((r) => r.off === r.gold).length
	const totOn = rows.filter((r) => r.on === r.gold).length
	const totWin = rows.filter((r) => r.off !== r.gold && r.on === r.gold).length
	const totReg = rows.filter((r) => r.off === r.gold && r.on !== r.gold).length

	const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "—")
	const lines: string[] = []
	lines.push(`# Coarse-placer — across-11 in-map MISROUTING gate (#244, path to default-on)`)
	lines.push("")
	lines.push(
		`_Generated by \`scripts/eval/coarse-placer-inmap-misroute.ts\`. ${totN} in-map rows (${PER_COUNTRY}/country × ` +
			`${COUNTRIES.length}; TW excluded — 0 WOF rows). Trailing country tokens STRIPPED so the country must be ` +
			`inferred. Open-set prior, abstainBelow ${ABSTAIN_BELOW}, anchorWeight ${ANCHOR_WEIGHT}, model ${card.version ?? "?"}. ` +
			`Right-country = most-specific resolved node's spr.country, NO defaultCountry._`
	)
	lines.push("")
	lines.push(`## Net effect: ${totWin} wins, ${totReg} regressions (${pct(totReg, totN)}% of rows)`)
	lines.push("")
	lines.push(
		`Right-country OFF ${totOff}/${totN} (${pct(totOff, totN)}%) → ON ${totOn}/${totN} (${pct(totOn, totN)}%).`
	)
	lines.push("")
	lines.push(`| country | n | OFF right | ON right | wins | regressions |`)
	lines.push(`|---|---:|---:|---:|---:|---:|`)
	for (const c of COUNTRIES) {
		const p = perCountry[c]
		if (!p) continue
		lines.push(`| ${c} | ${p.n} | ${pct(p.offR, p.n)}% | ${pct(p.onR, p.n)}% | ${p.win} | ${p.reg} |`)
	}
	lines.push("")
	lines.push(`## Regression buckets (gold → wrong-country the prior introduced)`)
	lines.push("")
	const buckets = Object.entries(regressionBuckets).sort((a, b) => b[1] - a[1])
	if (buckets.length === 0) lines.push(`_None — the prior introduced no in-map misroutes._`)
	else for (const [k, v] of buckets) lines.push(`- \`${k}\`: ${v}`)
	lines.push("")

	const regRate = (100 * totReg) / totN
	const verdict =
		totReg === 0
			? `PASS — zero misroutes; default-on is clean on this probe.`
			: regRate <= 1 &&
				  buckets.every(([, v]) => v <= Math.max(2, 0.02 * (perCountry[buckets[0]![0].split("→")[0]!]?.n ?? totN)))
				? `LEAN PASS — ${totReg} misroutes (${regRate.toFixed(1)}%), no systematic bucket; net ${totWin - totReg >= 0 ? "+" : ""}${totWin - totReg}. Default-on defensible; watch the buckets.`
				: `HOLD — ${totReg} misroutes (${regRate.toFixed(1)}%); a systematic bucket exists. Address before default-on (the posterior-distribution fix).`
	lines.push(`## Verdict`)
	lines.push("")
	lines.push(verdict)
	lines.push("")

	const md = lines.join("\n")
	console.log(md)
	if (outMd) {
		writeFileSync(outMd, md)
		console.error(`\n[written] ${outMd}`)
	}
	db.close()
}

await main()
