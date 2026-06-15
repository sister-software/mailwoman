/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cross-dataset correlation (#618) — the marquee proof: resolve ONE record set across datasets that
 *   share NO key. NPPES (the national provider registry), FCC Rural Health Care filings, and TX
 *   HHSC facility registries each describe overlapping physical entities under different names,
 *   formats, and schemas. Geo-first blocking is what makes resolving them tractable.
 *
 *   We ingest each source under its own {@link ColumnMapping} + a `source` provenance label into ONE
 *   combined record set, geocode every address through mailwoman's real parser + resolver, resolve
 *   to canonical entities, and report the entities whose members span ≥2 sources — those are the
 *   cross-dataset links. We surface the correlation; interpretation is the consumer's.
 *
 *   Tractable cut: TX-scoped, capped per source. Streams the 4.8 GB NPPES registry via `streamRows`.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/cross-dataset-correlation.ts\
 *   [--cap 300] [--wof <admin.db>] [--data-root <dir>] [--out-md docs/articles/evals/<date>-...md]
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
	type SourceRecord,
} from "@mailwoman/registry"
import { writeFileSync } from "node:fs"
import { geocodeAddress, ShardProvider } from "../../mailwoman/out/geocode-core.js"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const SOURCES = arg("sources", "/mnt/playpen/mailwoman-data/record-matcher/sources")
const CAP = Number(arg("cap", "300")) // rows kept per source (TX-scoped)
const STATE = arg("state", "TX").toUpperCase()
const WOF = arg("wof", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
const DATA_ROOT = arg("data-root", "/mnt/playpen/mailwoman-data")
const OUT_MD = arg("out-md", "")

const norm = (s: string | undefined) => (s ?? "").trim()

/**
 * One source to ingest: where it lives, the column mapping, a TX filter, and an optional row
 * "explode" for files that carry two addressable entities per row (the FCC commitments Filing +
 * Participating HCP).
 */
interface SourceSpec {
	source: string
	path: string
	mapping: ColumnMapping
	/** Keep only rows in-state (reads the row's state column). */
	inState: (row: Record<string, string>) => boolean
	/** Optional: a row carries ≥1 addressable entity — yield each as its own row. Default identity. */
	explode?: (row: Record<string, string>) => Record<string, string>[]
}

const S = `${SOURCES}`
const SPECS: SourceSpec[] = [
	{
		// TX HHSC nursing facilities — facility name + physical address + a real coordinate.
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
		// FCC Rural Health Care posted services — the funding/enrollment side; HCP name + site address.
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
		// NPPES — organization NPIs (the eligibility side); legal business name + practice address.
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
		// Org-type NPIs in TX with a business name — the entities most likely to co-occur with facilities.
		inState: (r) =>
			norm(r["Provider Business Practice Location Address State Name"]).toUpperCase() === STATE &&
			norm(r["Entity Type Code"]) === "2" &&
			!!norm(r["Provider Organization Name (Legal Business Name)"]),
	},
]

async function main(): Promise<void> {
	// --- Phase A: stream each source, TX-filter, cap, explode → combined raw rows. ---
	const rawBySource = new Map<string, Record<string, string>[]>()
	for (const spec of SPECS) {
		console.error(`[A] ${spec.source}: streaming + ${STATE} filter (cap ${CAP})…`)
		const kept: Record<string, string>[] = []
		for await (const row of streamRows(spec.path)) {
			if (!spec.inState(row)) continue
			const exploded = spec.explode ? spec.explode(row) : [row]
			for (const e of exploded) {
				kept.push(e)
				if (kept.length >= CAP) break
			}
			if (kept.length >= CAP) break
		}
		rawBySource.set(spec.source, kept)
		console.error(`    ${spec.source}: ${kept.length} rows`)
	}

	// --- Phase B: geocoder. ---
	console.error("[B] building the geocoder…")
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new mod.WofSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWofResolver(lookup as unknown as ResolverBackend)
	const shardProvider = new ShardProvider(mod, DATA_ROOT)

	let geo = 0
	let total = 0
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
			total++
			if (g.lat !== null) geo++
			return g
		},
		country: "US",
	})

	// --- Phase C: ingest each source (its own mapping + source label) into one combined record set. ---
	console.error("[C] geocoding + ingesting all sources…")
	const records: SourceRecord[] = []
	for (const spec of SPECS) {
		const rows = rawBySource.get(spec.source)!
		const recs = await ingestRows(rows, spec.mapping, { geocodeAddress: seam })
		// Namespace ids by source so cross-source ids never collide.
		for (const r of recs) r.id = `${spec.source}:${r.id}`
		records.push(...recs)
	}
	shardProvider.close()
	lookup.close()
	console.error(`    ${records.length} records; geocoded ${geo}/${total} (${((100 * geo) / total).toFixed(1)}%)`)

	// --- Phase D: resolve to canonical entities (geo-first spine: collapsed spatial + EM). ---
	console.error("[D] resolving across sources…")
	const { entities, candidatePairs } = resolveEntities(records, { trainEM: true, collapseSpatial: true })

	// --- Phase E: find the cross-source entities — members spanning ≥2 distinct sources. ---
	const sourceOf = (r: SourceRecord) => r.source ?? "?"
	const crossSource = entities
		.map((e) => ({ e, sources: new Set(e.records.map(sourceOf)) }))
		.filter((x) => x.sources.size >= 2)
		.sort((a, b) => b.sources.size - a.sources.size || b.e.records.length - a.e.records.length)

	// Source-pair co-occurrence matrix.
	const pairCounts = new Map<string, number>()
	for (const { sources } of crossSource) {
		const list = [...sources].sort()
		for (let i = 0; i < list.length; i++)
			for (let j = i + 1; j < list.length; j++) {
				const k = `${list[i]} ↔ ${list[j]}`
				pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1)
			}
	}

	const repName = (e: ResolvedEntity) =>
		e.representative.organization?.canonical ??
		[e.representative.name?.given, e.representative.name?.family].filter(Boolean).join(" ") ??
		e.representative.id

	// --- Report. ---
	const pct = (x: number) => (100 * x).toFixed(1)
	const lines: string[] = []
	lines.push(`# Cross-dataset correlation (#618)`)
	lines.push("")
	lines.push(
		`_Generated by \`scripts/record-matcher/cross-dataset-correlation.ts\`. ${STATE}-scoped, ≤${CAP} rows per ` +
			`source, resolved BLIND across sources (geo-first block → Fellegi-Sunter + EM → cluster). The sources share ` +
			`no key; an entity spanning ≥2 sources is a cross-dataset link we surface for review — interpretation is the ` +
			`consumer's._`
	)
	lines.push("")
	lines.push(`## Sources`)
	lines.push("")
	lines.push(`| source | rows | what it is |`)
	lines.push(`|---|---:|---|`)
	lines.push(
		`| \`txhhsc-nursing\` | ${rawBySource.get("txhhsc-nursing")!.length} | TX HHSC licensed nursing facilities |`
	)
	lines.push(`| \`fcc-rhc\` | ${rawBySource.get("fcc-rhc")!.length} | FCC Rural Health Care posted-services filings |`)
	lines.push(`| \`nppes\` | ${rawBySource.get("nppes")!.length} | NPPES organization NPIs |`)
	lines.push("")
	lines.push(
		`Combined: **${records.length} records**, geocoded ${pct(geo / total)}%. Resolved to ` +
			`**${entities.length} entities** from ${candidatePairs} candidate pairs.`
	)
	lines.push("")
	lines.push(`## Cross-dataset links (entities spanning ≥2 sources)`)
	lines.push("")
	lines.push(`**${crossSource.length}** entities resolve across ≥2 sources.`)
	lines.push("")
	if (pairCounts.size) {
		lines.push(`| source pair | entities linked |`)
		lines.push(`|---|---:|`)
		for (const [k, v] of [...pairCounts.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`)
		lines.push("")
	}
	const triple = crossSource.filter((x) => x.sources.size >= 3).length
	if (triple) lines.push(`Of those, **${triple}** span all three sources.`)
	lines.push("")
	lines.push(`## Spot-check — the first 12 cross-source entities (verify by eye)`)
	lines.push("")
	lines.push(`| entity | sources | name (representative) | coordinate |`)
	lines.push(`|---|---|---|---|`)
	for (const { e, sources } of crossSource.slice(0, 12)) {
		const coord = e.coordinate ? `${e.coordinate.latitude.toFixed(4)}, ${e.coordinate.longitude.toFixed(4)}` : "—"
		lines.push(`| ${e.id} | ${[...sources].sort().join(", ")} | ${repName(e)} | ${coord} |`)
	}
	lines.push("")
	lines.push(`## Reading`)
	lines.push("")
	lines.push(
		`Three datasets with no shared key — a provider registry, a federal funding program, and a state ` +
			`facility registry — resolve into a single entity model where ${crossSource.length} entities are corroborated ` +
			`by ≥2 independent sources, purely on geocoded location + name/org agreement, in pure Node (no Elasticsearch, ` +
			`no server). Each cross-source entity is a candidate "same place, multiple records" surfaced for review; whether ` +
			`a correlation means anything is the data consumer's call, not ours.`
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
