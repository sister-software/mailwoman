/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every source id a training config addresses is one some adapter, recipe or carried overlay has emitted.
 *
 *   A `source_weights` key refers to a string stored inside a built corpus. This check reads the
 *   configs as data and asks whether each key is a string something in the checkout emits.
 *
 *   What it catches: a key in `source_weights`, `source_reps`, `augment_exclude_sources` or
 *   `required_corpus_receipts[].source` that no adapter declares as its `<NAME>_ADAPTER_ID`, no Python corpus builder
 *   declares as a `SOURCE` constant, and `RECIPE_SOURCES` records under neither its retired nor its current spelling.
 *   A sweep that renames a key in a config alone fails here, in either direction.
 *
 *   What it does not catch: a corpus on disk whose rows carry a different spelling from the config that targets it.
 *   The loader's `_apply_source_weights` and `missing_positive` checks refuse that at launch, and only they can, because
 *   the corpus is not in the checkout. It also does not catch a sweep that renames the table entry and the config
 *   together, a string inside a built parquet file, a manifest, a model card or a dated record, or a key that spells a
 *   real source the config never meant. A historical config keeps the spelling its corpus stores, so both spellings
 *   of a recipe source pass by design.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { knownOverlaySourceNames } from "@mailwoman/corpus/recipes/sources"
import { relative } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

const CONFIGS = "corpus-python/src/mailwoman_train/configs/*.yaml"
const ADAPTERS = "packages/corpus/lib/*adapter.ts"
const PYTHON_BUILDERS = "corpus-python/src/mailwoman_train/*.py"

/**
 * The config fields whose mapping keys are source ids.
 */
const KEYED_FIELDS = new Set(["source_weights", "source_reps"])

/**
 * The config field whose list items are source ids.
 */
const LISTED_FIELD = "augment_exclude_sources"

/**
 * The config field whose list entries carry a `source:` value that is a source id.
 */
const RECEIPTS_FIELD = "required_corpus_receipts"

/**
 * One source id a config addresses, with where it sits.
 */
export interface ConfigSourceName {
	name: string
	field: string
	line: number
}

/**
 * The source ids a training config addresses, read from the four fields that hold them.
 *
 * The configs are written by hand in a small subset of YAML: two-space indentation,
 * one entry per line, `#` comments, and no flow syntax.
 * This scanner reads that subset by indentation, which is the same reading
 * `packages/corpus/lib/tools/audit.ts` applies to `source_weights`.
 *
 * A field this scanner cannot follow is an absence rather than an error,
 * and the loader still reads the real value at launch.
 */
export function configSourceNames(text: string): ConfigSourceName[] {
	const names: ConfigSourceName[] = []
	let field: string | null = null
	let fieldIndent = -1
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one training config, a few hundred lines read whole and bounded
	const lines = text.split("\n")

	for (const [index, raw] of lines.entries()) {
		const line = index + 1

		if (/^[\t ]*(#|$)/.test(raw)) continue

		const indent = /^[\t ]*/.exec(raw)![0].length
		const opener = /^[\t ]*([A-Za-z_]+):\s*(#.*)?$/.exec(raw)

		if (field !== null && indent <= fieldIndent) {
			field = null
		}

		if (field === null) {
			if (opener && (KEYED_FIELDS.has(opener[1]!) || opener[1] === LISTED_FIELD || opener[1] === RECEIPTS_FIELD)) {
				field = opener[1]!
				fieldIndent = indent
			}

			continue
		}

		if (KEYED_FIELDS.has(field)) {
			const entry = /^[\t ]+([\w-]+):\s*[-\d.]/.exec(raw)

			if (entry) {
				names.push({ name: entry[1]!, field, line })
			}
		} else if (field === LISTED_FIELD) {
			const item = /^[\t ]+-\s*([\w-]+)\s*(#.*)?$/.exec(raw)

			if (item) {
				names.push({ name: item[1]!, field, line })
			}
		} else {
			const receiptSource = /^[\t ]+(?:-\s+)?source:\s*([\w-]+)\s*(#.*)?$/.exec(raw)

			if (receiptSource) {
				names.push({ name: receiptSource[1]!, field, line })
			}
		}
	}

	return names
}

const ADAPTER_ID = /_ADAPTER_ID\s*=\s*"([a-z0-9-]+)"/g
const PYTHON_SOURCE = /^[A-Z_]*SOURCE\s*=\s*"([a-z0-9-]+)"/gm

/**
 * The source ids the checkout declares: every adapter's id, every Python builder's
 * `SOURCE` constant, and every spelling in `RECIPE_SOURCES` and `CARRIED_SOURCES`.
 */
export async function declaredSourceNames(context: Parameters<RepoCheck["run"]>[0]): Promise<Set<string>> {
	const declared = new Set(knownOverlaySourceNames())
	const adapters = await trackedSourcePaths(context, { globs: [ADAPTERS], existingOnly: true })
	const builders = await trackedSourcePaths(context, { globs: [PYTHON_BUILDERS], existingOnly: true })

	for (const [paths, pattern] of [
		[adapters, ADAPTER_ID],
		[builders, PYTHON_SOURCE],
	] as const) {
		for (const path of paths) {
			const text = await readLocalTextFile(path)

			for (const match of text.matchAll(pattern)) {
				declared.add(match[1]!)
			}
		}
	}

	return declared
}

/**
 * The `wire-identifiers` check: one error per config key that no adapter,
 * recipe or carried overlay has emitted.
 */
export const wireIdentifiersCheck: RepoCheck = {
	id: "wire-identifiers",
	description:
		"Every source id a training config addresses is one an adapter, a recipe or a carried overlay emits, under a spelling the source table records.",
	async run(context) {
		const declared = await declaredSourceNames(context)
		const configs = await trackedSourcePaths(context, { globs: [CONFIGS], existingOnly: true })
		const diagnostics: Diagnostic[] = []

		for (const config of configs) {
			const file = relative(context.repoRoot, config)

			for (const { name, field, line } of configSourceNames(await readLocalTextFile(config))) {
				if (declared.has(name)) continue

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					file,
					line,
					message:
						`\`${name}\` in \`${field}\` is not a source any adapter, recipe or carried overlay emits. ` +
						"A source id is the string stored on every row of a built corpus, so a config keys on the spelling its corpus stores. " +
						"If a sweep renamed it, restore the stored spelling. If it is new, add it to RECIPE_SOURCES or CARRIED_SOURCES in packages/corpus/lib/recipes/sources.ts.",
				})
			}
		}

		return diagnostics
	},
}
