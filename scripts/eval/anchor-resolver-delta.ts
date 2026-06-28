/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Synthetic resolver harness for the postcode anchor (task #59, #240 PR3). Measures — OFFLINE, in a
 *   non-default branch — what would change if the resolver re-ranked its locality candidates using
 *   the postcode anchor's country posterior. The actual re-ranker stays DEFERRED (per operator);
 *   this only LOGS score deltas, so there is no byte-stability risk to the shipped resolver.
 *
 *   The signal it answers: when you DON'T have a locale gate (the multi-locale demo case), how often
 *   would feeding the postcode-derived country posterior into the locality lookup change the pick,
 *   by how much score, and does it move resolution TOWARD the OpenAddresses gold locality? That
 *   early read tells us whether building the soft re-ranker is worth it.
 *
 *   Per row:
 *
 *   1. Parse → take the locality span the model emitted.
 *   2. `findPlace({text, placetype:"locality"})` with NO country = the honest "we don't know the
 *        country" baseline (anchor-OFF). The anchor's whole job is to supply the country signal a
 *        locale gate would otherwise provide, so the no-country baseline is the fair comparison.
 *   3. Extract the postcode anchor → its country posterior. Soft re-rank: each candidate's score gets `+
 *        anchorWeight * posterior[candidate.country]` (anchor-ON). Re-sort.
 *   4. Log: did the top-1 flip? the score margin the new winner overcame? did the pick match gold
 *        better? was a wrong-country pick corrected to the anchor's country?
 *
 *   Run: node --experimental-strip-types scripts/eval/anchor-resolver-delta.ts\
 *   --eval data/eval/external/openaddresses-de-sample.jsonl --limit 2000\
 *   --model neural-weights-en-us/model.onnx\
 *   --tokenizer neural-weights-en-us/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json\
 *   --out-md docs/articles/evals/2026-06-07-anchor-resolver-delta-de.md\
 *   [--anchor-weight 2.0 --candidates 10 --out-json /tmp/anchor-delta-de.json]
 */

import { readFileSync, writeFileSync } from "node:fs"

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import type { ResolvedPlace } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)

	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

interface OaRow {
	input: string
	lat: number
	lon: number
	expected: { locality?: string; region?: string; postcode?: string }
	state: string
	source: string
}

function median(xs: number[]): number | null {
	if (xs.length === 0) return null
	const s = [...xs].sort((a, b) => a - b)

	return s[Math.floor(s.length / 2)]!
}

function norm(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ")
}

/** Directional name match (surface, not WOF-id): normalized exact or either-direction token-subset. */
function nameMatch(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false
	const x = norm(a)
	const y = norm(b)

	if (!x || !y) return false

	if (x === y) return true
	const xs = new Set(x.split(" "))
	const ys = new Set(y.split(" "))
	const subset = (small: Set<string>, big: Set<string>): boolean => [...small].every((t) => big.has(t))

	return subset(xs, ys) || subset(ys, xs)
}

function firstByTag(tree: AddressTree, tag: string): AddressNode | undefined {
	let found: AddressNode | undefined
	const walk = (n: AddressNode): void => {
		if (found) return

		if (n.tag === tag) {
			found = n

			return
		}

		for (const c of n.children) walk(c)
	}

	for (const r of tree.roots) walk(r)

	return found
}

interface DeltaRow {
	input: string
	localityText: string
	goldLocality?: string
	anchorCountries: string[]
	anchorConf: number
	offTop1?: { name: string; country: string; score: number }
	onTop1?: { name: string; country: string; score: number; bonus: number }
	changed: boolean
	marginOvercome: number | null // new winner's orig score minus old winner's orig score (<=0 means it was a runner-up)
	matchOff: boolean
	matchOn: boolean
	countryCorrected: boolean
	// Coordinate error (km) from each pick's centroid to the OA gold point — the non-gameable signal the
	// name-match metric is blind to (a US "Berlin" name-matches gold "Berlin" but is ~6500 km wrong).
	errOff: number | null
	errOn: number | null
}

async function main(): Promise<void> {
	const evalPath = arg("eval", "data/eval/external/openaddresses-de-sample.jsonl")
	const limit = Number(arg("limit", "0")) || Infinity
	const anchorWeight = Number(arg("anchor-weight", "2.0"))
	const K = Number(arg("candidates", "10"))
	const wofPaths = arg(
		"wof",
		`${dataRootPath("wof", "admin-global-priority.db")},${dataRootPath("wof", "postcode-locality-intl.db")}`
	)
		.split(",")
		.map((s) => s.trim())
	const shards = arg(
		"postcode-shards",
		`${dataRootPath("wof", "postalcode-us.db")},${dataRootPath("wof", "postalcode-intl.db")}`
	)
		.split(",")
		.map((s) => s.trim())

	const rows: OaRow[] = readFileSync(evalPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l))
		.slice(0, limit === Infinity ? undefined : limit)

	const { NeuralAddressClassifier } = await import("@mailwoman/neural")
	const { OnnxRunner } = await import("@mailwoman/neural/onnx-runner")
	const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
	const modelCard = JSON.parse(readFileSync(arg("model-card", "neural-weights-en-us/model-card.json"), "utf8"))
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(arg("tokenizer", "neural-weights-en-us/tokenizer.model")),
		OnnxRunner.create(arg("model", "neural-weights-en-us/model.onnx")),
	])
	const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: modelCard.labels })
	const parseOpts = { postcodeRepair: true } as Parameters<typeof neural.parse>[1]

	const { WofSqlitePlaceLookup, WofPostcodeLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const backend = new WofSqlitePlaceLookup({ databasePath: wofPaths.length === 1 ? wofPaths[0]! : wofPaths })
	const postcodeLookup = new WofPostcodeLookup(shards)
	const { extractPostcodeAnchors } = await import("@mailwoman/neural/postcode-anchor")

	const results: DeltaRow[] = []
	const skip = { noLocality: 0, noCandidates: 0, noAnchor: 0 }
	let i = 0

	for (const row of rows) {
		i++

		if (i % 500 === 0) console.error(`  ${i}/${rows.length}  (${results.length} eligible)`)

		let tree: AddressTree

		try {
			tree = await neural.parse(row.input, parseOpts)
		} catch {
			continue
		}
		const locNode = firstByTag(tree, "locality")

		if (!locNode) {
			skip.noLocality++
			continue
		}

		// anchor-OFF: pure name ranking, no country knowledge.
		const candsOff = (await backend.findPlace({
			text: locNode.value,
			placetype: "locality",
			limit: K,
		})) as ResolvedPlace[]

		if (candsOff.length === 0) {
			skip.noCandidates++
			continue
		}

		// Postcode anchor → country posterior. Pick the highest-confidence placed anchor.
		let posterior: Record<string, number> | null = null
		let anchorConf = 0

		for (const a of extractPostcodeAnchors(row.input, postcodeLookup)) {
			if (a.candidates.length === 0) continue

			if (!posterior || a.confidence > anchorConf) {
				posterior = a.posterior
				anchorConf = a.confidence
			}
		}

		if (!posterior) {
			skip.noAnchor++
			continue
		}
		const post = posterior
		const anchorCountries = Object.keys(post)
		const anchorArgmax = anchorCountries.reduce((b, c) => (post[c]! > (post[b] ?? -1) ? c : b), anchorCountries[0]!)

		// anchor-ON: soft re-rank by posterior-weighted country bonus.
		const offTop1 = candsOff[0]!
		const rescored = candsOff.map((c) => ({
			c,
			bonus: anchorWeight * (post[c.country] ?? 0),
			newScore: c.score + anchorWeight * (post[c.country] ?? 0),
		}))
		rescored.sort((a, b) => b.newScore - a.newScore)
		const onTop1 = rescored[0]!.c
		const changed = String(onTop1.id) !== String(offTop1.id)

		const matchOff = nameMatch(offTop1.name, row.expected.locality)
		const matchOn = nameMatch(onTop1.name, row.expected.locality)
		const countryCorrected = changed && offTop1.country !== anchorArgmax && onTop1.country === anchorArgmax
		const hasGoldPt = Number.isFinite(row.lat) && Number.isFinite(row.lon) && (row.lat !== 0 || row.lon !== 0)
		const errOff =
			hasGoldPt && (offTop1.lat || offTop1.lon) ? haversineKm(offTop1.lat, offTop1.lon, row.lat, row.lon) : null
		const errOn = hasGoldPt && (onTop1.lat || onTop1.lon) ? haversineKm(onTop1.lat, onTop1.lon, row.lat, row.lon) : null

		results.push({
			input: row.input,
			localityText: locNode.value,
			goldLocality: row.expected.locality,
			anchorCountries,
			anchorConf,
			offTop1: { name: offTop1.name, country: offTop1.country, score: offTop1.score },
			onTop1: { name: onTop1.name, country: onTop1.country, score: rescored[0]!.newScore, bonus: rescored[0]!.bonus },
			changed,
			marginOvercome: changed ? onTop1.score - offTop1.score : null,
			matchOff,
			matchOn,
			countryCorrected,
			errOff,
			errOn,
		})
	}

	const n = results.length
	const changed = results.filter((r) => r.changed)
	const matchOff = results.filter((r) => r.matchOff).length
	const matchOn = results.filter((r) => r.matchOn).length
	const corrected = results.filter((r) => r.countryCorrected).length
	const improved = results.filter((r) => !r.matchOff && r.matchOn).length
	const regressed = results.filter((r) => r.matchOff && !r.matchOn).length
	const pct = (x: number): string => (n ? ((100 * x) / n).toFixed(1) : "0.0") + "%"
	const meanMargin = changed.length ? changed.reduce((a, r) => a + (r.marginOvercome ?? 0), 0) / changed.length : 0
	// Coordinate-error deltas over rows where BOTH picks have a centroid + the row has a gold point.
	const withErr = results.filter((r) => r.errOff !== null && r.errOn !== null)
	const medErrOff = median(withErr.map((r) => r.errOff!))
	const medErrOn = median(withErr.map((r) => r.errOn!))
	const coordImproved = withErr.filter((r) => r.errOff! - r.errOn! > 100).length // >100 km closer
	const coordWorsened = withErr.filter((r) => r.errOn! - r.errOff! > 100).length
	const sumErrSaved = withErr.reduce((a, r) => a + (r.errOff! - r.errOn!), 0)
	const km = (v: number | null): string => (v === null ? "—" : v >= 100 ? `${Math.round(v)} km` : `${v.toFixed(1)} km`)

	const lines: string[] = []
	lines.push(`# Anchor → resolver score-delta harness — ${evalPath.split("/").pop()}`)
	lines.push("")
	lines.push(
		"Offline early-signal for the DEFERRED postcode-anchor resolver re-ranker (task #59, #240). For each " +
			"row we query the locality lookup with no country (the honest multi-locale baseline), then soft " +
			"re-rank the candidates by the postcode anchor's country posterior, and log what changes. The shipped " +
			"resolver is untouched."
	)
	lines.push("")
	lines.push(`- anchor weight: ${anchorWeight} · candidates/query: ${K} · rows: ${rows.length}`)
	lines.push(
		`- eligible (locality + candidates + anchor): **${n}**  ` +
			`(skipped: ${skip.noLocality} no-locality, ${skip.noCandidates} no-candidate, ${skip.noAnchor} no-anchor)`
	)
	lines.push("")
	lines.push("| metric | value |")
	lines.push("| --- | --- |")
	lines.push(`| anchor changed the top-1 pick | ${pct(changed.length)} (${changed.length}/${n}) |`)
	lines.push(`| of those, wrong-country → anchor-country corrected | ${corrected} |`)
	lines.push(`| gold locality match — anchor-OFF | ${pct(matchOff)} (${matchOff}/${n}) |`)
	lines.push(`| gold locality match — anchor-ON | ${pct(matchOn)} (${matchOn}/${n}) |`)
	lines.push(
		`| **net gold-match delta (name)** | **${matchOn >= matchOff ? "+" : ""}${pct(matchOn - matchOff)}** (${improved} improved, ${regressed} regressed) |`
	)
	lines.push(`| mean score margin the new winner overcame | ${meanMargin.toFixed(3)} |`)
	lines.push(`| median coord error — anchor-OFF | ${km(medErrOff)} |`)
	lines.push(`| median coord error — anchor-ON | ${km(medErrOn)} |`)
	lines.push(
		`| coord error improved >100 km / worsened >100 km | ${coordImproved} / ${coordWorsened} (of ${withErr.length} placed) |`
	)
	lines.push("")
	lines.push("## Read")
	lines.push("")
	lines.push(
		'The name-surface gold-match metric is blind to country confusion — a US "Berlin" name-matches the ' +
			'German gold "Berlin" while sitting an ocean away. Coordinate error to the OA gold point is the ' +
			"non-gameable signal, so weigh the coord deltas over the name deltas here."
	)
	lines.push("")
	lines.push(
		coordImproved > coordWorsened
			? `Feeding the anchor's country posterior corrects ${corrected} wrong-country picks and pulls ${coordImproved} ` +
					`rows >100 km closer to the gold point (median ${km(medErrOff)} → ${km(medErrOn)}, ${Math.round(sumErrSaved)} km saved total). ` +
					`That value is invisible to name-match (${matchOn >= matchOff ? "+" : ""}${pct(matchOn - matchOff)}) — exactly the artifact the coordinate-first ` +
					`resolver direction flagged. The re-ranker is worth prototyping; the mean margin (${meanMargin.toFixed(3)}) is the score gap a soft boost must clear.`
			: `Feeding the anchor neither improves name-match (+${improved}/−${regressed}) nor coord error ` +
					`(${coordImproved} closer / ${coordWorsened} worse). On this slice a uniform posterior + flat weight don't pay off — ` +
					`the re-ranker needs a sharper posterior or position-aware weight first.`
	)
	lines.push("")

	const outMd = arg("out-md")

	if (outMd) {
		writeFileSync(outMd, lines.join("\n") + "\n")
		console.error(`wrote report → ${outMd}`)
	} else {
		console.log(lines.join("\n"))
	}
	const outJson = arg("out-json")

	if (outJson) {
		writeFileSync(outJson, JSON.stringify({ evalPath, anchorWeight, K, n, skip, results }, null, 2))
		console.error(`wrote per-row deltas → ${outJson}`)
	}
	console.error(
		`\neligible=${n}  changed=${pct(changed.length)}  goldMatch ${pct(matchOff)} → ${pct(matchOn)}  (+${improved}/−${regressed})  corrected=${corrected}`
	)
	postcodeLookup.close?.()
}

void main()
