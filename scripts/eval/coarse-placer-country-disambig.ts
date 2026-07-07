/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #244 M1 PROMOTION GATE — grade the ASSEMBLED pipeline (parse → resolve), not the
 *   coarse-placer in isolation. The reconcile-retirement lesson: a component's intrinsic accuracy
 *   says nothing about whether it helps the pipeline against ground truth. So this measures the
 *   geocoder's RIGHT-COUNTRY rate WITH vs WITHOUT the coarse-placer's soft country prior on
 *   ambiguous namesakes + off-map inputs.
 *
 *   The A/B lever is EXACTLY the `placeCountry` stage's only effect: it sets
 *   `resolveOpts.anchorPosterior` from the coarse-placer's prediction (threshold 0.9). So toggling
 *   the posterior on/off here is toggling the shipped stage on/off — a faithful assembled-pipeline
 *   A/B, not a simulation.
 *
 *   Per row: parse once, then resolve the SAME tree twice with NO `defaultCountry` (the honest "we
 *   don't know the country" baseline a locale gate would otherwise supply):
 *
 *   - OFF: `resolveTree(tree, {})` — ranking alone disambiguates.
 *   - ON: `resolveTree(tree, { anchorPosterior: {[country]: conf}, anchorWeight: 1.0 })` when the
 *       placer gives a confident IN-MAP guess; identical to OFF when it abstains / says OTHER.
 *
 *   The resolved country is the most-specific resolved admin node's `spr.country` (looked up by the
 *   node's `wof:<id>` in the WOF DB — no shipped-code change to surface it).
 *
 *   Promotion gate (per the soft-signal spec): the prior must IMPROVE the ambiguous/off-map
 *   right-country rate at NO in-map regression. Abstain/OTHER rows MUST be byte-identical OFF vs ON
 *   (a strong invariant the run asserts).
 *
 *   Run: node --experimental-strip-types scripts/eval/coarse-placer-country-disambig.ts\
 *   --eval data/eval/external/country-homograph-real.jsonl\
 *   --wof $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db\
 *   --model neural-weights-en-us/model.onnx\
 *   --tokenizer neural-weights-en-us/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json\
 *   --out-md docs/articles/evals/2026-06-14-coarse-placer-country-disambig.md
 */

import { readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { CoarsePlacer, inMapPosterior } from "@mailwoman/core/coarse-placer"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { createWOFResolver, type ResolveOpts } from "@mailwoman/resolver"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)

	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

/** The coarse-placer's 11 in-map countries (everything else is OTHER / off-map). */
const IN_MAP = new Set(["US", "FR", "GB", "CN", "NL", "IT", "DE", "JP", "ES", "KR", "TW"])

/** Soft-prior wiring defaults from the spec: abstain below 0.9, anchorWeight 1.0. */
const ABSTAIN_BELOW = Number(arg("abstain-below", "0.9"))
const ANCHOR_WEIGHT = Number(arg("anchor-weight", "1.0"))
/** `--openset` uses the M2 in-map-mass reject rule (1 - P(OTHER)) instead of top-class prob. */
const OPENSET = process.argv.includes("--openset")
// `--distribution` feeds the full in-map posterior (vs the one-hot argmax) as anchorPosterior (#244 residual).
const DISTRIBUTION = process.argv.includes("--distribution")

interface HomographRow {
	raw: string
	components: Record<string, string>
	country: string // gold ISO alpha-2
}

/** Most-specific resolved admin placetype wins. */
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

/** The WOF ids of every resolver-attributed node, with their placetype rank. */
function resolvedWOFNodes(tree: AddressTree): Array<{ id: number; rank: number; placetype: string }> {
	const out: Array<{ id: number; rank: number; placetype: string }> = []
	const visit = (n: AddressNode): void => {
		if (n.placeID?.startsWith("wof:")) {
			const placetype = String(n.sourceID ?? "").split(":")[0] ?? ""
			out.push({ id: Number(n.placeID.slice(4)), rank: PLACETYPE_RANK[placetype] ?? -1, placetype })
		}

		for (const c of n.children) {
			visit(c)
		}
	}

	for (const r of tree.roots) {
		visit(r)
	}

	return out
}

async function main(): Promise<void> {
	const evalPath = arg("eval", "data/eval/external/country-homograph-real.jsonl")
	const wofPath = arg("wof", dataRootPath("wof", "admin-global-priority.db"))
	const modelPath = arg("model", "neural-weights-en-us/model.onnx")
	const tokPath = arg("tokenizer", "neural-weights-en-us/tokenizer.model")
	const cardPath = arg("model-card", "neural-weights-en-us/model-card.json")
	const outMd = arg("out-md", "")

	const rows: HomographRow[] = readFileSync(evalPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as HomographRow)

	const card = JSON.parse(readFileSync(cardPath, "utf8")) as { labels: string[]; version?: string }
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(tokPath),
		ONNXRunner.create(modelPath),
	])
	const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: card.labels })

	const { WOFSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const backend = new WOFSqlitePlaceLookup({ databasePath: wofPath })
	const resolver = createWOFResolver(backend as never)

	const placer = await CoarsePlacer.fromBundled({ abstainBelow: ABSTAIN_BELOW, openSet: OPENSET })

	// Read-only country lookup over the resolved place's WOF id (spr.country is ISO alpha-2).
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

	/** Resolve a fresh clone of the parsed tree and read the most-specific resolved node's country. */
	const resolvedCountry = async (parsed: AddressTree, opts: ResolveOpts): Promise<string> => {
		const clone = structuredClone(parsed)
		const resolved = await resolver.resolveTree(clone, opts)
		const nodes = resolvedWOFNodes(resolved)

		if (nodes.length === 0) return ""
		nodes.sort((a, b) => b.rank - a.rank)

		return countryOf(nodes[0]!.id)
	}

	interface Outcome {
		row: HomographRow
		inMap: boolean
		placerCountry: string | null
		placerConf: number
		abstained: boolean
		off: string
		on: string
		offRight: boolean
		onRight: boolean
	}

	const outcomes: Outcome[] = []

	for (const row of rows) {
		const parsed = await neural.parse(row.raw, { postcodeRepair: true })
		const pred = placer.predict(row.raw)
		const usePrior = !!pred.country && pred.country !== "OTHER"
		const posterior = usePrior ? (DISTRIBUTION ? inMapPosterior(pred) : { [pred.country!]: pred.confidence }) : null
		const onOpts: ResolveOpts = posterior ? { anchorPosterior: posterior, anchorWeight: ANCHOR_WEIGHT } : {}

		const off = await resolvedCountry(parsed, {})
		const on = await resolvedCountry(parsed, onOpts)
		const gold = row.country.toUpperCase()

		outcomes.push({
			row,
			inMap: IN_MAP.has(gold),
			placerCountry: pred.country,
			placerConf: pred.confidence,
			abstained: pred.abstained || pred.country === "OTHER",
			off,
			on,
			offRight: off === gold,
			onRight: on === gold,
		})
	}

	// ---- Aggregate ----
	const tally = (subset: Outcome[]) => {
		const n = subset.length
		const offR = subset.filter((o) => o.offRight).length
		const onR = subset.filter((o) => o.onRight).length

		return { n, off: offR, on: onR, offPct: n ? (100 * offR) / n : 0, onPct: n ? (100 * onR) / n : 0 }
	}
	const all = tally(outcomes)
	const inMap = tally(outcomes.filter((o) => o.inMap))
	const offMap = tally(outcomes.filter((o) => !o.inMap))

	const wins = outcomes.filter((o) => !o.offRight && o.onRight)
	const regressions = outcomes.filter((o) => o.offRight && !o.onRight)
	const flipsNeutral = outcomes.filter((o) => o.off !== o.on && o.offRight === o.onRight)

	// Strong invariant: when the placer gave NO signal (abstain / OTHER), OFF and ON resolve identically.
	const invariantViolations = outcomes.filter((o) => o.abstained && o.off !== o.on)

	const pct = (x: number) => x.toFixed(1)
	const lines: string[] = []
	lines.push(`# Coarse-placer soft prior — assembled-pipeline country-disambiguation gate (#244 M1)`)
	lines.push("")
	lines.push(
		`_Generated by \`scripts/eval/coarse-placer-country-disambig.ts\`. Eval set: \`${evalPath}\` (${rows.length} rows). ` +
			`Model ${card.version ?? "?"}, ${OPENSET ? "OPEN-SET (1-P(OTHER))" : "max-prob"} reject rule, abstainBelow ${ABSTAIN_BELOW}, anchorWeight ${ANCHOR_WEIGHT}. ` +
			`Right-country = most-specific resolved admin node's \`spr.country\` vs gold, NO defaultCountry (honest unknown-country baseline)._`
	)
	lines.push("")
	lines.push(
		`> **Scope.** The baseline resolves with NO \`defaultCountry\` — the multi-locale / no-locale-gate path the ` +
			`soft prior exists to serve (library batch geocoding, the client demo). A flow that already pins ` +
			`\`--default-country US\` or runs the locale gate fixes most in-map cases without the prior; this gate ` +
			`isolates the prior's contribution where no other country signal exists. Off-map rows (gold ∉ the 11) ` +
			`are the graceful-degradation check: the placer says \`OTHER\` (or a low-confidence abstain) and injects ` +
			`no posterior, so the resolver ranks unconstrained — the prior must not move them.`
	)
	lines.push("")
	lines.push(`## Right-country rate — WITHOUT vs WITH the prior`)
	lines.push("")
	lines.push(`| Subset | n | OFF | ON | Δ |`)
	lines.push(`|---|---:|---:|---:|---:|`)
	lines.push(
		`| **All** | ${all.n} | ${all.off}/${all.n} (${pct(all.offPct)}%) | ${all.on}/${all.n} (${pct(all.onPct)}%) | ${(all.onPct - all.offPct >= 0 ? "+" : "") + pct(all.onPct - all.offPct)}pp |`
	)
	lines.push(
		`| In-map (placer's 11) | ${inMap.n} | ${inMap.off}/${inMap.n} (${pct(inMap.offPct)}%) | ${inMap.on}/${inMap.n} (${pct(inMap.onPct)}%) | ${(inMap.onPct - inMap.offPct >= 0 ? "+" : "") + pct(inMap.onPct - inMap.offPct)}pp |`
	)
	lines.push(
		`| Off-map (OTHER) | ${offMap.n} | ${offMap.off}/${offMap.n} (${pct(offMap.offPct)}%) | ${offMap.on}/${offMap.n} (${pct(offMap.onPct)}%) | ${(offMap.onPct - offMap.offPct >= 0 ? "+" : "") + pct(offMap.onPct - offMap.offPct)}pp |`
	)
	lines.push("")
	lines.push(`## Movement`)
	lines.push("")
	lines.push(`- **Wins** (wrong → right): ${wins.length}`)
	lines.push(`- **Regressions** (right → wrong): ${regressions.length}`)
	lines.push(`- **Neutral flips** (country changed, correctness unchanged): ${flipsNeutral.length}`)
	lines.push(
		`- **Abstain/OTHER rows** (no signal → must be identical OFF/ON): ${outcomes.filter((o) => o.abstained).length}`
	)
	lines.push(
		`- **Invariant violations** (abstained but OFF≠ON): ${invariantViolations.length} ${invariantViolations.length === 0 ? "✅" : "❌"}`
	)
	lines.push("")

	const showRows = (label: string, subset: Outcome[]) => {
		if (subset.length === 0) return
		lines.push(`### ${label}`)
		lines.push("")
		lines.push(`| input | gold | placer | OFF | ON |`)
		lines.push(`|---|---|---|---|---|`)

		for (const o of subset) {
			const placer = o.abstained ? `_(abstain)_` : `${o.placerCountry} ${o.placerConf.toFixed(2)}`
			lines.push(`| ${o.row.raw} | ${o.row.country} | ${placer} | ${o.off || "—"} | ${o.on || "—"} |`)
		}
		lines.push("")
	}
	showRows("Wins", wins)
	showRows("Regressions", regressions)
	showRows("Neutral flips", flipsNeutral)

	const verdict =
		regressions.length === 0 && all.onPct >= all.offPct
			? `PASS — no regression; right-country ${pct(all.offPct)}% → ${pct(all.onPct)}% (in-map ${pct(inMap.offPct)}→${pct(inMap.onPct)}).`
			: `MISS — ${regressions.length} regression(s); right-country ${pct(all.offPct)}% → ${pct(all.onPct)}%.`
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

	if (invariantViolations.length > 0) {
		console.error(`\n[FAIL] ${invariantViolations.length} byte-stability invariant violations`)
		process.exitCode = 1
	}
	db.close()
}

await main()
