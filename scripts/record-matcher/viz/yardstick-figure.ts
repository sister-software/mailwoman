/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The yardstick figure — "the dedup F1 climbs as the entity-truth gets honest."
 *
 *   The #625 finding, made visual: the matcher's MEASURED dedup quality depends almost entirely on
 *   which ruler you grade it against, not on the model. NPI-as-truth OVER-SEGMENTS (one org holds
 *   many NPIs), so the matcher's correct co-located same-org merges are scored as errors. Grade the
 *   IDENTICAL clusters against a gold-set-validated org-name truth and the F1 climbs +7.1pp — the
 *   ruler ceasing to charge for correct merges, not the model changing.
 *
 *   A slope chart over three rulers (NPI → site → org-name) for both the shipped GBT scorer and the
 *   FS baseline. Numbers are the committed measurement in
 *   `docs/articles/evals/2026-06-16-dedup-dual-level-benchmark.md` (1000 TX NPIs → 2757 records).
 *
 *   Emits a self-contained SVG (the docs' committed-chart-asset convention — see
 *   `docs/articles/evals/charts/*.svg`), no browser required.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/viz/yardstick-figure.ts\
 *   [--out-svg docs/articles/evals/charts/dedup-yardstick.svg]
 */

import { writeFileSync } from "node:fs"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}
const OUT = arg("out-svg", "docs/articles/evals/charts/dedup-yardstick.svg")

// ── The committed measurement (2026-06-16-dedup-dual-level-benchmark.md). ────────────────────────

interface Grain {
	key: "NPI" | "site" | "org-name"
	label: string
	classes: number
	note: string
}
const GRAINS: Grain[] = [
	{ key: "NPI", label: "NPI", classes: 1000, note: "one entity per registration\n(over-segments orgs)" },
	{ key: "site", label: "site", classes: 1456, note: "subpart-collapse +\naddress-split (conservative)" },
	{ key: "org-name", label: "org-name", classes: 956, note: "same-org co-located collapse\n(gold-set validated)" },
]

// F1 per (model, grain), in %.
const F1: Record<string, [number, number, number]> = {
	GBT: [53.6, 55.3, 60.7], // shipped default
	FS: [45.1, 42.7, 52.3], // FS full stack baseline
}
// Over-merged cluster counts per (model, grain) — the genuine-precision story for GBT.
const OVERMERGE: Record<string, [number, number, number]> = {
	GBT: [109, 208, 92],
	FS: [144, 253, 129],
}

// ── Geometry. ───────────────────────────────────────────────────────────────────────────────────

const W = 760
const H = 430
const PAD = { top: 64, right: 168, bottom: 92, left: 64 }
const plotL = PAD.left
const plotR = W - PAD.right
const plotT = PAD.top
const plotB = H - PAD.bottom

const Y_MIN = 40
const Y_MAX = 63
const yFor = (f1: number) => plotB - ((f1 - Y_MIN) / (Y_MAX - Y_MIN)) * (plotB - plotT)
const xFor = (i: number) => plotL + (i / (GRAINS.length - 1)) * (plotR - plotL)

const MODELS = [
	{ key: "GBT", label: "GBT (shipped default)", color: "#3578e5", width: 3, dash: "" },
	{ key: "FS", label: "FS full stack", color: "#9ca3af", width: 2, dash: "5 4" },
]

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const parts: string[] = []
const push = (s: string) => parts.push(s)

push(
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11"><rect width="${W}" height="${H}" fill="white"/>`
)

// Title + subtitle.
push(
	`<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="600">The dedup F1 climbs as the entity-truth gets honest</text>`
)
push(
	`<text x="${W / 2}" y="42" text-anchor="middle" font-size="11.5" fill="#555">Identical matcher output (the same clusters) graded against three rulers — 1000 TX NPIs → 2757 records, NPI held out</text>`
)

// Y gridlines + labels.
for (let v = Y_MIN; v <= Y_MAX; v += 5) {
	const y = yFor(v)
	push(
		`<line x1="${plotL}" y1="${y.toFixed(1)}" x2="${plotR}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`
	)
	push(`<text x="${plotL - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="#374151">${v}%</text>`)
}
push(
	`<text transform="translate(20, ${(plotT + plotB) / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="#374151">entity-resolution F1</text>`
)

// X category ticks + labels + the class-count + note strip.
GRAINS.forEach((g, i) => {
	const x = xFor(i)
	push(
		`<line x1="${x.toFixed(1)}" y1="${plotT}" x2="${x.toFixed(1)}" y2="${plotB}" stroke="#f1f1f1" stroke-width="1"/>`
	)
	push(
		`<text x="${x.toFixed(1)}" y="${plotB + 20}" text-anchor="middle" font-size="12.5" font-weight="600">${esc(g.label)}</text>`
	)
	push(
		`<text x="${x.toFixed(1)}" y="${plotB + 36}" text-anchor="middle" font-size="10" fill="#6b7280">${g.classes} classes</text>`
	)
	g.note.split("\n").forEach((line, k) => {
		push(
			`<text x="${x.toFixed(1)}" y="${plotB + 50 + k * 12}" text-anchor="middle" font-size="9" fill="#9ca3af">${esc(line)}</text>`
		)
	})
})

// Model slope lines + points.
for (const m of MODELS) {
	const f1s = F1[m.key]!
	const pts = f1s.map((f, i) => `${xFor(i).toFixed(1)},${yFor(f).toFixed(1)}`).join(" ")
	push(
		`<polyline points="${pts}" fill="none" stroke="${m.color}" stroke-width="${m.width}"${m.dash ? ` stroke-dasharray="${m.dash}"` : ""}/>`
	)
	f1s.forEach((f, i) => {
		const x = xFor(i)
		const y = yFor(f)
		push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${m.key === "GBT" ? 5 : 4}" fill="${m.color}"/>`)
		// value label: above for GBT, below for FS, to avoid collision
		const dy = m.key === "GBT" ? -10 : 16
		push(
			`<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="${m.key === "GBT" ? 700 : 400}" fill="${m.color}">${f.toFixed(1)}</text>`
		)
	})
}

// Legend (top-right, in the right margin).
const lx = plotR + 16
let ly = plotT + 6
for (const m of MODELS) {
	push(
		`<line x1="${lx}" y1="${ly}" x2="${lx + 22}" y2="${ly}" stroke="${m.color}" stroke-width="${m.width}"${m.dash ? ` stroke-dasharray="${m.dash}"` : ""}/>`
	)
	push(`<text x="${lx + 28}" y="${ly + 3.5}" font-size="10.5" fill="#374151">${esc(m.label)}</text>`)
	ly += 18
}

// The headline callout — the +7.1pp climb for the shipped model.
const gOrg = yFor(F1.GBT![2])
const gNpi = yFor(F1.GBT![0])
push(
	`<g font-size="10.5">` +
		`<text x="${lx}" y="${ly + 18}" font-weight="700" fill="#3578e5">+7.1pp NPI → org-name</text>` +
		`<text x="${lx}" y="${ly + 33}" fill="#555">same clusters —</text>` +
		`<text x="${lx}" y="${ly + 46}" fill="#555">the ruler, not the model.</text>` +
		`<text x="${lx}" y="${ly + 64}" fill="#555">over-merge 109 → 92,</text>` +
		`<text x="${lx}" y="${ly + 77}" fill="#555">precision 43.7% → 53.3%.</text>` +
		`</g>`
)
// Bracket the GBT climb on the right edge of the plot.
push(
	`<path d="M ${(plotR - 4).toFixed(1)} ${gNpi.toFixed(1)} L ${(plotR + 2).toFixed(1)} ${gNpi.toFixed(1)} L ${(plotR + 2).toFixed(1)} ${gOrg.toFixed(1)} L ${(plotR - 4).toFixed(1)} ${gOrg.toFixed(1)}" fill="none" stroke="#3578e5" stroke-width="1" opacity="0.5"/>`
)

// Footer caveat — the gold-set anchor.
push(
	`<text x="${plotL}" y="${H - 10}" font-size="9.5" fill="#9ca3af">Gold set (2026-06-16-dedup-gold-set-tx120): 120/120 hard co-located pairs = same org, 0 genuine over-merges. org-name is the honest yardstick; NPI charges correct same-org merges as errors.</text>`
)

push(`</svg>`)

writeFileSync(OUT, parts.join(""))
console.error(`[written] ${OUT}`)
console.error(
	`  GBT F1: NPI ${F1.GBT![0]} → site ${F1.GBT![1]} → org-name ${F1.GBT![2]}  (+${(F1.GBT![2] - F1.GBT![0]).toFixed(1)}pp)`
)
console.error(`  over-merge: ${OVERMERGE.GBT!.join(" → ")}`)
