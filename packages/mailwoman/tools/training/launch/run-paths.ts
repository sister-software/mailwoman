/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module defines where a training run writes on the volume and which directories a fresh start may clear.
 *   It also maps config volume paths onto the host copy read by preflight audits.
 */

import { isPresent } from "@mailwoman/core/objects"

/**
 * A run's checkpoint directory and CSV log on the volume, and the directory that holds both.
 */
export interface RunPaths {
	outputDir: string
	csvLogPath: string
	runBase: string
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/"

/**
 * The checkpoint directory and CSV log a run writes.
 *
 * An `output_dir` under the mount is kept.
 * Any other lands at `<mount>/output/checkpoints`.
 *
 * The log follows `{output_dir}` when the config names it, and otherwise sits
 * beside the checkpoint directory.
 *
 * @throws When an `output_dir` under the mount contains a `.` or `..` segment.
 * Such a segment would
 * let it name a shared directory that {@link checkClearable} compares by its segments.
 */
export function resolveRunPaths(outputDir: string, csvLogPath: string, mount: string): RunPaths {
	const prefix = `${mount.replace(/\/+$/, "")}/`

	if (outputDir.startsWith(prefix)) {
		refuseDotSegments(outputDir)
	}

	const resolved = outputDir.startsWith(prefix) ? outputDir : `${prefix}output/checkpoints`
	const runBase = parentOf(resolved)

	const log = csvLogPath.includes("{output_dir}")
		? csvLogPath.replaceAll("{output_dir}", resolved)
		: `${runBase}/train_log.csv`

	return { outputDir: resolved, csvLogPath: log, runBase }
}

/**
 * Refuses a path with a `.` or `..` segment because those segments do not
 * identify the directory it resolves to.
 */
function refuseDotSegments(outputDir: string): void {
	if (outputDir.split("/").some((segment) => segment === "." || segment === "..")) {
		throw new Error(`refusing output_dir ${outputDir}: a "." or ".." segment hides the directory it names`)
	}
}

/**
 * The path depth of an older config's run directory, `models/checkpoints/<run>`.
 */
const LEGACY_RUN_DEPTH = 3

/**
 * The volume's top-level directories that hold shared assets rather than one run.
 *
 * `corpus-python` is the directory written by the retired code upload.
 * The volume still contains it.
 */
const SHARED_ROOTS = new Set(["corpus", "corpus-python", "models", "audits", "gazetteer", "eval", "launch"])

/**
 * Refuses an `output_dir` a fresh start must not clear: one outside the mount, or a shared root inside it.
 *
 * An older config's `<mount>/models/checkpoints/<run>` is one run's directory and stays clearable.
 *
 * @throws Naming the directory and the reason.
 */
export function checkClearable(outputDir: string, mount: string): void {
	refuseDotSegments(outputDir)

	const prefix = `${mount.replace(/\/+$/, "")}/`

	if (!outputDir.startsWith(prefix)) throw new Error(`refusing to clear ${outputDir}: it is not inside ${mount}`)

	const parts = outputDir.slice(prefix.length).split("/").filter(isPresent)
	const [first] = parts

	if (!first) throw new Error(`refusing to clear ${outputDir}: it is the mount itself`)

	if (first === "models" && parts.length >= LEGACY_RUN_DEPTH && parts[1] === "checkpoints") return

	if (SHARED_ROOTS.has(first)) {
		throw new Error(`refusing to clear ${outputDir}: ${prefix}${first} holds shared assets, not one run`)
	}
}

/**
 * A config's text with every volume path re-rooted at the host mirror,
 * for the audits that read the corpus on the host.
 */
export function rerootConfigText(text: string, mount: string, hostRoot: string): string {
	const prefix = `${mount.replace(/\/+$/, "")}/`

	return text.replaceAll(prefix, `${hostRoot.replace(/\/+$/, "")}/`)
}
