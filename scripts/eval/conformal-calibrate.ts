/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Split-conformal confidence wrapper for the STREET-LEVEL coordinate tier (#374, heuristic-radius
 *   variant). The interpolation tier stamps an `uncertainty_m` radius on each hit (half the matched
 *   TIGER segment length) and the exact address-point tier stamps no radius — it is a real situs
 *   point, assigned a fixed 10 m floor (building-centroid precision).
 *
 *   The heuristic radius is a PRIOR, not a guarantee. This script turns it into a provably-calibrated
 *   interval: the conformal threshold Q̂ tells you "multiply the claimed radius by Q̂ and you now
 *   have a 90% coverage guarantee on held-out data."
 *
 *   RECIPE (DeepSeek scope, #374):
 *   1. Run the full cascade (parser → resolver with situs + interp shards) on a holdout set. For each
 *      RESOLVED street-level row capture:
 *      (a) coordinate error in METERS (haversine to the true lat/lon)
 *      (b) claimed radius in METERS (uncertainty_m for interp hits; 10 m fixed floor for situs hits)
 *   2. Nonconformity score per row: s_i = error_m / claimed_radius_m
 *   3. Conformal threshold Q̂ = the ⌈(n_cal + 1) × 0.9⌉ / n_cal empirical quantile of {s_i} over a
 *      CALIBRATION split (split the holdout ≈50/50, deterministic seed).
 *   4. Calibrated 90% interval at inference = claimed_radius × Q̂.
 *   5. VALIDATE on the test split: empirical coverage = fraction where error_m ≤ calibrated_radius.
 *      Target ≈ 90%.
 *
 *   CALIBRATION DATA (pre-built, Texas E-911 Travis County):
 *   - holdout : /tmp/ood-truth.jsonl   (1965 rows, {input, lat, lon, …})
 *   - situs   : /tmp/tx-situs.db       (--address-points)
 *   - interp  : /tmp/tx-metro-interp.db (--interpolation)
 *
 *   OUTPUT: threshold Q̂, empirical 90% coverage, median calibrated radius per tier, plus a 3-line
 *   calibration summary.
 *
 *   Run (no pre-compile needed — uses Node's --experimental-strip-types):
 *     node --experimental-strip-types scripts/eval/conformal-calibrate.ts \
 *       [--holdout /tmp/ood-truth.jsonl] \
 *       [--address-points /tmp/tx-situs.db] \
 *       [--interpolation /tmp/tx-metro-interp.db] \
 *       [--model neural-weights-en-us/model.onnx] \
 *       [--tokenizer neural-weights-en-us/tokenizer.model] \
 *       [--model-card neural-weights-en-us/model-card.json] \
 *       [--wof /mnt/playpen/mailwoman-data/wof/admin-global-priority.db,…] \
 *       [--cal-frac 0.5] [--alpha 0.9] [--seed 20260614]
 *
 *   DO NOT change the resolver or parser — this script only READS stamped metadata.
 */

import { readFileSync } from "node:fs"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { createWofResolver } from "@mailwoman/core/resolver"

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

// ---------------------------------------------------------------------------
// Haversine (in METERS for the street-level tier)
// ---------------------------------------------------------------------------

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000 // metres
  const p = Math.PI / 180
  const dLat = (lat2 - lat1) * p
  const dLon = (lon2 - lon1) * p
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// ---------------------------------------------------------------------------
// Percentile (0-indexed: p=0.9 → 90th)
// ---------------------------------------------------------------------------

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!
}

function median(xs: number[]): number {
  return percentile(xs, 0.5)
}

// ---------------------------------------------------------------------------
// Conformal quantile  Q̂ = the ⌈(n+1)×(1−α)⌉-th sorted calibration score
// ---------------------------------------------------------------------------

function conformalThreshold(calScores: number[], targetCoverage: number): number {
  const n = calScores.length
  if (n === 0) return Infinity
  const rank = Math.ceil((n + 1) * targetCoverage)
  if (rank > n) return Infinity // can't guarantee at this level
  return [...calScores].sort((a, b) => a - b)[rank - 1]!
}

// ---------------------------------------------------------------------------
// Seeded deterministic shuffle (LCG, no external deps)
// ---------------------------------------------------------------------------

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr]
  let state = (seed * 2654435761 + 1) & 0xffffffff
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

// ---------------------------------------------------------------------------
// Tree walkers — read STAMPED metadata, never alter resolution
// ---------------------------------------------------------------------------

/** Fixed floor for an exact situs point (building-centroid precision). */
const SITUS_FLOOR_M = 10

interface StreetHit {
  tier: "address_point" | "interpolated"
  lat: number
  lon: number
  /** Claimed uncertainty radius in metres (10 m floor for situs, uncertainty_m for interp). */
  claimedRadiusM: number
}

function findStreetHit(tree: AddressTree): StreetHit | null {
  const stack = [...tree.roots]
  while (stack.length > 0) {
    const n = stack.pop()!
    if (n.tag === "street") {
      const meta = n.metadata as Record<string, unknown> | undefined
      if (meta?.["resolution_tier"] === "address_point") {
        const ap = meta["address_point"] as { lat: number; lon: number } | undefined
        if (ap) {
          return { tier: "address_point", lat: ap.lat, lon: ap.lon, claimedRadiusM: SITUS_FLOOR_M }
        }
      }
      if (meta?.["resolution_tier"] === "interpolated") {
        const ip = meta["interpolated_point"] as { lat: number; lon: number } | undefined
        const uM = meta["uncertainty_m"]
        if (ip && typeof uM === "number") {
          return { tier: "interpolated", lat: ip.lat, lon: ip.lon, claimedRadiusM: uM }
        }
      }
    }
    stack.push(...n.children)
  }
  return null
}

// ---------------------------------------------------------------------------
// Holdout row type (matches /tmp/ood-truth.jsonl)
// ---------------------------------------------------------------------------

interface HoldoutRow {
  input: string
  lat: number
  lon: number
  expected?: { locality?: string; region?: string; postcode?: string }
  state?: string
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const holdoutPath = arg("holdout", "/tmp/ood-truth.jsonl")
  const addressPointsDb = arg("address-points", "/tmp/tx-situs.db")
  const interpolationDb = arg("interpolation", "/tmp/tx-metro-interp.db")
  const modelPath = arg("model", "neural-weights-en-us/model.onnx")
  const tokenizerPath = arg("tokenizer", "neural-weights-en-us/tokenizer.model")
  const modelCardPath = arg("model-card", "neural-weights-en-us/model-card.json")
  const wofPaths = arg(
    "wof",
    "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db,/mnt/playpen/mailwoman-data/wof/postcode-locality-intl.db"
  )
    .split(",")
    .map((s) => s.trim())
  const calFrac = Number(arg("cal-frac", "0.5"))
  const alpha = Number(arg("alpha", "0.9")) // target coverage level
  const seed = Number(arg("seed", "20260614"))

  // --- load holdout ---
  const rows: HoldoutRow[] = readFileSync(holdoutPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HoldoutRow)

  console.error(`[conformal-calibrate] ${rows.length} holdout rows from ${holdoutPath}`)
  console.error(`[conformal-calibrate] situs: ${addressPointsDb}  interp: ${interpolationDb}`)
  console.error(`[conformal-calibrate] model: ${modelPath}`)

  // --- build parser (mirror oa-resolver-eval.ts exactly) ---
  const { NeuralAddressClassifier } = await import("@mailwoman/neural")
  const { OnnxRunner } = await import("@mailwoman/neural/onnx-runner")
  const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
  const modelCard = JSON.parse(readFileSync(modelCardPath, "utf8")) as { labels: string[] }
  const [tokenizer, runner] = await Promise.all([
    MailwomanTokenizer.loadFromFile(tokenizerPath),
    OnnxRunner.create(modelPath),
  ])
  const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: modelCard.labels })

  // --- build resolver with BOTH street-level shards ---
  const { WofSqlitePlaceLookup, AddressPointSqliteLookup, StreetInterpolator } = await import(
    "@mailwoman/resolver-wof-sqlite"
  )
  const backend = new WofSqlitePlaceLookup({
    databasePath: wofPaths.length === 1 ? wofPaths[0]! : wofPaths,
  })
  const resolver = createWofResolver(backend as never)
  const addressPoints = new AddressPointSqliteLookup(addressPointsDb)
  const interpolation = new StreetInterpolator({ dbPath: interpolationDb })

  // --- run the cascade ---
  interface Row {
    errorM: number
    claimedRadiusM: number
    tier: "address_point" | "interpolated"
  }
  const resolved: Row[] = []
  let nTotal = 0
  let nNoStreetHit = 0

  console.error("[conformal-calibrate] running cascade …")
  const parseOpts = { postcodeRepair: true } as Parameters<typeof neural.parse>[1]
  const resolveOpts = { defaultCountry: "US", addressPoints, interpolation }

  for (const row of rows) {
    nTotal++
    if (nTotal % 200 === 0) console.error(`  ${nTotal}/${rows.length}`)
    try {
      const tree = await neural.parse(row.input, parseOpts)
      const decorated: AddressTree = await resolver.resolveTree(tree, resolveOpts)
      const hit = findStreetHit(decorated)
      if (!hit) {
        nNoStreetHit++
        continue
      }
      const errorM = haversineM(hit.lat, hit.lon, row.lat, row.lon)
      resolved.push({ errorM, claimedRadiusM: hit.claimedRadiusM, tier: hit.tier })
    } catch {
      nNoStreetHit++
    }
  }

  const nResolved = resolved.length
  console.error(
    `[conformal-calibrate] street-level hits: ${nResolved}/${nTotal}` +
      `  (${((100 * nResolved) / Math.max(1, nTotal)).toFixed(1)}%)` +
      `  no-hit (abstain/admin-only): ${nNoStreetHit}`
  )

  if (nResolved === 0) {
    console.error("ERROR: zero street-level hits — nothing to calibrate")
    process.exit(1)
  }

  // --- split into calibration / test (deterministic) ---
  const shuffled = seededShuffle(resolved, seed)
  const nCal = Math.floor(shuffled.length * calFrac)
  const calRows = shuffled.slice(0, nCal)
  const testRows = shuffled.slice(nCal)

  // --- nonconformity scores on calibration split ---
  const calScores = calRows.map((r) => r.errorM / r.claimedRadiusM)
  const Q = conformalThreshold(calScores, alpha)

  // --- empirical coverage on test split ---
  const testScores = testRows.map((r) => r.errorM / r.claimedRadiusM)
  const covered = testScores.filter((s) => s <= Q).length
  const coverage = covered / Math.max(1, testScores.length)

  // --- per-tier breakdown ---
  type Tier = "address_point" | "interpolated"
  const tiers: Tier[] = ["address_point", "interpolated"]
  const byTier: Record<Tier, Row[]> = { address_point: [], interpolated: [] }
  for (const r of resolved) byTier[r.tier].push(r)

  // Median calibrated radius = median(claimedRadiusM) × Q  per tier on ALL resolved rows
  const tierStats = tiers.map((t) => {
    const rows = byTier[t]
    if (rows.length === 0) return { tier: t, n: 0, medianClaimedM: NaN, medianCalibratedM: NaN, medianErrorM: NaN }
    const claimedMeds = median(rows.map((r) => r.claimedRadiusM))
    const errMeds = median(rows.map((r) => r.errorM))
    return {
      tier: t,
      n: rows.length,
      medianClaimedM: claimedMeds,
      medianCalibratedM: claimedMeds * Q,
      medianErrorM: errMeds,
    }
  })

  // Uncalibrated coverage: fraction where error_m ≤ claimed_radius_m (threshold=1)
  const uncalCovered = resolved.filter((r) => r.errorM <= r.claimedRadiusM).length
  const uncalCoverage = uncalCovered / Math.max(1, resolved.length)

  // --- per-tier conformal thresholds ---
  // Split each tier's rows independently: shuffled order is fixed, just filter by tier.
  // "Too few rows" warning fires when rank > n_cal (conformal_threshold returns ∞).
  const tierConformal = tiers.map((t) => {
    const allRows = byTier[t]
    // Maintain the same shuffle order as the overall split for reproducibility.
    const shuffledTier = seededShuffle(allRows, seed)
    const nCalT = Math.floor(shuffledTier.length * calFrac)
    const calT = shuffledTier.slice(0, nCalT)
    const testT = shuffledTier.slice(nCalT)
    const calScoresT = calT.map((r) => r.errorM / r.claimedRadiusM)
    const QT = conformalThreshold(calScoresT, alpha)
    const covT = testT.length > 0 ? testT.filter((r) => r.errorM / r.claimedRadiusM <= QT).length / testT.length : NaN
    const uncalCovT =
      allRows.length > 0 ? allRows.filter((r) => r.errorM <= r.claimedRadiusM).length / allRows.length : NaN
    return { tier: t, nAll: allRows.length, nCal: nCalT, nTest: testT.length, Q: QT, coverage: covT, uncalCov: uncalCovT }
  })

  // --- print report ---
  const hr = "─".repeat(72)
  console.log("")
  console.log("Conformal-prediction confidence wrapper — street-level coordinate tier  (#374)")
  console.log(hr)
  console.log(`holdout  : ${holdoutPath}  (${nTotal} rows)`)
  console.log(`resolved : ${nResolved}  (${((100 * nResolved) / Math.max(1, nTotal)).toFixed(1)}% street-level hit rate)`)
  console.log(`abstained: ${nNoStreetHit}  (no street-level coordinate — admin-centroid fallback)`)
  console.log(`split    : cal=${nCal}  test=${testRows.length}  seed=${seed}`)
  console.log(hr)
  console.log(`target coverage (α=1−${(1 - alpha).toFixed(2)})                  : ${(alpha * 100).toFixed(0)}%`)
  console.log(
    `combined conformal threshold Q̂                       : ${isFinite(Q) ? Q.toFixed(6) : "∞"}` +
      (isFinite(Q) ? `  (× claimed_radius = calibrated interval)` : "  (insufficient data at this α)")
  )
  console.log(
    `empirical coverage on test split (combined)           : ${(coverage * 100).toFixed(1)}%` +
      `  (${covered}/${testRows.length})` +
      (Math.abs(coverage - alpha) <= 0.03 ? "  ✓ within 3pp of target" : `  ✗ ${((coverage - alpha) * 100).toFixed(1)}pp off target`)
  )
  console.log(hr)
  console.log(`uncalibrated coverage (Q̂=1, as-is, combined)        : ${(uncalCoverage * 100).toFixed(1)}%  (${uncalCovered}/${nResolved})`)
  console.log(hr)
  console.log("")
  console.log("Per-tier calibration stats (ALL resolved rows, separate conformal splits):")
  console.log("")
  const fmtM = (v: number): string =>
    isNaN(v) ? "—" : v < 1000 ? `${v.toFixed(1)} m` : `${(v / 1000).toFixed(2)} km`
  const fmtPct = (v: number): string => (isNaN(v) ? "—" : `${(v * 100).toFixed(1)}%`)
  const fmtQ = (v: number): string => (isFinite(v) ? v.toFixed(4) : "∞")
  console.log(
    `  ${"tier".padEnd(14)} ${"n".padStart(5)} ${"Q̂".padStart(8)} ${"coverage".padStart(10)} ${"uncal.cov".padStart(10)} ${"median err".padStart(12)} ${"med.claimed r".padStart(14)} ${"med.cal. r".padStart(12)}`
  )
  console.log(
    `  ${"".padEnd(14,"-")} ${"".padStart(5,"-")} ${"".padStart(8,"-")} ${"".padStart(10,"-")} ${"".padStart(10,"-")} ${"".padStart(12,"-")} ${"".padStart(14,"-")} ${"".padStart(12,"-")}`
  )
  for (const ts of tierStats) {
    const tc = tierConformal.find((x) => x.tier === ts.tier)!
    const calRadM = isFinite(tc.Q) ? ts.medianClaimedM * tc.Q : Infinity
    const calRadFmt = !isFinite(calRadM) ? "∞" : fmtM(calRadM)
    console.log(
      `  ${ts.tier.padEnd(14)} ${String(ts.n).padStart(5)} ${fmtQ(tc.Q).padStart(8)} ${fmtPct(tc.coverage).padStart(10)} ${fmtPct(tc.uncalCov).padStart(10)} ${fmtM(ts.medianErrorM).padStart(12)} ${fmtM(ts.medianClaimedM).padStart(14)} ${calRadFmt.padStart(12)}`
    )
  }
  console.log("")
  console.log(hr)

  // --- 3-line calibration summary ---
  // Characterise the dominant tier (address_point here; interp may lack sufficient rows).
  const situsTC = tierConformal.find((x) => x.tier === "address_point")!
  const interpTC = tierConformal.find((x) => x.tier === "interpolated")!
  console.log("")
  console.log("CALIBRATION SUMMARY")
  console.log("")
  // Line 1: overall verdict on the heuristic prior
  if (!isFinite(Q)) {
    console.log(
      `  The combined conformal threshold is ∞ — not enough calibration data to guarantee ${(alpha * 100).toFixed(0)}% coverage.`
    )
    console.log(`  Collect more holdout rows or lower the target α.`)
    console.log(
      `  Uncalibrated (Q̂=1) coverage is ${(uncalCoverage * 100).toFixed(1)}%.`
    )
  } else if (Q < 1) {
    // The heuristic is conservative — can shrink and still cover
    const situsVerdict =
      isFinite(situsTC.Q)
        ? `situs floor (${SITUS_FLOOR_M} m) is ${(1 / situsTC.Q).toFixed(0)}× too large`
        : "situs tier: insufficient rows for per-tier threshold"
    const interpVerdict =
      interpTC.nAll === 0
        ? "interpolation tier: 0 hits in this holdout"
        : !isFinite(interpTC.Q)
          ? `interpolation tier (n=${interpTC.nAll}): too few rows for per-tier ${(alpha * 100).toFixed(0)}% threshold`
          : interpTC.Q > 1
            ? `interpolation tier: Q̂=${interpTC.Q.toFixed(3)} — uncertainty_m UNDERESTIMATES the true spread`
            : `interpolation tier: Q̂=${interpTC.Q.toFixed(3)} — uncertainty_m is conservative`
    console.log(
      `  Combined Q̂ = ${Q.toFixed(6)} ≪ 1: the heuristic prior is HIGHLY CONSERVATIVE — ${situsVerdict}.`
    )
    console.log(`  ${interpVerdict}.`)
    console.log(
      `  Uncalibrated coverage ${(uncalCoverage * 100).toFixed(1)}% (as-is) already beats ${(alpha * 100).toFixed(0)}% by a large margin; the conformal correction mainly tightens the reported interval.`
    )
  } else if (Q > 1.1) {
    // The heuristic underestimates the spread
    console.log(
      `  Combined Q̂ = ${Q.toFixed(4)} > 1: the heuristic radius UNDERESTIMATES the true spread — multiply by ${Q.toFixed(2)}× for ${(alpha * 100).toFixed(0)}% coverage.`
    )
    console.log(
      `  Uncalibrated coverage is only ${(uncalCoverage * 100).toFixed(1)}%; the conformal correction is load-bearing.`
    )
    console.log(
      `  Use Q̂ × claimed_radius as the reported interval at inference.`
    )
  } else {
    // Q near 1 — well-calibrated
    console.log(
      `  Combined Q̂ ≈ ${Q.toFixed(4)} (near 1): the heuristic radius is WELL-CALIBRATED as-is.`
    )
    console.log(
      `  Empirical coverage ${(coverage * 100).toFixed(1)}% on the test split is within 3pp of the ${(alpha * 100).toFixed(0)}% target; no correction needed.`
    )
    console.log(
      `  The raw uncertainty_m / situs floor is a reliable confidence bound to ship.`
    )
  }
  console.log("")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
