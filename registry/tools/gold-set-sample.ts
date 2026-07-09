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
 *   Run: `mailwoman registry gold-set-sample [--cap 200000] [--state TX] [--tau 0.7] [--n 300]
 *   [--out-jsonl <path>]`
 */

import { writeFileSync } from "node:fs"

import { dataRootPath } from "@mailwoman/core/utils"
import { addressFrequencyKey, streamRows } from "@mailwoman/registry"

/** Options for {@linkcode goldSetSample}. */
export interface GoldSetSampleOptions {
	/** Record-matcher sources directory. Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources`. */
	sources?: string
	/** Providers sampled from the registry. Default 200000. */
	cap?: number
	/** State filter. Default TX. */
	state?: string
	/** Org-name Jaccard collision threshold. Default 0.7. */
	tau?: number
	/** Adjudication sample size. Default 300. */
	n?: number
	/** Write the sampled pairs here as JSONL (otherwise the first 10 print to stdout). */
	outJsonl?: string
}

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

	for (const t of a)
		if (b.has(t)) {
			inter++
		}

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

/** Gold-set P3 (#625) — sample the HARD co-located name-collision slice for adjudication. */
export async function goldSetSample(
	options: GoldSetSampleOptions = {},
	report?: (line: string) => void
): Promise<{ hardPairs: number; sampled: number }> {
	const SOURCES = options.sources || dataRootPath("record-matcher", "sources")
	const CAP = options.cap ?? 200000
	const STATE = (options.state || "TX").toUpperCase()
	const TAU = options.tau ?? 0.7
	const N = options.n ?? 300
	const OUT = options.outJsonl || ""
	const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`

	report?.(`[A] streaming ${STATE} org providers (cap ${CAP})…`)
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

		if (!byAddr.has(addrKey)) {
			byAddr.set(addrKey, [])
		}
		byAddr.get(addrKey)!.push(p)
		kept++

		if (kept >= CAP) break
	}
	report?.(`    ${kept} providers at ${byAddr.size} addresses`)

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

		for (const p of provs)
			if (!distinct.has(p.npi)) {
				distinct.set(p.npi, p)
			}
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
	report?.(`    ${hard.length} hard co-located name-collision pairs (non-flagged-subpart)`)

	// Deterministic spread sample of N (stride, not head — avoid file-order bias, the dedup-ceiling lesson).
	const stride = Math.max(1, Math.floor(hard.length / N))
	const sample = hard.filter((_, i) => i % stride === 0).slice(0, N)
	report?.(`    sampling ${sample.length} (stride ${stride}) for adjudication`)

	if (OUT) {
		writeFileSync(OUT, sample.map((p) => JSON.stringify(p)).join("\n") + "\n")
		report?.(`[written] ${OUT}`)
	} else {
		for (const p of sample.slice(0, 10)) {
			console.log(JSON.stringify(p))
		}
	}

	return { hardPairs: hard.length, sampled: sample.length }
}
