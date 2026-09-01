/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman data [--list]` — the landing page for the `data` command group (#1577).
 *
 *   A directory's `index.tsx` is the group command itself, giving the group a description, its own options, and a bare
 *   invocation handler.
 *
 *   Output goes out through {@linkcode writeRawStdout} rather than Ink for the same reason
 *   `commands/geocode.tsx` does: an Ink frame at least as tall as the viewport makes Ink emit
 *   `\x1b[2J\x1b[3J\x1b[H`, and `3J` wipes the scrollback. The bundle table is 20+ lines, so on a
 *   short terminal it would.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { resolvePath } from "path-ts"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	useCommandTask,
	writeRawStdout,
} from "#cli-kit"
import { BUNDLES, PUBLIC_BUCKET_BASE_URL } from "#data-bundles"

/**
 * Shown at the top of `mailwoman data --help`. Commander reuses it in the root command listing, so it is held to two
 * sentences; the long-form "why" lives in {@link overview}, which is what a bare `mailwoman data` prints.
 */
export const description =
	"Fetch the reference databases geocoding needs — far too large to ship inside the npm package. `data --list` " +
	"shows what exists, `data pull <bundle>` downloads one, `data status` reports what is already on disk, and " +
	"`mailwoman doctor` names the one you are missing."

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "data",
	description,
	options: {
		list: { type: "boolean", default: false, description: "List every downloadable bundle" },
	},
} as const satisfies CommandSpec

interface Options {
	list: boolean
}

/**
 * The per-bundle table `--list` prints: name, artifact count, total size, destination, and the one-line description
 * from the registry. Sizes are the surveyed `approxBytes` totals — the same numbers `data pull --dry-run` plans
 * against, so a reader can budget disk before starting a 41 GB download.
 */
function listBundles(dataRoot: string): string {
	const lines: string[] = ["Downloadable bundles (mailwoman data pull <bundle>)", ""]

	for (const bundle of Object.values(BUNDLES)) {
		const totalBytes = bundle.artifacts.reduce((sum, artifact) => sum + artifact.approxBytes, 0)
		const files = bundle.artifacts.length
		const destinations = new Set(bundle.artifacts.map((artifact) => resolvePath(dataRoot, artifact.localPath)))
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
		"  mailwoman data pull us --only nh one state's rooftop shards instead of the whole tier",
		"  mailwoman doctor                 which bundle the thing you just ran was missing"
	)

	return lines.join("\n")
}

/**
 * Bare `mailwoman data` — the explainer, then the shortest path to a working geocode. Keeps the reader from having to
 * guess that `pull` and `status` exist, or that `doctor` is the thing that names the gap.
 */
function overview(dataRoot: string): string {
	return [
		"mailwoman data — the reference databases geocoding needs",
		"",
		"The parser ships with its model, but coordinates do not come from the model. They come from data that is far",
		"too large to put in an npm package: the admin gazetteer that resolves place names, the POI layer that resolves",
		"businesses and landmarks, and the per-country rooftop and interpolation shards that put a house number on the",
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

const DataIndex: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { mailwomanDataRoot } = await import("@mailwoman/core/utils")

		const dataRoot = mailwomanDataRoot()

		return options.list ? listBundles(dataRoot) : overview(dataRoot)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return writeRawStdout(state.result)
}

export default DataIndex
