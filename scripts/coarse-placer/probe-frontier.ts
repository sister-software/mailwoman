#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #822 PLACER-FRONTIER PROBE (night 2026-06-28, Phase A) — for the placer-recoverable countries (a
 *   country hint resolves them, so growing the placer captures the win), measure whether the DEPLOYED
 *   coarse placer can actually emit that country. Per query (`<City>, <Country>` from cities15000):
 *
 *   - `in_class_set`  — is the true country even in the placer's class set? (a class the model can't
 *                       represent can't be recovered by any threshold change — that's a DATA gap)
 *   - `top1_correct`  — did the placer's argmax land on the true country?
 *   - `prob_1`        — the calibrated top-class confidence (vs `HARD_PLACE_COUNTRY_MIN_CONF` = 0.9)
 *
 *   Branch (plan Phase 2): `in_class_set` false >5% → DATA GAP, defer to a class-set-widening retrain.
 *   in-set + top1>80% + median prob_1 < 0.9 → UNDER-CONFIDENT, M2 mass-rule fix. in-set + top1<80% →
 *   low-quality signal, defer. The probe is a LINEAR model (no ONNX), so it is heat-safe.
 *
 *   Run: node scripts/coarse-placer/probe-frontier.ts [--model <dir>] [--n 2000] [--out <md>]
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { ISO2_TO_NAME } from "@mailwoman/codex/country"
import { mailwomanDataRoot } from "@mailwoman/core/utils"

import type { CoarsePlacerMeta } from "../../core/coarse-placer/coarse-placer.ts"

const root = new URL("../../", import.meta.url)
const { CoarsePlacer } = (await import(
	new URL("core/out/coarse-placer/coarse-placer.js", root).href
)) as typeof import("../../core/coarse-placer/coarse-placer.ts")

const { values: args } = parseArgs({
	options: {
		// The DEPLOYED placer is the one bundled in @mailwoman/core (core/data/coarse-placer), NOT the
		// dataRootPath training output — match the runtime.
		model: { type: "string", default: join(String(root).replace("file://", ""), "core/data/coarse-placer") },
		n: { type: "string", default: "2000" },
		out: { type: "string", default: "" },
	},
})

const HARD_PLACE_COUNTRY_MIN_CONF = 0.9 // mirrors core/pipeline/runtime-pipeline.ts

// The placer-recoverable tranche from the 2026-06-26 frontier diagnostic (a country hint resolves them).
const RECOVERABLE = [
	"AO",
	"AR",
	"BO",
	"CN",
	"EC",
	"BH",
	"LK",
	"MY",
	"RS",
	"SK",
	"TH",
	"UA",
	"AU",
	"BY",
	"CA",
	"CR",
	"EG",
	"IE",
	"MA",
	"RU",
	"SG",
	"ZA",
	"AE",
	"BD",
	"BG",
	"CI",
	"CO",
	"CU",
	"DO",
	"DZ",
	"LV",
	"NZ",
	"SA",
	"TR",
	"UY",
	"VE",
]

const meta = JSON.parse(readFileSync(join(args.model, "meta.json"), "utf8")) as CoarsePlacerMeta
// The deployed bundle is int8-per-row quantized — fromArtifactDir dequantizes via meta.scales.
const placer = await CoarsePlacer.fromArtifactDir(args.model, { abstainBelow: 0 })
const classSet = new Set(meta.classes)

// Build `<City>, <Country>` queries from cities15000 for the recoverable set, shortest first.
const CITIES = join(mailwomanDataRoot(), "geonames", "cities15000.txt")
const want = new Set(RECOVERABLE)
interface Q {
	q: string
	cc: string
}
const all: Q[] = []

for (const line of readFileSync(CITIES, "utf8").split("\n")) {
	if (!line) continue
	const f = line.split("\t")
	const name = f[1]
	const cc = f[8]

	if (!name || !cc || !want.has(cc)) continue
	const country = ISO2_TO_NAME.get(cc)

	if (!country) continue
	all.push({ q: `${name}, ${country}`, cc })
}
all.sort((a, b) => a.q.length - b.q.length)
const queries = all.slice(0, Number(args.n))

interface Stat {
	cc: string
	n: number
	inClass: number
	top1Correct: number
	probs: number[]
}
const per = new Map<string, Stat>()

for (const { q, cc } of queries) {
	const p = placer.predict(q)
	const s = per.get(cc) ?? { cc, n: 0, inClass: 0, top1Correct: 0, probs: [] }
	s.n++

	if (classSet.has(cc)) {
		s.inClass++
	}

	if (p.country === cc) {
		s.top1Correct++
		s.probs.push(p.confidence)
	}
	per.set(cc, s)
}

const rows = [...per.values()].sort((a, b) => a.cc.localeCompare(b.cc))
const N = queries.length
const inClass = rows.reduce((t, r) => t + r.inClass, 0)
const top1 = rows.reduce((t, r) => t + r.top1Correct, 0)
const inClassCorrectProbs = rows.flatMap((r) => r.probs).sort((a, b) => a - b)
const median = (xs: number[]): number => (xs.length ? xs[Math.floor(xs.length / 2)]! : 0)
const pct = (a: number, b: number): string => ((100 * a) / Math.max(1, b)).toFixed(1)
const inClassFalseRate = 1 - inClass / N
const top1OfInClass = rows.reduce((t, r) => t + (classSet.has(r.cc) ? r.top1Correct : 0), 0)
const inClassN = rows.reduce((t, r) => t + r.inClass, 0)

const branch =
	inClassFalseRate > 0.05
		? "DATA GAP — class set does not cover the recoverable tranche; defer to a class-set-widening retrain."
		: top1OfInClass / Math.max(1, inClassN) < 0.8
			? "LOW-QUALITY SIGNAL — in-set top1 < 80%; lowering the threshold would hard-filter wrong guesses. Defer."
			: median(inClassCorrectProbs) < HARD_PLACE_COUNTRY_MIN_CONF
				? "UNDER-CONFIDENT — in-set + top1 ≥ 80% but median prob_1 < 0.9; the M2 mass rule is the CPU fix (default-off)."
				: "NO CHANGE — in-set, confident, correct; the recoverable countries already clear the bar."

const L: string[] = []
L.push("# #822 placer-frontier probe — can the deployed placer emit the recoverable tranche?")
L.push("")
L.push(`_Model: \`${args.model}\` (${meta.classes.length} classes). ${N} \`City, Country\` queries (shortest`)
L.push(
	`first) across ${RECOVERABLE.length} placer-recoverable countries. prob_1 vs HARD_PLACE_COUNTRY_MIN_CONF = 0.9._`
)
L.push("")
L.push(
	`- in_class_set: **${pct(inClass, N)}%** (${inClass}/${N}) — false rate **${(100 * inClassFalseRate).toFixed(1)}%**`
)
L.push(`- top1_correct (all): **${pct(top1, N)}%** (${top1}/${N})`)
L.push(`- top1_correct (in-set only): **${pct(top1OfInClass, inClassN)}%** (${top1OfInClass}/${inClassN})`)
L.push(`- median prob_1 (in-set correct): **${median(inClassCorrectProbs).toFixed(3)}**`)
L.push("")
L.push(`## Branch: ${branch}`)
L.push("")
L.push(`Classes (${meta.classes.length}): \`${meta.classes.join(" ")}\``)
L.push("")
L.push("| Country | ISO2 | in-class | n | top1-correct | median prob_1 |")
L.push("| --- | --- | :---: | ---: | ---: | ---: |")

for (const r of rows) {
	L.push(
		`| ${ISO2_TO_NAME.get(r.cc) ?? r.cc} | ${r.cc} | ${classSet.has(r.cc) ? "✓" : "—"} | ${r.n} | ${pct(r.top1Correct, r.n)}% | ${median(r.probs.slice().sort((a, b) => a - b)).toFixed(2)} |`
	)
}

const report = L.join("\n")
console.log(report.split("\n").slice(0, 12).join("\n"))
console.log("…")

if (args.out) {
	writeFileSync(args.out, `${report}\n`)
	console.error(`[probe] wrote ${args.out}`)
}
