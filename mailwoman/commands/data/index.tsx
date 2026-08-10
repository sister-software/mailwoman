/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman data [--list]` — the landing page for the `data` command group (#1577).
 *
 *   Pastel turns a directory's `index.tsx` into the group command itself (`read-commands.ts`:
 *   `subCommands.get("index")` is renamed to the directory name and keeps its siblings as
 *   subcommands), which is what gives the group a description, an option of its own, and something
 *   to print when invoked bare. Before this file, `mailwoman data` printed commander's stock
 *   "Usage / Options / Commands" block, which said nothing about WHY a reader would run any of it.
 *
 *   Output goes out through {@linkcode writeRawStdout} rather than Ink for the same reason
 *   `commands/geocode.tsx` does: an Ink frame at least as tall as the viewport makes Ink emit
 *   `\x1b[2J\x1b[3J\x1b[H`, and `3J` wipes the scrollback. The bundle table is 20+ lines, so on a
 *   short terminal it would.
 */

import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { Text } from "ink"
import { type CommandComponent, useCommandTask, writeRawStdout } from "mailwoman/cli-kit"
import { resolvePath } from "path-ts"
import zod from "zod"

import { BUNDLES, PUBLIC_BUCKET_BASE_URL } from "../../data-bundles.ts"
import { formatBytes } from "../../doctor/checks.ts"

/**
 * Shown at the top of `mailwoman data --help`. Commander reuses it in the root command listing, so it is held to two
 * sentences; the long-form "why" lives in {@link overview}, which is what a bare `mailwoman data` prints.
 */
export const description =
	"Fetch the reference databases geocoding needs — far too large to ship inside the npm package. `data --list` " +
	"shows what exists, `data pull <bundle>` downloads one, `data status` reports what is already on disk, and " +
	"`mailwoman doctor` names the one you are missing."

const OptionsSchema = zod.object({
	list: zod
		.boolean()
		.optional()
		.default(false)
		.describe("List every downloadable bundle: what it ships, how big it is, and where it lands on disk."),
})

export { OptionsSchema as options }

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
			`    ${files} file${files === 1 ? "" : "s"}, ~${formatBytes(totalBytes)} → ${destination}`,
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

const DataIndex: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const dataRoot = mailwomanDataRoot()

		return options.list ? listBundles(dataRoot) : overview(dataRoot)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status !== "done") return null

	return writeRawStdout(state.result)
}

export default DataIndex
