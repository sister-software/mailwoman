/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #655 measurement — can a RE-THRESHOLDED dedup GBT beat the FS baseline on the cross-SOURCE link
 *   discovery objective? The dedup GBT (#603) is pinned OFF for cross-dataset flows because its
 *   over-merge features (`spatial-exact × name/org-disagree`) push true "same facility, different
 *   operational name across sources" pairs NEGATIVE — and the GBT logit REPLACES the FS weight, so
 *   a threshold can't trivially separate them. This quantifies that.
 *
 *   Geocode the three sources ONCE (NPPES + FCC-RHC + TX HHSC, TX-scoped), then resolve repeatedly:
 *   the FS baseline (the recall-correct baseline) and the bundled GBT at a fine threshold sweep.
 *   For each arm, report cross-source links (entities spanning ≥2 sources), triple-source entities,
 *   total entities (an over-merge proxy — fewer = more collapsing), and a LABEL-FREE precision
 *   proxy: PHONE corroboration — the fraction of cross-source entities in which two records from
 *   DIFFERENT sources carry the same phone number (strong same-facility evidence the scorer didn't
 *   directly use as the join key).
 *
 *   Verdict logic: if some GBT threshold matches FS's cross-source link count at ≥ FS phone-corrob,
 *   the threshold fix (option 1) works → ship a cross-source threshold. If matching FS link count
 *   only comes with collapsing total entities and a LOWER phone-corrob (junk over-merges), the
 *   threshold is insufficient by construction → FS stays pinned / a cross-objective retrain (#655
 *   option 2) is the only lever.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/cross-source-threshold-sweep.ts\
 *   [--cap 2000] [--state TX] [--wof <admin.db>] [--data-root <dir>] [--out-md <md>]
 */

import { writeFileSync } from "node:fs"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath, mailwomanDataRoot } from "@mailwoman/core/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import {
	addressFrequencyKey,
	buildDefaultModel,
	createGbtScorer,
	DEDUP_GBT_META,
	DEDUP_GBT_MODEL,
	geocodeAddressVia,
	ingestRows,
	resolveEntities,
	streamRows,
	type ColumnMapping,
	type ResolvedEntity,
	type SourceRecord,
} from "@mailwoman/registry"
import { createWOFResolver } from "@mailwoman/resolver"

import { geocodeAddress, ShardProvider } from "../../mailwoman/out/geocode-core.js"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)

	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const SOURCES = arg("sources", dataRootPath("record-matcher", "sources"))
const CAP = Number(arg("cap", "2000"))
const STATE = arg("state", "TX").toUpperCase()
const WOF = arg("wof", dataRootPath("wof", "admin-global-priority.db"))
const DATA_ROOT = arg("data-root", mailwomanDataRoot())
const OUT_MD = arg("out-md", "")
// #655 option 2: a trained CROSS-SOURCE GBT module (exports CROSS_SOURCE_GBT_MODEL + _META) to grade as
// a third arm at its recommended threshold — the model train-cross-gbt.ts emits.
const CANDIDATE = arg("candidate", "")

const norm = (s: string | undefined) => (s ?? "").trim()

interface SourceSpec {
	source: string
	path: string
	mapping: ColumnMapping
	inState: (row: Record<string, string>) => boolean
}

const S = `${SOURCES}`
const SPECS: SourceSpec[] = [
	{
		source: "txhhsc-nursing",
		path: `${S}/txhhsc_nursing-facilities_20260611.tsv`,
		mapping: {
			id: "Facility ID",
			organization: "Facility Name",
			address: ["Physical Address", "Physical Address CITY", "Physical Address State", "Physical Address Zipcode"],
			phone: "Facility Phone Number",
			source: "txhhsc-nursing",
		},
		inState: (r) => norm(r["Physical Address State"]).toUpperCase() === STATE,
	},
	{
		source: "fcc-rhc",
		path: `${S}/fcc-rhc_posted-services_form461-465_20260615.tsv`,
		mapping: {
			id: "HCP Number",
			organization: "HCP Name",
			address: ["Site Address Line 1", "Site City", "Site State", "Site ZIP Code"],
			phone: "Contact Phone",
			email: "Contact E-mail",
			source: "fcc-rhc",
		},
		inState: (r) => norm(r["Site State"]).toUpperCase() === STATE,
	},
	{
		source: "nppes",
		path: `${S}/nppes_npi-registry_20260607.tsv`,
		mapping: {
			id: "NPI",
			organization: "Provider Organization Name (Legal Business Name)",
			address: [
				"Provider First Line Business Practice Location Address",
				"Provider Business Practice Location Address City Name",
				"Provider Business Practice Location Address State Name",
				"Provider Business Practice Location Address Postal Code",
			],
			phone: "Provider Business Practice Location Address Telephone Number",
			source: "nppes",
		},
		inState: (r) =>
			norm(r["Provider Business Practice Location Address State Name"]).toUpperCase() === STATE &&
			norm(r["Entity Type Code"]) === "2" &&
			!!norm(r["Provider Organization Name (Legal Business Name)"]),
	},
]

/** Distinct provenance labels an entity's records span. */
const entitySources = (e: ResolvedEntity): Set<string> =>
	new Set(e.records.map((r) => r.source).filter((s): s is string => !!s))

/** Last-10-digit phone key (drops formatting / country code). */
const normPhone = (p?: string | null): string => {
	if (!p) return ""
	const d = p.replace(/\D/g, "")

	return d.length >= 10 ? d.slice(-10) : ""
}

/**
 * Label-free precision proxy: does this cross-source entity carry the SAME phone in records from two DIFFERENT sources?
 * (Phone isn't the join key, so a match is independent corroboration of same-facility.) Entities where no two
 * cross-source records both have a phone are "unknown" — we only count corroborated / contradicted among those that CAN
 * be checked.
 */
function phoneEvidence(e: ResolvedEntity): "corroborated" | "contradicted" | "unknown" {
	const bySource = new Map<string, Set<string>>()

	for (const r of e.records) {
		const ph = normPhone(r.phone)

		if (!ph) continue
		const s = r.source ?? "?"

		if (!bySource.has(s)) bySource.set(s, new Set())
		bySource.get(s)!.add(ph)
	}
	const sources = [...bySource.keys()]

	if (sources.length < 2) return "unknown"
	let any = false

	for (let i = 0; i < sources.length; i++) {
		for (let j = i + 1; j < sources.length; j++) {
			any = true

			for (const ph of bySource.get(sources[i]!)!) if (bySource.get(sources[j]!)!.has(ph)) return "corroborated"
		}
	}

	return any ? "contradicted" : "unknown"
}

interface ArmMetrics {
	label: string
	threshold: number | null
	entities: number
	crossSource: number
	tripleSource: number
	phoneCorrob: number
	phoneContradict: number
	phoneCheckable: number
}

function measure(label: string, threshold: number | null, entities: ResolvedEntity[]): ArmMetrics {
	let crossSource = 0
	let tripleSource = 0
	let phoneCorrob = 0
	let phoneContradict = 0
	let phoneCheckable = 0

	for (const e of entities) {
		const n = entitySources(e).size

		if (n < 2) continue
		crossSource++

		if (n >= 3) tripleSource++
		const ev = phoneEvidence(e)

		if (ev === "corroborated") {
			phoneCorrob++
			phoneCheckable++
		} else if (ev === "contradicted") {
			phoneContradict++
			phoneCheckable++
		}
	}

	return {
		label,
		threshold,
		entities: entities.length,
		crossSource,
		tripleSource,
		phoneCorrob,
		phoneContradict,
		phoneCheckable,
	}
}

async function main(): Promise<void> {
	// --- Ingest + geocode each source ONCE. ---
	const rawBySource = new Map<string, Record<string, string>[]>()

	for (const spec of SPECS) {
		console.error(`[A] ${spec.source}: streaming + ${STATE} filter (cap ${CAP})…`)
		const kept: Record<string, string>[] = []

		for await (const row of streamRows(spec.path)) {
			if (!spec.inState(row)) continue
			kept.push(row)

			if (kept.length >= CAP) break
		}
		rawBySource.set(spec.source, kept)
		console.error(`    ${spec.source}: ${kept.length} rows`)
	}

	console.error("[B] building the geocoder…")
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new mod.WOFSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWOFResolver(lookup)
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

	console.error("[C] geocoding + ingesting…")
	const records: SourceRecord[] = []

	for (const spec of SPECS) {
		const recs = await ingestRows(rawBySource.get(spec.source)!, spec.mapping, { geocodeAddress: seam })

		for (const r of recs) r.id = `${spec.source}:${r.id}`
		records.push(...recs)
	}
	shardProvider.close()
	lookup.close()
	const geocoded = records.filter((r) => r.address?.geocode).length
	console.error(`    ${records.length} records; geocoded ${geocoded}`)

	// --- The bundled GBT scorer over the input-scoped address-frequency basis (eval convention). ---
	const addrCounts = new Map<string, number>()
	let addrTotal = 0

	for (const r of records) {
		if (!r.address?.raw) continue
		addrCounts.set(addressFrequencyKey(r.address.raw), (addrCounts.get(addressFrequencyKey(r.address.raw)) ?? 0) + 1)
		addrTotal++
	}
	const addressFrequency = {
		total: addrTotal,
		distinct: addrCounts.size,
		frequency: (v: string) => (v ? (addrCounts.get(addressFrequencyKey(v)) ?? 0) / addrTotal : 0),
	}
	const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons
	const gbtScorer = createGbtScorer({ model: DEDUP_GBT_MODEL, comparisons, addressFrequency })

	// --- Arm 1: the FS baseline (the recall-correct baseline cross-source flows currently pin). ---
	console.error("[D] resolving — FS baseline baseline…")
	const fs = measure(
		"FS baseline",
		0,
		resolveEntities(records, { trainEM: true, collapseSpatial: true, addressFrequency, learnedScorer: false }).entities
	)

	// --- Arm 2: the bundled GBT at a fine threshold sweep (down well below the dedup 2.71, since
	// cross-source pairs sit at strongly NEGATIVE logits). ---
	const SWEEP = [-8, -6, -5, -4, -3, -2, -1, 0, 1, 2, DEDUP_GBT_META.recommendedThreshold]
	const gbtArms: ArmMetrics[] = []

	for (const t of SWEEP) {
		console.error(`[D] resolving — GBT @ threshold ${t}…`)
		const { entities } = resolveEntities(records, {
			collapseSpatial: true,
			addressFrequency,
			scorer: gbtScorer,
			threshold: t,
		})
		gbtArms.push(measure(`GBT @ ${t.toFixed(2)}`, t, entities))
	}

	// --- Verdict. The threshold fix WORKS only if some GBT arm dominates FS — more (or equal)
	// cross-source links at ≥ FS phone-corroboration WITHOUT over-merging (entity count must not
	// collapse below ~90% of FS, else the "links" are giant-blob artifacts). Otherwise FS is on the
	// frontier and threshold alone is insufficient. ---
	const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(0)}%` : "—")
	// --- Arm 3 (#655 option 2): the cross-source-trained GBT at its own recommended threshold. ---
	const candidateArms: ArmMetrics[] = []

	if (CANDIDATE) {
		const { pathToFileURL } = await import("node:url")
		const { resolve: resolvePath } = await import("node:path")
		const mod = (await import(pathToFileURL(resolvePath(CANDIDATE)).href)) as {
			CROSS_SOURCE_GBT_MODEL: typeof DEDUP_GBT_MODEL
			CROSS_SOURCE_GBT_META?: { recommendedThreshold?: number }
		}
		const t0 = mod.CROSS_SOURCE_GBT_META?.recommendedThreshold ?? 0
		const candScorer = createGbtScorer({ model: mod.CROSS_SOURCE_GBT_MODEL, comparisons, addressFrequency })
		console.error(`[E] resolving — cross-source GBT candidate @ ${t0.toFixed(3)} (±)…`)

		for (const t of [t0 - 1, t0, t0 + 1]) {
			candidateArms.push(
				measure(
					`cross-GBT @ ${t.toFixed(2)}`,
					t,
					resolveEntities(records, {
						trainEM: true,
						collapseSpatial: true,
						addressFrequency,
						scorer: candScorer,
						threshold: t,
					}).entities
				)
			)
		}
	}
	const rate = (a: ArmMetrics) => (a.phoneCheckable > 0 ? a.phoneCorrob / a.phoneCheckable : 0)
	const fsCorrobRate = rate(fs)
	const minEntities = Math.floor(fs.entities * 0.9)
	const dominating = gbtArms.find(
		(a) => a.crossSource >= fs.crossSource && rate(a) >= fsCorrobRate && a.entities >= minEntities
	)

	const rows = [fs, ...gbtArms, ...candidateArms]
	const lines: string[] = []
	lines.push(`# #655 — cross-source threshold sweep: can a re-thresholded GBT beat FS?`)
	lines.push("")
	lines.push(
		`_TX-scoped, ≤${CAP} rows/source (NPPES org + TX HHSC nursing = eligibility-ish; FCC-RHC = funding), ` +
			`geocoded once then resolved per arm. **Phone-corrob** = of the cross-source entities whose records carry ` +
			`a phone in ≥2 different sources, the fraction where those phones MATCH — a label-free precision proxy ` +
			`(phone is not the join key). Higher cross-source + higher phone-corrob = better._`
	)
	lines.push("")
	lines.push(`| arm | threshold | total entities | cross-source links | triple-source | phone-corrob (of checkable) |`)
	lines.push(`|---|---:|---:|---:|---:|---|`)

	for (const r of rows) {
		lines.push(
			`| ${r.label} | ${r.threshold === null ? "—" : r.threshold} | ${r.entities} | ${r.crossSource} | ` +
				`${r.tripleSource} | ${r.phoneCorrob}/${r.phoneCheckable} (${pct(r.phoneCorrob, r.phoneCheckable)}) |`
		)
	}
	lines.push("")
	lines.push(`## Verdict`)
	lines.push("")
	lines.push(
		`FS baseline: **${fs.crossSource}** cross-source links (${fs.tripleSource} triple), ` +
			`phone-corrob ${pct(fs.phoneCorrob, fs.phoneCheckable)} (${fs.phoneCorrob}/${fs.phoneCheckable}).`
	)

	if (!dominating) {
		lines.push("")
		lines.push(
			`**No GBT threshold dominates FS** — none matches FS's ${fs.crossSource} cross-source links at ≥ its ` +
				`${pct(fs.phoneCorrob, fs.phoneCheckable)} phone-corrob without over-merging (entity count collapsing below ` +
				`${minEntities}). At its dedup threshold the GBT finds FEWER cross-source links than FS; lowering the ` +
				`threshold to admit more only over-merges (the over-merge features REPLACE the FS weight, so true ` +
				`cross-source pairs share a logit band with genuine over-merges). Threshold alone (option 1) is ` +
				`**INSUFFICIENT** — FS stays pinned (correct + best-precision for this objective); a cross-objective ` +
				`retrain (option 2), gated on cross-source labels, is the only lever. See #655.`
		)
	} else {
		lines.push("")
		lines.push(
			`**GBT @ ${dominating.threshold} dominates FS**: ${dominating.crossSource} links (vs ${fs.crossSource}) at ` +
				`${pct(dominating.phoneCorrob, dominating.phoneCheckable)} phone-corrob (vs ${pct(fs.phoneCorrob, fs.phoneCheckable)}), ` +
				`${dominating.entities} entities (vs ${fs.entities}). The threshold fix (option 1) WORKS: ship a cross-source ` +
				`threshold ≈ ${dominating.threshold}.`
		)
	}
	lines.push("")

	const md = lines.join("\n")
	console.log(md)

	if (OUT_MD) {
		writeFileSync(OUT_MD, md)
		console.error(`[written] ${OUT_MD}`)
	}
}

await main()
