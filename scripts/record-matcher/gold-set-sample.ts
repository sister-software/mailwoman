/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Gold-set P3 (#625) — sample the HARD slice for adjudication. The programmatic entity truth
 *   (`nppes-dedup-benchmark.ts`) collapses only NPPES-FLAGGED subparts (Is-Subpart + parent
 *   LBN/TIN); it can't settle the genuinely-ambiguous co-located collisions: distinct NPIs at one
 *   address with near-identical names that are NOT flagged subparts of the same parent. Those are
 *   where NPI-truth and any programmatic rule disagree — exactly the pairs a frozen adjudicated
 *   gold set must cover.
 *
 *   This finds them (over the full TX registry, geocode-free — same machinery as `dedup-ceiling.ts`)
 *   and writes each as a JSONL row carrying BOTH records' fields (org name, address, authorized
 *   official, taxonomy, subpart/parent flags) plus the programmatic verdict, so an adjudicator
 *   (human or LLM-as-judge, flagged as such) can label "same real-world entity? yes/no" and we can
 *   MEASURE how often the programmatic truth matches judgment.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/gold-set-sample.ts\
 *   [--cap 200000] [--state TX] [--tau 0.7] [--n 300] [--out-jsonl <path>]
 */

import { addressFrequencyKey, streamRows } from "@mailwoman/registry"
import { writeFileSync } from "node:fs"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const SOURCES = arg("sources", "/mnt/playpen/mailwoman-data/record-matcher/sources")
const CAP = Number(arg("cap", "200000"))
const STATE = arg("state", "TX").toUpperCase()
const TAU = Number(arg("tau", "0.7"))
const N = Number(arg("n", "300"))
const OUT = arg("out-jsonl", "")
const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`

const norm = (s: string | undefined) => (s ?? "").trim()
const STOP = new Set([
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
function orgTokens(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.replace(/[^a-z0-9 ]/g, " ")
			.split(/\s+/)
			.filter((t) => t && !STOP.has(t))
	)
}
function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0
	let inter = 0
	for (const t of a) if (b.has(t)) inter++
	return inter / (a.size + b.size - inter)
}
const C = {
	npi: "NPI",
	entityType: "Entity Type Code",
	org: "Provider Organization Name (Legal Business Name)",
	pAddr: "Provider First Line Business Practice Location Address",
	pCity: "Provider Business Practice Location Address City Name",
	pState: "Provider Business Practice Location Address State Name",
	pZip: "Provider Business Practice Location Address Postal Code",
	authLast: "Authorized Official Last Name",
	authFirst: "Authorized Official First Name",
	taxonomy: "Healthcare Provider Taxonomy Code_1",
	isSubpart: "Is Organization Subpart",
	parentLBN: "Parent Organization LBN",
	parentTIN: "Parent Organization TIN",
}

interface Prov {
	npi: string
	org: string
	tokens: Set<string>
	address: string
	auth: string
	taxonomy: string
	subpart: boolean
	parent: string
}

async function main(): Promise<void> {
	console.error(`[A] streaming ${STATE} org providers (cap ${CAP})…`)
	const byAddr = new Map<string, Prov[]>()
	let kept = 0
	for await (const r of streamRows(REGISTRY)) {
		if (norm(r[C.entityType]) !== "2") continue
		if (norm(r[C.pState]).toUpperCase() !== STATE) continue
		const org = norm(r[C.org])
		const line1 = norm(r[C.pAddr])
		if (!org || !line1) continue
		const address = [line1, norm(r[C.pCity]), STATE, norm(r[C.pZip])].filter(Boolean).join(", ")
		const addrKey = addressFrequencyKey(address)
		if (!addrKey) continue
		const p: Prov = {
			npi: norm(r[C.npi]),
			org,
			tokens: orgTokens(org),
			address,
			auth: `${norm(r[C.authFirst])} ${norm(r[C.authLast])}`.toLowerCase().trim(),
			taxonomy: norm(r[C.taxonomy]),
			subpart: norm(r[C.isSubpart]).toUpperCase() === "Y",
			parent: `${norm(r[C.parentLBN])}|${norm(r[C.parentTIN])}`.toLowerCase(),
		}
		if (!byAddr.has(addrKey)) byAddr.set(addrKey, [])
		byAddr.get(addrKey)!.push(p)
		kept++
		if (kept >= CAP) break
	}
	console.error(`    ${kept} providers at ${byAddr.size} addresses`)

	// Hard pairs: co-located, name-similar (≥τ), DISTINCT NPIs that programmatic truth can't confidently
	// collapse (NOT subparts of the same parent). Tag the programmatic verdict so adjudication can grade it.
	interface HardPair {
		npiA: string
		npiB: string
		orgA: string
		orgB: string
		address: string
		nameJaccard: number
		sameAuthorizedOfficial: boolean
		sameTaxonomy: boolean
		bothSubpartSameParent: boolean
		programmaticVerdict: "same-entity" | "distinct"
		adjudication: null // ← to be filled: "same-entity" | "distinct"
	}
	const hard: HardPair[] = []
	for (const provs of byAddr.values()) {
		const distinct = new Map<string, Prov>()
		for (const p of provs) if (!distinct.has(p.npi)) distinct.set(p.npi, p)
		const list = [...distinct.values()]
		if (list.length < 2) continue
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const a = list[i]!
				const b = list[j]!
				const sim = jaccard(a.tokens, b.tokens)
				if (sim < TAU) continue
				const sameParent = a.subpart && b.subpart && a.parent === b.parent && a.parent !== "|"
				if (sameParent) continue // programmatic truth already collapses these — not the hard slice
				const sameAuth = a.auth !== "" && a.auth === b.auth
				const sameTax = a.taxonomy !== "" && a.taxonomy === b.taxonomy
				hard.push({
					npiA: a.npi,
					npiB: b.npi,
					orgA: a.org,
					orgB: b.org,
					address: a.address,
					nameJaccard: Number(sim.toFixed(3)),
					sameAuthorizedOfficial: sameAuth,
					sameTaxonomy: sameTax,
					bothSubpartSameParent: false,
					// Programmatic heuristic verdict (what an entity-level rule WOULD say, beyond the flagged
					// subparts): same authorized official ⇒ likely one org; different official + different
					// specialty ⇒ likely distinct. The whole point is to ADJUDICATE whether this is right.
					programmaticVerdict: sameAuth ? "same-entity" : "distinct",
					adjudication: null,
				})
			}
		}
	}
	console.error(`    ${hard.length} hard co-located name-collision pairs (non-flagged-subpart)`)

	// Deterministic spread sample of N (stride, not head — avoid file-order bias, the dedup-ceiling lesson).
	const stride = Math.max(1, Math.floor(hard.length / N))
	const sample = hard.filter((_, i) => i % stride === 0).slice(0, N)
	console.error(`    sampling ${sample.length} (stride ${stride}) for adjudication`)

	if (OUT) {
		writeFileSync(OUT, sample.map((p) => JSON.stringify(p)).join("\n") + "\n")
		console.error(`[written] ${OUT}`)
	} else {
		for (const p of sample.slice(0, 10)) console.log(JSON.stringify(p))
	}
}

await main()
