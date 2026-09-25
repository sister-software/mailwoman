/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Implements the `mailwoman data` command group and its bare invocation.
 *
 *   Output goes through {@linkcode writeRawStdout} instead of Ink. An Ink frame at least as tall as the
 *   viewport makes Ink clear the scrollback, and the bundle list can exceed a short terminal.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import type { PathBuilderLike } from "path-ts"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask, writeRawStdout } from "#cli-kit"
import { bundleArtifactPath, BUNDLES, PUBLIC_BUCKET_BASE_URL } from "#data/bundles"

/**
 * The group description shown by `mailwoman data --help` and in the root command listing.
 *
 * A bare `mailwoman data` prints the longer explanation from {@link overview}.
 */
export const description =
	"Fetch the reference databases geocoding needs — far too large to ship inside the npm package. `data --list` " +
	"shows what exists, `data pull <bundle>` downloads one, `data status` reports what is already on disk, and " +
	"`mailwoman doctor` reports the one you are missing."

/**
 * The command specification for `mailwoman data`.
 */
export const spec = {
	name: "data",
	description,
	options: {
		list: { type: "boolean", default: false, description: "List every downloadable bundle" },
	},
} as const satisfies CommandSpec

/**
 * Formats the bundle list printed by `--list`.
 *
 * Sizes are the registry's `approxBytes` totals, which `data pull --dry-run` also uses.
 */
function listBundles(dataRoot: PathBuilderLike): string {
	const lines: string[] = ["Downloadable bundles (mailwoman data pull <bundle>)", ""]

	for (const bundle of Object.values(BUNDLES)) {
		const totalBytes = bundle.artifacts.reduce((sum, artifact) => sum + artifact.approxBytes, 0)
		const files = bundle.artifacts.length
		const destinations = new Set(bundle.artifacts.map((artifact) => bundleArtifactPath(dataRoot, artifact)))
		const destination = destinations.size === 1 ? [...destinations][0]! : `${dataRoot} (${destinations.size} paths)`

		lines.push(
			`  ${bundle.name}`,
			`    ${bundle.description}`,
			`    ${files} file${files === 1 ? "" : "s"}, ~${ByteFormatter.formatSI(totalBytes)} → ${destination}`,
			""
		)
	}

	lines.push(
		`Source: ${PUBLIC_BUCKET_BASE_URL} (public, unauthenticated)`,
		`Data root: ${dataRoot}   (set $MAILWOMAN_DATA_ROOT to move it; pull/status take --data-root per run)`,
		"",
		"  mailwoman data status            what is already on disk",
		"  mailwoman data pull candidate    the smallest useful bundle — admin resolution everywhere",
		"  mailwoman data pull us --only nh one state's rooftop databases instead of the whole tier",
		"  mailwoman doctor                 which bundle the thing you just ran was missing"
	)

	return lines.join("\n")
}

/**
 * Formats the explanation and subcommand summary printed by a bare `mailwoman data`.
 */
function overview(dataRoot: PathBuilderLike): string {
	return [
		"mailwoman data — the reference databases geocoding needs",
		"",
		"The parser ships with its model, but coordinates do not come from the model. They come from data that is far",
		"too large to put in an npm package: the admin gazetteer that resolves place names, the POI layer that resolves",
		"businesses and landmarks, and the per-country rooftop and interpolation databases that put a house number on the",
		"right side of the street. Nothing here is required to PARSE an address — only to place one.",
		"",
		`Data root: ${dataRoot}`,
		"",
		"  mailwoman data --list            every bundle, its size, and where it lands",
		"  mailwoman data status            present / missing / stale, per artifact",
		"  mailwoman data pull <bundle>     download one (atomic: staged, verified, swapped into place)",
		"  mailwoman doctor                 what is missing and the one command that fixes it",
		"",
		`Known bundles: ${Object.keys(BUNDLES).join(", ")}`,
	].join("\n")
}

/**
 * Prints the bundle list with `--list`, or the overview otherwise.
 */
const DataIndex: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath } = await import("@mailwoman/core/data-root")

		const dataRoot = dataRootPath()

		return options.list ? listBundles(dataRoot) : overview(dataRoot)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return writeRawStdout(state.result)
}

export default DataIndex
