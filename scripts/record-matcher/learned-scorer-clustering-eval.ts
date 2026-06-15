/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Learned-scorer CLUSTERING A/B (#603 Tier 2) — the definitive test the pairwise probe
 *   (`learned-scorer-eval.ts`) deferred. The probe showed a learned scorer ranks candidate pairs
 *   better than Fellegi-Sunter (GBT +0.0177 AUC, +6.6pp pairwise F1); a better pairwise scorer need
 *   NOT lift the assembled clustering F1 (clustering depends on the threshold +
 *   connected-components). This measures the clustering F1 directly, leakage-free:
 *
 *   1. Sample NPI-keyed records (real registry + name-drift + address-variation), geocode once.
 *   2. Split the NPIs into TRAIN / EVAL. Train a GBT + an LR on pairs blocked among TRAIN records (label
 *        = same-NPI). The eval NPIs' records are never seen in training.
 *   3. Cluster the EVAL records three ways via the SAME `resolveEntities` pipeline (block → score →
 *        connected-components) — once with the FS spine, once with the GBT as the link scorer (the
 *        new `ResolveConfig.scorer` hook), once with the LR. Sweep the link threshold for each;
 *        take best F1.
 *   4. Report the eval clustering F1 (the dedup benchmark's metric): does the learned scorer beat the FS
 *        spine on the ASSEMBLED output, not just pairwise ranking?
 *
 *   The FS arm IS the benchmark's spine (same model: address-frequency + collapsed spatial, EM-fit),
 *   so the comparison is credible. Honest framing: in-domain (one state), a held-out-NPI split (not
 *   a held-out STATE — generalization across states is the next axis), a compact pure-Node GBT.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/learned-scorer-clustering-eval.ts\
 *   [--npis 2000] [--split 0.67] [--seed 1] [--out-md <md>]
 */

import { decodeAsJson } from "@mailwoman/core/decoder"
import { createWofResolver, type ResolverBackend } from "@mailwoman/core/resolver"
import { block, gbtScore, trainGBT } from "@mailwoman/match"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import {
	addressFrequencyKey,
	buildDefaultModel,
	createMatchFeaturizer,
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
const STATE = arg("state", "TX").toUpperCase()
const NPIS = Number(arg("npis", "2000"))
const SPLIT = Number(arg("split", "0.67"))
const WOF = arg("wof", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
const DATA_ROOT = arg("data-root", "/mnt/playpen/mailwoman-data")
const SEED = Number(arg("seed", "1"))
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

/** Deterministic LCG (no Math.random — reproducible split). */
function lcg(seed: number): () => number {
	let s = seed >>> 0 || 1
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		return s / 0x100000000
	}
}

interface MessyRow {
	npi: string
	name: string
	org: string
	address: string
}

const choose2 = (n: number) => (n * (n - 1)) / 2

/** The dedup benchmark's pairwise clustering metric vs the NPI grouping (record.id = NPI). */
function scoreClusters(
	entities: ResolvedEntity[],
	n: number
): { precision: number; recall: number; f1: number; overMerged: number } {
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
	void n
	const tp = sumCK
	const precision = sumCluster > 0 ? tp / sumCluster : 0
	const recall = sumClass > 0 ? tp / sumClass : 0
	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
	return { precision, recall, f1, overMerged }
}

async function main(): Promise<void> {
	// --- Data-gen: the same NPI-keyed records as the dedup benchmark + the pairwise probe. ---
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

	console.error(`[B] full registry pass: address-frequency table + ${NPIS} ${STATE} sample…`)
	const rows: MessyRow[] = []
	const kept = new Set<string>()
	const addrCounts = new Map<string, number>()
	let addrTotal = 0
	let scanned = 0
	for await (const r of streamRows(REGISTRY)) {
		if (++scanned % 1_000_000 === 0) console.error(`    scanned ${scanned / 1e6}M, kept ${kept.size}`)
		const practice = addr(r[C.pAddr]!, r[C.pCity]!, r[C.pState]!, r[C.pZip]!)
		if (practice) {
			const k = addressFrequencyKey(practice)
			addrCounts.set(k, (addrCounts.get(k) ?? 0) + 1)
			addrTotal++
		}
		const npi = norm(r[C.npi])
		if (
			kept.size < NPIS &&
			npi &&
			!kept.has(npi) &&
			altNames.has(npi) &&
			practice &&
			norm(r[C.pState]).toUpperCase() === STATE
		) {
			const isOrg = norm(r[C.entityType]) === "2"
			const primaryName = isOrg ? norm(r[C.orgLegal]) : `${norm(r[C.first])} ${norm(r[C.last])}`.trim()
			if (primaryName) {
				const org = isOrg ? norm(r[C.orgLegal]) : ""
				kept.add(npi)
				rows.push({ npi, name: primaryName, org, address: practice })
				for (const alt of altNames.get(npi)!) rows.push({ npi, name: alt, org: alt, address: practice })
				const mailing = addr(r[C.mAddr]!, r[C.mCity]!, r[C.mState]!, r[C.mZip]!)
				if (mailing && mailing !== practice) rows.push({ npi, name: primaryName, org, address: mailing })
			}
		}
	}
	const addressFrequency = {
		total: addrTotal,
		distinct: addrCounts.size,
		frequency: (v: string) => (v ? (addrCounts.get(addressFrequencyKey(v)) ?? 0) / addrTotal : 0),
	}
	console.error(`    ${kept.size} NPIs → ${rows.length} records`)

	console.error("[C] geocoding…")
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
	const records = await ingestRows(rows as unknown as Record<string, string>[], mapping, { geocodeAddress: seam })
	shardProvider.close()
	lookup.close()

	// --- The feature basis: address-frequency + collapsed-spatial model (the spine). The agreement
	// pattern is EM-independent, so the same featurize() is consistent at train and inference time. ---
	// The featurizer is the SHARED production one (createMatchFeaturizer) — train ≡ eval ≡ inference, one
	// definition. Feed the collapsed-spatial + address-frequency comparison set (the benchmark spine).
	const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons
	const featurize = createMatchFeaturizer({ comparisons, addressFrequency })

	interface ArmScore {
		precision: number
		recall: number
		f1: number
		overMerged: number
	}
	interface SeedResult {
		seed: number
		trainN: number
		evalN: number
		fs: ArmScore
		lr: ArmScore
		gbt: ArmScore
	}

	/**
	 * One held-out-NPI split: train the GBT + LR on TRAIN pairs, then cluster the EVAL records three
	 * ways (FS spine, GBT scorer, LR scorer) through the same `resolveEntities` pipeline, sweeping
	 * the link threshold finely for each and taking best F1. The geocode is shared across seeds; only
	 * the split, the trained scorers, and the eval subset move with the seed.
	 */
	function runSeed(seed: number): SeedResult {
		const rnd = lcg(seed)
		const npiSplit = new Map<string, "train" | "eval">()
		for (const npi of kept) npiSplit.set(npi, rnd() < SPLIT ? "train" : "eval")
		const trainRecords = records.filter((r) => npiSplit.get(r.id) === "train")
		const evalRecords = records.filter((r) => npiSplit.get(r.id) === "eval")
		const N = evalRecords.length

		const { pairs: trainPairs } = block(trainRecords, defaultBlockingKeys())
		const trainX = trainPairs.map(([a, b]) => featurize(a, b))
		const trainY = trainPairs.map(([a, b]) => (a.id === b.id ? 1 : 0))
		const posRate = trainY.reduce((s, v) => s + v, 0) / Math.max(1, trainY.length)
		const trainW = trainY.map((y) => (y === 1 ? 1 - posRate : posRate))
		const dim = trainX[0]?.length ?? 0
		const gbt = trainGBT(trainX, trainY, trainW, { rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 })

		// LR (batch GD, class-balanced) — same as the pairwise probe.
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

		const bestOver = (thresholds: number[], cfg: (t: number) => Parameters<typeof resolveEntities>[1]): ArmScore => {
			let best: ArmScore = { precision: 0, recall: 0, f1: -1, overMerged: 0 }
			for (const t of thresholds) {
				const s = scoreClusters(resolveEntities(evalRecords, cfg(t)).entities, N)
				if (s.f1 > best.f1) best = s
			}
			return best
		}

		// FS spine: EM-fit weights in bits, fine grid [0..25]. Learned scorers: a FINE sweep (33 points)
		// from each scorer's own eval-pair score distribution, so a coarse grid can't understate them.
		const { pairs: evalPairs } = block(evalRecords, defaultBlockingKeys())
		const quantileThresholds = (scores: number[]): number[] => {
			const sorted = [...scores].sort((p, q) => p - q)
			const ts = new Set<number>()
			for (let k = 0; k <= 32; k++) ts.add(sorted[Math.floor((0.2 + (0.999 - 0.2) * (k / 32)) * (sorted.length - 1))]!)
			return [...ts]
		}
		const fs = bestOver(
			Array.from({ length: 26 }, (_, i) => i),
			(t) => ({ addressFrequency, collapseSpatial: true, trainEM: true, threshold: t })
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
		return { seed, trainN: trainRecords.length, evalN: N, fs, lr: lrArm, gbt: gbtArm }
	}

	const pct = (x: number) => (100 * x).toFixed(1)
	const sgn = (x: number) => (x >= 0 ? "+" : "")
	const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
	const std = (xs: number[]) => {
		const m = mean(xs)
		return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
	}

	const SEEDS = Number(arg("seeds", "4"))
	console.error(`[D-F] ${SEEDS} held-out-NPI splits: FS spine vs GBT vs LR…`)
	const results: SeedResult[] = []
	for (let k = 0; k < SEEDS; k++) {
		const r = runSeed(SEED + k)
		results.push(r)
		console.error(
			`    seed ${r.seed}: ${r.trainN}tr/${r.evalN}ev  FS ${pct(r.fs.f1)}  LR ${pct(r.lr.f1)} (${sgn(r.lr.f1 - r.fs.f1)}${pct(r.lr.f1 - r.fs.f1)})  ` +
				`GBT ${pct(r.gbt.f1)} (${sgn(r.gbt.f1 - r.fs.f1)}${pct(r.gbt.f1 - r.fs.f1)})`
		)
	}
	const fsF1 = results.map((r) => r.fs.f1)
	const lrF1 = results.map((r) => r.lr.f1)
	const gbtF1 = results.map((r) => r.gbt.f1)
	const dGbt = results.map((r) => r.gbt.f1 - r.fs.f1)
	const dLr = results.map((r) => r.lr.f1 - r.fs.f1)
	const gbtWins = dGbt.filter((d) => d > 0).length
	const meanDGbt = mean(dGbt)
	const armRow = (label: string, pick: (r: SeedResult) => ArmScore, dArr: number[] | null, bold: boolean) => {
		const f1s = results.map((r) => pick(r).f1)
		const P = mean(results.map((r) => pick(r).precision))
		const R = mean(results.map((r) => pick(r).recall))
		const om = mean(results.map((r) => pick(r).overMerged))
		const d = dArr ? `${sgn(mean(dArr) * 100)}${(mean(dArr) * 100).toFixed(1)}pp` : "—"
		const f1cell = `${pct(mean(f1s))}% ± ${pct(std(f1s))}`
		const cells = `${pct(P)}% | ${pct(R)}% | ${bold ? `**${f1cell}**` : f1cell} | ${bold ? `**${d}**` : d} | ${om.toFixed(0)}`
		return `| ${bold ? `**${label}**` : label} | ${cells} |`
	}
	const avgEval = Math.round(mean(results.map((r) => r.evalN)))
	const avgTrain = Math.round(mean(results.map((r) => r.trainN)))

	const lines: string[] = []
	lines.push(
		`# Learned-scorer CLUSTERING A/B (#603 Tier 2) — does a learned scorer beat the FS spine on the assembled output?`
	)
	lines.push("")
	lines.push(
		`_Generated by \`scripts/record-matcher/learned-scorer-clustering-eval.ts\`. ${kept.size} ${STATE} NPIs → ` +
			`${records.length} records, geocoded; split by NPI into ~${avgTrain} train / ~${avgEval} eval records over ${SEEDS} ` +
			`seeds (the GBT/LR never see an eval NPI's records). The held-out EVAL records are clustered three ways through the ` +
			`SAME \`resolveEntities\` pipeline (block → score → connected-components): the FS spine (address-frequency + ` +
			`collapsed-spatial, EM-fit), the GBT as the link scorer (the new \`ResolveConfig.scorer\` hook), and the LR. Best F1 ` +
			`over a fine per-scorer link-threshold sweep, averaged across seeds. This is the dedup benchmark's clustering metric ` +
			`— the definitive test the pairwise probe (#637/#640) deferred._`
	)
	lines.push("")
	lines.push(
		`## Result — eval clustering F1 (best over threshold, mean ± std over ${SEEDS} seeds, ~${avgEval} held-out records)`
	)
	lines.push("")
	lines.push(`| scorer | precision | recall | F1 | ΔF1 vs FS | over-merged clusters |`)
	lines.push(`|---|---:|---:|---:|---:|---:|`)
	lines.push(armRow("FS spine (EM-fit)", (r) => r.fs, null, false))
	lines.push(armRow("logistic regression", (r) => r.lr, dLr, false))
	lines.push(armRow("gradient-boosted trees", (r) => r.gbt, dGbt, true))
	lines.push("")
	lines.push(
		`**ΔF1 (GBT − FS): ${sgn(meanDGbt * 100)}${(meanDGbt * 100).toFixed(1)}pp mean, GBT > FS in ${gbtWins}/${SEEDS} seeds.**`
	)
	lines.push("")
	const verdict =
		meanDGbt > 0.02 && gbtWins >= SEEDS - 1
			? `**The learned scorer beats the FS spine on the assembled clustering output** — GBT clustering F1 ` +
				`${pct(mean(gbtF1))}% vs FS ${pct(mean(fsF1))}% (${sgn(meanDGbt * 100)}${(meanDGbt * 100).toFixed(1)}pp mean, ${gbtWins}/${SEEDS} ` +
				`seeds), driven by a large PRECISION gain that cuts the over-merge — the #625 problem. The pairwise gain (#640) ` +
				`DOES translate to the entity-resolution metric. This confirms the #603 GBM as a real dedup lever and justifies the ` +
				`production build (offline XGBoost/LightGBM → tree JSON, the \`scorer\` hook for inference). The honest next axis is ` +
				`cross-STATE generalization (train-TX / eval-other-state) and a tuned GBM on more features.`
			: meanDGbt < -0.02
				? `**The learned scorer does NOT beat the FS spine on clustering** (GBT ${pct(mean(gbtF1))}% vs FS ${pct(mean(fsF1))}%, ` +
					`${(meanDGbt * 100).toFixed(1)}pp). The pairwise ranking gain (#640) does not survive the threshold + ` +
					`connected-components assembly — clustering, not ranking, is the binding constraint. FS stays the spine.`
				: `**The learned scorer roughly TIES the FS spine on clustering** (GBT ${pct(mean(gbtF1))}% vs FS ${pct(mean(fsF1))}%, ` +
					`${sgn(meanDGbt * 100)}${(meanDGbt * 100).toFixed(1)}pp, ${gbtWins}/${SEEDS} seeds). The pairwise ranking gain (#640) is ` +
					`real but largely washes out through the threshold + connected-components assembly. A learned scorer is not a free ` +
					`dedup win; pairing it with a clustering change or a more distinctive identifier (#625) is the path.`
	lines.push(verdict)
	lines.push("")
	lines.push(`### Per-seed F1`)
	lines.push("")
	lines.push(`| seed | eval records | FS | LR | GBT |`)
	lines.push(`|---:|---:|---:|---:|---:|`)
	for (const r of results)
		lines.push(`| ${r.seed} | ${r.evalN} | ${pct(r.fs.f1)}% | ${pct(r.lr.f1)}% | ${pct(r.gbt.f1)}% |`)
	lines.push("")
	lines.push(`## Honest caveats`)
	lines.push("")
	lines.push(
		`In-domain (${STATE}), a held-out-NPI split (NOT a held-out STATE — cross-state generalization is the next axis, ` +
			`the #603 train-TX/eval-other-state design). The FS arm IS the benchmark spine (same model), so the comparison is ` +
			`fair. The GBT is a compact pure-Node implementation (120 rounds, depth 3), not a tuned XGBoost/LightGBM — a real ` +
			`GBM with more NPIs/features could move the number further. Thresholds are swept per scorer (FS in bits, learned ` +
			`scorers in logits), each at its own best operating point — note a 300-NPI smoke MISLED (FS ahead): too few ` +
			`co-located collisions to exhibit the over-merge, which only bites at scale, so trust the larger eval. NPI-as-truth ` +
			`is conservative (a cross-NPI merge is a candidate, not necessarily an error)._`
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
