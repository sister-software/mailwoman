/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Train the production learned-scorer model (#603). Builds the SAME NPI-keyed record set the dedup
 *   benchmark + the clustering A/B use (real registry + name-drift + address-variation), geocodes
 *   it, blocks → candidate pairs, featurizes each pair with the SHARED `createMatchFeaturizer` (so
 *   train ≡ inference), labels by held-out NPI, and fits the gradient-boosted-tree model. Writes
 *   the model as a committed TS module (`registry/models/dedup-gbt-en-us.ts`) that ships in the
 *   package.
 *
 *   Unlike the eval, this trains on ALL sampled NPIs (no held-out split) — the held-out F1 is the
 *   eval's job; this produces the shipped artifact. The eval (`learned-scorer-clustering-eval.ts`)
 *   then re-measures generalization against the FS baseline.
 *
 *   Run: node --experimental-strip-types scripts/eval/record-matcher/train-gbt.ts\
 *   [--state TX] [--npis 3000] [--wof <admin.db>] [--data-root <dir>]\
 *   [--out registry/models/dedup-gbt-en-us.ts]
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parseArgs } from "node:util"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath, mailwomanDataRoot } from "@mailwoman/core/utils"
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
	type SourceRecord,
} from "@mailwoman/registry"
import { createWOFResolver } from "@mailwoman/resolver"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"

// Loose scan parity with the retired local argv helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: {
		cost: { type: "string" },
		"data-root": { type: "string" },
		date: { type: "string" },
		locale: { type: "string" },
		npis: { type: "string" },
		out: { type: "string" },
		sources: { type: "string" },
		state: { type: "string" },
		wof: { type: "string" },
	},
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as {
	cost?: string
	"data-root"?: string
	date?: string
	locale?: string
	npis?: string
	out?: string
	sources?: string
	state?: string
	wof?: string
}
const SOURCES = values["sources"] || dataRootPath("record-matcher", "sources")
const STATE = (values["state"] || "TX").toUpperCase()
const NPIS = Number(values["npis"] || "3000")
const WOF = values["wof"] || dataRootPath("wof", "admin-global-priority.db")
const DATA_ROOT = values["data-root"] || mailwomanDataRoot()
const OUT = values["out"] || "registry/models/dedup-gbt-en-us.ts"
const LOCALE = values["locale"] || "en-US"
// Cost-sensitive training (#625): up-weight the NEGATIVE (distinct-pair) class by this factor so the
// model is more conservative about merging — directly trades recall for precision to cut over-merge.
// 1 = the symmetric class-balanced default; >1 penalizes a false merge more than a missed one.
const COST = Number(values["cost"] || "1")
const TRAIN_DATE = values["date"] || new Date().toISOString().slice(0, 10) // overridable for reproducible commits

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
	authLast: "Authorized Official Last Name",
	authFirst: "Authorized Official First Name",
}

const norm = (s: string | undefined) => (s ?? "").trim()
const addr = (line: string, city: string, st: string, zip: string) =>
	[norm(line), norm(city), norm(st), norm(zip)].filter(Boolean).join(", ")

interface MessyRow {
	npi: string
	name: string
	org: string
	address: string
	/** Authorized official — feeds the #625 roll-up-signature features (officialAgree × orgDisagree). */
	auth: string
}

/** Deterministic LCG (no Math.random — reproducible split + commit). */
function lcg(seed: number): () => number {
	let s = seed >>> 0 || 1

	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0

		return s / 0x100000000
	}
}

/** Up to `n` unique sorted-quantile values from a sorted score array — link-threshold candidates. */
function uniqueQuantiles(sorted: number[], n: number): number[] {
	if (sorted.length === 0) return [0]
	const ts = new Set<number>()

	for (let k = 0; k <= n; k++) {
		ts.add(sorted[Math.floor((k / n) * (sorted.length - 1))]!)
	}

	return [...ts]
}

/** Pairwise clustering F1 of resolved entities vs the NPI grouping (record.id = the NPI). */
function clusterF1(entities: { records: readonly SourceRecord[] }[]): number {
	const choose2 = (k: number) => (k * (k - 1)) / 2
	const npiTotals = new Map<string, number>()
	let tp = 0
	let sumCluster = 0

	for (const e of entities) {
		const byNPI = new Map<string, number>()

		for (const rec of e.records) {
			byNPI.set(rec.id, (byNPI.get(rec.id) ?? 0) + 1)
		}
		sumCluster += choose2(e.records.length)

		for (const [npi, c] of byNPI) {
			tp += choose2(c)
			npiTotals.set(npi, (npiTotals.get(npi) ?? 0) + c)
		}
	}
	let sumClass = 0

	for (const total of npiTotals.values()) {
		sumClass += choose2(total)
	}
	const precision = sumCluster > 0 ? tp / sumCluster : 0
	const recall = sumClass > 0 ? tp / sumClass : 0

	return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
}

async function main(): Promise<void> {
	// --- Phase A: NPIs with ≥1 alternate organization name (the variation set). ---
	console.error("[A] streaming other-names…")
	const altNames = new Map<string, string[]>()

	for await (const r of streamRows(OTHER_NAMES)) {
		const npi = norm(r[C.npi])
		const alt = norm(r[C.otherOrg])

		if (!npi || !alt) continue
		const list = altNames.get(npi) ?? []

		if (list.length < 5) {
			list.push(alt)
		}
		altNames.set(npi, list)
	}

	// --- Phase B: one full registry pass — corpus-wide address-frequency table + the sample. ---
	console.error(`[B] full registry pass: address-frequency table + ${NPIS} ${STATE} sample…`)
	const rows: MessyRow[] = []
	const kept = new Set<string>()
	const addrCounts = new Map<string, number>()
	let addrTotal = 0
	let scanned = 0

	for await (const r of streamRows(REGISTRY)) {
		if (++scanned % 1_000_000 === 0) {
			console.error(`    scanned ${scanned / 1e6}M, kept ${kept.size}`)
		}
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
				const auth = `${norm(r[C.authFirst])} ${norm(r[C.authLast])}`.trim()
				kept.add(npi)
				rows.push({ npi, name: primaryName, org, address: practice, auth })

				for (const alt of altNames.get(npi)!) {
					rows.push({ npi, name: alt, org: alt, address: practice, auth })
				}
				const mailing = addr(r[C.mAddr]!, r[C.mCity]!, r[C.mState]!, r[C.mZip]!)

				if (mailing && mailing !== practice) {
					rows.push({ npi, name: primaryName, org, address: mailing, auth })
				}
			}
		}
	}
	const addressFrequency = {
		total: addrTotal,
		distinct: addrCounts.size,
		frequency: (v: string) => (v ? (addrCounts.get(addressFrequencyKey(v)) ?? 0) / addrTotal : 0),
	}
	console.error(
		`    ${kept.size} NPIs → ${rows.length} records; freq table ${addrCounts.size} distinct over ${addrTotal}`
	)

	// --- Phase C: geocode + ingest (NPI rides on record.id as the label). ---
	console.error("[C] geocoding…")
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: LOCALE })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new mod.WOFSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWOFResolver(lookup)
	const shardProvider = new ShardProvider(mod, DATA_ROOT)
	const seam = geocodeAddressVia({
		parse: async (raw: string) => decodeAsJSON(await classifier.parse(raw, { postcodeRepair: true })),
		geocode: (raw: string) =>
			geocodeAddress(raw, {
				classifier,
				resolver,
				shards: shardProvider.for,
				defaultCountry: "US",
				placeCountry: false,
			}),
		country: "US",
	})
	// mapping.id = "npi" → record.id IS the NPI label (multiple records share an NPI, the ground truth).
	const mapping: ColumnMapping = {
		id: "npi",
		name: "name",
		organization: "org",
		address: "address",
		attributes: { authorizedOfficial: "auth" },
	}
	const records: SourceRecord[] = await ingestRows(rows as unknown as Record<string, string>[], mapping, {
		geocodeAddress: seam,
	})
	shardProvider.close()
	lookup.close()
	const geocoded = records.filter((r) => r.address?.geocode).length
	console.error(`    ${records.length} records, ${geocoded} geocoded`)

	// --- Phase D: block → features (the SHARED featurizer) → labels. ---
	console.error("[D] blocking + featurizing…")
	const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons
	const featurize = createMatchFeaturizer({ comparisons, addressFrequency })
	const { pairs } = block(records, defaultBlockingKeys())
	const X = pairs.map(([a, b]) => featurize(a, b))
	const Y = pairs.map(([a, b]) => (a.id === b.id ? 1 : 0))
	const posRate = Y.reduce<number>((s, v) => s + v, 0) / Math.max(1, Y.length)
	const W = Y.map((y) => (y === 1 ? 1 - posRate : posRate * COST)) // class-balanced; COST up-weights negatives
	const hyperparams = { rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 }

	if (COST !== 1) {
		console.error(`    cost-sensitive: negative class weighted ×${COST} (penalize over-merge)`)
	}

	// --- Phase E: calibrate the default link threshold. The GBT logit is NOT in FS-weight units — it's
	// trained with class-balanced weights, so logit 0 (the balanced boundary) ignores the ~1% match base
	// rate and over-merges. Split the NPIs 80/20, fit a calibration GBT on the 80%, and sweep the
	// CLUSTERING threshold on the held-out 20% (the metric resolveEntities actually optimizes) for F1-max.
	// The shipped full-data model has near-identical logit calibration, so the threshold transfers. ---
	console.error("[E] calibrating the default link threshold on a held-out NPI split…")
	const rnd = lcg(20260615)
	const split = new Map<string, "fit" | "holdout">()

	for (const npi of kept) {
		split.set(npi, rnd() < 0.8 ? "fit" : "holdout")
	}
	const fitPairs = pairs.filter(([a, b]) => split.get(a.id) === "fit" && split.get(b.id) === "fit")
	const calibGbt = trainGBT(
		fitPairs.map(([a, b]) => featurize(a, b)),
		fitPairs.map(([a, b]) => (a.id === b.id ? 1 : 0)),
		fitPairs.map(([a, b]) => (a.id === b.id ? 1 - posRate : posRate * COST)),
		hyperparams
	)
	const calibScorer = (a: SourceRecord, b: SourceRecord) => gbtScore(calibGbt, featurize(a, b))
	const holdoutRecords = records.filter((r) => split.get(r.id) === "holdout")
	const { pairs: holdoutPairs } = block(holdoutRecords, defaultBlockingKeys())
	const holdoutScores = holdoutPairs.map(([a, b]) => calibScorer(a, b)).sort((p, q) => p - q)
	let recommendedThreshold = 0
	let bestF1 = -1

	for (const t of uniqueQuantiles(holdoutScores, 40)) {
		const { entities } = resolveEntities(holdoutRecords, {
			addressFrequency,
			collapseSpatial: true,
			scorer: calibScorer,
			threshold: t,
		})
		const f1 = clusterF1(entities)

		if (f1 > bestF1) {
			bestF1 = f1
			recommendedThreshold = t
		}
	}
	console.error(
		`    recommended link threshold ${recommendedThreshold.toFixed(3)} (held-out clustering F1 ${(100 * bestF1).toFixed(1)}%)`
	)

	// --- Phase F: train the SHIPPED model on ALL pairs. ---
	console.error("[F] training the shipped model on all pairs…")
	const model = trainGBT(X, Y, W, hyperparams)
	console.error(`    ${pairs.length} pairs (${(100 * posRate).toFixed(1)}% positive), ${model.trees.length} trees`)

	// --- Emit the model as a committed TS module. The literal is single-line + prettier-ignored so a
	// retrain produces a clean one-line diff, not a thousand reformatted lines. ---
	const meta = {
		version: "1.0.0",
		locale: LOCALE,
		trainedOn: TRAIN_DATE,
		state: STATE,
		npis: kept.size,
		records: records.length,
		pairs: pairs.length,
		posRate: Number(posRate.toFixed(4)),
		costNegative: COST, // cost-sensitive negative-class up-weight (1 = symmetric class-balanced)
		hyperparams,
		recommendedThreshold: Number(recommendedThreshold.toFixed(4)), // F1-max link threshold (held-out); resolveEntities' default when learnedScorer is active
		features: X[0]?.length ?? 0,
		addressFrequencyDistinct: addrCounts.size,
		addressFrequencyTotal: addrTotal,
	}
	const moduleSource =
		`/**\n` +
		` * @copyright Sister Software\n` +
		` * @license AGPL-3.0\n` +
		` * @author Teffen Ellis, et al.\n` +
		` *\n` +
		` *   GENERATED by scripts/eval/record-matcher/train-gbt.ts — DO NOT edit by hand; retrain to update.\n` +
		` *\n` +
		` *   The default learned-scorer model (#603): a gradient-boosted-tree dedup scorer trained on the\n` +
		` *   NPPES NPI-truth set (${STATE}, ${kept.size} NPIs → ${pairs.length} candidate pairs). Validated to\n` +
		` *   generalize across states by learned-scorer-crossstate-eval.ts. Used by resolveEntities'\n` +
		` *   opt-in learnedScorer hook via createGbtScorer. The trained {@link GBT} is plain data.\n` +
		` */\n\n` +
		`import type { GBT } from "@mailwoman/match"\n\n` +
		`/** Provenance for the bundled model — what it was trained on. */\n` +
		`export const DEDUP_GBT_META = ${JSON.stringify(meta, null, 2)} as const\n\n` +
		`// prettier-ignore\n` +
		`export const DEDUP_GBT_MODEL: GBT = ${JSON.stringify(model)}\n`
	mkdirSync(dirname(OUT), { recursive: true })
	writeFileSync(OUT, moduleSource)
	console.error(`[written] ${OUT} (${(moduleSource.length / 1024).toFixed(0)} KB)`)
}

await main()
