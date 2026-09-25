/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseAnchorLookup } from "@mailwoman/neural/anchor-inference"
import { PostcodeBinaryResolver } from "@mailwoman/neural/postcode"
import { resolveWeights } from "@mailwoman/neural/weights"
import { readRequiredChannels } from "@mailwoman/neural/weights-channels"
import { normalizeTokens, deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import { poiDatabaseRoot, wofDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import type { PlaceImportanceDatabase } from "@mailwoman/resolver-wof-sqlite/place-importance-schema"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolveCandidateDBPath, resolveWOFDatabasePaths } from "mailwoman/resolver-backend"
import { basename, type PathBuilderLike, resolvePath } from "path-ts"

import type { EngineConfig, EngineRegistryLike } from "#engine/registry"
import {
	loadFSTArtifact,
	LookupSource,
	lookupFST,
	lookupNormalize,
	lookupStreetMorphology,
	openSealedArtifact,
	type LookupResult,
	type LookupRow,
} from "#lookup/index"
import {
	type CandidateDelta,
	diffCandidateRows,
	lookupCandidate,
	lookupCodex,
	lookupPOI,
	lookupPostcodeAnchor,
	lookupWOF,
	type PostcodeAnchorResolver,
	type WOFExtract,
} from "#lookup/sources"
import { syntheticIDNote } from "#place-id-provenance"

/**
 * A candidate lookup against two artifacts, with the per-query differences.
 */
export interface CandidateCompareResult extends LookupResult {
	rows_compare: LookupRow[]
	deltas: CandidateDelta[]
}

/**
 * The arguments of {@link runLookup}.
 */
export interface LookupArgs {
	source: LookupSource
	queries: string[]
	locale?: string

	/**
	 * Locales whose FST artifacts are probed separately and reported under `by_locale`.
	 * This applies only to FST sources.
	 */
	locales?: string[]
	country?: string
	limit?: number
	config?: EngineConfig

	/**
	 * A second candidate database that receives the same queries.
	 *
	 * The result then reports row and ranking deltas for each query.
	 * This applies only to candidate lookups.
	 */
	compareCandidateDB?: string
}

/**
 * Runs the queries against one lookup source and closes every artifact it opened.
 *
 * A source whose artifact is missing returns no rows and an `unavailable_reason`,
 * so it cannot be mistaken for a miss on every query.
 */
export async function runLookup(
	registry: EngineRegistryLike,
	args: LookupArgs
): Promise<LookupResult | CandidateCompareResult> {
	const { source, queries } = args
	const config = args.config ?? {}
	const dataRoot = config.data_root ?? dataRootPath()

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
			return await withArtifact(source, await resolveCandidateDB(config, dataRoot), async (db, path) => {
				const importancePath = wofDatabaseRoot(dataRoot)("admin-global-priority-importance.db").toString()

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
						const comparePath = await resolveCandidateDB({ ...config, candidate_db: args.compareCandidateDB }, dataRoot)
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
			return await withArtifact(source, poiDatabaseRoot(dataRoot)("poi.db").toString(), (db, path) => ({
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
			throw new Error(`mwdev_lookup: unknown source ${stringifyJSON(source)}.`)
		}
	}
}

/**
 * Resolves the candidate database path.
 *
 * An explicit path that does not resolve is returned as given, so opening it reports why it is unavailable.
 */
async function resolveCandidateDB(config: EngineConfig, dataRoot: PathBuilderLike): Promise<string | undefined> {
	const resolved = await resolveCandidateDBPath(config.candidate_db, dataRoot)

	if (resolved || !config.candidate_db || config.candidate_db === "none") return resolved

	return config.candidate_db
}

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

const UNAVAILABLE_NOTE =
	"No row is reported, because a source whose artifact is missing answers 'no' to everything — which would read as " +
	"absence for every query rather than as an unavailable source."

async function runWOFLookup(args: LookupArgs, dataRoot: PathBuilderLike): Promise<LookupResult> {
	const paths = resolveWOFDatabasePaths(args.config?.resolve_db, dataRoot)
	const extracts: WOFExtract<WOFDatabase>[] = []
	const skipped: string[] = []

	for (const path of paths) {
		const opened = await openSealedArtifact<WOFDatabase>(path)

		if ("unavailable" in opened) {
			skipped.push(opened.unavailable)

			continue
		}

		extracts.push({ name: basename(path), db: opened.db })
	}

	if (!extracts.length) {
		return {
			source: LookupSource.WOF,
			rows: [],
			unavailable_reason: `No WOF extract could be opened. ${skipped.join(" ")}`,
			notes: [UNAVAILABLE_NOTE],
		}
	}

	try {
		const rows = lookupWOF(extracts, args.queries, {
			...(args.country ? { country: args.country } : {}),
			...(args.limit ? { limit: args.limit } : {}),
		})

		const idNote = syntheticIDNote(
			rows.flatMap((row) => (row.entries ?? []).map((e) => Number((e as { id: number }).id)))
		)

		return {
			source: LookupSource.WOF,
			provenance: { artifact: extracts.map((extract) => extract.name).join(", ") },
			rows,
			notes: [
				`Probed ${extracts.length} of ${paths.length} extract(s) in the runtime's own set.`,
				...(skipped.length ? [`Not opened: ${skipped.join(" ")}`] : []),
				"Read this against `candidate`: a string this source holds and the candidate table misses is a BUILD gap.",
				"Deprecated and not-current records are named in the row note and kept OUT of `entries` — the FTS5 content " +
					"the resolver reads is built with that filter already applied, so they exist in the extract and reach " +
					"nothing downstream.",
				...(idNote ? [idNote] : []),
			],
		}
	} finally {
		for (const extract of extracts) {
			extract.db.destroy()
		}
	}
}

async function runPostcodeLookup(args: LookupArgs): Promise<LookupResult> {
	const locale = args.locale ?? args.config?.locale ?? "en-us"
	let resolved: Awaited<ReturnType<typeof resolveWeights>>

	try {
		resolved = await resolveWeights({ locale })
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
				`${resolved.packageDir ?? resolved.source} ships no postcode anchor artifact (neither postcode-<cc>.bin nor ` +
				"anchor-lookup.json). The anchor channel runs OFF for this locale — an absent artifact, not an empty one.",
			notes: [UNAVAILABLE_NOTE],
		}
	}

	const spanMode = (await readRequiredChannels(resolved.modelCardPath))?.anchor?.span_mode ?? "alnum-run"
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
		...(path ? { artifact: resolvePath(path) } : {}),
		engine_id: engine.engineID,
		rows:
			args.source === LookupSource.FST
				? lookupFST(loaded.fst, normalizeTokens, args.queries)
				: lookupStreetMorphology(loaded.fst, args.queries),
	}
}
