/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Learned-scorer CROSS-STATE generalization (#603 Tier 2, the next axis after the held-out-NPI A/B
 *   in `learned-scorer-clustering-eval.ts`). The held-out-NPI A/B showed the GBT beats the FS baseline
 *   on clustering by +5.2pp — but the GBT was trained and evaluated within ONE state (TX). The
 *   production question is whether that win GENERALIZES: train on one state, evaluate the dedup
 *   clustering F1 on a DIFFERENT state the model never saw. If it holds, the GBM is
 *   production-worthy; if it collapses, the scorer is fitting state-specific structure and needs
 *   per-state training (a finding either way).
 *
 *   One registry pass builds the global address-frequency table + a TRAIN-state sample + an
 *   EVAL-state sample; both are geocoded; the GBT + LR are trained on the train state's pairs and
 *   used to cluster the eval state's records through the same `resolveEntities` pipeline (FS baseline
 *   / GBT scorer / LR scorer), best F1 over a fine per-scorer threshold sweep. The metric is the
 *   dedup benchmark's clustering F1.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/learned-scorer-crossstate-eval.ts\
 *   [--train-state TX] [--eval-state CA] [--npis 2000] [--out-md <md>]
 */

import { decodeAsJson } from "@mailwoman/core/decoder"
import { createWofResolver, type ResolverBackend } from "@mailwoman/core/resolver"
import { block, gbtScore, trainGBT } from "@mailwoman/match"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import {
	addressFrequencyKey,
	buildDefaultModel,
	createGbtScorer,
	createMatchFeaturizer,
	DEDUP_GBT_MODEL,
	defaultBlockingKeys,
	geocodeAddressVia,
	ingestRows,
	resolveEntities,
	streamRows,
	type ColumnMapping,
	type ResolvedEntity,
	type SourceRecord,
} from "@mailwoman/registry"
import { writeFileSync } from "node:fs"
import { geocodeAddress, ShardProvider } from "../../mailwoman/out/geocode-core.js"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}
const SOURCES = arg("sources", "/mnt/playpen/mailwoman-data/record-matcher/sources")
const TRAIN_STATE = arg("train-state", "TX").toUpperCase()
const EVAL_STATE = arg("eval-state", "CA").toUpperCase()
const NPIS = Number(arg("npis", "2000"))
const WOF = arg("wof", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
const DATA_ROOT = arg("data-root", "/mnt/playpen/mailwoman-data")
const OUT_MD = arg("out-md", "")

const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`
const OTHER_NAMES = `${SOURCES}/nppes_other-names_20260607.tsv`

const C = {
	npi: "NPI",
	entityType: "Entity Type Code",
	orgLegal: "Provider Organization Name (Legal Business Name)",
	last: "Provider Last Name (Legal Name)",
	first: "Provider First Name",
	pAddr: "Provider First Line Business Practice Location Address",
	pCity: "Provider Business Practice Location Address City Name",
	pState: "Provider Business Practice Location Address State Name",
	pZip: "Provider Business Practice Location Address Postal Code",
	mAddr: "Provider First Line Business Mailing Address",
	mCity: "Provider Business Mailing Address City Name",
	mState: "Provider Business Mailing Address State Name",
	mZip: "Provider Business Mailing Address Postal Code",
	otherOrg: "Provider Other Organization Name",
}
const norm = (s: string | undefined) => (s ?? "").trim()
const addr = (line: string, city: string, st: string, zip: string) =>
	[norm(line), norm(city), norm(st), norm(zip)].filter(Boolean).join(", ")
const choose2 = (n: number) => (n * (n - 1)) / 2

interface MessyRow {
	npi: string
	name: string
	org: string
	address: string
}

/** The dedup benchmark's pairwise clustering metric vs the NPI grouping (record.id = NPI). */
function scoreClusters(entities: ResolvedEntity[]): {
	precision: number
	recall: number
	f1: number
	overMerged: number
} {
	const npiTotals = new Map<string, number>()
	let sumCK = 0
	let sumCluster = 0
	let overMerged = 0
	for (const e of entities) {
		const byNpi = new Map<string, number>()
		for (const rec of e.records) byNpi.set(rec.id, (byNpi.get(rec.id) ?? 0) + 1)
		sumCluster += choose2(e.records.length)
		if (byNpi.size > 1) overMerged++
		for (const [npi, c] of byNpi) {
			sumCK += choose2(c)
			npiTotals.set(npi, (npiTotals.get(npi) ?? 0) + c)
		}
	}
	let sumClass = 0
	for (const total of npiTotals.values()) sumClass += choose2(total)
	const tp = sumCK
	const precision = sumCluster > 0 ? tp / sumCluster : 0
	const recall = sumClass > 0 ? tp / sumClass : 0
	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
	return { precision, recall, f1, overMerged }
}

async function main(): Promise<void> {
	console.error("[A] streaming other-names…")
	const altNames = new Map<string, string[]>()
	for await (const r of streamRows(OTHER_NAMES)) {
		const npi = norm(r[C.npi])
		const alt = norm(r[C.otherOrg])
		if (!npi || !alt) continue
		const list = altNames.get(npi) ?? []
		if (list.length < 5) list.push(alt)
		altNames.set(npi, list)
	}

	// ONE registry pass: global address-frequency + a TRAIN-state sample + an EVAL-state sample.
	console.error(`[B] registry pass: address-frequency + ${NPIS} ${TRAIN_STATE} (train) + ${NPIS} ${EVAL_STATE} (eval)…`)
	const samples: Record<string, { rows: MessyRow[]; kept: Set<string> }> = {
		[TRAIN_STATE]: { rows: [], kept: new Set() },
		[EVAL_STATE]: { rows: [], kept: new Set() },
	}
	const addrCounts = new Map<string, number>()
	let addrTotal = 0
	let scanned = 0
	for await (const r of streamRows(REGISTRY)) {
		if (++scanned % 1_000_000 === 0) console.error(`    scanned ${scanned / 1e6}M`)
		const practice = addr(r[C.pAddr]!, r[C.pCity]!, r[C.pState]!, r[C.pZip]!)
		if (practice) {
			const k = addressFrequencyKey(practice)
			addrCounts.set(k, (addrCounts.get(k) ?? 0) + 1)
			addrTotal++
		}
		const npi = norm(r[C.npi])
		const st = norm(r[C.pState]).toUpperCase()
		const bucket = samples[st]
		if (bucket && bucket.kept.size < NPIS && npi && !bucket.kept.has(npi) && altNames.has(npi) && practice) {
			const isOrg = norm(r[C.entityType]) === "2"
			const primaryName = isOrg ? norm(r[C.orgLegal]) : `${norm(r[C.first])} ${norm(r[C.last])}`.trim()
			if (primaryName) {
				const org = isOrg ? norm(r[C.orgLegal]) : ""
				bucket.kept.add(npi)
				bucket.rows.push({ npi, name: primaryName, org, address: practice })
				for (const alt of altNames.get(npi)!) bucket.rows.push({ npi, name: alt, org: alt, address: practice })
				const mailing = addr(r[C.mAddr]!, r[C.mCity]!, r[C.mState]!, r[C.mZip]!)
				if (mailing && mailing !== practice) bucket.rows.push({ npi, name: primaryName, org, address: mailing })
			}
		}
	}
	const addressFrequency = {
		total: addrTotal,
		distinct: addrCounts.size,
		frequency: (v: string) => (v ? (addrCounts.get(addressFrequencyKey(v)) ?? 0) / addrTotal : 0),
	}
	console.error(
		`    ${TRAIN_STATE}: ${samples[TRAIN_STATE]!.kept.size} NPIs → ${samples[TRAIN_STATE]!.rows.length} records · ` +
			`${EVAL_STATE}: ${samples[EVAL_STATE]!.kept.size} NPIs → ${samples[EVAL_STATE]!.rows.length} records`
	)

	console.error("[C] geocoding both states…")
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new mod.WofSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWofResolver(lookup as unknown as ResolverBackend)
	const shardProvider = new ShardProvider(mod, DATA_ROOT)
	const seam = geocodeAddressVia({
		parse: async (raw: string) => decodeAsJson(await classifier.parse(raw, { postcodeRepair: true })),
		geocode: async (raw: string) =>
			geocodeAddress(raw, {
				classifier,
				resolver,
				shards: shardProvider.for,
				defaultCountry: "US",
				placeCountry: false,
			}),
		country: "US",
	})
	const mapping: ColumnMapping = { id: "npi", name: "name", organization: "org", address: "address", source: "nppes" }
	const geocodeRows = (rows: MessyRow[]) =>
		ingestRows(rows as unknown as Record<string, string>[], mapping, { geocodeAddress: seam })
	const trainRecords = await geocodeRows(samples[TRAIN_STATE]!.rows)
	const evalRecords = await geocodeRows(samples[EVAL_STATE]!.rows)
	shardProvider.close()
	lookup.close()

	// Feature basis: the SHARED production featurizer (train ≡ eval ≡ inference, one definition) over the
	// collapsed-spatial + address-frequency comparison set (the baseline).
	const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons
	const featurize = createMatchFeaturizer({ comparisons, addressFrequency })

	console.error(`[D] training GBT + LR on ${TRAIN_STATE} pairs…`)
	const { pairs: trainPairs } = block(trainRecords, defaultBlockingKeys())
	const trainX = trainPairs.map(([a, b]) => featurize(a, b))
	const trainY = trainPairs.map(([a, b]) => (a.id === b.id ? 1 : 0))
	const posRate = trainY.reduce((s, v) => s + v, 0) / Math.max(1, trainY.length)
	const trainW = trainY.map((y) => (y === 1 ? 1 - posRate : posRate))
	const dim = trainX[0]?.length ?? 0
	const gbt = trainGBT(trainX, trainY, trainW, { rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 })
	const w = new Array<number>(dim).fill(0)
	let bias = 0
	const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))))
	for (let epoch = 0; epoch < 400; epoch++) {
		const gw = new Array<number>(dim).fill(0)
		let gb = 0
		for (let i = 0; i < trainX.length; i++) {
			let z = bias
			for (let j = 0; j < dim; j++) z += w[j]! * trainX[i]![j]!
			const err = (sigmoid(z) - trainY[i]!) * trainW[i]!
			for (let j = 0; j < dim; j++) gw[j]! += err * trainX[i]![j]!
			gb += err
		}
		for (let j = 0; j < dim; j++) w[j]! -= 0.1 * (gw[j]! / trainX.length + 1e-3 * w[j]!)
		bias -= 0.1 * (gb / trainX.length)
	}
	const lrSc = (x: number[]) => {
		let z = bias
		for (let j = 0; j < x.length; j++) z += w[j]! * x[j]!
		return z
	}
	const gbtScorer = (a: SourceRecord, b: SourceRecord) => gbtScore(gbt, featurize(a, b))
	const lrScorer = (a: SourceRecord, b: SourceRecord) => lrSc(featurize(a, b))

	console.error(`[E] clustering ${EVAL_STATE} records (FS baseline vs GBT vs LR, trained on ${TRAIN_STATE})…`)
	interface ArmScore {
		precision: number
		recall: number
		f1: number
		overMerged: number
	}
	const bestOver = (thresholds: number[], cfg: (t: number) => Parameters<typeof resolveEntities>[1]): ArmScore => {
		let best: ArmScore = { precision: 0, recall: 0, f1: -1, overMerged: 0 }
		for (const t of thresholds) {
			const s = scoreClusters(resolveEntities(evalRecords, cfg(t)).entities)
			if (s.f1 > best.f1) best = s
		}
		return best
	}
	const { pairs: evalPairs } = block(evalRecords, defaultBlockingKeys())
	const quantileThresholds = (scores: number[]): number[] => {
		const sorted = [...scores].sort((p, q) => p - q)
		const ts = new Set<number>()
		for (let k = 0; k <= 32; k++) ts.add(sorted[Math.floor((0.2 + (0.999 - 0.2) * (k / 32)) * (sorted.length - 1))]!)
		return [...ts]
	}
	const fs = bestOver(
		Array.from({ length: 26 }, (_, i) => i),
		// learnedScorer:false — the FS baseline is the baseline (the learned scorer is now default-on, so
		// without this the "FS arm" would silently BE the GBT).
		(t) => ({ addressFrequency, collapseSpatial: true, trainEM: true, threshold: t, learnedScorer: false })
	)
	const gbtArm = bestOver(quantileThresholds(evalPairs.map(([a, b]) => gbtScorer(a, b))), (t) => ({
		addressFrequency,
		collapseSpatial: true,
		scorer: gbtScorer,
		threshold: t,
	}))
	const lrArm = bestOver(quantileThresholds(evalPairs.map(([a, b]) => lrScorer(a, b))), (t) => ({
		addressFrequency,
		collapseSpatial: true,
		scorer: lrScorer,
		threshold: t,
	}))
	// The SHIPPED model (the default-on candidate): the bundled DEDUP_GBT_MODEL, NOT a fresh per-run TX
	// fit. This is the arm that justifies flipping `learnedScorer` default-on — the actual artifact every
	// caller would get, evaluated on a state it never trained on.
	const bundledScorer = createGbtScorer({ model: DEDUP_GBT_MODEL, comparisons, addressFrequency })
	const bundledArm = bestOver(quantileThresholds(evalPairs.map(([a, b]) => bundledScorer(a, b))), (t) => ({
		addressFrequency,
		collapseSpatial: true,
		scorer: bundledScorer,
		threshold: t,
	}))
	const dBundled = bundledArm.f1 - fs.f1

	const pct = (x: number) => (100 * x).toFixed(1)
	const sgn = (x: number) => (x >= 0 ? "+" : "")
	const dGbt = gbtArm.f1 - fs.f1
	const dLr = lrArm.f1 - fs.f1
	console.error(
		`    FS  ${pct(fs.f1)}%  ·  LR ${pct(lrArm.f1)}% (${sgn(dLr)}${pct(dLr)})  ·  GBT ${pct(gbtArm.f1)}% (${sgn(dGbt)}${pct(dGbt)})` +
			`  ·  BUNDLED ${pct(bundledArm.f1)}% (${sgn(dBundled)}${pct(dBundled)})`
	)

	const row = (label: string, a: ArmScore, d: number | null, bold: boolean) => {
		const dCell = d === null ? "—" : `${sgn(d * 100)}${(d * 100).toFixed(1)}pp`
		const f1 = bold ? `**${pct(a.f1)}%**` : `${pct(a.f1)}%`
		return `| ${bold ? `**${label}**` : label} | ${pct(a.precision)}% | ${pct(a.recall)}% | ${f1} | ${bold ? `**${dCell}**` : dCell} | ${a.overMerged} |`
	}
	const lines: string[] = []
	lines.push(`# Learned-scorer CROSS-STATE generalization (#603 Tier 2) — train ${TRAIN_STATE}, evaluate ${EVAL_STATE}`)
	lines.push("")
	lines.push(
		`_Generated by \`scripts/record-matcher/learned-scorer-crossstate-eval.ts\`. The GBT + LR are trained on ` +
			`${samples[TRAIN_STATE]!.kept.size} ${TRAIN_STATE} NPIs (${trainRecords.length} records) and used to cluster ` +
			`${samples[EVAL_STATE]!.kept.size} held-out ${EVAL_STATE} NPIs (${evalRecords.length} records) — a state the model ` +
			`never saw — through the same \`resolveEntities\` pipeline (FS baseline / GBT scorer / LR scorer), best F1 over a fine ` +
			`per-scorer threshold sweep. This is the generalization axis the within-state held-out-NPI A/B couldn't cover._`
	)
	lines.push("")
	lines.push(`## Result — ${EVAL_STATE} clustering F1 (GBT/LR trained on ${TRAIN_STATE})`)
	lines.push("")
	lines.push(`| scorer | precision | recall | F1 | ΔF1 vs FS | over-merged |`)
	lines.push(`|---|---:|---:|---:|---:|---:|`)
	lines.push(row("FS baseline (EM-fit)", fs, null, false))
	lines.push(row("logistic regression", lrArm, dLr, false))
	lines.push(row(`GBT (fresh ${TRAIN_STATE} fit)`, gbtArm, dGbt, false))
	lines.push(row("SHIPPED bundled model (default-on candidate)", bundledArm, dBundled, true))
	lines.push("")
	lines.push(
		`The **bundled** row is the actual shipped \`DEDUP_GBT_MODEL\` (the default-on candidate), evaluated on ` +
			`${EVAL_STATE} — a state it never trained on. The "fresh ${TRAIN_STATE} fit" row retrains per run for comparison.`
	)
	lines.push("")
	const verdict =
		dGbt > 0.02
			? `**The GBT win GENERALIZES across states** — trained on ${TRAIN_STATE}, it still beats the FS baseline on ${EVAL_STATE} ` +
				`clustering F1 (${pct(gbtArm.f1)}% vs ${pct(fs.f1)}%, ${sgn(dGbt * 100)}${(dGbt * 100).toFixed(1)}pp). The learned scorer ` +
				`isn't fitting ${TRAIN_STATE}-specific structure; the over-merge signal it learns transfers. This is the strongest ` +
				`evidence yet for the #603 production GBM — one model, trained once, helps a state it never saw.`
			: dGbt < -0.02
				? `**The GBT win does NOT generalize** — trained on ${TRAIN_STATE}, it is WORSE than the FS baseline on ${EVAL_STATE} ` +
					`(${pct(gbtArm.f1)}% vs ${pct(fs.f1)}%, ${(dGbt * 100).toFixed(1)}pp). The within-state gain was state-specific ` +
					`structure; a production GBM would need per-state (or much broader) training. Important caveat for #603.`
				: `**The GBT roughly TIES the FS baseline cross-state** (${pct(gbtArm.f1)}% vs ${pct(fs.f1)}%, ` +
					`${sgn(dGbt * 100)}${(dGbt * 100).toFixed(1)}pp). The within-state win attenuates across states — partial ` +
					`generalization. A production GBM likely needs broader/multi-state training to recover the full within-state margin.`
	lines.push(verdict)
	lines.push("")
	lines.push(`## Honest caveats`)
	lines.push("")
	lines.push(
		`A single train/eval state pair (${TRAIN_STATE}→${EVAL_STATE}), one geocoded sample each, a compact pure-Node GBT ` +
			`(120 rounds, depth 3). The FS arm is the benchmark baseline (same model), so the comparison is fair. Absolute F1 ` +
			`differs from the within-state A/B because the eval population + over-merge density differ by state. NPI-as-truth is ` +
			`conservative. The within-state held-out-NPI A/B (\`learned-scorer-clustering-eval.ts\`) is the companion; together ` +
			`they bound the generalization question a production GBM must answer._`
	)
	lines.push("")
	const md = lines.join("\n")
	console.log(md)
	if (OUT_MD) {
		writeFileSync(OUT_MD, md)
		console.error(`[written] ${OUT_MD}`)
	}
}

await main()
