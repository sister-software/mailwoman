/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The geocode-first decision surface — the headline concept figure for the record matcher.
 *
 *   What a reader should walk away with: **geography is the primary key; string similarity only
 *   refines within a place.** The figure makes that legible as a _landscape_. Two surfaces of
 *   P(match) over the same record-pair space (string similarity × geographic distance), scored by
 *   the SAME Fellegi-Sunter machinery, differing only in which evidence each model is allowed to
 *   see:
 *
 *   - **String-first** sees the name agreement only → its decision boundary is _vertical_: high string
 *       similarity ⇒ match, at any distance. It fuses `Springfield General (IL)` with `Springfield
 *       General (MA)` (identical name, ~1500 km apart) and still misses `123 Main St` ↔ `123 Main
 *       Street Apt 2` when the strings drift.
 *   - **Geocode-first** also sees the distance agreement → its boundary _bends with geography_: near
 *       the same coordinate a modest name match suffices; far apart, even an exact name is
 *       rejected. It gets both traps right.
 *
 *   Honesty notes (so the figure can't mislead):
 *
 *   - The per-level weights are the REAL Bayes factors from the codebase — `NAME_LEVELS`
 *       (`registry/resolve.ts`) and `DEFAULT_DISTANCE_LEVELS` (`match/distance.ts`). Geography
 *       simply carries the heaviest evidence: ±9.45 bits at the same-building grain vs ±6.32 for an
 *       exact name.
 *   - The PRIOR is illustrative (λ shown in the caption), not production's λ=1e-4. Production is even
 *       more conservative and leans on additional corroboration (phone, the spatial exact-key) that
 *       this two-axis slice deliberately omits — the point here is the _shape of the boundary_, not
 *       a reproduction of a production score. The caption says so.
 *
 *   Emits a self-contained Plotly HTML (twin 3D landscapes + an annotated 2D contour). Render to PNG
 *   with `registry/tools/viz/render.mjs` (Playwright + swiftshader for headless WebGL).
 *
 *   Run: node registry/tools/viz/geocode-first-surface.ts\
 *   [--lambda 0.02] [--out-html /tmp/geocode-first-surface.html]
 */

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

// Loose scan parity with the retired local argv helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: { lambda: { type: "string" }, "out-html": { type: "string" } },
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as { lambda?: string; "out-html"?: string }
// Illustrative prior. Production's record matcher uses λ=1e-4 (calibrated for the full multi-field
// model with phone + spatial exact-key); here we want the boundary visible in a two-axis slice.
const LAMBDA = Number(values["lambda"] || "0.02")
const OUT_HTML = values["out-html"] || "/tmp/geocode-first-surface.html"

// ── Real Bayes-factor weights, transcribed from source (values kept in sync by comment, not import,
//    so this generator is self-contained / independent of the match package's build state). ───────────

interface Level {
	label: string
	m: number
	u: number
	minSimilarity?: number
	maxKm?: number
}

// registry/resolve.ts → NAME_LEVELS
const NAME_LEVELS: Level[] = [
	{ label: "exact", minSimilarity: 1.0, m: 0.8, u: 0.01 },
	{ label: "high", minSimilarity: 0.88, m: 0.15, u: 0.03 },
	{ label: "different", minSimilarity: 0, m: 0.05, u: 0.96 },
]

// match/distance.ts → DEFAULT_DISTANCE_LEVELS
const DISTANCE_LEVELS: Level[] = [
	{ label: "same-building", maxKm: 0.05, m: 0.7, u: 0.001 },
	{ label: "same-block", maxKm: 0.5, m: 0.2, u: 0.02 },
	{ label: "same-area", maxKm: 5, m: 0.08, u: 0.2 },
	{ label: "far", m: 0.02, u: 0.779 },
]

// match/fellegi-sunter.ts → levelWeight / priorWeight / probabilityFromWeight
const levelWeight = (lvl: Level) => (lvl.u <= 0 ? (lvl.m > 0 ? Infinity : 0) : Math.log2(lvl.m / lvl.u))
const priorWeight = (lambda: number) => Math.log2(lambda / (1 - lambda))
const probabilityFromWeight = (w: number) => 1 / (1 + 2 ** -w)

/** Assign a name-similarity score to its agreement-level weight (levels ordered high→low sim). */
function nameWeight(sim: number): number {
	for (const lvl of NAME_LEVELS) if (sim >= (lvl.minSimilarity ?? 0)) return levelWeight(lvl)

	return levelWeight(NAME_LEVELS[NAME_LEVELS.length - 1]!)
}

/** Assign a distance (km) to its agreement-level weight (levels ordered near→far). */
function distanceWeight(km: number): number {
	for (const lvl of DISTANCE_LEVELS) if (km <= (lvl.maxKm ?? Infinity)) return levelWeight(lvl)

	return levelWeight(DISTANCE_LEVELS[DISTANCE_LEVELS.length - 1]!)
}

const PRIOR = priorWeight(LAMBDA)

/** String-first model: name evidence only — distance is invisible to it. */
const pStringFirst = (sim: number, _km: number) => probabilityFromWeight(PRIOR + nameWeight(sim))
/** Geocode-first model: name + distance evidence. */
const pGeocodeFirst = (sim: number, km: number) => probabilityFromWeight(PRIOR + nameWeight(sim) + distanceWeight(km))

// ── Grid. X = string similarity 0→1. Y = geographic distance, sampled denser near 0 (log-ish) so
//    the meaningful same-building / same-block transitions aren't a single pixel. ────────────────

const NX = 60
const NY = 60
const KM_MAX = 50 // 0 → 50 km, log-spaced

const simAxis = Array.from({ length: NX }, (_, i) => i / (NX - 1))
// log-spaced distance: 0.005 km (5 m) → 50 km, plus a literal 0 at the front
const kmAxis = Array.from({ length: NY }, (_, j) => {
	const t = j / (NY - 1)

	return 0.005 * Math.pow(KM_MAX / 0.005, t)
})

function surface(p: (sim: number, km: number) => number): number[][] {
	// Plotly z is row-major over y (distance), each row across x (similarity).
	return kmAxis.map((km) => simAxis.map((sim) => p(sim, km)))
}

const zString = surface(pStringFirst)
const zGeo = surface(pGeocodeFirst)

// ── The two trap points. (sim, km) chosen to sit in the off-diagonal quadrants. ─────────────────

interface Trap {
	label: string
	detail: string
	sim: number
	km: number
}
const TRAPS: Trap[] = [
	{
		label: "Springfield General — IL vs MA",
		detail: "identical name, ~1500 km apart",
		sim: 1.0,
		km: 15, // plotted on the far plateau (real distance ~1500 km; clamped into view)
	},
	{
		// "St" → "Street" canonicalizes to a high (not exact) name agreement; the trailing "Apt 2"
		// keeps it off 1.0. Lands in the 0.88 "high" tier — same place, drifted-but-recognizable string.
		label: "123 Main St vs 123 Main Street Apt 2",
		detail: "same building, drifted string",
		sim: 0.9,
		km: 0.01,
	},
]

// Decision verdicts at each trap (for the annotation text).
const verdict = (p: number) => (p >= 0.5 ? "MATCH" : "no")
const trapRows = TRAPS.map((t) => ({
	...t,
	stringP: pStringFirst(t.sim, t.km),
	geoP: pGeocodeFirst(t.sim, t.km),
}))

// ── HTML. ───────────────────────────────────────────────────────────────────────────────────────

const data = {
	simAxis,
	kmAxis,
	zString,
	zGeo,
	traps: trapRows,
	lambda: LAMBDA,
	prior: PRIOR,
}

const safe = JSON.stringify(data).replace(/<\/script>/gi, "<\\/script>")

const html = `<!doctype html><html><head><meta charset="utf-8"/>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#fff;color:#111}
  h1{font-size:18px;margin:14px 0 2px 20px}
  h2{font-size:14px;margin:14px 0 0 20px;font-weight:600}
  p.sub{margin:2px 20px 0;color:#555;font-size:12px;max-width:1100px;line-height:1.45}
  #pair{width:1120px;height:440px}
  #contour{width:1120px;height:520px}
  .cap{margin:6px 20px 14px;color:#666;font-size:11px;max-width:1100px;line-height:1.4}
</style></head><body>
<h1>Two ways to draw the line — string-first vs geocode-first</h1>
<p class="sub">P(match) over the same record-pair space: string similarity (x) × geographic distance (y).
Same Fellegi-Sunter scorer, real per-level Bayes factors; the only difference is which evidence each
model may see. <b>String-first</b> sees the name only — its boundary is a vertical wall at high
similarity, blind to where the records are. <b>Geocode-first</b> also sees distance — the wall bends,
becoming a basin you can only climb out of <i>near a shared place</i>.</p>
<div id="pair"></div>
<h2>The decision boundary, read from above</h2>
<p class="sub">The geocode-first P(match) contour with the string-first boundary (dashed) drawn for
contrast, and the two traps string matching was built to fall into. Geocode-first puts the far-apart
namesakes in the reject basin and pulls the same-building pair across the line — string-first inverts
both.</p>
<div id="contour"></div>
<p class="cap" id="cap"></p>
<script>
const D = ${safe};
const COMMON_SCENE = (title) => ({
  xaxis:{title:"string similarity", range:[0,1], backgroundcolor:"#fafafa", gridcolor:"#e5e5e5"},
  yaxis:{title:"distance (km, log)", type:"log", backgroundcolor:"#fafafa", gridcolor:"#e5e5e5"},
  zaxis:{title:"P(match)", range:[0,1], gridcolor:"#e5e5e5"},
  camera:{eye:{x:-1.6,y:-1.5,z:0.9}},
  aspectratio:{x:1,y:1,z:0.6}
});
const surfFor = (z, name, colorscale) => ({
  type:"surface", z:z, x:D.simAxis, y:D.kmAxis, name:name,
  colorscale:colorscale, cmin:0, cmax:1, showscale:false,
  contours:{z:{show:true, usecolormap:true, project:{z:true}, start:0, end:1, size:0.1}},
  lighting:{ambient:0.75, diffuse:0.6, roughness:0.9}, opacity:1
});
Plotly.newPlot("pair", [
  Object.assign(surfFor(D.zString, "string-first", "YlOrRd"), {scene:"scene"}),
  Object.assign(surfFor(D.zGeo, "geocode-first", "Viridis"), {scene:"scene2"})
], {
  margin:{l:0,r:0,t:24,b:0},
  scene:Object.assign(COMMON_SCENE(), {domain:{x:[0,0.48]}}),
  scene2:Object.assign(COMMON_SCENE(), {domain:{x:[0.52,1]}}),
  annotations:[],
  showlegend:false
}, {displayModeBar:false, responsive:false}).then(()=>{
  // titles over each scene
  Plotly.relayout("pair", {
    "annotations":[
      {text:"<b>STRING-FIRST</b> — name only (vertical wall)", x:0.22, y:1.04, xref:"paper", yref:"paper", showarrow:false, font:{size:13, color:"#b3402a"}},
      {text:"<b>GEOCODE-FIRST</b> — name + distance (basin)", x:0.78, y:1.04, xref:"paper", yref:"paper", showarrow:false, font:{size:13, color:"#2a6b6b"}}
    ]
  });
});

// 2D contour of geocode-first, traps annotated.
const trapX = D.traps.map(t=>t.sim);
const trapY = D.traps.map(t=>Math.max(t.km, D.kmAxis[0]));
Plotly.newPlot("contour", [
  {type:"contour", z:D.zGeo, x:D.simAxis, y:D.kmAxis, colorscale:"Viridis", zmin:0, zmax:1,
   contours:{coloring:"heatmap", showlines:true, start:0, end:1, size:0.1,
     // emphasize the P=0.5 decision isocline
   }, colorbar:{title:"P(match)", thickness:12, len:0.8}},
  // string-first boundary: vertical line where name alone crosses 0.5
  {type:"scatter", mode:"lines", x:[0.985,0.985], y:[D.kmAxis[0], D.kmAxis[D.kmAxis.length-1]],
   line:{color:"#b3402a", width:2, dash:"dash"}, name:"string-first boundary", hoverinfo:"name"},
  {type:"scatter", mode:"markers+text", x:trapX, y:trapY,
   marker:{size:13, color:"#fff", line:{color:"#111", width:2}, symbol:"x-thin", "line.width":3},
   text:D.traps.map((t,i)=> (i===0?"①":"②")), textposition:"middle center",
   textfont:{size:13,color:"#111"}, name:"traps", hoverinfo:"text",
   hovertext:D.traps.map(t=>t.label)}
], {
  margin:{l:70,r:20,t:10,b:50},
  yaxis:{title:"geographic distance (km, log)", type:"log", range:[Math.log10(D.kmAxis[0]), Math.log10(D.kmAxis[D.kmAxis.length-1])], autorange:false},
  xaxis:{title:"string similarity", range:[0,1]},
  showlegend:true, legend:{x:0.62, y:0.06, bgcolor:"rgba(255,255,255,0.85)", font:{size:11}},
  shapes:[0.05,0.5,5].map((km)=>({type:"line", xref:"paper", x0:0, x1:1, yref:"y", y0:km, y1:km, line:{color:"rgba(255,255,255,0.45)", width:1, dash:"dot"}})),
  annotations:[
    {x:0.015, y:0.05, text:"same-building", showarrow:false, font:{size:9,color:"#eee"}, xanchor:"left", yanchor:"bottom"},
    {x:0.015, y:0.5, text:"same-block", showarrow:false, font:{size:9,color:"#eee"}, xanchor:"left", yanchor:"bottom"},
    {x:0.015, y:5, text:"same-area", showarrow:false, font:{size:9,color:"#ddd"}, xanchor:"left", yanchor:"bottom"},
    // Paper-anchored callout boxes (stable placement), each tied to its ①/② marker, with a paper→data arrow.
    {xref:"paper", yref:"paper", x:0.30, y:0.86, ax:trapX[0], ay:trapY[0], axref:"x", ayref:"y",
     text:"① "+D.traps[0].label+"<br>"+D.traps[0].detail+"<br><b>string-first: MATCH ✗ · geocode-first: reject ✓</b>",
     showarrow:true, arrowhead:2, arrowcolor:"#b3402a", align:"left", font:{size:10,color:"#111"}, bgcolor:"rgba(255,255,255,0.94)", bordercolor:"#b3402a", borderpad:3},
    {xref:"paper", yref:"paper", x:0.30, y:0.30, ax:trapX[1], ay:trapY[1], axref:"x", ayref:"y",
     text:"② "+D.traps[1].label+"<br>"+D.traps[1].detail+"<br><b>string-first: reject ✗ · geocode-first: MATCH ✓</b>",
     showarrow:true, arrowhead:2, arrowcolor:"#2a6b6b", align:"left", font:{size:10,color:"#111"}, bgcolor:"rgba(255,255,255,0.94)", bordercolor:"#2a6b6b", borderpad:3}
  ]
}, {displayModeBar:false, responsive:false});

const fmt = (p)=> (p*100).toFixed(p>=0.5?0:1)+"%";
document.getElementByID("cap").innerHTML =
  "Real per-level Bayes factors (NAME_LEVELS, DEFAULT_DISTANCE_LEVELS); illustrative prior λ="+D.lambda+
  " (production λ=1e-4 + phone/spatial-key corroboration, omitted here to isolate the two-axis boundary). "+
  "Trap ① string-first="+fmt(D.traps[0].stringP)+" (MATCH ✗) · geocode-first="+fmt(D.traps[0].geoP)+" (reject ✓). "+
  "Trap ② string-first="+fmt(D.traps[1].stringP)+" (reject ✗) · geocode-first="+fmt(D.traps[1].geoP)+" (MATCH ✓).";
</script>
</body></html>`

writeFileSync(OUT_HTML, html)
console.error(`[written] ${OUT_HTML}`)
console.error(`λ=${LAMBDA}  prior=${PRIOR.toFixed(2)} bits`)

for (const t of trapRows) {
	console.error(
		`  ${t.label}: string-first ${(t.stringP * 100).toFixed(1)}% (${verdict(t.stringP)}) | geocode-first ${(t.geoP * 100).toFixed(1)}% (${verdict(t.geoP)})`
	)
}
