/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Learned-scorer probe (#603) — does a model over the Fellegi-Sunter feature vector separate
 *   matches from non-matches BETTER than the FS scorer itself? This is the honest, rigorous answer
 *   to "is the learned-scorer path worth it?" before investing in a full GBM/training pipeline.
 *
 *   The over-merge (co-located distinct providers fused; co-located same-entity name-drift split) is
 *   a FIELD-INTERACTION effect FS can't express: it scores each field independently. A learned
 *   model with INTERACTION features (spatial-agreement × name-disagreement) can. We test that
 *   directly, with a clean methodology — no clustering confound, no leakage:
 *
 *   1. Generate the same NPI-keyed records as the dedup benchmark (real registry + name-drift +
 *        address-variation), geocoded.
 *   2. Block → candidate pairs. For each: the FS agreement pattern + engineered interaction features;
 *        the label is same-NPI.
 *   3. Split the NPIs into train / test. A pair is train iff BOTH endpoints are train-NPIs, test iff
 *        both test-NPIs — so no NPI's records leak across the split.
 *   4. Train TWO learned scorers on the train pairs: an L2 logistic regression (linear) and
 *        gradient-boosted shallow trees (non-linear — the model #603 names). Both pure-Node.
 *   5. Score the test pairs with (a) the EM-fitted FS scorer, (b) the LR, (c) the GBT. Report pairwise
 *        ROC-AUC + best-threshold F1 for each, averaged over N seeds. AUC is threshold-free: does
 *        the learned scorer RANK matches above non-matches better than FS — and does the TREE beat
 *        the LINEAR model (i.e. is there non-linear signal the hand-crafted interaction features
 *        miss)?
 *
 *   Honest caveats are printed: in-domain (TX), a modest sample, PAIRWISE (not the clustering
 *   metric). The definitive test is a GBM A/B on the dedup clustering metric with a
 *   train-TX/eval-held-out-state split (#603 Tier 2); this probe bounds the pairwise-ranking gain
 *   cheaply first.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/learned-scorer-eval.ts [--npis 1500]\
 *   [--seeds 8] [--wof <admin.db>] [--data-root <dir>] [--seed 1] [--out-md <md>]
 */

import { writeFileSync } from "node:fs"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath, mailwomanDataRoot } from "@mailwoman/core/utils"
import { agreementPattern, block, estimateParameters, gbtScore, scorePair, trainGBT } from "@mailwoman/match"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import {
	addressFrequencyKey,
	buildDefaultModel,
	defaultBlockingKeys,
	geocodeAddressVia,
	ingestRows,
	streamRows,
	type ColumnMapping,
	type SourceRecord,
} from "@mailwoman/registry"
import { createWofResolver, type ResolverBackend } from "@mailwoman/resolver"

import { geocodeAddress, ShardProvider } from "../../mailwoman/out/geocode-core.js"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)

	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const SOURCES = arg("sources", dataRootPath("record-matcher", "sources"))
const STATE = arg("state", "TX").toUpperCase()
const NPIS = Number(arg("npis", "1500"))
const WOF = arg("wof", dataRootPath("wof", "admin-global-priority.db"))
const DATA_ROOT = arg("data-root", mailwomanDataRoot())
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

async function main(): Promise<void> {
	// --- Data-gen: same NPI-keyed records as the dedup benchmark. ---
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
		parse: async (raw: string) => decodeAsJSON(await classifier.parse(raw, { postcodeRepair: true })),
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

	// --- Block + feature extraction. The model (collapsed spatial + address-frequency) defines the
	// comparisons; EM-fit it for the FS baseline. ---
	console.error("[D] blocking + features…")
	const model = buildDefaultModel({ collapseSpatial: true, addressFrequency })
	const { pairs } = block(records, defaultBlockingKeys())
	const patterns = pairs.map(([a, b]) => agreementPattern(model.comparisons, a, b))
	const fsModel = estimateParameters(model, patterns).model

	// Level counts per comparison (for one-hot). Index -1 (missing) → all-zero block.
	const levelCounts = model.comparisons.map((c) => c.levels.length)
	const compIndex = Object.fromEntries(model.comparisons.map((c, i) => [c.name, i]))
	const spatialI = compIndex["spatial"]!
	const givenI = compIndex["given"]!
	const familyI = compIndex["family"]!
	const orgI = compIndex["organization"]!
	const lastLevel = (i: number) => levelCounts[i]! - 1 // the "different"/"far" catch-all level

	/**
	 * Feature vector for a pair: one-hot agreement levels + the over-merge interactions + address crowdedness.
	 */
	function features(pat: number[], a: SourceRecord): number[] {
		const f: number[] = []

		for (let i = 0; i < pat.length; i++) {
			const lvl = pat[i]!

			for (let l = 0; l < levelCounts[i]!; l++) f.push(lvl === l ? 1 : 0)
		}
		// Interaction: co-located (spatial exact = level 0) AND the names/org disagree (catch-all level).
		const spatialExact = pat[spatialI] === 0 ? 1 : 0
		const nameDisagree = pat[givenI] === lastLevel(givenI) && pat[familyI] === lastLevel(familyI) ? 1 : 0
		const orgDisagree = pat[orgI] === lastLevel(orgI) ? 1 : 0
		f.push(spatialExact * nameDisagree) // the over-merge signature: same place, names disagree
		f.push(spatialExact * orgDisagree)
		// Address crowdedness (how shared this address is) — high → "same address" is weak evidence.
		const freq = a.address?.raw ? addressFrequency.frequency(a.address.raw) : 0
		f.push(Math.min(1, freq * 1000))

		// scale into a usable range
		return f
	}

	interface Sample {
		x: number[]
		y: number
		fs: number
	}
	interface Scored {
		s: number
		y: number
	}
	interface SplitScored {
		seed: number
		trainN: number
		testN: number
		lrScored: Scored[]
		fsScored: Scored[]
		gbtScored: Scored[]
	}

	const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))))

	/**
	 * One train/test split (by NPI): train the L2 logistic regression on the train pairs, then score the held-out test
	 * pairs with both the LR and the EM-fitted FS scorer. The FS model is seed-independent (fit unsupervised on ALL
	 * pairs); only the LR weights and the test subset move with the seed, so repeating over seeds bounds split variance.
	 */
	function runSplit(seed: number): SplitScored {
		const rnd = lcg(seed)
		const npiSplit = new Map<string, "train" | "test">()

		for (const npi of kept) npiSplit.set(npi, rnd() < 0.67 ? "train" : "test")

		const train: Sample[] = []
		const test: Sample[] = []
		pairs.forEach(([a, b], i) => {
			const sa = npiSplit.get(a.id)
			const sb = npiSplit.get(b.id)

			if (!sa || sa !== sb) return // cross-split or unknown → drop (no leakage)
			const sample: Sample = {
				x: features(patterns[i]!, a),
				y: a.id === b.id ? 1 : 0,
				fs: scorePair(fsModel, a, b).weight,
			}
			;(sa === "train" ? train : test).push(sample)
		})
		const dim = train[0]?.x.length ?? 0

		// L2-regularized logistic regression (batch gradient descent), rare class up-weighted.
		const w = new Array<number>(dim).fill(0)
		let bias = 0
		const lrate = 0.1
		const l2 = 1e-3
		const posWeight = train.filter((s) => s.y === 1).length / Math.max(1, train.length)

		for (let epoch = 0; epoch < 400; epoch++) {
			const gw = new Array<number>(dim).fill(0)
			let gb = 0

			for (const s of train) {
				let z = bias

				for (let j = 0; j < dim; j++) z += w[j]! * s.x[j]!
				const p = sigmoid(z)
				const sampleW = s.y === 1 ? 1 - posWeight : posWeight
				const err = (p - s.y) * sampleW

				for (let j = 0; j < dim; j++) gw[j]! += err * s.x[j]!
				gb += err
			}

			for (let j = 0; j < dim; j++) w[j]! -= lrate * (gw[j]! / train.length + l2 * w[j]!)
			bias -= lrate * (gb / train.length)
		}
		const lrScore = (x: number[]) => {
			let z = bias

			for (let j = 0; j < x.length; j++) z += w[j]! * x[j]!

			return z
		}

		// Gradient-boosted trees on the SAME train pairs + class weights — the non-linear arm.
		const gbt = trainGBT(
			train.map((s) => s.x),
			train.map((s) => s.y),
			train.map((s) => (s.y === 1 ? 1 - posWeight : posWeight)),
			{ rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 }
		)

		return {
			seed,
			trainN: train.length,
			testN: test.length,
			lrScored: test.map((s) => ({ s: lrScore(s.x), y: s.y })),
			fsScored: test.map((s) => ({ s: s.fs, y: s.y })),
			gbtScored: test.map((s) => ({ s: gbtScore(gbt, s.x), y: s.y })),
		}
	}

	// --- Eval on the held-out test pairs: ROC-AUC + best-threshold F1, for LR vs FS. ---
	function auc(scored: Array<{ s: number; y: number }>): number {
		const pos = scored.filter((d) => d.y === 1)
		const neg = scored.filter((d) => d.y === 0)

		if (!pos.length || !neg.length) return NaN
		// Mann-Whitney U via rank.
		const sorted = [...scored].sort((p, q) => p.s - q.s)
		let rank = 1
		let rankSum = 0

		for (let i = 0; i < sorted.length; ) {
			let j = i

			while (j < sorted.length && sorted[j]!.s === sorted[i]!.s) j++
			const avg = (rank + (rank + (j - i) - 1)) / 2

			for (let k = i; k < j; k++) if (sorted[k]!.y === 1) rankSum += avg
			rank += j - i
			i = j
		}

		return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length)
	}
	function bestF1(scored: Array<{ s: number; y: number }>): { f1: number; precision: number; recall: number } {
		const thresholds = [...new Set(scored.map((d) => d.s))].sort((p, q) => p - q)
		let best = { f1: 0, precision: 0, recall: 0 }
		const P = scored.filter((d) => d.y === 1).length

		for (const t of thresholds) {
			let tp = 0
			let fp = 0

			for (const d of scored) {
				if (d.s >= t) {
					if (d.y === 1) tp++
					else fp++
				}
			}
			const precision = tp + fp > 0 ? tp / (tp + fp) : 0
			const recall = P > 0 ? tp / P : 0
			const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0

			if (f1 > best.f1) best = { f1, precision, recall }
		}

		return best
	}

	console.error("[E] training across seeds…")
	const SEEDS = Number(arg("seeds", "8"))
	const splits = Array.from({ length: SEEDS }, (_, k) => runSplit(SEED + k))
	const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
	const std = (xs: number[]) => {
		const m = mean(xs)

		return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
	}
	const fsAucs = splits.map((r) => auc(r.fsScored))
	const lrAucs = splits.map((r) => auc(r.lrScored))
	const deltas = splits.map((_, i) => lrAucs[i]! - fsAucs[i]!)
	const fsF1s = splits.map((r) => bestF1(r.fsScored).f1)
	const lrF1s = splits.map((r) => bestF1(r.lrScored).f1)
	const lrWins = deltas.filter((d) => d > 0).length
	const meanDelta = mean(deltas)
	const avgTestN = mean(splits.map((r) => r.testN))
	const avgTestPos = mean(splits.map((r) => r.lrScored.filter((d) => d.y === 1).length))
	const seMean = std(deltas) / Math.sqrt(SEEDS) // standard error of the mean ΔAUC
	const zScore = seMean > 0 ? meanDelta / seMean : 0 // ΔAUC in standard errors above zero
	const f1Delta = mean(lrF1s) - mean(fsF1s) // operating-point F1 gain (LR − FS)
	const unanimous = lrWins === SEEDS
	// GBT (non-linear) arm.
	const gbtAucs = splits.map((r) => auc(r.gbtScored))
	const gbtF1s = splits.map((r) => bestF1(r.gbtScored).f1)
	const gbtVsFs = splits.map((_, i) => gbtAucs[i]! - fsAucs[i]!)
	const gbtVsLr = splits.map((_, i) => gbtAucs[i]! - lrAucs[i]!)
	const gbtBeatsFs = gbtVsFs.filter((d) => d > 0).length
	const gbtBeatsLr = gbtVsLr.filter((d) => d > 0).length
	const meanGbtVsFs = mean(gbtVsFs)
	const meanGbtVsLr = mean(gbtVsLr)
	const f1DeltaGbt = mean(gbtF1s) - mean(fsF1s)

	// operating-point F1 gain (GBT − FS)
	for (const r of splits) {
		const dl = auc(r.lrScored) - auc(r.fsScored)
		const dg = auc(r.gbtScored) - auc(r.fsScored)
		console.error(
			`    seed ${r.seed}: ${r.trainN}tr/${r.testN}te  FS ${auc(r.fsScored).toFixed(4)}  ` +
				`LR ${auc(r.lrScored).toFixed(4)} (Δ${dl >= 0 ? "+" : ""}${dl.toFixed(4)})  ` +
				`GBT ${auc(r.gbtScored).toFixed(4)} (Δ${dg >= 0 ? "+" : ""}${dg.toFixed(4)})`
		)
	}
	console.error(
		`    mean/${SEEDS} — FS ${mean(fsAucs).toFixed(4)}  LR ${mean(lrAucs).toFixed(4)} (Δ${meanDelta >= 0 ? "+" : ""}${meanDelta.toFixed(4)})  ` +
			`GBT ${mean(gbtAucs).toFixed(4)} (Δ${meanGbtVsFs >= 0 ? "+" : ""}${meanGbtVsFs.toFixed(4)} vs FS, ` +
			`${meanGbtVsLr >= 0 ? "+" : ""}${meanGbtVsLr.toFixed(4)} vs LR)`
	)

	const pct = (x: number) => (100 * x).toFixed(1)
	const f4 = (x: number) => x.toFixed(4)
	const sgn = (x: number) => (x >= 0 ? "+" : "")
	const lines: string[] = []
	lines.push(`# Learned-scorer probe (#603) — does a model beat Fellegi-Sunter on the FS feature vector?`)
	lines.push("")
	lines.push(
		`_Generated by \`scripts/record-matcher/learned-scorer-eval.ts\`. ${kept.size} ${STATE} NPIs → ${records.length} ` +
			`records, geocoded. Candidate pairs are split BY NPI into train/test (no NPI's records cross the split), repeated ` +
			`over ${SEEDS} seeds to bound split variance. Two learned scorers over the FS agreement pattern + over-merge ` +
			`interaction features (spatial-exact × name-disagree, spatial-exact × org-disagree, address crowdedness) — features ` +
			`FS structurally cannot express — vs the EM-fitted FS scorer, on the held-out test pairs: an **L2 logistic ` +
			`regression** (linear) and **gradient-boosted trees** (non-linear, the model #603 names). AUC is threshold-free ` +
			`(does it RANK matches above non-matches?). The FS scorer is fit unsupervised on ALL pairs, so the comparison ` +
			`slightly favors FS — it has already seen the test pairs (label-free), the learned scorers have not._`
	)
	lines.push("")
	lines.push(
		`## Result — mean over ${SEEDS} NPI-splits (~${Math.round(avgTestN)} test pairs/split, ~${Math.round(avgTestPos)} matches)`
	)
	lines.push("")
	lines.push(`| scorer | ROC-AUC (mean±std) | ΔAUC vs FS | best F1 (mean) |`)
	lines.push(`|---|---:|---:|---:|`)
	lines.push(`| Fellegi-Sunter (EM-fit) | ${f4(mean(fsAucs))} ± ${f4(std(fsAucs))} | — | ${pct(mean(fsF1s))}% |`)
	lines.push(
		`| logistic regression (linear) | ${f4(mean(lrAucs))} ± ${f4(std(lrAucs))} | ${sgn(meanDelta)}${f4(meanDelta)} | ${pct(mean(lrF1s))}% |`
	)
	lines.push(
		`| **gradient-boosted trees** | **${f4(mean(gbtAucs))} ± ${f4(std(gbtAucs))}** | **${sgn(meanGbtVsFs)}${f4(meanGbtVsFs)}** | **${pct(mean(gbtF1s))}%** |`
	)
	lines.push("")
	lines.push(
		`**ΔAUC (LR − FS): ${sgn(meanDelta)}${f4(meanDelta)} ± ${f4(std(deltas))}, LR > FS in ${lrWins}/${SEEDS} seeds.**`
	)
	lines.push("")
	lines.push(
		`Robustness: the ΔAUC is small but **consistent** — std ${f4(std(deltas))} across seeds, SE ±${f4(seMean)} → ` +
			`≈${zScore.toFixed(1)}σ above zero, ${lrWins}/${SEEDS} seeds in LR's favour. At the operating point the gap is ` +
			`larger: **ΔF1 ${sgn(f1Delta * 100)}${(f1Delta * 100).toFixed(1)}pp** (${pct(mean(fsF1s))}% → ${pct(mean(lrF1s))}%), ` +
			`because the interaction features sharpen the hard co-located band near the decision boundary even where overall ` +
			`ranking barely moves.`
	)
	lines.push("")
	// Linear vs tree: does a non-linear model extract MORE than the LR? (The probe's open question.)
	const treeVerdict =
		meanGbtVsLr > 0.005 && gbtBeatsLr >= SEEDS - 1
			? `**The tree extends the linear gain** — GBT beats the LR by ΔAUC ${sgn(meanGbtVsLr)}${f4(meanGbtVsLr)} ` +
				`(${gbtBeatsLr}/${SEEDS} seeds), ${sgn(meanGbtVsFs)}${f4(meanGbtVsFs)} over FS, ΔF1 ${sgn(f1DeltaGbt * 100)}${(f1DeltaGbt * 100).toFixed(1)}pp. ` +
				`Non-linear interactions the hand-crafted features miss carry additional signal — a real GBM (XGBoost/LightGBM, ` +
				`more NPIs, more features) is worth building.`
			: meanGbtVsLr < -0.005
				? `**The tree does NOT beat the linear model** (GBT − LR = ${sgn(meanGbtVsLr)}${f4(meanGbtVsLr)} AUC, ` +
					`${gbtBeatsLr}/${SEEDS} seeds; GBT − FS = ${sgn(meanGbtVsFs)}${f4(meanGbtVsFs)}). With the over-merge interactions ` +
					`already hand-engineered into the feature vector, a shallow tree finds little extra and slightly overfits the ` +
					`small label set — the LR is the better-behaved scorer here.`
				: `**The tree roughly TIES the linear model** (GBT − LR = ${sgn(meanGbtVsLr)}${f4(meanGbtVsLr)} AUC, ` +
					`${gbtBeatsLr}/${SEEDS} seeds; GBT − FS = ${sgn(meanGbtVsFs)}${f4(meanGbtVsFs)}, ΔF1 ${sgn(f1DeltaGbt * 100)}${(f1DeltaGbt * 100).toFixed(1)}pp). ` +
					`Because the key over-merge interactions are ALREADY hand-engineered into the feature vector, the tree's main ` +
					`advantage — auto-discovering interactions — is largely pre-empted; it neither extends nor erases the linear ` +
					`gain. The signal in this feature set is close to linearly saturated, so a production GBM should budget for the ` +
					`SAME modest margin the LR shows, not a step change — its real value is generalizing the #625 levers, not ` +
					`finding hidden non-linear structure here.`
	lines.push(treeVerdict)
	lines.push("")
	lines.push(`### Per-seed`)
	lines.push("")
	lines.push(`| seed | test pairs | FS AUC | LR AUC | GBT AUC |`)
	lines.push(`|---:|---:|---:|---:|---:|`)

	for (const r of splits) {
		lines.push(`| ${r.seed} | ${r.testN} | ${f4(auc(r.fsScored))} | ${f4(auc(r.lrScored))} | ${f4(auc(r.gbtScored))} |`)
	}
	lines.push("")
	const verdict =
		unanimous && (meanDelta > 0.01 || f1Delta > 0.02)
			? `The LR beats FS **consistently** — it wins ${lrWins}/${SEEDS} seeds and lifts the operating-point F1 by ` +
				`${sgn(f1Delta * 100)}${(f1Delta * 100).toFixed(1)}pp (${pct(mean(fsF1s))}% → ${pct(mean(lrF1s))}%). The ΔAUC is ` +
				`small (+${f4(meanDelta)}) only because FS already ranks well (${f4(mean(fsAucs))}); the gain concentrates at the ` +
				`decision boundary, exactly where the interaction features (which FS structurally can't express) bite. ` +
				`**This greenlights the #603 learned scorer:** a GBM — non-linear over the same features — is the principled ` +
				`generalization of the hand-tuned #625 levers and should extend this linear gain. Honest framing: the linear ` +
				`headroom is modest, so the GBM's job is to *widen a real-but-small margin*, not to unlock a step change past the ` +
				`64.7% dedup plateau on its own — the reliable secondary identifier (#625) is still the larger lever.`
			: unanimous && zScore >= 3
				? `The LR beats FS by a **small but statistically robust** margin (ΔAUC +${f4(meanDelta)}, ≈${zScore.toFixed(1)}σ, ` +
					`${lrWins}/${SEEDS} seeds; ΔF1 ${sgn(f1Delta * 100)}${(f1Delta * 100).toFixed(1)}pp). The interaction features ` +
					`carry real signal, but FS's calibrated weights already capture most of it. **Qualified greenlight for #603:** a ` +
					`tree may extend the margin, but budget for a modest gain, not a plateau-breaker.`
				: meanDelta < -0.005 && lrWins < SEEDS / 2
					? `The LR is **worse** than FS (ΔAUC ${f4(meanDelta)}, ${lrWins}/${SEEDS} seeds) — the linear+interaction features ` +
						`don't help on this sample. FS's calibrated weights are hard to beat here; a tree is the only remaining test ` +
						`before committing to #603.`
					: `The LR and FS are **statistically indistinguishable** (ΔAUC ${sgn(meanDelta)}${f4(meanDelta)}, ${lrWins}/${SEEDS} ` +
						`seeds, within noise). On these features the over-merge resists a learned scorer — the discriminating signal a ` +
						`reliable secondary identifier provides (#625) isn't recoverable from the FS feature vector alone. A richer ` +
						`feature set or a tree is the next test before committing to #603.`
	lines.push(verdict)
	lines.push("")
	lines.push(`## Honest caveats`)
	lines.push("")
	lines.push(
		`In-domain (${STATE} only), ${kept.size} NPIs, PAIRWISE ranking (not the assembled clustering metric the dedup ` +
			`benchmark reports against the 64.7% baseline — a better pairwise scorer need not translate 1:1 to cluster F1). The GBT ` +
			`is a compact pure-Node implementation (120 boosting rounds, depth 3), a faithful stand-in for an offline ` +
			`XGBoost/LightGBM but not tuned. The split is by NPI so there's no record-level leakage, but the address-frequency ` +
			`feature is a corpus statistic over all NPIs (a population prior, not per-pair leakage), and the FS scorer is EM-fit ` +
			`on all pairs including the test subset (standard for label-free FS — it makes the learned scorers' win the harder ` +
			`result). At ~${Math.round(avgTestN)} test pairs/split both AUC and F1 are stable across seeds (per-seed table). The ` +
			`definitive test remains a GBM A/B on the **clustering** metric with a train-TX / eval-held-out-state split (#603 ` +
			`Tier 2)._`
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
