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
 *   WHY IT IS NOT IN `cli-kit/index.ts`: that barrel is the Pastel/Ink toolkit for
 *   `mailwoman/commands/*` and imports `ink` + `react`. The drop-ins are plain `parseArgs` scripts
 *   that render no UI, and `npx @mailwoman/libpostal serve` should not pay for a TUI runtime to
 *   start an HTTP server. Hence a standalone module with its own `mailwoman/cli-kit/dropin`
 *   subpath, deliberately NOT re-exported through the barrel.
 */

import { existsSync } from "node:fs"
import { parseArgs } from "node:util"

import { NeuralAddressClassifier } from "@mailwoman/neural"

import {
	buildNoGazetteerMessage,
	mailwomanDataRoot,
	resolveCandidateDBPath,
	wofShardPaths,
} from "../resolver-backend.ts"

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
	const { values } = parseArgs({
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
	candidateDb: string | undefined
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
export function resolveGazetteerOrExit(candidateDBFlag: string | undefined): GazetteerPaths {
	if (candidateDBFlag && !existsSync(candidateDBFlag)) {
		fail(`✗ --candidate-db not found: ${candidateDBFlag}`)
	}

	const wofPaths = wofShardPaths().filter(existsSync)
	// Candidate gazetteer = worldwide resolution (population-first ranking + global coverage + the FTS5-trigram typo
	// fallback). --candidate-db, else $MAILWOMAN_CANDIDATE_DB, else the `<data-root>/wof/candidate.db` convention
	// path. Absent → the admin FTS shards.
	const candidateDb = resolveCandidateDBPath(candidateDBFlag)

	if (!candidateDb && !wofPaths.length) {
		fail(buildNoGazetteerMessage({ dataRoot: mailwomanDataRoot(), docsPath: GAZETTEER_DOCS_PATH }))
	}

	return { adminDBPath: wofPaths[0], candidateDb, wofPaths }
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
export function gazetteerBannerLines({ adminDBPath, candidateDb }: GazetteerPaths): string[] {
	return [
		`  wof: ${adminDBPath ?? "(none found — set MAILWOMAN_WOF_DB)"}`,
		candidateDb
			? `  resolver: candidate gazetteer (worldwide) — ${candidateDb}`
			: `  resolver: admin-only (US-optimized) — point --candidate-db / $MAILWOMAN_CANDIDATE_DB at a candidate gazetteer for worldwide`,
	]
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
	const command = parseArgs({ strict: false, allowPositionals: true }).positionals[0]

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
