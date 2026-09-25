

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import type {
	PlaceLookup,
	WOFCandidateTableLookup,
	WOFPostalCityAliasLookup,
	WOFSQLitePlaceLookup,
} from "@mailwoman/resolver-wof-sqlite"
import { readCapitalPoints } from "@mailwoman/resolver-wof-sqlite/capital-schema"
import { CapitalIndex, type CapitalPoint } from "@mailwoman/resolver-wof-sqlite/capitals"
import { wofDatabaseRoot, wofExtractPaths } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder, PathBuilderLike } from "path-ts"

import { $public } from "#env"


export function conventionCandidateDBPath(dataRoot: PathBuilderLike = dataRootPath()): string {
	return wofDatabaseRoot(dataRoot)("candidate.db").toString()
}


export async function resolveCandidateDBPath(
	explicit?: string,
	dataRoot: PathBuilderLike = dataRootPath()
): Promise<string | undefined> {
	const pinned = explicit ?? $public.MAILWOMAN_CANDIDATE_DB

	if (pinned === "none") return undefined

	if (pinned) return (await pathExists(pinned)) ? pinned : undefined

	const convention = conventionCandidateDBPath(dataRoot)

	return (await pathExists(convention)) ? convention : undefined
}


export function resolveWOFDatabasePaths(explicit?: string, dataRoot: PathBuilderLike = dataRootPath()): string[] {
	const raw = explicit ?? $public.MAILWOMAN_WOF_DB

	if (raw) {
		return extractDelimited(raw)
	}

	return [...wofExtractPaths(dataRoot)]
}


export async function resolvePostalCityAliasDBPath(explicit?: string): Promise<string | undefined> {
	const p = explicit ?? $public.MAILWOMAN_POSTAL_CITY_ALIAS_DB

	return p && (await pathExists(p)) ? p : undefined
}


export function buildNoGazetteerMessage(opts: { dataRoot: PathBuilder; docsPath: string }): string {
	
	
	const conventionCandidate = conventionCandidateDBPath(opts.dataRoot)

	const afterPull = [`  The file lands at ${conventionCandidate} and is auto-detected there — just re-run.`]

	return [
		"✗ no gazetteer data found — the endpoint needs a resolver database to answer queries.",
		"",
		"  Fastest path (worldwide resolution, population-first ranking, ~1.65 GB):",
		"    mailwoman data pull candidate",
		"",
		...afterPull,
		"",
		"  Or point at your own:",
		"    --candidate-db <path> / $MAILWOMAN_CANDIDATE_DB   (candidate gazetteer)",
		"    $MAILWOMAN_WOF_DB / <data-root>/db/wof/*.db       (admin WOF distribution)",
		"",
		`  Docs: https://mailwoman.ai${opts.docsPath}`,
	].join("\n")
}


interface ResolverLookupModule {
	WOFSQLitePlaceLookup: typeof WOFSQLitePlaceLookup
	WOFCandidateTableLookup: typeof WOFCandidateTableLookup
	WOFPostalCityAliasLookup: typeof WOFPostalCityAliasLookup
}


export async function createResolverBackend(
	mod: ResolverLookupModule,
	opts: {
		candidateDB?: string
		dataRoot?: PathBuilderLike
		wofPaths: string | string[]
		postalCityAliasDB?: string
		
		variantAliasExemption?: boolean
	}
): Promise<PlaceLookup> {
	const candidate = await resolveCandidateDBPath(opts.candidateDB, opts.dataRoot)

	if (candidate) {
		console.error(`[resolver] candidate-table backend (demo-parity, population-first): ${candidate}`)

		return new mod.WOFCandidateTableLookup({
			databasePath: candidate,
			...(opts.variantAliasExemption !== false ? { variantAliasExemption: true } : {}),
		})
	}

	const wp = opts.wofPaths
	const aliasDB = await resolvePostalCityAliasDBPath(opts.postalCityAliasDB)
	const postalCityAliases = aliasDB ? new mod.WOFPostalCityAliasLookup({ databasePath: aliasDB }) : undefined

	if (postalCityAliases) {
		console.error(`[resolver] postal-city alias scorer enabled (#475): ${aliasDB}`)
	}

	return new mod.WOFSQLitePlaceLookup({
		databasePath: Array.isArray(wp) && wp.length === 1 ? wp[0]! : wp,
		postalCityAliases,
	})
}


export function conventionCapitalsPath(): PathBuilder {
	return repoRootPathBuilder("data", "gazetteer", "capitals-v1.json")
}


export async function loadCapitalIndex(opts: {
	candidateDB?: PathBuilderLike
	path?: PathBuilderLike
	missing?: "throw" | "degrade"
}): Promise<CapitalIndex | undefined> {
	if (opts.candidateDB && (await pathExists(opts.candidateDB))) {
		using db = new DatabaseClient<WOFDatabase>(opts.candidateDB, { readOnly: true })

		const points = readCapitalPoints(db)

		
		
		if (points) {
			console.error(`[resolver] capital reference: ${points.length} rows from the candidate artifact`)

			return new CapitalIndex(points)
		}
	}

	const path = opts.path ?? conventionCapitalsPath()

	if (!(await pathExists(path))) {
		if (opts.missing === "degrade") {
			console.error(
				`[resolver] capital reference: none in the candidate artifact or at ${path} — capital promotion degrades to a no-op`
			)

			return undefined
		}

		throw new Error(
			`capital_tier is on, but neither the candidate artifact nor ${path} carries the capitals reference — ` +
				"pull a candidate.db that includes the `capital` table, or build the repo file with `mailwoman gazetteer capitals`"
		)
	}

	const parsed = await readLocalJSONFile<{ version?: number; entries?: CapitalPoint[] }>(path)

	if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
		throw new Error(`${path} is not a v1 capitals reference — rebuild with \`mailwoman gazetteer capitals\``)
	}

	
	
	
	if (parsed.entries.length && !Array.isArray(parsed.entries[0]?.k)) {
		throw new Error(`${path} predates the name-set field — rebuild with \`mailwoman gazetteer capitals\``)
	}

	return new CapitalIndex(parsed.entries)
}


export async function existingWOFDatabasePaths(explicit?: readonly string[]): Promise<string[]> {
	const candidates = explicit ?? wofExtractPaths()
	const existing: string[] = []

	for (const databasePath of candidates) {
		if (await pathExists(databasePath)) {
			existing.push(databasePath)
		}
	}

	return existing
}


export async function resolvePOIResolverPaths(options: {
	candidateDB?: string
	resolveDB?: string
}): Promise<{ candidateDB: string | undefined; wofPaths: string[] }> {
	const candidateDB = await resolveCandidateDBPath(options.candidateDB)

	if (candidateDB) return { candidateDB, wofPaths: [] }

	const explicit = options.resolveDB ? extractDelimited(options.resolveDB) : undefined

	return { candidateDB, wofPaths: await existingWOFDatabasePaths(explicit) }
}


export async function requireWOFPath(explicit?: string): Promise<string> {
	const resolved = explicit ?? $public.MAILWOMAN_WOF_DB

	if (!resolved) {
		throw new Error(
			"No WOF database configured. Pass --resolve-db or set $MAILWOMAN_WOF_DB (build one with `mailwoman gazetteer build fts`)."
		)
	}

	return resolved
}
