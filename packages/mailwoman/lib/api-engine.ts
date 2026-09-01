/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The wired {@link MailwomanAPIEngine} for `mailwoman serve` (Phase 4b, the Hono cutover). Ports the
 *   former express `server/`'s handler bodies — `GeocodeRouter.getDeps` + its retired `/api/geocode`,
 *   `/api/batch`, `/api/resolve-tree`, `/api/reload` handlers, `AddressRouter`'s retired `/parse`
 *   handler, and `HealthRouter`'s `/health` data block — onto the engine-agnostic `@mailwoman/api`
 *   contract's live routes (`/v1/parse`, `/v1/geocode`, `/v1/batch`, `/v1/resolve`, `/v1/reload`).
 *   `mailwoman/server/` is deleted — this file is its sole successor, a fresh port rather
 *   than a thin wrapper.
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

import type {
	BatchResultEntry,
	GeocodeCallback,
	GeocodeOutcome,
	HealthData,
	MailwomanAPIEngine,
	ResolveTreeOutcome,
} from "@mailwoman/api"
import { recordTimed } from "@mailwoman/api-kit"
import { decodeAsTuples, decodeAsXML } from "@mailwoman/core"
import { walkNodes, type AddressTree } from "@mailwoman/core/decoder"
import { $public } from "@mailwoman/core/env"
import { pathExists, readDirectory, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { deriveInputMode } from "@mailwoman/core/pipeline"
import { classifyKindSync } from "@mailwoman/kind-classifier"
import { computeQueryShape } from "@mailwoman/query-shape"
import { createWOFResolver, type Resolver, type ResolveOpts } from "@mailwoman/resolver"

import { readReleaseManifest } from "#data-release"
import { geocodeAddress, type GeocodeClassifier } from "#geocode-core"
import { regionSlugFromTree, RegionDatabaseProvider } from "#geocode-regions"
import { INTERP_RADIUS_CALIBRATION, interpCalibrationForRegion } from "#interp-calibration"
import {
	buildNoGazetteerMessage,
	createResolverBackend,
	existingWOFDatabasePaths,
	mailwomanDataRoot,
	resolveCandidateDBPath,
} from "#resolver-backend"

/**
 * Default per-state database root + interp calibration — mirrors the express server's defaults (`GeocodeRouter.ts`).
 */
const DATA_ROOT = mailwomanDataRoot()

/**
 * The classifier/resolver/database bundle `geocode`/`batch`/`resolveTree`/`reload` close over.
 */
interface GeocodeDepsBundle {
	classifier: GeocodeClassifier
	resolver: Resolver
	databases: RegionDatabaseProvider
	defaultCountry?: string
}

/**
 * Same WOF-path resolution as the express `GeocodeRouter`/`HealthRouter` (env override, else the conventional
 * databases).
 */
async function wofPaths(): Promise<string[]> {
	const env = $public.MAILWOMAN_WOF_DB

	// The env override is comma-split and probed like the convention set: a listed database that is not on
	// disk is dropped here rather than handed to the resolver to fail on open.
	const explicit = env
		? env
				.split(",")
				.map((p) => p.trim())
				.filter((p) => p.length > 0)
		: undefined

	return await existingWOFDatabasePaths(explicit)
}

/**
 * #1009-style boot preflight message. Same shape as the drop-ins' (`photon/cli.ts`, `nominatim/cli.ts`) — a stranger's
 * first `mailwoman serve` must say exactly what data is missing and the one command that fixes it.
 */
function buildPreflightMessage(): string {
	return buildNoGazetteerMessage({
		dataRoot: DATA_ROOT,
		docsPath: "/docs/developers/get-started/ten-minute-trial",
	})
}

/**
 * Best-effort model-card read: env override → installed weights package → dev-tree fallback. Ported from
 * `HealthRouter`.
 */
async function readModelCard(): Promise<Record<string, unknown> | null> {
	const candidates: string[] = []

	if ($public.MAILWOMAN_MODEL_CARD) {
		candidates.push($public.MAILWOMAN_MODEL_CARD)
	}

	try {
		// Native ESM resolution of the weights package's card. `@mailwoman/neural-weights-*` packages carry no `exports`
		// map, so the subpath resolves as a plain file inside the package, and (unlike `node:module`'s
		// `findPackageJSON`) `import.meta.resolve` realpaths through the workspace symlink — the same string the CJS
		// `require.resolve` this replaced returned. It does NOT throw for a missing FILE inside a resolvable package,
		// only for an unresolvable package; the `pathExists` below already gates every candidate, so that is a no-op
		// here.
		candidates.push(resolveModulePath("@mailwoman/neural-weights-en-us/model-card.json"))
	} catch {
		/* package not resolvable from here — fall through */
	}

	candidates.push("packages/neural-weights-en-us/model-card.json")

	for (const p of candidates) {
		try {
			if (await pathExists(p)) {
				const card = tryParsingJSON<Record<string, unknown>>(await readLocalTextFile(p))

				if (card) return card
			}
		} catch {
			/* unreadable — try the next candidate */
		}
	}

	return null
}

/**
 * Count canonical per-state databases (`<prefix>-us-<2-letter>.db`) in a data subdir; 0 if absent. Ported from
 * `HealthRouter`.
 */
async function countDatabases(subdir: string, prefix: string): Promise<number> {
	try {
		const re = new RegExp(`^${prefix}-us-[a-z]{2}\\.db$`)

		return (await readDirectory(`${DATA_ROOT}/${subdir}`)).filter((f) => re.test(f)).length
	} catch {
		return 0
	}
}

/**
 * The `/health` data block: model card + data-root inventory. Ported from `HealthRouter`'s `healthHandler`. Always
 * available — reads files best-effort and never throws, regardless of preflight status.
 */
async function buildHealthData(): Promise<HealthData> {
	const card = await readModelCard()
	// The express HealthRouter existence-filtered here where GeocodeRouter's wofPaths() didn't (for
	// env-supplied paths); this diagnostic field keeps the health-side behavior (no phantom env paths in
	// "what's deployed").
	const wofDBs: string[] = []

	for (const p of await wofPaths()) {
		if (await pathExists(p)) {
			wofDBs.push(p)
		}
	}

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
			versions: await readReleaseManifest(DATA_ROOT),
			wof_dbs: wofDBs,
			situs_states: await countDatabases("address-points", "address-points"),
			interpolation_states: await countDatabases("interpolation", "interpolation"),
		},
	}
}

/**
 * One geocode call over the shared deps. Ported from `GeocodeRouter`'s `oneGeocode`.
 */
function oneGeocode(
	deps: GeocodeDepsBundle,
	address: string,
	inputMode?: "fragmented" | "formatted"
): Promise<GeocodeOutcome> {
	return geocodeAddress(address, {
		classifier: deps.classifier,
		resolver: deps.resolver,
		databases: deps.databases.for,
		defaultCountry: deps.defaultCountry,
		interpCalibration: INTERP_RADIUS_CALIBRATION,
		inputMode,
	})
}

/**
 * Pull the street node's resolution tier (if any) for the metric. Ported verbatim from `GeocodeRouter`.
 */
function collectStreetTier(
	node: AddressTree["roots"][number]
): Array<"address_point" | "interpolated" | "street" | "admin"> {
	const out: Array<"address_point" | "interpolated" | "street" | "admin"> = []

	for (const n of walkNodes([node])) {
		if (n.tag !== "street") continue
		const tier = n.metadata?.["resolution_tier"]

		if (tier === "address_point" || tier === "interpolated" || tier === "street") {
			out.push(tier)
		}
	}

	return out
}

/**
 * {@link createServeEngine}'s return value.
 */
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
			// Decision A: explicit wire register wins; unset → the kind classifier decides (same derivation
			// as the runtime pipeline / geocode-core — /v1/parse is the "plain parse" endpoint class).
			const shape = computeQueryShape(address)

			const inputMode =
				opts.inputMode ?? deriveInputMode(classifyKindSync({ raw: address, normalized: address }, shape).kind)

			const tree = await parseClassifier.parse(address, { postcodeRepair: true, inputMode })

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

	const paths = await wofPaths()
	// Candidate backend → country-agnostic default (demo's global, population-first behavior); a per-request `country`
	// still scopes. FTS backend keeps the US default. (#170) A candidate DB alone (no WOF admin database) is a valid boot
	// configuration — `createResolverBackend` prefers it over `wofPaths` — so the preflight gate below checks BOTH,
	// mirroring the drop-ins' `!candidateDB && wofPaths.length === 0` gate rather than `GeocodeRouter`'s WOF-only check.
	// This gate governs geocode/batch/resolveTree/reload ONLY — `parse` is already wired above and unaffected.
	const candidateDB = await resolveCandidateDBPath()

	if (!paths.length && !candidateDB) {
		console.error("createServeEngine: no WOF DBs found — set MAILWOMAN_WOF_DB or MAILWOMAN_CANDIDATE_DB")

		return { engine: { parse, health }, preflight: { ok: false, message: buildPreflightMessage() } }
	}

	const backend = await createResolverBackend(resolverMod, { wofPaths: paths })
	const resolver = createWOFResolver(backend)
	const databases = await RegionDatabaseProvider.create(resolverMod, DATA_ROOT)
	const deps: GeocodeDepsBundle = { classifier, resolver, databases, defaultCountry: candidateDB ? undefined : "US" }

	// Route records the whole-call metric already (`@mailwoman/api`'s `routes.ts`) — the engine records nothing extra
	// here. Ported from `GeocodeRouter`'s `singleHandler`. The cast mirrors `@mailwoman/api/routes.ts`'s established
	// "documented wire shape looser than the domain type" idiom — `GeocodeOutcome` is a deliberately loose passthrough.
	const geocode: GeocodeCallback = async (address, opts) => oneGeocode(deps, address, opts?.inputMode)

	// Sequential loop — results land in input order; a thrown row is isolated to its own
	// `{ input, error }` slot. Rows are trimmed here (the route passes the raw validated array through).
	//
	// This was a bounded-concurrency worker pool (`MAILWOMAN_BATCH_CONCURRENCY`, default 8) until
	// 2026-07-16. The pool was measured at 1.00x — a geocode cannot overlap another in-process, because
	// `onnxruntime-node`'s `session.run()` blocks the JS thread rather than releasing to the libuv pool,
	// and `node:sqlite` reads are synchronous. The pool bought nothing but the appearance of tuning, so
	// it's a plain loop now. To actually parallelize, cross a thread boundary — see
	// `mailwoman/geocode-stream.ts`. Receipts: `docs/engineering/reference/performance.mdx`.
	const batch: MailwomanAPIEngine["batch"] = async (addresses, opts) => {
		// Decision A endpoint default: batch rows are the record register.
		const inputMode = opts?.inputMode ?? "formatted"
		const inputs = addresses.map((a) => a.trim())
		const results: BatchResultEntry[] = new Array<BatchResultEntry>(inputs.length)

		for (let i = 0; i < inputs.length; i++) {
			const input = inputs[i]!
			const t0 = performance.now()

			try {
				const result = await oneGeocode(deps, input, inputMode)
				recordTimed(performance.now() - t0, result.resolution_tier)
				results[i] = result
			} catch (error) {
				recordTimed(performance.now() - t0, "error")
				results[i] = { input, error: error instanceof Error ? error.message : String(error) }
			}
		}

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
			const { addressPoints, interpolation } = deps.databases.for(slug)

			const opts: ResolveOpts = {
				...incomingOpts,
				defaultCountry: incomingOpts.defaultCountry ?? deps.defaultCountry,
				...(addressPoints ? { addressPoints } : {}),
				// #374 calibration ladder: explicit incoming factor (instrument override, survives the spread) →
				// the artifact's own header value (`interpolation.radiusCalibration`, read at database open — the
				// resolver consumes it directly, nothing passed here) → the in-code per-region table for databases
				// predating the `interp_calibration` metadata table.
				...(interpolation
					? {
							interpolation,
							...(incomingOpts.interpolationRadiusCalibration == null && interpolation.radiusCalibration == null
								? { interpolationRadiusCalibration: interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, slug) }
								: {}),
						}
					: {}),
			}

			const resolved = await deps.resolver.resolveTree(tree, opts)
			// Best-effort tier metric: read the street node's stamped tier (matches the geocode path).
			const street = resolved.roots.flatMap((r) => collectStreetTier(r)).find(Boolean)
			recordTimed(performance.now() - t0, street ?? "admin")

			const outcome: ResolveTreeOutcome = { tree: resolved }

			return outcome
		} catch (error) {
			recordTimed(performance.now() - t0, "error")
			throw error
		}
	}

	// Ported from `GeocodeRouter`'s `reloadHandler`.
	const reload: MailwomanAPIEngine["reload"] = async () => {
		const versions = await deps.databases.reload()

		return { reloaded: true, versions }
	}

	return {
		engine: { parse, geocode, batch, resolveTree, reload, health },
		preflight: { ok: true },
	}
}
