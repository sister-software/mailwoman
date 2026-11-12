// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `createServeEngine` builds the shared stack once at boot.
 *
 * The CLI's `serve` command awaits it before listening, so a misconfigured deployment
 * fails at boot rather than on the first request.
 * A degraded boot is deliberate: `parse` needs only the model weights and still
 * answers `/v1/parse` without WOF data, while `geocode`/`batch`/`resolveTree`/`reload`
 * are absent and their routes answer 503.
 *
 * When the weights are unresolvable `parse` is absent too and its routes answer 501 with no rules fallback.
 * `health` always answers.
 */

import type { HealthData, MailwomanAPIEngine } from "@mailwoman/api"
import { recordTimed } from "@mailwoman/api-kit"
import type { BatchRow } from "@mailwoman/api/operations/geocode/batch"
import { decodeAsTuples, decodeAsXML } from "@mailwoman/core"
import { dataRootPath } from "@mailwoman/core/data-root"
import { walkNodes, type AddressTree } from "@mailwoman/core/decoder"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { tryParsingJSON } from "@mailwoman/core/json"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import type { ResolveOpts } from "@mailwoman/core/resolver"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"
import { Globerator } from "spliterator/node/fs"

import { readReleaseManifest } from "#data/release"
import { $public } from "#env"
import { createGeocodeCommandOptions } from "#geocode/command-options"
import { deriveGeocodeRegister } from "#geocode/core"
import { need, ProcessServices } from "#geocode/services"
import { createGeocodeProcessScope, createGeocodeSession, type GeocodeSessionOptions } from "#geocode/session"
import { GeocodeSessionSlot } from "#geocode/session/slot"
import { buildNoGazetteerMessage, existingWOFDatabasePaths } from "#resolver-backend"

const DATA_ROOT = dataRootPath()

async function wofPaths(): Promise<string[]> {
	const env = $public.MAILWOMAN_WOF_DB

	// The env override is comma-split and probed like the convention set: a listed database
	// that's not on disk is dropped here rather than handed to the resolver to fail on open.
	const explicit = env ? extractDelimited(env) : null

	return existingWOFDatabasePaths(explicit)
}

/**
 * A boot preflight message that a stranger's first `mailwoman serve` reads:
 * it reports exactly what data is missing and the one command that fixes it.
 */
function buildPreflightMessage(): string {
	return buildNoGazetteerMessage({
		dataRoot: DATA_ROOT,
		docsPath: "/docs/reference/data-and-locales",
	})
}

async function readModelCard(): Promise<Record<string, unknown> | null> {
	const candidates: string[] = []

	if ($public.MAILWOMAN_MODEL_CARD) {
		candidates.push($public.MAILWOMAN_MODEL_CARD)
	}

	try {
		// `@mailwoman/neural-weights-*` packages have no `exports` map.
		// The subpath resolves as a plain file inside the package.
		// `import.meta.resolve` realpaths through the workspace symlink.
		// It throws only for an unresolvable package and resolves a missing file inside one.
		// `pathExists` below therefore checks every candidate.
		candidates.push(resolveModulePath("@mailwoman/neural-weights-en-us/model-card.json"))
	} catch {
		// A weights package that doesn't resolve here falls through to the next candidate.
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
	// This field drops env-supplied paths that are not on disk, so "what's deployed" lists only existing paths.
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
					labels: Array.isArray(card["labels"]) ? card["labels"].length : null,
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
 *
 * Its async disposal waits for in-flight requests, closes the geocode session, and releases the classifier.
 */
export interface ServeEngine extends AsyncDisposable {
	engine: MailwomanAPIEngine
	preflight: { ok: true } | { ok: false; message: string }
}

/**
 * The options the server's sessions build from: the library defaults at `en-US` over the process data root.
 *
 * `$MAILWOMAN_WOF_DB` and `$MAILWOMAN_CANDIDATE_DB` pin the gazetteer as they do for `mailwoman geocode`.
 */
function serveSessionOptions(): GeocodeSessionOptions {
	return createGeocodeCommandOptions({ locale: "en-US", dataRoot: DATA_ROOT })
}

/**
 * Builds the wired `mailwoman serve` engine, awaited once at boot so a misconfigured
 * deployment reports its preflight failure before the process starts listening.
 *
 * The engine geocodes through the same {@link createGeocodeSession} as `mailwoman geocode`.
 * The classifier lives in a process scope that every session shares,
 * and `reload` builds a session for the data root's current generation, swaps it in,
 * and closes the previous session once its in-flight requests finish.
 */
export async function createServeEngine(): Promise<ServeEngine> {
	// `health` reads files best-effort and never throws, so it is wired unconditionally.
	const health: MailwomanAPIEngine["health"] = () => buildHealthData()
	const options = serveSessionOptions()
	const processScope = createGeocodeProcessScope(options)
	const disposeProcessScope = () => processScope[Symbol.asyncDispose]()

	// Parse needs only the model weights.
	// The session below reads them from the same process scope.
	// `/v1/parse` therefore answers even on a geocode-degraded boot.
	let parse: MailwomanAPIEngine["parse"]

	try {
		const classifier = (await need(processScope, ProcessServices.classifier)).primary

		parse = async (address, opts) => {
			const inputMode = opts.inputMode === "auto" ? deriveGeocodeRegister(address) : opts.inputMode

			const tree = await classifier.parse(address, { postcodeRepair: true, inputMode })

			return {
				input: address,
				components: decodeAsTuples(tree).map(([tag, value]) => ({ tag, value })),
				tree,
				debug: opts.debug ? decodeAsXML(tree) : null,
			}
		}
	} catch {
		console.error("createServeEngine: neural weights not found — /v1/parse disabled (501)")

		return {
			engine: { health },
			preflight: { ok: false, message: buildPreflightMessage() },
			[Symbol.asyncDispose]: disposeProcessScope,
		}
	}

	let slot: GeocodeSessionSlot

	try {
		slot = new GeocodeSessionSlot(await createGeocodeSession(options, { process: processScope }))
	} catch (error) {
		// A missing gazetteer or resolver package is a preflight failure the operator fixes.
		// Any other construction failure is a fault, and boot stops on it.
		if (!(error instanceof CommandError)) throw error

		console.error(`createServeEngine: ${error.message}`)

		return {
			engine: { parse, health },
			preflight: { ok: false, message: buildPreflightMessage() },
			[Symbol.asyncDispose]: disposeProcessScope,
		}
	}

	// The route already records the whole-call metric, so the engine records no extra metric here.
	const geocode: MailwomanAPIEngine["geocode"] = (address, init) =>
		slot.run(async (session) => {
			const { result, tree } = await session.geocode(address, {
				inputMode: init.inputMode,
				bias: init.bias.map((point) => ({ ...point })),
			})

			return { ...result, tree: init.includeTree ? tree : null }
		})

	// Sequential because `onnxruntime-node`'s `session.run()` blocks the JS thread
	// and `node:sqlite` reads are synchronous, so a geocode cannot overlap another in-process.
	// Results land in input order and a thrown row is isolated to its own `{ input, error }` slot.
	// The whole batch reads one data generation.
	const batch: MailwomanAPIEngine["batch"] = (addresses, opts) =>
		slot.run(async (session) => {
			const results: BatchRow[] = []

			for (const address of addresses) {
				const input = address.trim()
				const t0 = performance.now()

				try {
					const { result } = await session.geocode(input, { inputMode: opts.inputMode })

					recordTimed(performance.now() - t0, result.resolution_tier)
					results.push(result)
				} catch (error) {
					recordTimed(performance.now() - t0, "error")
					results.push({ input, error: error instanceof Error ? error.message : String(error) })
				}
			}

			return { results }
		})

	// Unlike `/v1/geocode`, the route wraps no try/catch around `resolveTree`,
	// so the tier metric and the rethrow both happen here.
	const resolveTree: MailwomanAPIEngine["resolveTree"] = (tree, rawOpts) =>
		slot.run(async (session) => {
			const t0 = performance.now()

			try {
				const resolved = await session.resolveTree(tree, (rawOpts ?? {}) as ResolveOpts)
				const street = resolved.roots.flatMap((r) => collectStreetTier(r)).find(Boolean)

				recordTimed(performance.now() - t0, street ?? "admin")

				return { tree: resolved }
			} catch (error) {
				recordTimed(performance.now() - t0, "error")
				throw error
			}
		})

	const reload: MailwomanAPIEngine["reload"] = async () => {
		await slot.replace(() => createGeocodeSession(options, { process: processScope }))

		return { reloaded: true, versions: await readReleaseManifest(DATA_ROOT) }
	}

	return {
		engine: { parse, geocode, batch, resolveTree, reload, health },
		preflight: { ok: true },
		[Symbol.asyncDispose]: async () => {
			await slot[Symbol.asyncDispose]()
			await disposeProcessScope()
		},
	}
}
