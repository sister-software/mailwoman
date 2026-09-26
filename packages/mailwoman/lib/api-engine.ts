/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `createServeEngine` builds the shared stack once at boot — the CLI's `serve` command awaits it before listening, so a misconfigured deployment fails friendly at boot rather than on the first request — and a degraded boot is deliberate: `parse` needs only the model weights and still answers `/v1/parse` without WOF data, while `geocode`/`batch`/`resolveTree`/`reload` are absent and their routes answer 503; when the weights are unresolvable `parse` is absent too and its routes answer 501 with no rules fallback; and `health` always answers.
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
import { dataRootPath } from "@mailwoman/core/data-root"
import { walkNodes, type AddressTree } from "@mailwoman/core/decoder"
import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { tryParsingJSON } from "@mailwoman/core/json"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { deriveInputMode } from "@mailwoman/core/pipeline"
import type { Resolver, ResolveOpts } from "@mailwoman/core/resolver"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { classifyKindSync } from "@mailwoman/kind-classifier"
import { computeQueryShape } from "@mailwoman/query-shape"
import { createWOFResolver } from "@mailwoman/resolver"
import { Globerator } from "spliterator/node/fs"

import { readReleaseManifest } from "#data/release"
import { $public } from "#env"
import { geocodeAddress, type GeocodeClassifier } from "#geocode/core"
import { regionSlugFromTree, RegionDatabaseProvider } from "#geocode/regions"
import { INTERP_RADIUS_CALIBRATION, interpCalibrationForRegion } from "#interp-calibration"
import {
	buildNoGazetteerMessage,
	createResolverBackend,
	existingWOFDatabasePaths,
	resolveCandidateDBPath,
} from "#resolver-backend"

const DATA_ROOT = dataRootPath()

interface GeocodeDepsBundle {
	classifier: GeocodeClassifier
	resolver: Resolver
	databases: RegionDatabaseProvider
	defaultCountry?: string
}

async function wofPaths(): Promise<string[]> {
	const env = $public.MAILWOMAN_WOF_DB

	// The env override is comma-split and probed like the convention set: a listed database
	// that is not on disk is dropped here rather than handed to the resolver to fail on open.
	const explicit = env ? extractDelimited(env) : undefined

	return await existingWOFDatabasePaths(explicit)
}

/**
 * A boot preflight message that a stranger's first `mailwoman serve` reads:
 * it says exactly what data is missing and the one command that fixes it.
 */
function buildPreflightMessage(): string {
	return buildNoGazetteerMessage({
		dataRoot: DATA_ROOT,
		docsPath: "/docs/developers/get-started/ten-minute-trial",
	})
}

async function readModelCard(): Promise<Record<string, unknown> | null> {
	const candidates: string[] = []

	if ($public.MAILWOMAN_MODEL_CARD) {
		candidates.push($public.MAILWOMAN_MODEL_CARD)
	}

	try {
		// `@mailwoman/neural-weights-*` packages carry no `exports` map, so the subpath
		// resolves as a plain file inside the package, and `import.meta.resolve` realpaths
		// through the workspace symlink; it throws only for an unresolvable package,
		// not a missing file inside one, so `pathExists` below checks every candidate.
		candidates.push(resolveModulePath("@mailwoman/neural-weights-en-us/model-card.json"))
	} catch {
		// A weights package that does not resolve here simply falls through to the next candidate.
	}

	candidates.push("packages/neural-weights-en-us/model-card.json")

	for (const p of candidates) {
		try {
			if (await pathExists(p)) {
				const card = tryParsingJSON<Record<string, unknown>>(await readLocalTextFile(p))

				if (card) return card
			}
		} catch {
			// Unreadable — try the next candidate.
		}
	}

	return null
}

async function countDatabases(subdir: string, prefix: string): Promise<number> {
	try {
		const re = new RegExp(`^${prefix}-us-[a-z]{2}\\.db$`)

		return await Globerator.from("*.db", { cwd: `${DATA_ROOT}/${subdir}`, absolute: false })
			.filter((file) => re.test(file))
			.reduce((count) => count + 1, 0)
	} catch {
		return 0
	}
}

/**
 * The `/health` data block: the model card plus the data-root inventory, best-effort
 * and never throwing regardless of preflight status.
 */
async function buildHealthData(): Promise<HealthData> {
	const card = await readModelCard()
	// This field drops env-supplied paths that are not on disk, so "what's deployed" carries no phantom paths.
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
			// Versioned-switchover provenance: the releases.json pin, or null in legacy mode.
			versions: await readReleaseManifest(DATA_ROOT),
			wof_dbs: wofDBs,
			situs_states: await countDatabases("address-points", "address-points"),
			interpolation_states: await countDatabases("interpolation", "interpolation"),
		},
	}
}

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
 * Builds the wired `mailwoman serve` engine, awaited once at boot so a misconfigured
 * deployment reports its preflight failure before the process starts listening.
 */
export async function createServeEngine(): Promise<ServeEngine> {
	// `health` reads files best-effort and never throws, so it is wired unconditionally.
	const health: MailwomanAPIEngine["health"] = () => buildHealthData()

	// Parse needs only the model weights, loaded here once per boot and reused by the
	// geocode stack below, so `/v1/parse` answers even on a geocode-degraded boot.
	let parse: MailwomanAPIEngine["parse"]
	let neuralMod: typeof import("@mailwoman/neural") | undefined
	let classifier: GeocodeClassifier | undefined

	try {
		neuralMod = await import("@mailwoman/neural")
		classifier = await neuralMod.NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

		const parseClassifier = classifier

		parse = async (address, opts) => {
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
	// A candidate DB alone (no WOF admin database) is a valid boot configuration,
	// so the preflight checks both; this check governs geocode/batch/resolveTree/reload
	// only, and `parse` is already wired above.
	const candidateDB = await resolveCandidateDBPath()

	if (!paths.length && !candidateDB) {
		console.error("createServeEngine: no WOF DBs found — set MAILWOMAN_WOF_DB or MAILWOMAN_CANDIDATE_DB")

		return { engine: { parse, health }, preflight: { ok: false, message: buildPreflightMessage() } }
	}

	const backend = await createResolverBackend(resolverMod, { wofPaths: paths })
	const resolver = createWOFResolver(backend)
	const databases = await RegionDatabaseProvider.create(resolverMod, DATA_ROOT)
	const deps: GeocodeDepsBundle = { classifier, resolver, databases, defaultCountry: candidateDB ? undefined : "US" }

	// The route already records the whole-call metric, so the engine records no extra metric here.
	const geocode: GeocodeCallback = async (address, opts) => oneGeocode(deps, address, opts?.inputMode)

	// Sequential because `onnxruntime-node`'s `session.run()` blocks the JS thread
	// and `node:sqlite` reads are synchronous, so a geocode cannot overlap another in-process;
	// results land in input order and a thrown row is isolated to its own `{ input, error }` slot.
	const batch: MailwomanAPIEngine["batch"] = async (addresses, opts) => {
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

	// Unlike `/v1/geocode`, the route wraps no try/catch around `resolveTree`,
	// so the tier metric and the rethrow both happen here.
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
				// Calibration ladder: an explicit incoming factor wins, then the artifact's own
				// header value (`interpolation.radiusCalibration`), then the in-code per-region
				// table for databases predating the `interp_calibration` metadata table.
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
			const street = resolved.roots.flatMap((r) => collectStreetTier(r)).find(Boolean)
			recordTimed(performance.now() - t0, street ?? "admin")

			const outcome: ResolveTreeOutcome = { tree: resolved }

			return outcome
		} catch (error) {
			recordTimed(performance.now() - t0, "error")
			throw error
		}
	}

	const reload: MailwomanAPIEngine["reload"] = async () => {
		const versions = await deps.databases.reload()

		return { reloaded: true, versions }
	}

	return {
		engine: { parse, geocode, batch, resolveTree, reload, health },
		preflight: { ok: true },
	}
}
