/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwdev_lookup`'s handler: resolve each source's artifact the way the RUNTIME resolves it, open it read-only, ask
 *   the probe, close it.
 *
 *   Resolution is the part worth reading. Every path here comes from the function the running system uses —
 *   `resolveCandidateDBPath`, `resolveWOFShardPaths`, `resolveWeights` — never from a literal assembled here. A probe
 *   that reads a different `candidate.db` than the session does answers a question nobody asked, and the failure is
 *   invisible: it looks exactly like the gazetteer being wrong.
 *
 *   Handles are opened per call rather than held. The probes are B-tree and FTS reads measured in single-digit
 *   milliseconds against a warm page cache, and the artifacts are multi-gigabyte — the engine registry is where this
 *   server spends its resident memory, and it spends it on sessions.
 */

import { readFileSync } from "node:fs"
import { basename } from "node:path"
import type { DatabaseSync } from "node:sqlite"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { parseAnchorLookup } from "@mailwoman/neural/anchor-inference"
import { PostcodeBinaryResolver } from "@mailwoman/neural/postcode-binary-resolver"
import { readRequiredChannels, resolveWeights } from "@mailwoman/neural/weights"
import { normalizeTokens } from "@mailwoman/resolver-wof-sqlite/fst-matcher"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import { resolveCandidateDBPath, resolveWOFShardPaths } from "mailwoman/resolver-backend"
import { resolvePath } from "path-ts"

import type { EngineConfig, EngineRegistry } from "./engine-registry.ts"
import {
	lookupCandidate,
	lookupCodex,
	lookupPOI,
	lookupPostcodeAnchor,
	lookupWOF,
	type PostcodeAnchorResolver,
	type WOFShard,
} from "./lookup-sources.ts"
import {
	loadFSTArtifact,
	LookupSource,
	lookupFST,
	lookupNormalize,
	lookupStreetMorphology,
	openSealedArtifact,
	type LookupResult,
} from "./lookup.ts"

/**
 * Everything a caller can pass, beyond the source and the queries.
 */
export interface LookupArgs {
	source: LookupSource
	queries: string[]
	locale?: string
	country?: string
	limit?: number
	config?: EngineConfig
}

/**
 * Run one source and close whatever it opened.
 *
 * `unavailable_reason` and NO rows is the answer for a missing artifact. The alternative — a row per query saying "no"
 * — is the same shape a genuine absence has, and a caller reading it would conclude the gazetteer lacks fifty places
 * when what it lacks is a file.
 */
export async function runLookup(registry: EngineRegistry, args: LookupArgs): Promise<LookupResult> {
	const { source, queries } = args
	const config = args.config ?? {}
	const dataRoot = config.data_root ?? String(mailwomanDataRoot())

	switch (source) {
		case LookupSource.Normalize: {
			return {
				source,
				rows: lookupNormalize(queries, args.locale ?? "und"),
				notes: [
					"Normalization always answers, so every row is a hit. The useful column is `changed`: a query whose " +
						"normalized form differs is the usual reason a lookup against another source misses.",
				],
			}
		}

		case LookupSource.Codex: {
			return {
				source,
				rows: lookupCodex(queries),
				notes: [
					"Pure reference data — no artifact, so this source is never unavailable and a miss is always a real " +
						"absence from the codex tables.",
				],
			}
		}

		case LookupSource.Candidate: {
			return withArtifact(source, resolveCandidateDB(config, dataRoot), (db, path) => ({
				source,
				provenance: { artifact: path },
				rows: lookupCandidate(db, queries, {
					...(args.country ? { country: args.country } : {}),
					...(args.limit ? { limit: args.limit } : {}),
				}),
				notes: [
					"Keyed on `name_key` — the shared fold applied at build AND at query time. Every row reports the key " +
						"that reached it beside the stored `name`, because those differ far more often than they agree.",
					"`importance: null` is UNMEASURED (the score source had no row for that place), never an importance of " +
						"zero. A (0, 0) centroid is the build's unlocated sentinel.",
				],
			}))
		}

		case LookupSource.POI: {
			return withArtifact(source, resolvePath(dataRoot, "poi", "poi.db"), (db, path) => ({
				source,
				provenance: { artifact: path },
				rows: lookupPOI(db, queries, {
					...(args.country ? { country: args.country } : {}),
					...(args.limit ? { limit: args.limit } : {}),
				}),
				notes: [
					"The exact-`name_key` path only. The runtime also reaches rows through an FTS5 name index, so a miss " +
						"here is an absence from the exact key, not proof no POI answers this name.",
				],
			}))
		}

		case LookupSource.WOF: {
			return runWOFLookup(args, dataRoot)
		}

		case LookupSource.Postcode: {
			return runPostcodeLookup(args)
		}

		case LookupSource.FST:
		case LookupSource.StreetMorphology: {
			return runFSTLookup(registry, args)
		}

		default: {
			throw new Error(`mwdev_lookup: unknown source ${JSON.stringify(source)}.`)
		}
	}
}

/**
 * The candidate gazetteer, resolved exactly as the session resolves it — with the ONE thing `resolveCandidateDBPath`
 * cannot say folded back in.
 *
 * That function answers `undefined` for three different situations: nothing was pinned and the convention path is
 * absent, `none` was pinned to force the FTS backend, and a pinned path does not exist. The runtime is right not to
 * distinguish them (all three mean "no candidate backend"), but a probe that reported the third as "no path was
 * resolved" would tell someone who typo'd `--candidate-db` that the gazetteer is missing.
 */
function resolveCandidateDB(config: EngineConfig, dataRoot: string): string | undefined {
	const resolved = resolveCandidateDBPath(config.candidate_db, dataRoot)

	if (resolved || !config.candidate_db || config.candidate_db === "none") return resolved

	// Hand back the path AS PINNED so `openSealedArtifact` reports it by name.
	return config.candidate_db
}

/**
 * Open one sealed artifact, hand it to `build`, and close it whatever happens. An unopenable path short-circuits to the
 * unavailable envelope with no rows.
 */
function withArtifact(
	source: LookupSource,
	path: string | undefined,
	build: (db: DatabaseSync, path: string) => LookupResult
): LookupResult {
	const opened = openSealedArtifact(path)

	if ("unavailable" in opened || !path) {
		const unavailable = "unavailable" in opened ? opened.unavailable : "No artifact path was resolved for this source."

		return { source, rows: [], unavailable_reason: unavailable, notes: [UNAVAILABLE_NOTE] }
	}

	try {
		return build(opened.db, path)
	} finally {
		opened.db.close()
	}
}

/**
 * The one sentence every unavailable source returns, so the reason a result is empty can never be mistaken for the
 * answer.
 */
const UNAVAILABLE_NOTE =
	"No row is reported, because a source whose artifact is missing answers 'no' to everything — which would read as " +
	"absence for every query rather than as an unavailable source."

/**
 * The WOF shards, opened as a set. Unavailable only when NO shard opens; a partial set is reported in the notes,
 * because "three of six shards" is a different reading of a miss than "all six".
 */
function runWOFLookup(args: LookupArgs, dataRoot: string): LookupResult {
	const paths = resolveWOFShardPaths(args.config?.resolve_db, dataRoot)
	const shards: WOFShard[] = []
	const skipped: string[] = []

	for (const path of paths) {
		const opened = openSealedArtifact(path)

		if ("unavailable" in opened) {
			skipped.push(opened.unavailable)

			continue
		}

		shards.push({ name: basename(path), db: opened.db })
	}

	if (!shards.length) {
		return {
			source: LookupSource.WOF,
			rows: [],
			unavailable_reason: `No WOF shard could be opened. ${skipped.join(" ")}`,
			notes: [UNAVAILABLE_NOTE],
		}
	}

	try {
		return {
			source: LookupSource.WOF,
			provenance: { artifact: shards.map((shard) => shard.name).join(", ") },
			rows: lookupWOF(shards, args.queries, args.limit ? { limit: args.limit } : {}),
			notes: [
				`Probed ${shards.length} of ${paths.length} shard(s) in the runtime's own set.`,
				...(skipped.length ? [`Not opened: ${skipped.join(" ")}`] : []),
				"Read this against `candidate`: a string this source holds and the candidate table misses is a BUILD gap.",
				"Deprecated and not-current records are named in the row note and kept OUT of `entries` — the FTS5 content " +
					"the resolver reads is built with that filter already applied, so they exist in the shard and reach " +
					"nothing downstream.",
			],
		}
	} finally {
		for (const shard of shards) {
			shard.db.close()
		}
	}
}

/**
 * The postcode→anchor artifact for one locale's weights package.
 *
 * The span mode comes from the package's own model card. Defaulting it here instead would describe a configuration the
 * loader never runs — `alnum-run` is the loader's default only when the card declares nothing.
 */
function runPostcodeLookup(args: LookupArgs): LookupResult {
	const locale = args.locale ?? args.config?.locale ?? "en-us"
	let resolved: ReturnType<typeof resolveWeights>

	try {
		resolved = resolveWeights({ locale })
	} catch (error) {
		return {
			source: LookupSource.Postcode,
			rows: [],
			unavailable_reason: `No weights package resolved for locale ${locale}: ${(error as Error).message}`,
			notes: [UNAVAILABLE_NOTE],
		}
	}

	if (!resolved.anchorLookupPath) {
		return {
			source: LookupSource.Postcode,
			rows: [],
			unavailable_reason:
				`${resolved.packageDir ?? resolved.source} ships no postcode anchor artifact (no postcode-<cc>.bin, no ` +
				"anchor-lookup.json). The anchor channel runs OFF for this locale — an absent artifact, not an empty one.",
			notes: [UNAVAILABLE_NOTE],
		}
	}

	const spanMode = readRequiredChannels(resolved.modelCardPath)?.anchor?.span_mode ?? "alnum-run"
	let resolver: PostcodeAnchorResolver

	try {
		resolver = loadAnchorArtifact(resolved.anchorLookupPath)
	} catch (error) {
		return {
			source: LookupSource.Postcode,
			rows: [],
			unavailable_reason: `${resolved.anchorLookupPath.path} did not parse: ${(error as Error).message}`,
			notes: [UNAVAILABLE_NOTE],
		}
	}

	return {
		source: LookupSource.Postcode,
		provenance: { artifact: resolved.anchorLookupPath.path, locale, span_mode: spanMode },
		rows: lookupPostcodeAnchor(resolver, args.queries, { spanMode }),
		notes: [
			"This is the channel the MODEL is fed, not a gazetteer — membership is scoped to one weights package, so a " +
				"US bundle answering 'no' to a GB code is telling you about the bundle.",
			`The card declares span_mode "${spanMode}", which decides whether a key containing a space is reachable at ` +
				"serve at all.",
		],
	}
}

/**
 * Read the anchor artifact behind the resolver seam.
 *
 * The binary is probed by binary SEARCH, never decoded whole: `postcode-gb.bin` holds 1,749,839 keys and
 * `toAnchorLookup()` builds all of them into a Map in 2,035 ms (against 24 ms to construct the reader), which is the
 * wrong trade for a handful of queries. The JSON form has no search seam, so it is parsed and wrapped.
 */
function loadAnchorArtifact(artifact: { path: string; binary: boolean }): PostcodeAnchorResolver {
	if (artifact.binary) {
		return new PostcodeBinaryResolver(new Uint8Array(readFileSync(artifact.path)))
	}

	const lookup = parseAnchorLookup(parseJSONStrict(readFileSync(artifact.path, "utf8")))

	return {
		lookup: (postcode: string) => {
			const entry = lookup.get(postcode)

			if (!entry) return []

			return Object.keys(entry.posterior).map((country) => ({ country, lat: entry.lat, lon: entry.lon }))
		},
	}
}

/**
 * The two FST sources, which need a warm session to learn WHICH artifact the decoder would read.
 *
 * `gazetteer_prior: true` is forced. A session resolves the FST paths only when it will actually feed the prior, and it
 * is right to: `artifacts` reports what a session READ, not what it could have. A lookup wants the artifact the decoder
 * would consult, so it asks for an engine that loads one — resolving the path any other way would answer about an FST
 * no runtime configuration reads.
 */
async function runFSTLookup(registry: EngineRegistry, args: LookupArgs): Promise<LookupResult> {
	const engine = await registry.acquire({ ...args.config, gazetteer_prior: true })

	const path =
		args.source === LookupSource.FST ? engine.session.artifacts.fstPath : engine.session.artifacts.streetMorphologyPath

	const loaded = loadFSTArtifact(path, deserializeFST as never)

	if ("unavailable" in loaded) {
		return { source: args.source, rows: [], unavailable_reason: loaded.unavailable, notes: [UNAVAILABLE_NOTE] }
	}

	return {
		source: args.source,
		provenance: { engine_id: engine.engineID, artifact: path },
		rows:
			args.source === LookupSource.FST
				? lookupFST(loaded.fst, normalizeTokens, args.queries)
				: lookupStreetMorphology(loaded.fst, args.queries),
		notes:
			args.source === LookupSource.FST
				? [
						"Entries are the per-BIO-tag MAX, which is all the emission prior reads. A surface accepted with no " +
							"BIO-mapped placetype gives the decoder nothing — different from a zero.",
					]
				: [],
	}
}
