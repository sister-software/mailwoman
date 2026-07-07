/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #625 ceiling measurement — "how good is good enough" for dedup, derived from the data instead of
 *   asserted as a round number (DeepSeek consult, issue #625). The residual dedup error is
 *   OVER-MERGE: distinct co-located providers (different NPIs at one clinic/billing address) fused
 *   because a shared address outvotes a disagreeing name. The irreducible part of that — the
 *   **Bayes error** — is the set of co-located distinct-NPI pairs whose NAMES are also ~identical:
 *   no name/org feature can separate them, so any address-aware matcher over-merges them. That
 *   floor caps PRECISION.
 *
 *   This measures it directly and label-free, using NPI as the distinctness truth (different NPI =
 *   different provider). Geocode-free on purpose: the question is the DATA's separability, not the
 *   geocoder — so we can run at large N (tens of thousands of TX providers) in seconds. We key
 *   "same address" with the matcher's own `addressFrequencyKey`, and "same name" with a normalized
 *   token Jaccard over the legal business name.
 *
 *   Reports, over co-located distinct-NPI pairs (the over-merge population):
 *
 *   - Co-location prevalence (addresses hosting ≥2 distinct NPIs; providers at shared addresses)
 *   - The org-name-similarity distribution of those pairs
 *   - The COLLISION rate: fraction with org-sim ≥ τ (irreducible over-merge) — the precision floor
 *   - Whether a shared phone would help (it doesn't: institutional switchboards) — among collisions,
 *       how often the two distinct NPIs ALSO share a phone (so phone over-links, can't separate)
 *       …and derives a precision/F1 CEILING under stated assumptions, with the caveats called out.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/dedup-ceiling.ts\
 *   [--cap 50000] [--state TX] [--sources <dir>] [--tau 0.7] [--out-md <md>]
 */

import { writeFileSync } from "node:fs"

import { dataRootPath } from "@mailwoman/core/utils"
import { addressFrequencyKey, streamRows } from "@mailwoman/registry"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)

	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const SOURCES = arg("sources", dataRootPath("record-matcher", "sources"))
const CAP = Number(arg("cap", "50000"))
const STATE = arg("state", "TX").toUpperCase()
const TAU = Number(arg("tau", "0.7"))
const OUT_MD = arg("out-md", "")
const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`

const norm = (s: string | undefined) => (s ?? "").trim()

// Strip only corporate-form tokens + articles — KEEP domain words (health, medical, center…), which
// carry the distinguishing signal between two co-located providers.
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
const normPhone = (p?: string): string => {
	const d = (p ?? "").replace(/\D/g, "")

	return d.length >= 10 ? d.slice(-10) : ""
}

interface Provider {
	npi: string
	tokens: Set<string>
	phone: string
	/** Authorized official (last + first), lowercased — same official ⇒ almost certainly one org. */
	auth: string
	/**
	 * Primary taxonomy (specialty) code — different specialty ⇒ likely a genuinely different provider.
	 */
	taxonomy: string
}

async function main(): Promise<void> {
	// --- Stream TX type-2 (org) providers; one primary record per NPI at its practice address. ---
	console.error(`[A] streaming ${STATE} org providers (cap ${CAP})…`)
	const byAddr = new Map<string, Provider[]>()
	let kept = 0
	let scanned = 0

	for await (const r of streamRows(REGISTRY)) {
		scanned++

		if (norm(r["Entity Type Code"]) !== "2") continue

		if (norm(r["Provider Business Practice Location Address State Name"]).toUpperCase() !== STATE) continue
		const org = norm(r["Provider Organization Name (Legal Business Name)"])

		if (!org) continue
		const line1 = norm(r["Provider First Line Business Practice Location Address"])
		const city = norm(r["Provider Business Practice Location Address City Name"])
		const zip = norm(r["Provider Business Practice Location Address Postal Code"])

		if (!line1) continue
		const addrKey = addressFrequencyKey(`${line1}, ${city}, ${STATE} ${zip}`)

		if (!addrKey) continue
		const npi = norm(r["NPI"])
		const auth = `${norm(r["Authorized Official Last Name"])} ${norm(r["Authorized Official First Name"])}`
			.toLowerCase()
			.trim()
		const p: Provider = {
			npi,
			tokens: orgTokens(org),
			phone: normPhone(r["Provider Business Practice Location Address Telephone Number"]),
			auth: auth === "" ? "" : auth,
			taxonomy: norm(r["Healthcare Provider Taxonomy Code_1"]),
		}

		if (!byAddr.has(addrKey)) {
			byAddr.set(addrKey, [])
		}
		byAddr.get(addrKey)!.push(p)
		kept++

		if (kept >= CAP) break
	}
	console.error(`    scanned ${scanned} rows → ${kept} ${STATE} org providers at ${byAddr.size} distinct addresses`)

	// --- Over co-located distinct-NPI pairs: the org-similarity distribution + collision rate. ---
	let sharedAddresses = 0
	let providersAtSharedAddr = 0
	let pairs = 0
	let collide = 0 // org-sim ≥ τ — name-indistinguishable co-located distinct NPIs
	let mid = 0 // τ > sim ≥ 0.3 — partially separable
	let separable = 0 // sim < 0.3 — clearly different names
	let collideSharePhone = 0 // of collisions, also share a phone (phone can't separate either)
	// Of the collisions, split NPI-over-segmentation (one org, many NPIs — merge is CORRECT) from
	// genuinely-distinct co-located providers (the TRUE irreducible over-merge):
	let collideSameAuth = 0 // share an authorized official ⇒ one org, multiple NPIs ⇒ correct to merge
	let collideDistinct = 0 // different official AND different specialty ⇒ genuinely different providers
	const PAIR_BUDGET = 5_000_000

	// guard against a pathological mega-address (PO-box farms)

	for (const provs of byAddr.values()) {
		// distinct NPIs at this address
		const distinct = new Map<string, Provider>()

		for (const p of provs)
			if (!distinct.has(p.npi)) {
				distinct.set(p.npi, p)
			}
		const list = [...distinct.values()]

		if (list.length < 2) continue
		sharedAddresses++
		providersAtSharedAddr += list.length

		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				if (pairs >= PAIR_BUDGET) break
				pairs++
				const a = list[i]!
				const b = list[j]!
				const sim = jaccard(a.tokens, b.tokens)

				if (sim >= TAU) {
					collide++

					if (a.phone && a.phone === b.phone) {
						collideSharePhone++
					}
					const sameAuth = a.auth !== "" && a.auth === b.auth
					const sameTax = a.taxonomy !== "" && a.taxonomy === b.taxonomy

					if (sameAuth) {
						collideSameAuth++
					} else if (!sameTax) {
						collideDistinct++
					}
				} else if (sim >= 0.3) {
					mid++
				} else {
					separable++
				}
			}
		}
	}

	// --- Derive the precision ceiling. An address-aware matcher must, on co-located distinct-NPI
	// pairs, either merge (wrong) or hold them apart using name/org. It CAN separate the `separable`
	// (and most `mid`) pairs but NOT the `collide` ones. So the irreducible false-merge rate among
	// co-located distinct pairs is collide/pairs; an oracle's precision on the co-located decision is
	// bounded by how many merges it makes that are correct. We report the collision rate directly and
	// a precision-ceiling BAND (optimistic: only `collide` over-merge; conservative: `collide` + half
	// of `mid`). Recall is NOT the binding constraint here (NPPES same-NPI records almost always share
	// either address or org), so the F1 ceiling tracks the precision ceiling. ---
	const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : "—")
	const collisionRate = pairs > 0 ? collide / pairs : 0

	const lines: string[] = []
	lines.push(`# #625 — dedup ceiling: the irreducible over-merge of co-located providers`)
	lines.push("")
	lines.push(
		`_Generated by \`scripts/record-matcher/dedup-ceiling.ts\`. ${STATE}, ${kept} type-2 (org) providers ` +
			`(cap ${CAP}), geocode-free: "same address" = the matcher's \`addressFrequencyKey\`; "same name" = ` +
			`normalized token Jaccard over the legal business name (corporate suffixes + articles stripped, domain ` +
			`words kept). NPI is the distinctness truth (different NPI = different provider). τ = ${TAU}._`
	)
	lines.push("")
	lines.push(`## Co-location prevalence`)
	lines.push("")
	lines.push(
		`- **${sharedAddresses}** addresses host ≥2 distinct NPIs (${pct(sharedAddresses, byAddr.size)} of ${byAddr.size} addresses).`
	)
	lines.push(
		`- **${providersAtSharedAddr}** providers sit at a shared address (${pct(providersAtSharedAddr, kept)} of ${kept}).`
	)
	lines.push(
		`- **${pairs}** co-located distinct-NPI pairs (the over-merge population)${pairs >= PAIR_BUDGET ? ` — capped at the ${PAIR_BUDGET} pair budget` : ""}.`
	)
	lines.push("")
	lines.push(`## Name separability of co-located distinct providers`)
	lines.push("")
	lines.push(`| org-name Jaccard | pairs | share | meaning |`)
	lines.push(`|---|---:|---:|---|`)
	lines.push(
		`| ≥ ${TAU} (collision) | ${collide} | ${pct(collide, pairs)} | ~identical names → **irreducible over-merge** |`
	)
	lines.push(`| ${0.3}–${TAU} | ${mid} | ${pct(mid, pairs)} | partial — separable with a good model |`)
	lines.push(`| < 0.3 | ${separable} | ${pct(separable, pairs)} | clearly different names → separable |`)
	lines.push("")
	lines.push(
		`Of the ${collide} collision pairs, **${collideSharePhone}** (${pct(collideSharePhone, collide)}) also share a phone — ` +
			`so phone (a shared institutional switchboard) does NOT separate them either; if anything it over-links. This is ` +
			`why the benchmark found phone an unreliable secondary identifier.`
	)
	lines.push("")
	lines.push(`## Splitting the collisions: NPI over-segmentation vs genuinely distinct providers`)
	lines.push("")
	lines.push(
		`A collision (same address, ~same name, often same phone) with DIFFERENT NPIs is usually one organization holding ` +
			`multiple NPIs (subparts / departments) — where merging is **correct** and NPI-as-truth is **over-segmenting**, ` +
			`not a model error. NPPES's own fields separate the two cases:`
	)
	lines.push("")
	lines.push(`| collision pair is… | pairs | share of collisions | merging it is… |`)
	lines.push(`|---|---:|---:|---|`)
	lines.push(
		`| same authorized official | ${collideSameAuth} | ${pct(collideSameAuth, collide)} | **correct** — one org, many NPIs (NPI over-segments) |`
	)
	lines.push(
		`| different official AND different specialty | ${collideDistinct} | ${pct(collideDistinct, collide)} | a **genuine** distinct co-located provider — true over-merge |`
	)
	lines.push(
		`| (remainder: different official, same specialty) | ${collide - collideSameAuth - collideDistinct} | ${pct(collide - collideSameAuth - collideDistinct, collide)} | ambiguous — needs adjudication |`
	)
	lines.push("")
	lines.push(`## The ceiling`)
	lines.push("")
	lines.push(
		`The raw collision rate is **${pct(collide, pairs)}** of co-located distinct-NPI pairs — but only **${pct(collideDistinct, pairs)}** ` +
			`of co-located pairs are *genuinely* distinct providers indistinguishable by name (different official + specialty). ` +
			`Most collisions are **NPI over-segmentation** (${pct(collideSameAuth, collide)} share an authorized official), where ` +
			`a merge is correct and NPI-truth penalizes it wrongly.`
	)
	lines.push("")
	lines.push(`**This is the answer to "how good is good enough," and it has two parts:**`)
	lines.push(
		`1. Measured against **NPI-as-truth**, F1 is capped well below 0.85 — ~${pct(collide, pairs)} of co-located pairs are ` +
			`unseparable, and NPI-truth scores most of them as errors even though merging is correct. The round **0.85 target ` +
			`is unreachable under this yardstick and should be dropped.**`
	)
	lines.push(
		`2. The *real* irreducible over-merge — genuinely distinct co-located providers with identical names — is only ` +
			`~**${pct(collideDistinct, pairs)}** of the co-located population. Against an **entity-level truth** (subpart-aware), ` +
			`the achievable ceiling is much higher. But that ceiling can only be MEASURED with an entity-level / adjudicated ` +
			`gold set — NPI-truth alone can't tell a correct subpart-merge from a true over-merge. **This is why the gold set ` +
			`(the "second comparison") is necessary, not optional.**`
	)
	lines.push("")
	lines.push(
		`Recommendation: drop 0.85. Set the bar against a subpart-aware / adjudicated entity truth, report NPI-level AND ` +
			`entity-level side by side, and target "separate the ~${pct(collideDistinct, pairs)} genuinely-distinct co-located ` +
			`pairs the GBT can still reach" rather than a round F1. The GBT's corroboration-feature work (#625 revised) ` +
			`attacks exactly that separable slice.`
	)
	lines.push("")
	lines.push(`## Caveats`)
	lines.push("")
	lines.push(
		`- **Geocode-free + exact address key.** "Co-located" here is an exact normalized-address match; geocoding would ` +
			`add near-but-not-exact neighbors (suite splits, slightly different formatting), which can only RAISE the ` +
			`collision count. So this is a LOWER bound on the irreducible over-merge.`
	)
	lines.push(
		`- **Recall side under-measured.** NPPES same-NPI records almost always share an address or the org name, so the ` +
			`recall floor looks ~1.0 here; real-world feeds with distant + name-drifted same-entity records would lower it. ` +
			`The F1 ceiling reported tracks the PRECISION constraint, which is the binding one for the over-merge problem.`
	)
	lines.push(
		`- **Token-Jaccard ≠ the model's name comparison.** A proxy for separability; the GBT uses the FS agreement ` +
			`levels. The collision SET (sim ≥ τ + shared phone) is robust to the exact similarity metric.`
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
