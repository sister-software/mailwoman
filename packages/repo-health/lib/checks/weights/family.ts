/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every shipping weights package belongs to exactly one declared family, and every family's graph package ships
 *   the artifacts its encoder needs.
 *
 *   `@mailwoman/neural`'s `FAMILIES` declares which model graphs exist and which locales each serves, and the
 *   `neural-weights-*` workspaces are the artifacts that claim must describe; the two can disagree in four ways, each
 *   silent at compile time because a package manifest is data — a locale package named by no family, a locale named by
 *   two families, a family whose graph package ships no `model.onnx`, and a family whose graph package ships the wrong
 *   vocabulary artifact.
 *
 *   The check reads manifests rather than the filesystem, because `model.onnx` and `tokenizer.model` are not in git
 *   and the `files` array is where a package states what it publishes.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { FAMILIES, FAMILY_VOCABULARY_ARTIFACT } from "@mailwoman/neural/weights-families"
import { relative, resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

/**
 * The fields this check reads from a weights package's manifest.
 */
interface WeightsManifest {
	name?: string
	private?: boolean
	files?: string[]
	mailwoman?: { baseWeights?: string; encoder?: string }
}

/**
 * The locale a `neural-weights-*` directory name carries, such as `en-gb` from `neural-weights-en-gb`, and the
 * same string `resolveWeights` takes as its locale, which is why the family registry keys on it.
 */
function localeForDirectory(directory: string): string {
	return directory.replace(/^neural-weights-/u, "")
}

/**
 * A package is a family's graph when its `files` array declares `model.onnx`; an overlay declares no graph and
 * names its base through `mailwoman.baseWeights`.
 */
function declaresGraph(manifest: WeightsManifest): boolean {
	return (manifest.files ?? []).includes("model.onnx")
}

/**
 * Reads `@mailwoman/neural`'s `FAMILIES` against the tracked `neural-weights-*` manifests and reports every
 * place the declared topology and the published artifacts disagree.
 */
export const weightsFamilyCheck: RepoCheck = {
	id: "weights-family",
	description:
		"Every shipping weights package maps to one family, and every family's graph package declares its artifacts",

	async run({ repoRoot, trackedFiles }): Promise<Diagnostic[]> {
		const diagnostics: Diagnostic[] = []

		const manifestPaths = trackedFiles.filter((file) => /^packages\/neural-weights-[^/]+\/package\.json$/u.test(file))

		const manifests = new Map<string, WeightsManifest>()

		for (const file of manifestPaths) {
			const directory = file.split("/")[1] as string

			manifests.set(
				localeForDirectory(directory),
				await readLocalJSONFile<WeightsManifest>(resolvePath(repoRoot, file))
			)
		}

		// A locale claimed twice makes the router's family order decide the answer, so report the pair rather than the
		// second one alone, since either declaration could be wrong.
		const claimedBy = new Map<string, string[]>()

		for (const family of FAMILIES) {
			for (const locale of family.locales) {
				claimedBy.set(locale, [...(claimedBy.get(locale) ?? []), family.family])
			}
		}

		for (const [locale, families] of claimedBy) {
			if (families.length > 1) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`Locale \`${locale}\` is claimed by ${families.length} families (${families.join(", ")}). ` +
						"A locale decodes through one graph. Remove it from every family but the one that owns it.",
					file: "packages/neural/lib/weights/families.ts",
				})
			}
		}

		// A language claimed twice makes `familyForLocale`'s language fallback answer whichever family `FAMILIES` lists
		// first, the same defect as a locale claimed twice one level up.
		const languageOwners = new Map<string, string[]>()

		for (const family of FAMILIES) {
			for (const language of family.languages ?? []) {
				languageOwners.set(language, [...(languageOwners.get(language) ?? []), family.family])
			}
		}

		for (const [language, families] of languageOwners) {
			if (families.length > 1) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`Language \`${language}\` is claimed by ${families.length} families (${families.join(", ")}), so ` +
						"every unpackaged locale in it resolves to whichever is declared first.",
					file: "packages/neural/lib/weights/families.ts",
				})
			}
		}

		// A language that also names another family's packaged locale makes the two paths through `familyForLocale`
		// disagree, since the packaged lookup wins and the language list covers no locale.
		for (const [language, [owner]] of languageOwners) {
			const packagedElsewhere = FAMILIES.filter(
				(entry) => entry.family !== owner && entry.locales.some((locale) => locale.split("-")[0] === language)
			)

			for (const entry of packagedElsewhere) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`Family \`${owner}\` claims language \`${language}\`, and \`${entry.family}\` packages a locale in ` +
						"that language. The packaged lookup wins, so the language claim would cover nothing.",
					file: "packages/neural/lib/weights/families.ts",
				})
			}
		}

		// Two scripts routing to two families would make `familyForSegment`'s iteration order load-bearing.
		const scriptOwners = new Map<string, string[]>()

		for (const family of FAMILIES) {
			for (const script of family.routingScripts ?? []) {
				scriptOwners.set(script, [...(scriptOwners.get(script) ?? []), family.family])
			}
		}

		for (const [script, families] of scriptOwners) {
			if (families.length > 1) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`Script \`${script}\` routes to ${families.length} families (${families.join(", ")}), so the ` +
						"router's declaration order would decide which graph reads it.",
					file: "packages/neural/lib/weights/families.ts",
				})
			}
		}

		for (const family of FAMILIES) {
			const manifest = manifests.get(family.family)

			if (!manifest) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`Family \`${family.family}\` names graph package \`${family.graphPackage}\`, and no ` +
						`\`packages/neural-weights-${family.family}/package.json\` is tracked.`,
					file: "packages/neural/lib/weights/families.ts",
				})

				continue
			}

			if (manifest.name !== family.graphPackage) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`Family \`${family.family}\` names \`${family.graphPackage}\`, and that directory's manifest ` +
						`declares \`${manifest.name}\`.`,
					file: `packages/neural-weights-${family.family}/package.json`,
				})
			}

			if (!declaresGraph(manifest)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`Family \`${family.family}\`'s graph package declares no \`model.onnx\` in \`files\`. A family ` +
						"is a graph; a package with no graph is an overlay and belongs in some family's `locales`.",
					file: `packages/neural-weights-${family.family}/package.json`,
				})
			}

			const vocabulary = FAMILY_VOCABULARY_ARTIFACT[family.encoder]

			if (!(manifest.files ?? []).includes(vocabulary)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`Family \`${family.family}\` declares encoder \`${family.encoder}\`, which reads ` +
						`\`${vocabulary}\`, and its graph package does not publish that file.`,
					file: `packages/neural-weights-${family.family}/package.json`,
				})
			}
		}

		for (const [locale, manifest] of manifests) {
			// A private package is a parked artifact rather than a shipping locale.
			if (manifest.private) continue

			if (!claimedBy.has(locale)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`\`${manifest.name}\` ships and no family names locale \`${locale}\`, so no file states which ` +
						"graph decodes its rows. Add it to the family whose graph it inherits.",
					file: `packages/neural-weights-${locale}/package.json`,
				})

				continue
			}

			const family = FAMILIES.find((entry) => entry.locales.includes(locale))
			const base = manifest.mailwoman?.baseWeights

			// A family's own graph package declares no `baseWeights`, and reading it as an overlay would report a second
			// diagnostic for a graph package whose `model.onnx` is already reported missing.
			if (family?.family === locale) continue

			// An overlay's `baseWeights` and its family must name the same graph, since they are written in different files
			// and no other check compares them.
			if (!declaresGraph(manifest) && family && base !== family.graphPackage) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`\`${manifest.name}\` inherits \`${base ?? "no base"}\` through \`mailwoman.baseWeights\`, and ` +
						`family \`${family.family}\` says its graph is \`${family.graphPackage}\`.`,
					file: `packages/neural-weights-${locale}/package.json`,
				})
			}
		}

		return diagnostics.map((diagnostic) => ({
			...diagnostic,
			...(diagnostic.file ? { file: relative(repoRoot, resolvePath(repoRoot, diagnostic.file)) } : {}),
		}))
	},
}
