/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shared skeleton behind the drop-in CLIs — `mailwoman-libpostal`, `mailwoman-nominatim`,
 *   `mailwoman-photon`. All three are the same program with a different engine bolted in: dispatch
 *   `serve` / `openapi` off the first positional, boot the neural classifier with a friendly
 *   failure, (for the two geocoding drop-ins) locate a gazetteer with a friendly failure, then print
 *   a banner. Those pieces were copied between the three files, and the copies were being kept in
 *   sync BY HAND — nominatim/cli.ts said so in a comment ("same message shape as
 *   @mailwoman/photon's pre-flight (kept in lockstep)"). This module is the lockstep.
 *
 *   WHY IT LIVES HERE and not in `@mailwoman/api-kit`, which already owns `printOpenAPIDocument` and
 *   `serveNode` and would otherwise be the obvious home: the preflights need `@mailwoman/neural` and
 *   this package's `resolver-backend`, and api-kit is engine-agnostic by charter. Splitting the
 *   skeleton across two packages to preserve that charter costs more than the duplication did. All
 *   three drop-ins already declare `mailwoman` as a dependency, so landing the whole thing here adds
 *   no dependency to anyone.
 *
 *   WHY IT IS NOT IN `cli-kit/index.ts`: that barrel is the Ink toolkit for
 *   `mailwoman/commands/*` and imports `ink` + `react`. The drop-ins are plain `parseArgs` scripts
 *   that render no UI, and `npx @mailwoman/libpostal serve` should not pay for a TUI runtime to
 *   start an HTTP server. Hence a standalone module with its own `mailwoman/cli-kit/dropin`
 *   subpath, deliberately NOT re-exported through the barrel.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import { type FreshnessArtifact, type FreshnessReport, readFreshness } from "#freshness"
import { buildNoGazetteerMessage, mailwomanDataRoot, resolveCandidateDBPath, wofShardPaths } from "#resolver-backend"

/**
 * The docs page every drop-in's missing-gazetteer message points a stranger at (#1009). One constant so the three
 * messages cannot drift onto different pages when the docs move.
 */
const GAZETTEER_DOCS_PATH = "/docs/developers/get-started/ten-minute-trial"

/**
 * Print an error and exit non-zero. Typed `never` so callers get definite-assignment narrowing after the call.
 */
function fail(message: string): never {
	console.error(message)

	process.exit(1)
}

/**
 * Parse the `openapi` subcommand's flags, validating `--flavor`. Exits 1 with the binary's usage line on a bad flavor.
 *
 * Returns the shape `printOpenAPIDocument` takes, so a drop-in's `openapi` command is this call plus building its app
 * around a stub engine — which is what keeps the command pure route-table introspection that never boots a classifier
 * or opens a gazetteer.
 */
export function parseOpenAPIFlags(binaryName: string): { flavor?: string; out?: string } {
	const { values } = parseArguments({
		options: {
			flavor: { type: "string", default: "3.1" },
			out: { type: "string" },
		},
		allowPositionals: true,
	})

	if (values.flavor !== "3.1" && values.flavor !== "3.0") {
		console.error(`✗ --flavor must be "3.1" or "3.0" (got "${values.flavor}")`)

		fail(`Usage: ${binaryName} openapi [--flavor 3.1|3.0] [--out <path>]`)
	}

	return values
}

/**
 * Load the en-US neural classifier, failing FRIENDLY (#1009).
 *
 * `resolveWeights` (`neural/weights.ts`) already names the exact fix command; this guard only keeps that message from
 * being buried under an unhandled-rejection stack trace. Eager, so a missing-weights boot fails at startup rather than
 * on the first request.
 */
export async function loadClassifierOrExit(): Promise<NeuralAddressClassifier> {
	try {
		return await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	} catch (error) {
		return fail(`✗ ${error instanceof Error ? error.message : String(error)}`)
	}
}

/**
 * Where a geocoding drop-in reads its places from.
 */
export interface GazetteerPaths {
	/**
	 * The candidate gazetteer (worldwide resolution), when one was found.
	 */
	candidateDB: string | undefined
	/**
	 * The WOF admin FTS shards that exist on disk.
	 */
	wofPaths: string[]
	/**
	 * The first shard — the admin DB the reverse geocoder opens. `undefined` when there are no shards.
	 */
	adminDBPath: string | undefined
}

/**
 * Locate the gazetteer for a geocoding drop-in, with both of the #1009 friendly failures:
 *
 * - An EXPLICIT `--candidate-db` that does not exist errors loudly. It must never silently fall back to whatever ambient
 *   data-root file happens to be present — a typo'd path would otherwise serve the wrong gazetteer without a word.
 * - No candidate DB AND no shards prints the named-artifact message with the one command that fixes it, instead of
 *   letting the resolver throw its internal "resolveShards: at least one shard is required".
 */
export async function resolveGazetteerOrExit(candidateDBFlag: string | undefined): Promise<GazetteerPaths> {
	if (candidateDBFlag && !(await pathExists(candidateDBFlag))) {
		fail(`✗ --candidate-db not found: ${candidateDBFlag}`)
	}

	const wofPaths: string[] = []

	for (const shardPath of wofShardPaths()) {
		if (await pathExists(shardPath)) {
			wofPaths.push(shardPath)
		}
	}

	// Candidate gazetteer = worldwide resolution (population-first ranking + global coverage + the FTS5-trigram typo
	// fallback). --candidate-db, else $MAILWOMAN_CANDIDATE_DB, else the `<data-root>/wof/candidate.db` convention
	// path. Absent → the admin FTS shards.
	const candidateDB = await resolveCandidateDBPath(candidateDBFlag)

	if (!candidateDB && !wofPaths.length) {
		fail(buildNoGazetteerMessage({ dataRoot: mailwomanDataRoot(), docsPath: GAZETTEER_DOCS_PATH }))
	}

	return { adminDBPath: wofPaths[0], candidateDB, wofPaths }
}

/**
 * The `cors:` line of a drop-in's startup banner.
 */
export function corsBannerLine(cors: boolean): string {
	return `  cors: ${cors ? "enabled (Access-Control-Allow-Origin: *)" : "disabled (--no-cors)"}`
}

/**
 * The `wof:` + `resolver:` lines of a geocoding drop-in's startup banner — which gazetteer the process actually opened,
 * and (when it fell back to admin-only) the flag that widens it.
 */
export function gazetteerBannerLines({ adminDBPath, candidateDB }: GazetteerPaths): string[] {
	return [
		`  wof: ${adminDBPath ?? "(none found — set MAILWOMAN_WOF_DB)"}`,
		candidateDB
			? `  resolver: candidate gazetteer (worldwide) — ${candidateDB}`
			: `  resolver: admin-only (US-optimized) — point --candidate-db / $MAILWOMAN_CANDIDATE_DB at a candidate gazetteer for worldwide`,
	]
}

/**
 * The provenance of the gazetteer artifacts a drop-in actually OPENED, for its `/status` surface (#997).
 *
 * The set is derived from the same {@link GazetteerPaths} the banner prints, and it follows the backend selection rather
 * than the search order: `createResolverBackend` opens the candidate gazetteer ALONE when one is resolved, so listing
 * the admin shards beside it would name databases this process never read. The reverse geocoder is the exception — it
 * opens the first admin shard whatever the forward path chose, which can be a different build, so it is reported
 * separately unless it is already in the list.
 *
 * Call once at boot: a server holds its handles for its whole life, so the artifact it serves from is the one it opened
 * at start, whatever a later symlink swap points at.
 */
export async function gazetteerFreshness({
	adminDBPath,
	candidateDB,
	wofPaths,
}: GazetteerPaths): Promise<FreshnessReport> {
	const artifacts: FreshnessArtifact[] = []

	if (candidateDB) {
		artifacts.push({ name: "gazetteer", path: candidateDB })
	} else {
		for (const [index, path] of wofPaths.entries()) {
			artifacts.push({ name: `gazetteer-shard-${index}`, path })
		}
	}

	if (adminDBPath && !artifacts.some((artifact) => artifact.path === adminDBPath)) {
		artifacts.push({ name: "reverse-admin", path: adminDBPath })
	}

	return await readFreshness(artifacts)
}

/**
 * A drop-in CLI's two subcommands.
 */
export interface DropInCLI {
	/**
	 * The binary name, for the usage message (e.g. `mailwoman-photon`).
	 */
	binaryName: string
	/**
	 * Usage lines for the subcommands, without the leading `Usage:` header.
	 */
	usage: string[]
	serve: () => Promise<void>
	openapi: () => void
}

/**
 * Dispatch a drop-in CLI's subcommand off the first positional.
 *
 * `strict: false` because the per-command parsers own their own flags — this pass only reads the positional. An unknown
 * command exits 1; a bare invocation prints usage and exits 0.
 */
export async function runDropInCLI({ binaryName, openapi, serve, usage }: DropInCLI): Promise<void> {
	const command = parseArguments({ strict: false, allowPositionals: true }).positionals[0]

	switch (command) {
		case "serve":
			await serve()
			break
		case "openapi":
			openapi()
			break
		default:
			console.error([`Usage: ${binaryName} <command>`, ...usage].join("\n"))
			process.exit(command ? 1 : 0)
	}
}
