/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The wired {@link MailwomanAPIEngine} for `mailwoman serve` (Phase 4b, the Hono cutover). Ports the
 *   former express `server/`'s handler bodies — `GeocodeRouter.getDeps` + its `/api/geocode`,
 *   `/api/batch`, `/api/resolve-tree`, `/api/reload` handlers, `AddressRouter`'s `/parse` handler, and
 *   `HealthRouter`'s `/health` data block — onto the engine-agnostic `@mailwoman/api` contract
 *   (`/v1/parse`, `/v1/geocode`, `/v1/batch`, `/v1/resolve`, `/v1/reload`). `mailwoman/server/` is
 *   deleted (Task 2) — this file is its sole successor, a fresh port rather than a thin wrapper.
 *
 *   `createServeEngine` builds the shared stack ONCE, at boot, instead of express's lazy
 *   first-request memoized promise — the CLI's `serve` command awaits it before listening, so a
 *   misconfigured deployment fails FRIENDLY at boot (the #1009 pattern the drop-ins already use)
 *   instead of a runtime 503 on the first request. `parse` speaks native neural output (`ParseOutcome`
 *   = ordered components + the decoded `AddressTree`, the same language `/v1/resolve` speaks) — it
 *   needs only the model weights, loaded ONCE here and reused by the geocode stack below, so it is
 *   built independently of the WOF-data gate: a WOF-less boot still answers `/v1/parse`, while
 *   `geocode`/`batch`/`resolveTree`/`reload` are simply absent (`@mailwoman/api`'s routes answer 503
 *   for those on their own). When the weights themselves are unresolvable (`@mailwoman/neural`
 *   missing, or no weights package installed), `parse` is ALSO absent and the routes answer 501 — no
 *   rules fallback (the legacy-excision's point). `health` always answers, even when everything else
 *   is broken.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

import type { BatchRow, GeocodeOutcome, HealthData, MailwomanAPIEngine, ResolveTreeOutcome } from "@mailwoman/api"
import { recordTimed } from "@mailwoman/api-kit"
import { decodeAsTuples, decodeAsXML } from "@mailwoman/core"
import type { AddressTree } from "@mailwoman/core/decoder"
import { $public } from "@mailwoman/core/env"
import { createWOFResolver, type Resolver, type ResolveOpts } from "@mailwoman/resolver"

import { readReleaseManifest } from "./data-release.ts"
import {
	geocodeAddress,
	type GeocodeClassifier,
	type GeocodeResult,
	regionSlugFromTree,
	ShardProvider,
} from "./geocode-core.ts"
import { INTERP_RADIUS_CALIBRATION, interpCalibrationForRegion } from "./interp-calibration.ts"
import { createResolverBackend, mailwomanDataRoot, resolveCandidateDBPath, wofShardPaths } from "./resolver-backend.ts"

/** Default per-state shard root + interp calibration — mirrors the express server's defaults (`GeocodeRouter.ts`). */
const DATA_ROOT = mailwomanDataRoot()

/** Bounded concurrency for `batch()`. Override with `MAILWOMAN_BATCH_CONCURRENCY`. */
const BATCH_CONCURRENCY = Math.max(1, $public.MAILWOMAN_BATCH_CONCURRENCY)

/** The classifier/resolver/shard bundle `geocode`/`batch`/`resolveTree`/`reload` close over. */
interface GeocodeDepsBundle {
	classifier: GeocodeClassifier
	resolver: Resolver
	shards: ShardProvider
	defaultCountry?: string
}

/** Same WOF-path resolution as the express `GeocodeRouter`/`HealthRouter` (env override, else the conventional shards). */
function wofPaths(): string[] {
	const env = $public.MAILWOMAN_WOF_DB

	if (env)
		return env
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean)

	return wofShardPaths().filter((p) => existsSync(p))
}

/**
 * #1009-style boot preflight message. Same shape as the drop-ins' (`photon/cli.ts`, `nominatim/cli.ts`) — a stranger's
 * first `mailwoman serve` must say exactly what data is missing and the one command that fixes it — adapted to this
 * package's own override (`MAILWOMAN_WOF_DB`, a comma-separated FTS shard list) alongside the shared
 * candidate-gazetteer fast path (`MAILWOMAN_CANDIDATE_DB`).
 */
function buildPreflightMessage(): string {
	const conventionCandidate = join(DATA_ROOT, "wof", "candidate.db")

	return [
		"✗ no gazetteer data found — `mailwoman serve` needs a WOF SQLite distribution to geocode/resolve.",
		"",
		"  Fastest path (worldwide resolution, ~1.4 GB, byte-range friendly):",
		`    mkdir -p ${join(DATA_ROOT, "wof")}`,
		`    curl -fSL https://public.sister.software/mailwoman/gazetteer/2026-07-07a/candidate.db \\`,
		`      -o ${conventionCandidate}`,
		"",
		"  Then re-run `serve` (the file is auto-detected at that path), or point at your own:",
		"    $MAILWOMAN_WOF_DB=<path1,path2,...>    (admin WOF SQLite shard(s) — the FTS backend)",
		"    $MAILWOMAN_CANDIDATE_DB=<path>         (candidate-table gazetteer — population-first, demo-parity)",
		"",
		"  Docs: https://mailwoman.sister.software/docs",
	].join("\n")
}

/**
 * Best-effort model-card read: env override → installed weights package → dev-tree fallback. Ported from
 * `HealthRouter`.
 */
function readModelCard(): Record<string, unknown> | null {
	const candidates: string[] = []

	if ($public.MAILWOMAN_MODEL_CARD) {
		candidates.push($public.MAILWOMAN_MODEL_CARD)
	}

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

/**
 * Count canonical per-state shards (`<prefix>-us-<2-letter>.db`) in a data subdir; 0 if absent. Ported from
 * `HealthRouter`.
 */
function countShards(subdir: string, prefix: string): number {
	try {
		const re = new RegExp(`^${prefix}-us-[a-z]{2}\\.db$`)

		return readdirSync(`${DATA_ROOT}/${subdir}`).filter((f) => re.test(f)).length
	} catch {
		return 0
	}
}

/**
 * The `/health` data block: model card + data-root inventory. Ported from `HealthRouter`'s `healthHandler`. Always
 * available — reads files best-effort and never throws, regardless of preflight status.
 */
function buildHealthData(): HealthData {
	const card = readModelCard()

	return {
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
			// The express HealthRouter existsSync-filtered here where GeocodeRouter's wofPaths() didn't;
			// this diagnostic field keeps the health-side behavior (no phantom env paths in "what's deployed").
			wof_dbs: wofPaths().filter((p) => existsSync(p)),
			situs_states: countShards("address-points", "address-points"),
			interpolation_states: countShards("interpolation", "interpolation"),
		},
	}
}

/** One geocode call over the shared deps. Ported from `GeocodeRouter`'s `oneGeocode`. */
function oneGeocode(deps: GeocodeDepsBundle, address: string): Promise<GeocodeResult> {
	return geocodeAddress(address, {
		classifier: deps.classifier,
		resolver: deps.resolver,
		shards: deps.shards.for,
		defaultCountry: deps.defaultCountry,
		interpCalibration: INTERP_RADIUS_CALIBRATION,
	})
}

/** Pull the street node's resolution tier (if any) for the metric. Ported verbatim from `GeocodeRouter`. */
function collectStreetTier(
	node: AddressTree["roots"][number]
): Array<"address_point" | "interpolated" | "street" | "admin"> {
	const out: Array<"address_point" | "interpolated" | "street" | "admin"> = []

	if (node.tag === "street") {
		const tier = node.metadata?.["resolution_tier"]

		if (tier === "address_point" || tier === "interpolated" || tier === "street") {
			out.push(tier)
		}
	}

	for (const child of node.children) {
		out.push(...collectStreetTier(child))
	}

	return out
}

/** {@link createServeEngine}'s return value. */
export interface ServeEngine {
	engine: MailwomanAPIEngine
	preflight: { ok: true } | { ok: false; message: string }
}

/**
 * Build the wired `mailwoman serve` engine. Awaited ONCE at boot (unlike express's lazy per-request `getDeps()`), so a
 * misconfigured deployment reports its preflight failure before the process starts listening — the caller (the `serve`
 * command) decides whether to boot degraded (parse+health only) or exit friendly.
 */
export async function createServeEngine(): Promise<ServeEngine> {
	// `health` reads files best-effort and never throws — wired unconditionally, matching `HealthRouter`'s "answers even
	// when broken" contract.
	const health: MailwomanAPIEngine["health"] = () => buildHealthData()

	// Parse needs only the model weights — not the gazetteer. Load them independently of the WOF-data gate below so
	// `/v1/parse` answers whenever weights resolve, even on a geocode-degraded boot. The classifier instance loaded
	// here is reused by the geocode stack below — weights load ONCE per boot.
	let parse: MailwomanAPIEngine["parse"]
	let neuralMod: typeof import("@mailwoman/neural") | undefined
	let classifier: GeocodeClassifier | undefined

	try {
		neuralMod = await import("@mailwoman/neural")
		classifier = await neuralMod.NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

		const parseClassifier = classifier
		parse = async (address, opts) => {
			const tree = await parseClassifier.parse(address, { postcodeRepair: true })

			return {
				input: address,
				components: decodeAsTuples(tree).map(([tag, value]) => ({ tag, value })),
				tree,
				debug: opts.debug ? decodeAsXML(tree) : undefined,
			}
		}
	} catch {
		// Weights unresolvable — leave parse undefined; the route answers 501 with its existing guard.
		console.error("createServeEngine: neural weights not found — /v1/parse disabled (501)")
	}

	if (!neuralMod || !classifier) {
		console.error("createServeEngine: @mailwoman/neural + @mailwoman/resolver-wof-sqlite are required")

		return { engine: { parse, health }, preflight: { ok: false, message: buildPreflightMessage() } }
	}

	let resolverMod: typeof import("@mailwoman/resolver-wof-sqlite")

	try {
		resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		console.error("createServeEngine: @mailwoman/neural + @mailwoman/resolver-wof-sqlite are required")

		return { engine: { parse, health }, preflight: { ok: false, message: buildPreflightMessage() } }
	}

	const paths = wofPaths()
	// Candidate backend → country-agnostic default (demo's global, population-first behavior); a per-request `country`
	// still scopes. FTS backend keeps the US default. (#170) A candidate DB alone (no WOF admin shard) is a valid boot
	// configuration — `createResolverBackend` prefers it over `wofPaths` — so the preflight gate below checks BOTH,
	// mirroring the drop-ins' `!candidateDb && wofPaths.length === 0` gate rather than `GeocodeRouter`'s WOF-only check.
	// This gate governs geocode/batch/resolveTree/reload ONLY — `parse` is already wired above and unaffected.
	const candidateDb = resolveCandidateDBPath()

	if (paths.length === 0 && !candidateDb) {
		console.error("createServeEngine: no WOF DBs found — set MAILWOMAN_WOF_DB or MAILWOMAN_CANDIDATE_DB")

		return { engine: { parse, health }, preflight: { ok: false, message: buildPreflightMessage() } }
	}

	const backend = createResolverBackend(resolverMod, { wofPaths: paths })
	const resolver = createWOFResolver(backend)
	const shards = new ShardProvider(resolverMod, DATA_ROOT)
	const deps: GeocodeDepsBundle = { classifier, resolver, shards, defaultCountry: candidateDb ? undefined : "US" }

	// Route records the whole-call metric already (`@mailwoman/api`'s `routes.ts`) — the engine records nothing extra
	// here. Ported from `GeocodeRouter`'s `singleHandler`. The cast mirrors `@mailwoman/api/routes.ts`'s established
	// "documented wire shape looser than the domain type" idiom — `GeocodeOutcome` is a deliberately loose passthrough.
	const geocode: MailwomanAPIEngine["geocode"] = async (address) =>
		(await oneGeocode(deps, address)) as unknown as GeocodeOutcome

	// Bounded-concurrency worker pool over a shared cursor — results land in input order; a thrown row is isolated to
	// its own `{ input, error }` slot. Rows are trimmed here (the route passes the raw validated array through). Ported
	// from `GeocodeRouter`'s `batchHandler`.
	const batch: MailwomanAPIEngine["batch"] = async (addresses) => {
		const inputs = addresses.map((a) => a.trim())
		const results: BatchRow[] = new Array<BatchRow>(inputs.length)

		let cursor = 0
		const worker = async (): Promise<void> => {
			for (let i = cursor++; i < inputs.length; i = cursor++) {
				const input = inputs[i]!
				const t0 = performance.now()

				try {
					const result = await oneGeocode(deps, input)
					recordTimed(performance.now() - t0, result.resolution_tier)
					results[i] = result as unknown as GeocodeOutcome
				} catch (err) {
					recordTimed(performance.now() - t0, "error")
					results[i] = { input, error: err instanceof Error ? err.message : String(err) }
				}
			}
		}
		await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, inputs.length) }, worker))

		return { results }
	}

	// Metrics are the engine's own responsibility here — unlike `/v1/geocode`, the route wraps no try/catch around
	// `resolveTree` (it lets a fault fall through to the app's 500 safety net), so the tier metric AND the rethrow both
	// happen here. Ported from `GeocodeRouter`'s `resolveTreeHandler`.
	const resolveTree: MailwomanAPIEngine["resolveTree"] = async (tree, rawOpts) => {
		const incomingOpts = (rawOpts ?? {}) as ResolveOpts
		const t0 = performance.now()

		try {
			const slug = regionSlugFromTree(tree)
			const { addressPoints, interpolation } = deps.shards.for(slug)
			const opts: ResolveOpts = {
				...incomingOpts,
				defaultCountry: incomingOpts.defaultCountry ?? deps.defaultCountry,
				...(addressPoints ? { addressPoints } : {}),
				...(interpolation
					? {
							interpolation,
							interpolationRadiusCalibration:
								incomingOpts.interpolationRadiusCalibration ??
								interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, slug),
						}
					: {}),
			}
			const resolved = await deps.resolver.resolveTree(tree, opts)
			// Best-effort tier metric: read the street node's stamped tier (matches the geocode path).
			const street = resolved.roots.flatMap((r) => collectStreetTier(r)).find(Boolean)
			recordTimed(performance.now() - t0, street ?? "admin")

			const outcome: ResolveTreeOutcome = { tree: resolved }

			return outcome
		} catch (err) {
			recordTimed(performance.now() - t0, "error")
			throw err
		}
	}

	// Ported from `GeocodeRouter`'s `reloadHandler`.
	const reload: MailwomanAPIEngine["reload"] = async () => {
		const versions = deps.shards.reload()

		return { reloaded: true, versions }
	}

	return {
		engine: { parse, geocode, batch, resolveTree, reload, health },
		preflight: { ok: true },
	}
}
