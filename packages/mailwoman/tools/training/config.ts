/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Training configs as the TypeScript training tools read them: loaded through the config resolver, with
 *   `section.key=value` overrides and the volume paths re-rooted to their host copies.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { isFile } from "@mailwoman/core/fs/readers/stat"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { gitSync } from "@mailwoman/core/git"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { isPlainObject } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/paths"
import { readTrainingConfig, typedTrainingConfig } from "@mailwoman/corpus/training/config/load"
import { parsePythonYAML, type PythonValue } from "@mailwoman/corpus/training/config/python-yaml"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import { relative } from "path-ts"
import { TextSpliterator } from "spliterator"

import { hostPath } from "./sampler.ts"

/**
 * Every `data` field naming a file or directory the encoding reads.
 */
export const INPUT_FIELDS = [
	"tokenizer_dir",
	"char_vocab_path",
	"anchor_lookup_path",
	"gazetteer_lexicon_path",
	"country_lexicon_path",
	"street_type_lexicon_path",
	"locality_surface_lexicon_path",
	"affix_relabel_lexicon_path",
] as const

/**
 * The committed training config named `name` under `packages/corpus/data/training-configs`,
 * or that directory when `name` is omitted.
 */
export function trainingConfigPath(name = ""): string {
	return repoRootPath("packages", "corpus", "data", "training-configs", ...(name ? [name] : []))
}

/**
 * Loads and types the config at `path`, as `load_config` loads it.
 */
export async function loadTrainingConfig(path: string): Promise<TrainingConfig> {
	return typedTrainingConfig(await readTrainingConfig(path), path)
}

function plain(value: PythonValue): unknown {
	if (typeof value === "bigint") return Number(value)

	if (Array.isArray(value)) return value.map(plain)

	if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), plain(v)]))

	return value
}

/**
 * Applies `section.key=value` overrides, each value parsed as YAML so `false`,
 * `16` and `null` take their types.
 *
 * @throws When an override names no existing field.
 */
export function applyOverrides(config: TrainingConfig, overrides: readonly string[]): TrainingConfig {
	for (const override of overrides) {
		const separator = override.indexOf("=")
		const key = separator === -1 ? "" : override.slice(0, separator)
		const [section = "", attribute = ""] = key.split(".", 2)
		const sections: Record<string, unknown> = config
		const target = sections[section]

		if (separator === -1 || !attribute || !isPlainObject(target) || !Object.hasOwn(target, attribute)) {
			throw new Error(`--set expects section.key=value naming an existing field, got ${stringifyJSON(override)}`)
		}

		target[attribute] = plain(parsePythonYAML(override.slice(separator + 1), override))
	}

	return config
}

/**
 * Rewrites the corpus directory and every input path under the volume mount to its
 * host copy, as the encoder-parity audit's `prepare_config` does.
 */
export function rerootToHost(config: TrainingConfig): TrainingConfig {
	const data: Record<string, unknown> = config.data

	data.corpus_dir = hostPath(config.data.corpus_dir)

	for (const field of INPUT_FIELDS) {
		const value = data[field]

		if (typeof value === "string" && value) {
			data[field] = hostPath(value)
		}
	}

	return config
}

/**
 * The config a record was captured with: its recorded path, or the committed config of the same name.
 *
 * When the committed file's SHA-256 is not the recorded one, the revision of it
 * with the recorded bytes is read from the file's git history, across its renames,
 * and written once under `<data root>/cache/recorded-configs/`.
 *
 * @throws When no revision of the file has the recorded SHA-256.
 */
export async function recordedConfigPath(recorded: { path: string; sha256: string }): Promise<string> {
	const path = (await isFile(recorded.path))
		? recorded.path
		: trainingConfigPath(recorded.path.split("/").at(-1) ?? recorded.path)

	const digest = await sha256File(path)

	if (digest === recorded.sha256) return path

	const cached = dataRootPath("cache", "recorded-configs", `${recorded.sha256}.yaml`).toString()

	if (await isFile(cached)) return cached

	const relativeToRoot = relative(repoRootPath(), path).toString()
	// One file's history: a revision line, then the path that revision held the file at.
	const lines = TextSpliterator.from(gitSync(["log", "--follow", "--format=%H", "--name-only", "--", relativeToRoot]))
	let revision: string | null = null

	for (const line of lines) {
		if (/^[0-9a-f]{40}$/.test(line)) {
			revision = line

			continue
		}

		if (!line || !revision) continue

		const text = gitSync(["show", `${revision}:${line}`], { trim: false })

		if (sha256Hex(text) === recorded.sha256) {
			await writeLocalTextFile(text, cached)

			return cached
		}
	}

	throw new Error(`${path} has sha256 ${digest}, and no revision of it has the recorded ${recorded.sha256}`)
}
