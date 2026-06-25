/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Operational endpoints (#485 observability):
 *
 *   - `GET /health` — "what's deployed, in one curl": model-card name/version/locale + which WOF
 *       gazetteer and how many per-state situs/interpolation shards are on disk. LIGHTWEIGHT —
 *       reads JSON + counts files, never loads the model, never throws (health must answer even
 *       when broken).
 *   - `GET /metrics` — the live geocode metrics snapshot (latency percentiles + per-tier counts).
 */

import { type RequestHandler, Router } from "express"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"

import { readReleaseManifest } from "../data-release.js"
import { mailwomanDataRoot, wofShardPaths } from "../resolver-backend.js"
import { metricsSnapshot } from "./metrics.js"

const DATA_ROOT = mailwomanDataRoot()
const startedAt = Date.now()

/** Best-effort model-card read: env override → installed weights package → dev-tree fallback. */
function readModelCard(): Record<string, unknown> | null {
	const candidates: string[] = []
	if (process.env["MAILWOMAN_MODEL_CARD"]) candidates.push(process.env["MAILWOMAN_MODEL_CARD"]!)
	try {
		candidates.push(createRequire(import.meta.url).resolve("@mailwoman/neural-weights-en-us/model-card.json"))
	} catch {
		/* package not resolvable from here — fall through */
	}
	candidates.push("neural-weights-en-us/model-card.json")
	for (const p of candidates) {
		try {
			if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>
		} catch {
			/* unreadable / malformed — try the next candidate */
		}
	}
	return null
}

/** Count canonical per-state shards (`<prefix>-us-<2-letter>.db`) in a data subdir; 0 if absent. */
function countShards(subdir: string, prefix: string): number {
	try {
		const re = new RegExp(`^${prefix}-us-[a-z]{2}\\.db$`)
		return readdirSync(`${DATA_ROOT}/${subdir}`).filter((f) => re.test(f)).length
	} catch {
		return 0
	}
}

function wofPaths(): string[] {
	const env = process.env["MAILWOMAN_WOF_DB"]
	const paths = env
		? env
				.split(",")
				.map((p) => p.trim())
				.filter(Boolean)
		: wofShardPaths()
	return paths.filter((p) => existsSync(p))
}

const healthHandler: RequestHandler = (_req, res) => {
	const card = readModelCard()
	res.status(200).json({
		status: "ok",
		uptime_s: Math.round((Date.now() - startedAt) / 1000),
		model: card
			? {
					name: card["name"],
					version: card["version"],
					locale: card["locale"],
					labels: Array.isArray(card["labels"]) ? card["labels"].length : undefined,
					format: card["format"],
				}
			: null,
		data: {
			data_root: DATA_ROOT,
			// Versioned-switchover provenance (#485): the releases.json pin, or null in legacy mode.
			versions: readReleaseManifest(DATA_ROOT),
			wof_dbs: wofPaths(),
			situs_states: countShards("address-points", "address-points"),
			interpolation_states: countShards("interpolation", "interpolation"),
		},
	})
}

const metricsHandler: RequestHandler = (_req, res) => {
	res.status(200).json(metricsSnapshot())
}

export const HealthRouter: Router = Router()
HealthRouter.get("/health", healthHandler)
HealthRouter.get("/metrics", metricsHandler)
