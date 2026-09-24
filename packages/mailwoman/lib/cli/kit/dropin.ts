/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared helpers for the `mailwoman-libpostal`, `mailwoman-nominatim`, and
 *   `mailwoman-photon` CLIs. They handle command dispatch, classifier and gazetteer
 *   setup, and startup output.
 *
 *   This module is in `mailwoman` because it uses the neural classifier and resolver
 *   backend. It is separate from `cli-kit/index.ts`, which loads Ink and React for
 *   interactive commands. The drop-in CLIs need no UI, so they use this module's
 *   standalone subpath instead.
 */

import { printOpenAPIDocument } from "@mailwoman/api-kit"
import { pathExists } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { failScript } from "@mailwoman/core/scripting/utils"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import { printLicenseNotice, resolveEngineStamp, type ResolvedEngineStamp } from "#cli/kit/engine-stamp"
import { type FreshnessArtifact, type FreshnessReport, readFreshness } from "#freshness"
import { buildNoGazetteerMessage, existingWOFDatabasePaths, resolveCandidateDBPath } from "#resolver-backend"
/**
 * The documentation page linked by missing-gazetteer messages.
 */
const GAZETTEER_DOCS_PATH = "/docs/developers/get-started/ten-minute-trial"

/**
 * Print an error and exit with a non-zero status.
 */
function fail(message: string): never {
	return failScript(message)
}

/**
 * Parse OpenAPI flags and validate the requested document flavor.
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
 * Create a command that prints or writes the drop-in's OpenAPI document.
 */
export function openAPICommand<Engine>(
	binaryName: string,
	createApp: (engine: Engine) => Parameters<typeof printOpenAPIDocument>[0],
	docInfo: Parameters<typeof printOpenAPIDocument>[1],
	stubEngine: Engine
): () => Promise<void> {
	return async () => {
		await printOpenAPIDocument(createApp(stubEngine), docInfo, parseOpenAPIFlags(binaryName))
	}
}

/**
 * Load the en-US classifier, or exit with a clear error.
 */
export async function loadClassifierOrExit(): Promise<NeuralAddressClassifier> {
	try {
		return await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	} catch (error) {
		return fail(`✗ ${error instanceof Error ? error.message : String(error)}`)
	}
}

/**
 * Database paths used by a geocoding drop-in.
 */
export interface GazetteerPaths {
	/**
	 * The candidate gazetteer (worldwide resolution), when one was found.
	 */
	candidateDB: string | undefined
	/**
	 * The WOF admin FTS databases that exist on disk.
	 */
	wofPaths: string[]
	/**
	 * The first database — the admin DB the reverse geocoder opens.
	 *
	 * `undefined` when there are no databases.
	 */
	adminDBPath: string | undefined
}

/**
 * Find gazetteer databases, or exit with a clear error if they are unavailable.
 */
export async function resolveGazetteerOrExit(candidateDBFlag: string | undefined): Promise<GazetteerPaths> {
	if (candidateDBFlag && !(await pathExists(candidateDBFlag))) {
		fail(`✗ --candidate-db not found: ${candidateDBFlag}`)
	}

	const wofPaths = await existingWOFDatabasePaths()

	// Candidate gazetteer = worldwide resolution (population-first ranking + global coverage +
	// the FTS5-trigram typo fallback). --candidate-db, else $MAILWOMAN_CANDIDATE_DB,
	// else the `<data-root>/db/wof/candidate.db` convention path.
	// Absent → the admin FTS databases.
	const candidateDB = await resolveCandidateDBPath(candidateDBFlag)

	if (!candidateDB && !wofPaths.length) {
		fail(buildNoGazetteerMessage({ dataRoot: mailwomanDataRoot(), docsPath: GAZETTEER_DOCS_PATH }))
	}

	return { adminDBPath: wofPaths[0], candidateDB, wofPaths }
}

/**
 * Format the CORS line in the startup banner.
 */
export function corsBannerLine(cors: boolean): string {
	return `  cors: ${cors ? "enabled (Access-Control-Allow-Origin: *)" : "disabled (--no-cors)"}`
}

/**
 * Format the gazetteer and resolver lines in the startup banner.
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
 * Read freshness data for the databases this process uses.
 *
 * Call at startup so the report describes the files opened by the server, even if paths change later.
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
			artifacts.push({ name: `gazetteer-database-${index}`, path })
		}
	}

	if (adminDBPath && !artifacts.some((artifact) => artifact.path === adminDBPath)) {
		artifacts.push({ name: "reverse-admin", path: adminDBPath })
	}

	return await readFreshness(artifacts)
}

/**
 * Configuration for a drop-in CLI.
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
	/**
	 * Boot the listener and resolve once it is bound.
	 *
	 * The engine stamp is the process's, resolved here so every drop-in carries it the same way
	 * and the license notice prints after the listening banner.
	 */
	serve: (engineStamp: ResolvedEngineStamp) => Promise<void>
	openapi: () => void | Promise<void>
}

/**
 * Run the requested command, or print usage if none was given.
 */
export async function runDropInCLI({ binaryName, openapi, serve, usage }: DropInCLI): Promise<void> {
	const command = parseArguments({
		// The subcommand is the first positional, and the rest are parsed by the subcommand's own spec.
		strict: false,
		allowPositionals: true,
	}).positionals[0]

	switch (command) {
		case "serve": {
			const engineStamp = await resolveEngineStamp()

			await serve(engineStamp)

			printLicenseNotice(engineStamp)

			break
		}
		case "openapi":
			await openapi()
			break
		default:
			console.error([`Usage: ${binaryName} <command>`, ...usage].join("\n"))
			process.exit(command ? 1 : 0)
	}
}
