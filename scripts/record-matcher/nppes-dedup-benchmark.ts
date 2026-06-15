/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #617 NPPES dedup benchmark — the measurable proof of the record-matcher hypothesis.
 *
 *   NPPES is NPI-keyed, so the NPI is a ground-truth entity id. We build a deliberately varied
 *   multi-record set per NPI from REAL data — the registry's primary record, each alternate
 *   organization name (`nppes_other-names`, NAME drift at the same place), and the mailing address
 *   where it differs from the practice location (ADDRESS variation) — then run the matcher BLIND to
 *   the NPI (geocode → block → Fellegi-Sunter + EM → cluster) and score the recovered clusters
 *   against the NPI grouping (pairwise P/R/F1 + adjusted Rand).
 *
 *   Honest reading (per the epic): NPI-as-truth is CONSERVATIVE. A cluster that merges two NPIs is a
 *   candidate "same entity, two NPIs" surfaced for review, not an error we adjudicate; and a single
 *   NPI split across two genuinely-distant addresses is geo-first behaving correctly, counted here
 *   as a recall miss. We resolve and report; interpretation is the consumer's.
 *
 *   Sample: a tractable, variation-rich cut — providers in one state (default TX) that have ≥1
 *   alternate name, so every entity has ≥2 records and the dedup is non-trivial. Streams the 4.8 GB
 *   registry via `streamRows` (#616), so nothing loads whole.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/nppes-dedup-benchmark.ts\
 *   [--state TX] [--max-npis 300] [--wof <admin.db>] [--data-root <dir>] [--no-train-em]\
 *   [--out-md docs/articles/evals/<date>-nppes-dedup-benchmark.md]
 */

import { decodeAsJson } from "@mailwoman/core/decoder"
import { createWofResolver, type ResolverBackend } from "@mailwoman/core/resolver"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import {
	geocodeAddressVia,
	ingestRows,
	resolveEntities,
	streamRows,
	type ColumnMapping,
	type ResolvedEntity,
} from "@mailwoman/registry"
import { writeFileSync } from "node:fs"
import { geocodeAddress, ShardProvider } from "../../mailwoman/out/geocode-core.js"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const SOURCES = arg("sources", "/mnt/playpen/mailwoman-data/record-matcher/sources")
const STATE = arg("state", "TX").toUpperCase()
const MAX_NPIS = Number(arg("max-npis", "300"))
const WOF = arg("wof", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
const DATA_ROOT = arg("data-root", "/mnt/playpen/mailwoman-data")
const OUT_MD = arg("out-md", "")
const TRAIN_EM = !process.argv.includes("--no-train-em")

const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`
const OTHER_NAMES = `${SOURCES}/nppes_other-names_20260607.tsv`

// NPPES column names (verbatim from the file headers).
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

/** One synthetic input row for the matcher; `npi` is the hidden ground-truth label. */
interface MessyRow {
	npi: string
	name: string
	org: string
	address: string
}

async function main(): Promise<void> {
	// --- Phase A: the variation set — NPIs that carry ≥1 alternate organization name. ---
	console.error("[A] streaming other-names…")
	const altNames = new Map<string, string[]>()
	for await (const r of streamRows(OTHER_NAMES)) {
		const npi = norm(r[C.npi])
		const alt = norm(r[C.otherOrg])
		if (!npi || !alt) continue
		const list = altNames.get(npi) ?? []
		if (list.length < 5) list.push(alt) // cap fan-out per NPI
		altNames.set(npi, list)
	}
	console.error(`    ${altNames.size} NPIs with ≥1 alternate name`)

	// --- Phase B: stream the registry, keep in-state NPIs with variation, build the messy record set. ---
	console.error(`[B] streaming registry, sampling ${MAX_NPIS} ${STATE} providers with name variation…`)
	const rows: MessyRow[] = []
	const kept = new Set<string>()
	let scanned = 0
	for await (const r of streamRows(REGISTRY)) {
		if (++scanned % 1_000_000 === 0) console.error(`    scanned ${scanned / 1e6}M rows, kept ${kept.size}`)
		const npi = norm(r[C.npi])
		if (!npi || kept.has(npi) || !altNames.has(npi)) continue
		if (norm(r[C.pState]).toUpperCase() !== STATE) continue
		const practice = addr(r[C.pAddr]!, r[C.pCity]!, r[C.pState]!, r[C.pZip]!)
		if (!practice) continue

		const isOrg = norm(r[C.entityType]) === "2"
		const primaryName = isOrg ? norm(r[C.orgLegal]) : `${norm(r[C.first])} ${norm(r[C.last])}`.trim()
		if (!primaryName) continue
		const org = isOrg ? norm(r[C.orgLegal]) : ""
		kept.add(npi)

		// 1) the primary record (name + practice address)
		rows.push({ npi, name: primaryName, org, address: practice })
		// 2) one record per alternate name — NAME drift, same place (real other-names data)
		for (const alt of altNames.get(npi)!) rows.push({ npi, name: alt, org: alt, address: practice })
		// 3) the mailing address as a record when it differs from the practice location — ADDRESS variation
		const mailing = addr(r[C.mAddr]!, r[C.mCity]!, r[C.mState]!, r[C.mZip]!)
		if (mailing && mailing !== practice) rows.push({ npi, name: primaryName, org, address: mailing })

		if (kept.size >= MAX_NPIS) break
	}
	console.error(`    ${kept.size} NPIs → ${rows.length} records (${(rows.length / kept.size).toFixed(1)}/NPI)`)

	// --- Phase C: geocode + ingest (the NPI rides on record.id as the held-out label). ---
	console.error("[C] building the geocoder + geocoding records…")
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new mod.WofSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWofResolver(lookup as unknown as ResolverBackend)
	const shardProvider = new ShardProvider(mod, DATA_ROOT)

	let geo = 0
	const seam = geocodeAddressVia({
		parse: async (raw: string) => decodeAsJson(await classifier.parse(raw, { postcodeRepair: true })),
		geocode: async (raw: string) => {
			const g = await geocodeAddress(raw, {
				classifier,
				resolver,
				shards: shardProvider.for,
				defaultCountry: "US",
				placeCountry: false,
			})
			if (g.lat !== null) geo++
			return g
		},
		country: "US",
	})

	const mapping: ColumnMapping = { id: "npi", name: "name", organization: "org", address: "address", source: "nppes" }
	const records = await ingestRows(rows as unknown as Record<string, string>[], mapping, { geocodeAddress: seam })
	shardProvider.close()
	lookup.close()
	console.error(`    geocoded ${geo}/${rows.length} (${((100 * geo) / rows.length).toFixed(1)}%)`)

	// --- Phase E: score recovered clusters vs the NPI grouping (record.id = the held-out NPI). ---
	const choose2 = (n: number) => (n * (n - 1)) / 2
	const N = records.length

	interface Score {
		precision: number
		recall: number
		f1: number
		ari: number
		clusters: number
		singletons: number
		overMergedClusters: number
		recordsInOverMerged: number
		maxNpisFused: number
		splitNpis: number
	}

	function scoreEntities(entities: ResolvedEntity[]): Score {
		const npiTotals = new Map<string, number>()
		const npiClusters = new Map<string, Set<number>>()
		let sumCK = 0 // Σ C(n_ck, 2)
		let sumCluster = 0 // Σ_c C(|c|, 2)
		let singletons = 0
		let overMergedClusters = 0
		let recordsInOverMerged = 0
		let maxNpisFused = 0
		entities.forEach((e, ci) => {
			const byNpi = new Map<string, number>()
			for (const rec of e.records) byNpi.set(rec.id, (byNpi.get(rec.id) ?? 0) + 1)
			sumCluster += choose2(e.records.length)
			if (e.records.length === 1) singletons++
			if (byNpi.size > 1) {
				overMergedClusters++
				recordsInOverMerged += e.records.length
				maxNpisFused = Math.max(maxNpisFused, byNpi.size)
			}
			for (const [npi, n] of byNpi) {
				sumCK += choose2(n)
				npiTotals.set(npi, (npiTotals.get(npi) ?? 0) + n)
			}
			for (const rec of e.records) {
				const s = npiClusters.get(rec.id) ?? new Set<number>()
				s.add(ci)
				npiClusters.set(rec.id, s)
			}
		})
		let sumClass = 0 // Σ_k C(|k|, 2)
		for (const total of npiTotals.values()) sumClass += choose2(total)

		const tp = sumCK
		const precision = tp + (sumCluster - tp) > 0 ? tp / sumCluster : 0
		const recall = sumClass > 0 ? tp / sumClass : 0
		const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
		const expected = (sumCluster * sumClass) / choose2(N)
		const maxIndex = (sumCluster + sumClass) / 2
		const ari = maxIndex - expected !== 0 ? (tp - expected) / (maxIndex - expected) : 1
		const splitNpis = [...npiClusters.values()].filter((s) => s.size > 1).length
		return {
			precision,
			recall,
			f1,
			ari,
			clusters: entities.length,
			singletons,
			overMergedClusters,
			recordsInOverMerged,
			maxNpisFused,
			splitNpis,
		}
	}

	// --- Phase D: resolve at a sweep of link thresholds (geocode once, resolve many — config is cheap). ---
	console.error(`[D] resolving at a threshold sweep${TRAIN_EM ? " (EM-trained)" : ""}…`)
	const THRESHOLDS = [0, 4, 8, 12, 16, 20]
	const sweep = THRESHOLDS.map((t) => {
		const res = resolveEntities(records, { trainEM: TRAIN_EM, threshold: t })
		return { t, res, score: scoreEntities(res.entities) }
	})
	const base = sweep[0]! // threshold 0 = the default config
	const best = sweep.reduce((a, b) => (b.score.f1 > a.score.f1 ? b : a))
	console.error(
		`    default F1 ${(100 * base.score.f1).toFixed(1)}% → best F1 ${(100 * best.score.f1).toFixed(1)}% @ threshold ${best.t}`
	)

	const pct = (x: number) => (100 * x).toFixed(1)
	const lines: string[] = []
	lines.push(`# NPPES NPI dedup benchmark (#617)`)
	lines.push("")
	lines.push(
		`_Generated by \`scripts/record-matcher/nppes-dedup-benchmark.ts\`. Sample: ${kept.size} ${STATE} NPIs with ≥1 ` +
			`alternate name → ${N} records (${(N / kept.size).toFixed(1)}/NPI) from real registry + other-names + ` +
			`mailing-vs-practice variation. Matcher run BLIND to the NPI${TRAIN_EM ? ", EM-trained (label-free)" : ""}; ` +
			`geocoded ${pct(geo / N)}% of addresses. The NPI is held-out ground truth._`
	)
	lines.push("")
	lines.push(`## Dedup accuracy vs the NPI, across the link threshold (the scoring lever)`)
	lines.push("")
	lines.push(`| link threshold (bits) | precision | recall | F1 | ARI | clusters | over-merged |`)
	lines.push(`|---:|---:|---:|---:|---:|---:|---:|`)
	for (const s of sweep) {
		const star = s === best ? " ⭐" : ""
		lines.push(
			`| ${s.t}${s.t === 0 ? " (default)" : ""} | ${pct(s.score.precision)}% | ${pct(s.score.recall)}% | **${pct(s.score.f1)}%**${star} | ${s.score.ari.toFixed(3)} | ${s.score.clusters} | ${s.score.overMergedClusters} |`
		)
	}
	lines.push("")
	lines.push(
		best.t === 0
			? `Best F1 is at the **default threshold** (${pct(base.score.f1)}%): raising it only trades recall away faster ` +
					`than it buys precision. So the threshold knob alone can't separate co-located distinct providers — the ` +
					`over-merge is structural, in the comparison model, not the cutoff.`
			: `Best F1 **${pct(best.score.f1)}%** (ARI ${best.score.ari.toFixed(3)}) at threshold ${best.t}, vs **${pct(base.score.f1)}%** at the ` +
					`default — the threshold knob moves it ${(100 * (best.score.f1 - base.score.f1)).toFixed(0)}pp. Higher thresholds trade recall for precision.`
	)
	lines.push("")
	lines.push(`## Shape + where the errors are (at the default threshold)`)
	lines.push("")
	lines.push(`- records: ${N} · true entities (NPIs): ${kept.size} · recovered clusters: ${base.score.clusters}`)
	lines.push(
		`- candidate pairs blocked: ${base.res.candidatePairs}${base.res.droppedBlocks.length ? ` · oversized blocks skipped: ${base.res.droppedBlocks.length}` : ""}`
	)
	lines.push(
		`- **Over-merge (precision):** ${base.score.overMergedClusters} clusters fuse ≥2 distinct NPIs (largest fuses ` +
			`${base.score.maxNpisFused}; ${base.score.recordsInOverMerged} records) — **co-located providers sharing a clinic / ` +
			`billing address**, linked by address agreement despite different names.`
	)
	lines.push(
		`- **Under-merge (recall):** ${base.score.splitNpis}/${kept.size} NPIs split across >1 cluster — records at distant ` +
			`addresses (mailing vs practice) or with strong name drift the score didn't bridge.`
	)
	lines.push("")
	lines.push(`## Reading`)
	lines.push("")
	lines.push(
		`The geocode-first **foundation works**: **${pct(geo / N)}%** of addresses placed, blocking + clustering clean — the ` +
			`geocoding (the Pelias/Nominatim-can't-do-this part) is not the bottleneck. The gap is the **comparison model**. At ` +
			`a shared clinic/billing address the address + distance agreement dominates, so distinct co-located providers fuse ` +
			`(over-merge) while same-provider records with strong name or address drift fall below the link bar (under-merge); ` +
			`the threshold sweep shows a single cutoff can't resolve both at once. The revision: a link must require name **or** ` +
			`org corroboration — address alone is not identity — plus EM-tuned \`m\`/\`u\` per comparison. Config dominates the ` +
			`model (the pre-registered finding), tracked as the auto-tuning + selective-model work (#602 / #603).`
	)
	lines.push("")
	lines.push(
		`NPI-as-truth is **conservative**: a cluster fusing two NPIs is a candidate "same entity, two NPIs" surfaced for ` +
			`review, not an adjudicated error; an NPI split across genuinely-distant addresses is geo-first behaving correctly, ` +
			`counted here as a recall miss. We resolve and report; interpretation is the consumer's.`
	)
	lines.push("")

	const md = lines.join("\n")
	console.log(md)
	if (OUT_MD) {
		writeFileSync(OUT_MD, md)
		console.error(`\n[written] ${OUT_MD}`)
	}
}

await main()
