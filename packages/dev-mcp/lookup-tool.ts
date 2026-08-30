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

import { pathExists, readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { parseAnchorLookup } from "@mailwoman/neural/anchor-inference"
import { PostcodeBinaryResolver } from "@mailwoman/neural/postcode-binary-resolver"
import { readRequiredChannels, resolveWeights } from "@mailwoman/neural/weights"
import { basename } from "@mailwoman/platform/path"
import { normalizeTokens } from "@mailwoman/resolver-wof-sqlite/fst-matcher"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import type { PlaceImportanceDatabase } from "@mailwoman/resolver-wof-sqlite/place-importance-schema"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolveCandidateDBPath, resolveWOFShardPaths } from "mailwoman/resolver-backend"
import { resolvePath } from "path-ts"

import type { EngineConfig, EngineRegistryLike } from "./engine-registry.ts"
import {
	type CandidateDelta,
	diffCandidateRows,
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
	type LookupRow,
} from "./lookup.ts"
import { syntheticIDNote } from "./place-id-provenance.ts"

/**
 * The `candidate` source's two-artifact answer: the primary artifact's rows, the compare artifact's rows for the SAME
 * queries, and the per-query delta between the returned sets.
 */
export interface CandidateCompareResult extends LookupResult {
	rows_compare: LookupRow[]
	deltas: CandidateDelta[]
}

/**
 * Everything a caller can pass, beyond the source and the queries.
 */
export interface LookupArgs {
	source: LookupSource
	queries: string[]
	locale?: string
	/**
	 * Sweep the same queries across several locales' own artifacts. FST sources only.
	 */
	locales?: string[]
	country?: string
	limit?: number
	config?: EngineConfig
	/**
	 * `candidate` only — a SECOND candidate.db to run the same queries against, answering both row sets plus a per-query
	 * delta (rows only one artifact holds; shared rows whose ranking fields moved). The two-artifact probe every staged
	 * gazetteer diagnosis previously scripted by hand.
	 */
	compareCandidateDB?: string
}

/**
 * Run one source and close whatever it opened.
 *
 * `unavailable_reason` and NO rows is the answer for a missing artifact. The alternative — a row per query saying "no"
 * — is the same shape a genuine absence has, and a caller reading it would conclude the gazetteer lacks fifty places
 * when what it lacks is a file.
 */
export async function runLookup(
	registry: EngineRegistryLike,
	args: LookupArgs
): Promise<LookupResult | CandidateCompareResult> {
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
			return await withArtifact(source, resolveCandidateDB(config, dataRoot), async (db, path) => {
				// The score source's split channels ride along whenever the conventional importance DB exists beside the
				// artifacts — the join every fame-contest diagnosis needs, attached rather than scripted.
				const importancePath = String(resolvePath(dataRoot, "wof", "admin-global-priority-importance.db"))

				const importanceDB = (await pathExists(importancePath))
					? new DatabaseClient<PlaceImportanceDatabase>(importancePath, { readOnly: true })
					: null

				try {
					const candidateOptions = {
						...(args.country ? { country: args.country } : {}),
						...(args.limit ? { limit: args.limit } : {}),
						...(importanceDB ? { importance: { db: importanceDB, artifact: importancePath } } : {}),
					}

					const rows = lookupCandidate(db, queries, candidateOptions)

					const idNote = syntheticIDNote(
						rows.flatMap((row) => (row.entries ?? []).map((e) => Number((e as { spr_id: number }).spr_id)))
					)

					const entries = rows.flatMap((row) => (row.entries ?? []) as Array<{ importance_split?: unknown }>)

					const joined = entries.filter(
						(entry) => entry.importance_split !== undefined && entry.importance_split !== null
					).length

					const splitNote = importanceDB
						? `importance_split joined for ${joined} of ${entries.length} returned row(s) by spr_id from ` +
							`${basename(importancePath)}. A LOW rate against rows whose blended importance IS measured means ` +
							"the id spaces diverged (a cross-era pair re-keys Overture-minted ids) — not missing scores."
						: "No admin-global-priority-importance.db under the data root, so entries carry no importance_split — " +
							"the split channels are UNREAD here, not absent from the world."

					if (args.compareCandidateDB) {
						const comparePath = resolveCandidateDB({ ...config, candidate_db: args.compareCandidateDB }, dataRoot)
						const openedB = await openSealedArtifact<WOFDatabase>(comparePath)

						if ("unavailable" in openedB || !comparePath) {
							return {
								source,
								provenance: { artifact: path },
								rows,
								notes: [
									`compare_candidate_db did not open (${"unavailable" in openedB ? openedB.unavailable : "no path resolved"}) — ` +
										"single-artifact rows only, and this line is the reason there are no deltas.",
									splitNote,
									...(idNote ? [idNote] : []),
								],
							}
						}

						try {
							const rowsCompare = lookupCandidate(openedB.db, queries, candidateOptions)

							return {
								source,
								provenance: { artifact: path, compare_artifact: comparePath },
								rows,
								rows_compare: rowsCompare,
								deltas: diffCandidateRows(rows, rowsCompare),
								notes: [
									"Two artifacts, same queries: `rows` is the primary, `rows_compare` the compare_candidate_db, " +
										"and `deltas` the per-query difference — computed over the RETURNED rows only, so raise " +
										"`limit` before reading a delta over a deep key population.",
									splitNote,
									...(idNote ? [idNote] : []),
								],
							}
						} finally {
							openedB.db.destroy()
						}
					}

					return {
						source,
						provenance: { artifact: path },
						rows,
						notes: [
							"Keyed on `name_key` — the shared fold applied at build AND at query time. Every row reports the key " +
								"that reached it beside the stored `name`, because those differ far more often than they agree.",
							"`importance: null` is UNMEASURED (the score source had no row for that place), never an importance of " +
								"zero. A (0, 0) centroid is the build's unlocated sentinel.",
							splitNote,
							...(idNote ? [idNote] : []),
						],
					}
				} finally {
					importanceDB?.destroy()
				}
			})
		}

		case LookupSource.POI: {
			return await withArtifact(source, resolvePath(dataRoot, "poi", "poi.db"), (db, path) => ({
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
			return await runWOFLookup(args, dataRoot)
		}

		case LookupSource.Postcode: {
			return await runPostcodeLookup(args)
		}

		case LookupSource.FST:
		case LookupSource.StreetMorphology: {
			return await runFSTLookup(registry, args)
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
async function withArtifact<T extends LookupResult>(
	source: LookupSource,
	path: string | undefined,
	build: (db: DatabaseClient<WOFDatabase>, path: string) => T | Promise<T>
): Promise<T | LookupResult> {
	const opened = await openSealedArtifact<WOFDatabase>(path)

	if ("unavailable" in opened || !path) {
		const unavailable = "unavailable" in opened ? opened.unavailable : "No artifact path was resolved for this source."

		return { source, rows: [], unavailable_reason: unavailable, notes: [UNAVAILABLE_NOTE] }
	}

	try {
		return await build(opened.db, path)
	} finally {
		opened.db.destroy()
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
async function runWOFLookup(args: LookupArgs, dataRoot: string): Promise<LookupResult> {
	const paths = resolveWOFShardPaths(args.config?.resolve_db, dataRoot)
	const shards: WOFShard<WOFDatabase>[] = []
	const skipped: string[] = []

	for (const path of paths) {
		const opened = await openSealedArtifact<WOFDatabase>(path)

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
		const rows = lookupWOF(shards, args.queries, {
			...(args.country ? { country: args.country } : {}),
			...(args.limit ? { limit: args.limit } : {}),
		})

		const idNote = syntheticIDNote(
			rows.flatMap((row) => (row.entries ?? []).map((e) => Number((e as { id: number }).id)))
		)

		return {
			source: LookupSource.WOF,
			provenance: { artifact: shards.map((shard) => shard.name).join(", ") },
			rows,
			notes: [
				`Probed ${shards.length} of ${paths.length} shard(s) in the runtime's own set.`,
				...(skipped.length ? [`Not opened: ${skipped.join(" ")}`] : []),
				"Read this against `candidate`: a string this source holds and the candidate table misses is a BUILD gap.",
				"Deprecated and not-current records are named in the row note and kept OUT of `entries` — the FTS5 content " +
					"the resolver reads is built with that filter already applied, so they exist in the shard and reach " +
					"nothing downstream.",
				...(idNote ? [idNote] : []),
			],
		}
	} finally {
		for (const shard of shards) {
			shard.db.destroy()
		}
	}
}

/**
 * The postcode→anchor artifact for one locale's weights package.
 *
 * The span mode comes from the package's own model card. Defaulting it here instead would describe a configuration the
 * loader never runs — `alnum-run` is the loader's default only when the card declares nothing.
 */
async function runPostcodeLookup(args: LookupArgs): Promise<LookupResult> {
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
		resolver = await loadAnchorArtifact(resolved.anchorLookupPath)
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
async function loadAnchorArtifact(artifact: { path: string; binary: boolean }): Promise<PostcodeAnchorResolver> {
	if (artifact.binary) {
		return new PostcodeBinaryResolver(new Uint8Array(await readLocalBuffer(artifact.path)))
	}

	const lookup = parseAnchorLookup(await readLocalJSONFile(artifact.path))

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
async function runFSTLookup(registry: EngineRegistryLike, args: LookupArgs): Promise<LookupResult> {
	const notes =
		args.source === LookupSource.FST
			? [
					"Entries are the per-BIO-tag MAX, which is all the emission prior reads. A surface accepted with no " +
						"BIO-mapped placetype gives the decoder nothing — different from a zero, and different again from an " +
						"entry AT importance 0, which is BIO-mapped and still inert. `fires` is that third state.",
				]
			: []

	if (args.locales?.length) {
		const byLocale: NonNullable<LookupResult["by_locale"]> = {}

		// Sequential, and each locale costs a full session build: `artifacts` reports what a session READ, so learning
		// which artifact a locale's decoder consults means building that locale's decoder. The registry evicts to its
		// cap as this walks, so a wide sweep rebuilds rather than accumulating.
		for (const locale of args.locales) {
			byLocale[locale] = await probeLocaleFST(registry, args, locale)
		}

		return { source: args.source, by_locale: byLocale, rows: [], notes }
	}

	const probe = await probeLocaleFST(registry, args, args.config?.locale)

	if (probe.unavailable_reason) {
		return { source: args.source, rows: [], unavailable_reason: probe.unavailable_reason, notes: [UNAVAILABLE_NOTE] }
	}

	return {
		source: args.source,
		provenance: { engine_id: probe.engine_id, artifact: probe.artifact },
		rows: probe.rows,
		notes,
	}
}

/**
 * One locale's answer, with a missing artifact reported IN PLACE rather than by omission.
 *
 * Five shipped overlays carry no FST at all, so a sweep that dropped those locales would read as a set of locales that
 * knew nothing about the queries.
 */
async function probeLocaleFST(
	registry: EngineRegistryLike,
	args: LookupArgs,
	locale: string | undefined
): Promise<{ artifact?: string; engine_id?: string; rows: LookupRow[]; unavailable_reason?: string }> {
	const engine = await registry.acquire({
		...args.config,
		...(locale ? { locale } : {}),
		gazetteer_prior: true,
	})

	const path =
		args.source === LookupSource.FST ? engine.session.artifacts.fstPath : engine.session.artifacts.streetMorphologyPath

	const loaded = await loadFSTArtifact(path, deserializeFST)

	if ("unavailable" in loaded) return { rows: [], unavailable_reason: loaded.unavailable }

	return {
		...(path ? { artifact: path } : {}),
		engine_id: engine.engineID,
		rows:
			args.source === LookupSource.FST
				? lookupFST(loaded.fst, normalizeTokens, args.queries)
				: lookupStreetMorphology(loaded.fst, args.queries),
	}
}
