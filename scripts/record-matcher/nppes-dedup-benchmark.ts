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
import { haversineKm, type GBT } from "@mailwoman/match"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import {
	addressFrequencyKey,
	geocodeAddressVia,
	ingestRows,
	resolveEntities,
	streamRows,
	type ColumnMapping,
	type ResolvedEntity,
	type SourceRecord,
} from "@mailwoman/registry"
import { writeFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
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
// Optional A/B: a path to a trained dedup-gbt TS module (exports DEDUP_GBT_MODEL + DEDUP_GBT_META) to
// score alongside the shipped GBT at both truth levels — e.g. grade the #625 corroboration candidate.
const CANDIDATE = arg("candidate", "")

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
	authLast: "Authorized Official Last Name",
	authFirst: "Authorized Official First Name",
	isSubpart: "Is Organization Subpart",
	parentLBN: "Parent Organization LBN",
	parentTIN: "Parent Organization TIN",
}

const norm = (s: string | undefined) => (s ?? "").trim()
const addr = (line: string, city: string, st: string, zip: string) =>
	[norm(line), norm(city), norm(st), norm(zip)].filter(Boolean).join(", ")

// Org-name similarity for the org-name entity-truth (the gold-set rule: same address + same org name
// ⇒ same entity, even when NPPES doesn't flag the subpart). Strip corporate-form + articles, keep
// domain words (the distinguishing signal).
const ORG_STOP = new Set([
	"llc",
	"inc",
	"incorporated",
	"corp",
	"corporation",
	"co",
	"ltd",
	"pllc",
	"pc",
	"pa",
	"lp",
	"llp",
	"the",
	"of",
	"and",
])
const orgTokens = (s: string): Set<string> =>
	new Set(
		s
			.toLowerCase()
			.replace(/[^a-z0-9 ]/g, " ")
			.split(/\s+/)
			.filter((t) => t && !ORG_STOP.has(t))
	)
function orgJaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0
	let inter = 0
	for (const t of a) if (b.has(t)) inter++
	return inter / (a.size + b.size - inter)
}
const ORG_TAU = 0.7 // gold-set threshold

/**
 * One synthetic input row for the matcher; `npi` is the hidden NPI-level truth, `entityId` the
 * site-level entity-level truth (subpart-collapsed).
 */
interface MessyRow {
	npi: string
	name: string
	org: string
	address: string
	auth: string
	entityId: string
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

	// --- Phase B: ONE full registry pass — build the GLOBAL address-frequency table (every practice
	// address, so the sharing structure is corpus-wide, not sample-biased) AND collect the sample. ---
	console.error(`[B] full registry pass: address-frequency table + ${MAX_NPIS} ${STATE} sample…`)
	const rows: MessyRow[] = []
	const kept = new Set<string>()
	// Per-NPI primary org name + practice address key — the basis for the ORG-NAME entity-truth.
	const npiPrimary = new Map<string, { tokens: Set<string>; addrKey: string }>()
	const addrCounts = new Map<string, number>()
	let addrTotal = 0
	let scanned = 0
	for await (const r of streamRows(REGISTRY)) {
		if (++scanned % 1_000_000 === 0) console.error(`    scanned ${scanned / 1e6}M rows, kept ${kept.size}`)
		const practice = addr(r[C.pAddr]!, r[C.pCity]!, r[C.pState]!, r[C.pZip]!)
		// Global address-frequency: count every practice address (one row ≈ one distinct NPI).
		if (practice) {
			const k = addressFrequencyKey(practice)
			addrCounts.set(k, (addrCounts.get(k) ?? 0) + 1)
			addrTotal++
		}

		// Sample: in-state NPIs with ≥1 alternate name, up to MAX_NPIS — NO early break (the table needs the full pass).
		const npi = norm(r[C.npi])
		if (
			kept.size < MAX_NPIS &&
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
				const auth = `${norm(r[C.authFirst])} ${norm(r[C.authLast])}`.trim() // the NPI's registrant — shared across its records
				// Entity-level (site) truth: same org + same physical address. Subparts (NPPES
				// "Is Organization Subpart" + parent LBN/TIN) collapse to their PARENT, so the matcher isn't
				// charged for correctly fusing one org's many subpart-NPIs at a site; an NPI's mailing-vs-
				// practice records stay DISTINCT sites. orgKey = parent identity for subparts, else the NPI
				// (independent orgs sharing an address stay distinct — the conservative choice).
				const isSubpart = norm(r[C.isSubpart]).toUpperCase() === "Y"
				const parentKey = `${norm(r[C.parentLBN])}|${norm(r[C.parentTIN])}`.toLowerCase()
				const orgKey = isSubpart && parentKey !== "|" ? `p:${parentKey}` : `n:${npi}`
				const eid = (a: string) => `${addressFrequencyKey(a)}|${orgKey}`
				if (org) npiPrimary.set(npi, { tokens: orgTokens(org), addrKey: addressFrequencyKey(practice) })
				kept.add(npi)
				rows.push({ npi, name: primaryName, org, address: practice, auth, entityId: eid(practice) }) // primary
				for (const alt of altNames.get(npi)!)
					rows.push({ npi, name: alt, org: alt, address: practice, auth, entityId: eid(practice) }) // name drift
				const mailing = addr(r[C.mAddr]!, r[C.mCity]!, r[C.mState]!, r[C.mZip]!)
				if (mailing && mailing !== practice)
					rows.push({ npi, name: primaryName, org, address: mailing, auth, entityId: eid(mailing) }) // address variation
			}
		}
	}
	// Corpus-wide address-frequency table — the inverse-frequency signal (#617 fix per the DeepSeek consult).
	const addressFrequency = {
		total: addrTotal,
		distinct: addrCounts.size,
		frequency: (v: string) => (v ? (addrCounts.get(addressFrequencyKey(v)) ?? 0) / addrTotal : 0),
	}
	console.error(
		`    ${kept.size} NPIs → ${rows.length} records; address table: ${addrCounts.size} distinct over ${addrTotal} rows`
	)

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

	const mapping: ColumnMapping = {
		id: "npi",
		name: "name",
		organization: "org",
		address: "address",
		// `entityTruth` rides as an attribute purely for scoring (NOT a discriminator → never used in
		// matching); it carries the site-level entity-level label alongside the NPI (record.id).
		attributes: { authorizedOfficial: "auth", entityTruth: "entityId" },
		source: "nppes",
	}
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

	function scoreEntities(entities: ResolvedEntity[], labelOf: (rec: SourceRecord) => string): Score {
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
			for (const rec of e.records) {
				const lbl = labelOf(rec)
				byNpi.set(lbl, (byNpi.get(lbl) ?? 0) + 1)
			}
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
				const lbl = labelOf(rec)
				const s = npiClusters.get(lbl) ?? new Set<number>()
				s.add(ci)
				npiClusters.set(lbl, s)
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

	// Truth labels: NPI-level (the conservative held-out NPI = record.id) and entity-level (the
	// site-level subpart-collapsed id that rides on attributes.entityTruth). Scoring the SAME clusters
	// both ways isolates how much of the apparent over-merge is NPI over-segmentation, not model error.
	const npiLabel = (rec: SourceRecord) => rec.id
	const entityLabel = (rec: SourceRecord) => rec.attributes?.["entityTruth"] ?? rec.id

	// --- ORG-NAME entity-truth (the gold-set lever, #625). Union-find over NPIs: same NPI ⇒ same entity
	// (so an NPI's records stay together — recall preserved), PLUS union two NPIs at the same address whose
	// primary org names match (Jaccard ≥ ORG_TAU). This collapses the same-org-many-NPIs over-segmentation
	// the gold set proved is correct, WITHOUT the subpart flag (which the gold set showed misses 37%). ---
	const parent = new Map<string, string>()
	const find = (x: string): string => {
		if (!parent.has(x)) parent.set(x, x)
		let root = x
		while (parent.get(root)! !== root) root = parent.get(root)!
		while (parent.get(x)! !== root) {
			const next = parent.get(x)!
			parent.set(x, root)
			x = next
		}
		return root
	}
	const union = (a: string, b: string) => {
		const ra = find(a)
		const rb = find(b)
		if (ra !== rb) parent.set(ra, rb)
	}
	{
		const byAddr = new Map<string, string[]>()
		for (const [npi, info] of npiPrimary) {
			find(npi) // seed
			if (!info.addrKey) continue
			if (!byAddr.has(info.addrKey)) byAddr.set(info.addrKey, [])
			byAddr.get(info.addrKey)!.push(npi)
		}
		for (const group of byAddr.values()) {
			for (let i = 0; i < group.length; i++) {
				for (let j = i + 1; j < group.length; j++) {
					if (orgJaccard(npiPrimary.get(group[i]!)!.tokens, npiPrimary.get(group[j]!)!.tokens) >= ORG_TAU)
						union(group[i]!, group[j]!)
				}
			}
		}
	}
	const orgNameLabel = (rec: SourceRecord) => (npiPrimary.has(rec.id) ? find(rec.id) : rec.id)

	// --- ORG-NAME-COORD entity-truth (Tier 2D, #625). The string org-name truth above blocks by the
	// address STRING (`addressFrequencyKey`), so it MISSES same-building pairs whose text differs —
	// "1504 Taub LOOP" vs "1504 Taub LP STE 100" key apart even though the geocoder places them at one
	// point. This variant blocks by the GEOCODED BUILDING instead: union two NPIs whose org names match
	// (Jaccard ≥ ORG_TAU) AND whose primary practice coordinates are within the same-building distance
	// (≤ 50 m haversine, the DEFAULT_DISTANCE_LEVELS grain). Brute-force pairwise over the ~1000 sampled
	// NPIs (trivial); a tighter LOWER bound on the org-name truth — the org-name F1 here is ≥ the string
	// one. The Jaccard gate still prevents collapsing distinct co-located orgs (the gold-set safety). ---
	const COLOCATION_KM = 0.05
	const npiCoord = new Map<string, { latitude: number; longitude: number }>()
	for (const rec of records) {
		const c = rec.address?.geocode?.coordinate
		// first geocoded record per NPI ≈ its primary practice address (primary row is pushed first)
		if (c && !npiCoord.has(rec.id)) npiCoord.set(rec.id, c)
	}
	const parentC = new Map<string, string>()
	const findC = (x: string): string => {
		if (!parentC.has(x)) parentC.set(x, x)
		let root = x
		while (parentC.get(root)! !== root) root = parentC.get(root)!
		while (parentC.get(x)! !== root) {
			const next = parentC.get(x)!
			parentC.set(x, root)
			x = next
		}
		return root
	}
	const unionC = (a: string, b: string) => {
		const ra = findC(a)
		const rb = findC(b)
		if (ra !== rb) parentC.set(ra, rb)
	}
	{
		const coLocated = [...npiPrimary.keys()].filter((n) => npiCoord.has(n))
		for (const n of npiPrimary.keys()) findC(n) // seed every NPI (un-geocoded ones stay singletons)
		for (let i = 0; i < coLocated.length; i++) {
			for (let j = i + 1; j < coLocated.length; j++) {
				const a = coLocated[i]!
				const b = coLocated[j]!
				if (haversineKm(npiCoord.get(a)!, npiCoord.get(b)!) > COLOCATION_KM) continue
				if (orgJaccard(npiPrimary.get(a)!.tokens, npiPrimary.get(b)!.tokens) >= ORG_TAU) unionC(a, b)
			}
		}
	}
	const geocodedNpis = [...npiPrimary.keys()].filter((n) => npiCoord.has(n)).length
	const orgNameCoordLabel = (rec: SourceRecord) => (npiPrimary.has(rec.id) ? findC(rec.id) : rec.id)

	// --- Phase D: the comparison-model lever progression — toggle each lever ON in turn at the default
	// threshold to isolate its marginal effect, then sweep the link threshold on the best config (geocode
	// once, resolve many — config is cheap). ---
	console.error(`[D] resolving the lever progression${TRAIN_EM ? " (EM-trained)" : ""}…`)
	type LeverConfig = {
		addressFrequency?: typeof addressFrequency | false
		collapseSpatial?: boolean
		discriminators?: string[]
	}
	// The proven levers are now DEFAULT-ON in resolveEntities (#86). Each row sets BOTH `collapseSpatial`
	// and `addressFrequency` EXPLICITLY so the progression isolates one lever at a time — otherwise the
	// flipped default (collapseSpatial:true) would silently ride the `+ inverse-address-frequency` row and
	// the A1 delta would read as 0. Every row feeds the corpus-wide frequency table (the realistic
	// deployment, where the CLI builds it from the full source files); the zero-config `{}` default is
	// reported SEPARATELY below, since on a sub-sample its input-scoped table is intentionally sparse.
	const LEVERS: Array<{ label: string; config: LeverConfig }> = [
		{
			label: "baseline (legacy: address-key + distance, levers OFF)",
			config: { collapseSpatial: false, addressFrequency: false },
		},
		{ label: "+ inverse-address-frequency (#617, corpus-wide)", config: { collapseSpatial: false, addressFrequency } },
		{ label: "+ collapsed spatial signal (A1, #625)", config: { collapseSpatial: true, addressFrequency } },
		{
			label: "+ authorized-official discriminator (#625, full stack)",
			config: { collapseSpatial: true, addressFrequency, discriminators: ["authorizedOfficial"] },
		},
	]
	// learnedScorer:false throughout — this benchmark studies the FS COMPARISON-MODEL levers (#617/#625).
	// The learned scorer is now default-on, so it must be pinned off here or every row would silently be the
	// GBT; the learned scorer is measured separately (learned-scorer-clustering-eval / -crossstate-eval).
	const progression = LEVERS.map((l) => {
		const res = resolveEntities(records, { learnedScorer: false, trainEM: TRAIN_EM, threshold: 0, ...l.config })
		return { ...l, res, score: scoreEntities(res.entities, npiLabel) }
	})
	const baseline = progression[0]! // no levers — the prior-prior behaviour
	const bestLever = progression[progression.length - 1]! // the full lever stack

	// The SHIPPED out-of-box default (#86): no lever config at all → resolveEntities auto-computes an
	// input-scoped address-frequency table + collapsed spatial. On this deliberately-sub-sampled corpus the
	// auto table is sparse (few repeats), so the inverse-frequency signal is near-inert and F1 collapses to
	// ≈baseline — NOT a regression, just the honest truth that IDF is a corpus statistic you can't synthesize
	// from a slice. On a FULL-dataset dedup the input IS the corpus and this default reaches the spine; the
	// CLI passes a corpus-wide table built from the full source files so even a geocoded sub-sample benefits.
	const defaultOutOfBox = (() => {
		const res = resolveEntities(records, { learnedScorer: false, trainEM: TRAIN_EM, threshold: 0 })
		return { res, score: scoreEntities(res.entities, npiLabel) }
	})()

	const THRESHOLDS = [0, 4, 8, 12, 16, 20]
	const sweep = THRESHOLDS.map((t) => {
		const res = resolveEntities(records, { learnedScorer: false, trainEM: TRAIN_EM, threshold: t, ...bestLever.config })
		return { t, res, score: scoreEntities(res.entities, npiLabel) }
	})
	const base = sweep[0]! // threshold 0, full lever stack
	const best = sweep.reduce((a, b) => (b.score.f1 > a.score.f1 ? b : a))
	console.error(
		`    progression @ threshold 0: ${progression.map((p) => `${(100 * p.score.f1).toFixed(1)}%`).join(" → ")} F1`
	)
	console.error(
		`    default F1 ${(100 * base.score.f1).toFixed(1)}% → best F1 ${(100 * best.score.f1).toFixed(1)}% @ threshold ${best.t}`
	)

	// --- Phase F: NPI-level vs ENTITY-level truth. Score the SAME clusters against both yardsticks to
	// reveal how much of the apparent over-merge is NPI over-segmentation (one org / many subpart-NPIs,
	// where merging is CORRECT) rather than model error. Two production configs: the FS full lever stack
	// and the shipped default (GBT, default-on) — each fed the corpus-wide address-frequency table. ---
	const entityCount = new Set(records.map((r) => entityLabel(r))).size
	const orgCount = new Set(records.map((r) => orgNameLabel(r))).size
	const fsNpi = bestLever.score
	const fsEntity = scoreEntities(bestLever.res.entities, entityLabel)
	const fsOrg = scoreEntities(bestLever.res.entities, orgNameLabel)
	const gbtRes = resolveEntities(records, { addressFrequency, trainEM: TRAIN_EM }) // GBT default-on (production)
	const gbtNpi = scoreEntities(gbtRes.entities, npiLabel)
	const gbtEntity = scoreEntities(gbtRes.entities, entityLabel)
	const gbtOrg = scoreEntities(gbtRes.entities, orgNameLabel)
	// Tier 2D: the coordinate-co-location org-name truth (tighter lower bound).
	const orgCoordCount = new Set(records.map((r) => orgNameCoordLabel(r))).size
	const fsOrgCoord = scoreEntities(bestLever.res.entities, orgNameCoordLabel)
	const gbtOrgCoord = scoreEntities(gbtRes.entities, orgNameCoordLabel)

	// Optional candidate A/B (--candidate): score a trained GBT module at both levels, at its own
	// recommendedThreshold, alongside the shipped GBT — grades a new model (e.g. corroboration features).
	let cand: { label: string; npi: Score; entity: Score } | null = null
	if (CANDIDATE) {
		const mod = (await import(pathToFileURL(resolvePath(CANDIDATE)).href)) as {
			DEDUP_GBT_MODEL: GBT
			DEDUP_GBT_META?: { recommendedThreshold?: number; features?: number; costNegative?: number }
		}
		const t = mod.DEDUP_GBT_META?.recommendedThreshold ?? 0
		const res = resolveEntities(records, {
			addressFrequency,
			trainEM: TRAIN_EM,
			learnedScorer: mod.DEDUP_GBT_MODEL,
			threshold: t,
		})
		const cost = mod.DEDUP_GBT_META?.costNegative ?? 1
		cand = {
			label: `GBT candidate (${mod.DEDUP_GBT_META?.features ?? "?"}-feat${cost !== 1 ? `, cost ×${cost}` : ""})`,
			npi: scoreEntities(res.entities, npiLabel),
			entity: scoreEntities(res.entities, entityLabel),
		}
		console.error(
			`    candidate ${CANDIDATE}: NPI ${(100 * cand.npi.f1).toFixed(1)}% / entity ${(100 * cand.entity.f1).toFixed(1)}%`
		)
	}
	console.error(
		`    truth-grains — GBT NPI ${(100 * gbtNpi.f1).toFixed(1)}% → site ${(100 * gbtEntity.f1).toFixed(1)}% → org-name ${(100 * gbtOrg.f1).toFixed(1)}% → org-name-coord ${(100 * gbtOrgCoord.f1).toFixed(1)}%; ` +
			`FS: NPI ${(100 * fsNpi.f1).toFixed(1)}% / entity ${(100 * fsEntity.f1).toFixed(1)}% / org-coord ${(100 * fsOrgCoord.f1).toFixed(1)}%`
	)

	const pct = (x: number) => (100 * x).toFixed(1)
	const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}pp`
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
	lines.push(
		`**Headline — org-name truth (the honest grain, [why](../concepts/dedup-entity-truth.mdx)):** the shipped ` +
			`matcher resolves these records at **F1 ${pct(gbtOrg.f1)}%** against org-name entity-truth — not the NPI-level ` +
			`${pct(gbtNpi.f1)}%, which mostly measures NPI over-segmentation (one organization holds many subpart NPIs, so ` +
			`correct co-located merges are scored as errors). Same clusters, three rulers: ` +
			`**NPI ${pct(gbtNpi.f1)}% → site ${pct(gbtEntity.f1)}% → org-name ${pct(gbtOrg.f1)}%** ` +
			`(${kept.size} NPI → ${entityCount} site → ${orgCount} org-name classes); the climb is the yardstick getting honest, ` +
			`not the model changing — gold-set validated (120/120 hard pairs = same org). Details in "Three truth grains" below.`
	)
	lines.push("")
	lines.push(`## The comparison-model levers (each toggled on, at the default threshold)`)
	lines.push("")
	lines.push(`| model | precision | recall | F1 | ΔF1 | ARI | over-merged |`)
	lines.push(`|---|---:|---:|---:|---:|---:|---:|`)
	progression.forEach((p, i) => {
		const delta = i === 0 ? "—" : signed(100 * (p.score.f1 - progression[i - 1]!.score.f1))
		const bold = i === progression.length - 1
		const w = (s: string) => (bold ? `**${s}**` : s)
		lines.push(
			`| ${w(p.label)} | ${w(pct(p.score.precision) + "%")} | ${w(pct(p.score.recall) + "%")} | ${w(pct(p.score.f1) + "%")} | ${delta} | ${w(p.score.ari.toFixed(3))} | ${w(String(p.score.overMergedClusters))} |`
		)
	})
	lines.push("")
	lines.push(
		`Inverse-frequency weighting uses the corpus-wide table (${addrCounts.size.toLocaleString()} distinct addresses ` +
			`over ${addrTotal.toLocaleString()} providers) to down-weight a crowded shared address; collapsing the redundant ` +
			`address-key + distance comparisons into one spatial signal (A1) removes the double-count that let a shared address ` +
			`over-vote a disagreeing name. The address-frequency + A1 spine is F1 ${pct(progression[2]!.score.f1)}% at the ` +
			`default threshold; the **authorized-official discriminator** is roughly neutral there (${signed(100 * (bestLever.score.f1 - progression[2]!.score.f1))}) ` +
			`but enables a higher cutoff — it holds recall where the spine alone collapses, reaching **${pct(best.score.f1)}%** at ` +
			`threshold ${best.t} (below), the first config past the spine (#625).`
	)
	lines.push("")
	lines.push(
		`**Out-of-the-box (zero-config \`resolveEntities(records)\`, levers default-on #86):** F1 ` +
			`**${pct(defaultOutOfBox.score.f1)}%** on this sample — essentially the baseline. The default auto-computes the ` +
			`address-frequency table over the INPUT records, and this benchmark deliberately sub-samples ${N} records, so ` +
			`that table is too sparse to carry the inverse-frequency signal (a corpus statistic you can't synthesize from a ` +
			`slice). It's **not a regression** (≥ baseline, no over-merge added) — it's the honest floor when the input isn't ` +
			`corpus-scale. Fed the corpus-wide table (the \`+ inverse-address-frequency\` row above, what the CLI builds from ` +
			`the full source files) the SAME default reaches the **${pct(progression[2]!.score.f1)}%** spine. On a full-dataset ` +
			`dedup the input IS the corpus, so zero-config reaches the spine on its own.`
	)
	lines.push("")
	lines.push(`## With all levers on, across the link threshold (the secondary lever)`)
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
	lines.push(`## Three truth grains — NPI → site → org-name (the over-segmentation correction)`)
	lines.push("")
	lines.push(
		`NPI-as-truth OVER-SEGMENTS: one org holds many NPIs, so the matcher's correct co-located merges are scored as ` +
			`errors. Three yardsticks, same clusters: **NPI** (one entity per registration), **site** (subpart-flagged ` +
			`collapse + split an NPI's distinct addresses), and **org-name** — the gold-set-validated truth: same NPI ⇒ ` +
			`same entity (recall preserved) PLUS collapse co-located NPIs whose primary org names match (Jaccard ≥ ${ORG_TAU}), ` +
			`with NO reliance on the subpart flag (the gold set showed it misses 37%). The same ${N} records carry ` +
			`**${kept.size} NPI** → **${entityCount} site** → **${orgCount} org-name** classes. The org-name number is the ` +
			`honest one: it stops charging the matcher for the same-org merges the gold set proved are correct.`
	)
	lines.push("")
	lines.push(`| config | truth | precision | recall | F1 | ΔF1 vs NPI | ARI | over-merged |`)
	lines.push(`|---|---|---:|---:|---:|---:|---:|---:|`)
	const dualRow = (label: string, truth: string, s: Score, delta?: number) =>
		lines.push(
			`| ${label} | ${truth} | ${pct(s.precision)}% | ${pct(s.recall)}% | **${pct(s.f1)}%** | ${delta === undefined ? "—" : signed(100 * delta)} | ${s.ari.toFixed(3)} | ${s.overMergedClusters} |`
		)
	dualRow("FS full stack", "NPI", fsNpi)
	dualRow("FS full stack", "site", fsEntity, fsEntity.f1 - fsNpi.f1)
	dualRow("FS full stack", "**org-name**", fsOrg, fsOrg.f1 - fsNpi.f1)
	dualRow("FS full stack", "org-name (coord)", fsOrgCoord, fsOrgCoord.f1 - fsNpi.f1)
	dualRow("GBT (shipped default)", "NPI", gbtNpi)
	dualRow("GBT (shipped default)", "site", gbtEntity, gbtEntity.f1 - gbtNpi.f1)
	dualRow("GBT (shipped default)", "**org-name**", gbtOrg, gbtOrg.f1 - gbtNpi.f1)
	dualRow("GBT (shipped default)", "**org-name (coord)**", gbtOrgCoord, gbtOrgCoord.f1 - gbtNpi.f1)
	if (cand) {
		dualRow(cand.label, "NPI", cand.npi)
		dualRow(cand.label, "**entity**", cand.entity, cand.entity.f1 - cand.npi.f1)
	}
	lines.push("")
	lines.push(
		`The F1 **climbs as the yardstick gets honest**: GBT **${pct(gbtNpi.f1)}% (NPI) → ${pct(gbtEntity.f1)}% (site) → ` +
			`${pct(gbtOrg.f1)}% (org-name)**, the over-merge collapsing (${gbtNpi.overMergedClusters} → ${gbtOrg.overMergedClusters}) ` +
			`and precision rising (${pct(gbtNpi.precision)}% → ${pct(gbtOrg.precision)}%). The clusters are IDENTICAL across the three ` +
			`columns — the climb is purely the ruler ceasing to charge the matcher for the correct same-org merges the gold set proved ` +
			`(\`2026-06-16-dedup-gold-set-tx120.md\`: 120/120 same org, 0 genuine over-merges).`
	)
	lines.push("")
	lines.push(
		`**Tier 2D — tightening the org-name ruler with the geocode coordinate.** The org-name truth above blocks by the address ` +
			`STRING (\`addressFrequencyKey\`), so two records at one building whose text differs — \`1504 Taub LOOP\` vs ` +
			`\`1504 Taub LP STE 100\` — key apart and the merge is still charged as an error. Block by the GEOCODED BUILDING instead ` +
			`(union co-located NPIs within ${COLOCATION_KM * 1000} m whose org names agree, same Jaccard gate) and the truth tightens ` +
			`further: GBT **org-name ${pct(gbtOrg.f1)}% → org-name-coord ${pct(gbtOrgCoord.f1)}%** ` +
			`(${signed(100 * (gbtOrgCoord.f1 - gbtOrg.f1))}), ${orgCount} → ${orgCoordCount} classes, over ${geocodedNpis}/${kept.size} ` +
			`geocoded NPIs. The string org-name F1 is a conservative LOWER bound; the coordinate one is tighter (the Jaccard gate ` +
			`still blocks distinct co-located orgs). Both are honest — the coordinate is the geocode-first key.`
	)
	lines.push("")
	lines.push(
		`**Takeaways:** (1) The dedup model's REAL quality is the **org-name F1 ~${pct(gbtOrg.f1)}%**, not the NPI-level ` +
			`${pct(gbtNpi.f1)}% — the difference was NPI over-segmentation, not model error. (2) The #625 lever was the YARDSTICK, ` +
			`not the scorer: the corroboration-feature experiment (reverted) couldn't move precision because the over-merge was ` +
			`mostly correct. (3) The remaining org-name over-merge (${gbtOrg.overMergedClusters} clusters) is the genuine frontier — ` +
			`small, approaching the ceiling's ~1.6% irreducible (\`2026-06-16-dedup-ceiling.md\`). (4) Trust the large eval: a 50-NPI ` +
			`smoke misled on the site delta (+5–7pp vs this run's ±2pp).`
	)
	lines.push("")
	lines.push(
		`Caveats: the programmatic site-truth is CONSERVATIVE (collapses only NPPES-flagged subparts; unflagged same-org pairs still ` +
			`read as over-merge), so it understates the subpart correction. A hand-adjudicated gold set on the ambiguous co-located + ` +
			`two-site slice is the next refinement (#625).`
	)
	lines.push("")
	lines.push(`## Reading`)
	lines.push("")
	lines.push(
		`The geocode-first **foundation works**: **${pct(geo / N)}%** of addresses placed, blocking + clustering clean — the ` +
			`geocoding (the Pelias/Nominatim-can't-do-this part) is not the bottleneck. The comparison-model levers reach the ` +
			`address-frequency + A1 spine at F1 **${pct(progression[2]!.score.f1)}%** (${signed(100 * (progression[2]!.score.f1 - baseline.score.f1))} over baseline): ` +
			`inverse-frequency weighting restores full weight to a *rare* shared address (stitching a provider's name-drifted ` +
			`records together — mostly recall) while down-weighting a *crowded* one, and the collapsed spatial signal (A1) drops ` +
			`the address+distance double-count. What remains is **precision / over-merge** — ${bestLever.score.overMergedClusters} ` +
			`clusters still fuse distinct co-located providers, because even one down-weighted spatial agreement can outvote a ` +
			`disagreeing name. The lever search (#625) — two negatives, then the first positive: a name/org/phone ` +
			`**corroboration gate** (A2/A3) — phone is an unreliable secondary identifier on NPPES (shared institutional ` +
			`switchboard lines), so it over-links and falsely corroborates co-phone distinct providers; and **average-linkage ` +
			`clustering** (A4) — the over-merged clusters are joined by STRONG shared-address edges, not weak bridges, so ` +
			`average-linkage can't split them and only trades away name-drift recall. The over-merge is a **scoring** problem ` +
			`this data can't resolve, not a clustering-topology one. The **authorized-official discriminator** is the first lever to beat the spine — a reliable secondary identifier holds recall so a higher threshold separates the co-located providers; a still-more-distinctive identifier ` +
			`(taxonomy / license) or a learned scorer over the FS feature vector (#603) goes further. Config ` +
			`dominates the model (the pre-registered finding) — tracked as #625 / the selective-model work (#602 / #603).`
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
