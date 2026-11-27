// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Stages a weights root for grading a model: `<out>/node_modules/@mailwoman/neural-weights-<locale>`
 *   for the family's graph package and each overlay, the layout `resolveWeights`' explicit cache rung
 *   reads and `weights_cache` names in `mwdev_compare`, `mwdev_arc` and `mwdev_promotion_eval`.
 *
 *   Each package receives the concrete entries of its workspace's `files` list.
 *   An entry comes from the workspace when the workspace holds it and from the
 *   data-root weights overlay otherwise, and its bytes are copied, so the root
 *   survives a move of the data root or of the checkout.
 *
 *   A package that inherits the base graph through `mailwoman.baseWeights` gets the base's
 *   `model.onnx` and vocabulary as links inside the root, so one graph serves every package.
 *
 *   A candidate graph comes from a training export (`--export`, verified against its signed provenance)
 *   or a `--file model.onnx=<path>` override.
 *   The base's card is then derived from the published card with the candidate's identity,
 *   unless `--card` supplies a finished one.
 *
 *   The root is built beside `--out` and moved into place only after it verifies:
 *   every declared artifact is present, the base card's md5 for each graph file matches the
 *   staged bytes, every package resolves the base graph's sha256 through `resolveWeights`,
 *   and the graph's address-system head matches the card's table.
 *
 *   Usage:
 *     yarn mwops release stage-weights-cache --out <dir> \
 *       --export <run>/export --recipe packages/corpus/data/training-configs/<config>.yaml
 *     yarn mwops release stage-weights-cache --out <dir>              # the published model
 *     yarn mwops release stage-weights-cache --out <dir> --omit locality-surface-lexicon-v7.json
 */

import { md5File, sha256File } from "@mailwoman/core/crypto/hash"
import { weightsOverlayPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { isFile, pathExists, tryStat } from "@mailwoman/core/fs/readers/stat"
import {
	copyFileTo,
	createSymbolicLink,
	makeDirectories,
	movePath,
	removePathIfPresent,
	stagingSiblingPath,
	writeLocalJSONFile,
} from "@mailwoman/core/fs/writers"
import { verifyProvenanceManifest } from "@mailwoman/core/license/provenance"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { resolveWeights, weightsCachePackageDir } from "@mailwoman/neural/weights"
import {
	DEFAULT_WEIGHTS_LOCALE,
	FAMILY_VOCABULARY_ARTIFACT,
	familyByID,
	type WeightsFamily,
} from "@mailwoman/neural/weights/families"
import { basename, dirname, PathBuilder, type PathBuilderLike, relative, resolvePathBuilder } from "path-ts"

import { auditAddressSystemWidths, fitAddressSystemTable } from "#release-kit/weights/address-system-width"

/**
 * The graph file a training export's quantized graph is written to, the one a weights package serves.
 */
const EXPORT_GRAPH = "model-int8.onnx"

export interface StageWeightsCacheOptions {
	repoRoot: PathBuilderLike
	/**
	 * The root directory, resolved against {@linkcode StageWeightsCacheOptions.repoRoot}.
	 */
	out: PathBuilderLike
	/**
	 * The weights family whose graph package and overlays are staged.
	 *
	 * @defaultValue the default weights locale's family, `en-us`.
	 */
	family?: string
	/**
	 * The family's locales to stage.
	 * Empty stages every locale the family declares.
	 */
	locales: string[]
	/**
	 * A training export directory.
	 * It supplies the candidate graph and its signed identity.
	 */
	exportDirectory?: PathBuilderLike
	/**
	 * The graph file inside {@linkcode StageWeightsCacheOptions.exportDirectory}.
	 *
	 * @defaultValue {@linkcode EXPORT_GRAPH}
	 */
	graph?: string
	/**
	 * The training config that produced the candidate, recorded in the derived card.
	 */
	recipe?: PathBuilderLike
	/**
	 * The published card a candidate card is derived from.
	 *
	 * @defaultValue the graph package workspace's committed `model-card.json`.
	 */
	baseCard?: PathBuilderLike
	/**
	 * A finished card for the graph package, staged as given and verified against the staged graph.
	 */
	card?: PathBuilderLike
	/**
	 * `[<locale>:]<name-in-package>=<source path>` overrides.
	 * Without a locale an entry applies to the graph package.
	 */
	file: string[]
	/**
	 * `[<locale>:]<name-in-package>` artifacts to leave out, the ablation arm of an A/B.
	 * Without a locale an entry applies to every package.
	 */
	omit: string[]
	/**
	 * Replace an existing root at `out`.
	 * Without it an existing root is refused.
	 */
	replace: boolean
	/**
	 * The weights overlay root that holds the artifacts a workspace doesn't.
	 *
	 * @defaultValue the data root's `weights/` directory.
	 */
	overlayRoot?: PathBuilderLike
	/**
	 * Provenance keys to trust in place of the trust register's.
	 */
	trustedProvenanceKeys?: Readonly<Record<string, string>>
	log: (line: string) => void
}

/**
 * One staged package and the graph it resolves.
 */
interface StagedPackage {
	locale: string
	packageDir: PathBuilder
	/**
	 * The artifact names staged, as names inside the package.
	 */
	staged: string[]
	omitted: string[]
	/**
	 * The sha256 of the `model.onnx` the package's own directory holds.
	 */
	modelSHA256: string
	/**
	 * The sha256 of the graph `resolveWeights` reads for the locale.
	 */
	resolvedModelSHA256: string
}

export interface StageWeightsCacheReport {
	cacheRoot: PathBuilder
	family: string
	graph: { source: string; md5: string; sha256: string }
	/**
	 * Where the graph package's card came from.
	 */
	card: "published" | "derived" | "given"
	packages: StagedPackage[]
}

/**
 * The identity of a candidate graph, recorded in the card derived for it.
 */
interface CandidateIdentity {
	graph: { source: string; md5: string; sha256: string; bytes: number }
	recipe: { path: string; sha256: string }
	export: {
		directory: string
		provenanceID: string
		attestation: string
		kid: string | null
		runID: string | null
		licenseBranch: string | null
		resolvedConfigSHA256: string | null
		corpusManifestSHA256: string | null
		corpusVersion: string | null
		trainerImage: string | null
	} | null
}

type ModelCard = Record<string, unknown> & {
	version?: string
	files_md5?: Record<string, string>
	training?: Record<string, unknown>
}

/**
 * The training-manifest key for a corpus version: the frozen records under
 * `packages/corpus/data/training-manifests/` take the file title `v<version>`,
 * and an export's `CORPUS.json` writes the version without the `v`.
 */
function corpusManifestKey(version: string): string {
	return version.startsWith("v") ? version : `v${version}`
}

/**
 * Returns the graph package's card for a candidate graph: the published card with
 * `files_md5["model.onnx"]`, the recipe and the corpus set from the candidate,
 * and a `candidate` block recording the graph's digests and the export's signed identity.
 *
 * Every other field is the published card's.
 * The `candidate` block states that evaluation, lineage and step counts describe the published model.
 */
function deriveCandidateCard(published: ModelCard, identity: CandidateIdentity): ModelCard {
	const publishedModelMD5 = published.files_md5?.["model.onnx"] ?? null
	const training: Record<string, unknown> = { ...published.training, recipe: identity.recipe.path }

	if (identity.export?.corpusVersion) {
		training["corpus_version"] = corpusManifestKey(identity.export.corpusVersion)
	}

	return {
		...published,
		files_md5: {
			...published.files_md5,
			$comment:
				`A staged candidate: model.onnx is ${identity.graph.source}. ` +
				`Every other entry is the published ${published.version ?? "unversioned"} card's.`,
			"model.onnx": identity.graph.md5,
		},
		training,
		candidate: {
			$comment:
				"Written by `mwops release stage-weights-cache`. The graph, the recipe and the corpus are the " +
				"candidate's. Every other field of this card, evaluation and lineage included, is the published card's.",
			published_card: { version: published.version ?? null, model_md5: publishedModelMD5 },
			graph: identity.graph,
			recipe: identity.recipe,
			export: identity.export
				? {
						directory: identity.export.directory,
						provenance_id: identity.export.provenanceID,
						attestation: identity.export.attestation,
						kid: identity.export.kid,
						run_id: identity.export.runID,
						license_branch: identity.export.licenseBranch,
						resolved_config_sha256: identity.export.resolvedConfigSHA256,
						corpus_manifest_sha256: identity.export.corpusManifestSHA256,
						corpus_version: identity.export.corpusVersion,
						trainer_image: identity.export.trainerImage,
					}
				: null,
		},
	}
}

/**
 * Sets the derived card's `outcomes` block from the export's `OUTCOMES.json`,
 * which `trainer-export export-onnx` writes beside a graph with the outcome hint
 * or head, and declares `requires.outcome_hint` for a graph with the hint.
 *
 * The published card's block describes another graph, so a candidate without the sidecar drops it.
 */
async function fitOutcomesBlock(card: ModelCard, exportDirectory: PathBuilder): Promise<void> {
	const sidecar = exportDirectory("OUTCOMES.json")
	const requires = { ...(card.requires as Record<string, unknown> | undefined) }

	delete card.outcomes
	delete requires["outcome_hint"]

	if (await pathExists(sidecar)) {
		const block = await readLocalJSONFile<{ hint_classes?: unknown[] }>(sidecar)

		card.outcomes = block

		if (block.hint_classes?.length) {
			requires["outcome_hint"] = { required: true }
		}
	}

	if (card.requires || Object.keys(requires).length) {
		card.requires = requires
	}
}

/**
 * Splits a `[<locale>:]<rest>` entry.
 *
 * A prefix counts as a locale only when it equals a staged locale, so a path holding a colon stays whole.
 */
function splitLocalePrefix(entry: string, locales: readonly string[]): [string | null, string] {
	const colon = entry.indexOf(":")

	if (colon === -1) return [null, entry]

	const prefix = entry.slice(0, colon).toLowerCase()

	return locales.includes(prefix) ? [prefix, entry.slice(colon + 1)] : [null, entry]
}

interface PackagePlan {
	locale: string
	workspace: PathBuilder
	inheritsBase: boolean
	/**
	 * Staged name → source path.
	 */
	sources: Map<string, PathBuilder>
	omitted: string[]
}

/**
 * Reads the export's provenance manifest and returns the candidate graph's export identity.
 *
 * @throws When the manifest doesn't verify against the export's files, or binds another graph.
 */
async function readExportIdentity(
	directory: PathBuilder,
	graph: string,
	trustedKeys: Readonly<Record<string, string>> | undefined
): Promise<{ identity: NonNullable<CandidateIdentity["export"]>; graphSHA256: string }> {
	const manifestPath = directory(`${basename(graph, ".onnx")}.provenance.json`)

	if (!(await pathExists(manifestPath))) {
		throw new Error(`the export at ${directory} has no ${basename(manifestPath)} for ${graph}`)
	}

	const verification = await verifyProvenanceManifest(manifestPath, {
		requireSignature: true,
		...(trustedKeys ? { trustedKeys } : {}),
	})

	if (verification.status !== "verified") {
		throw new Error(`${manifestPath} does not verify (${verification.refusal}): ${verification.reason}`)
	}

	const { payload } = verification
	const bound = payload.artifacts[0]!

	if (bound.path !== graph) {
		throw new Error(`${manifestPath} binds ${bound.path} first, not the graph ${graph}`)
	}

	const corpusPath = directory("CORPUS.json")

	const corpus = (await pathExists(corpusPath))
		? await readLocalJSONFile<{ corpus_version?: string }>(corpusPath)
		: null

	return {
		identity: {
			directory: directory.toString(),
			provenanceID: payload.provenance_id,
			attestation: payload.attestation,
			kid: verification.kid,
			runID: payload.training?.run_id ?? null,
			licenseBranch: payload.training?.license_branch ?? null,
			resolvedConfigSHA256: payload.training?.resolved_config_sha256 ?? null,
			corpusManifestSHA256: payload.training?.corpus_manifest_sha256 ?? null,
			corpusVersion: corpus?.corpus_version ?? null,
			trainerImage: payload.training?.trainer.image ?? null,
		},
		graphSHA256: bound.sha256,
	}
}

/**
 * Returns the family with this id, and throws when no family has it.
 */
function readFamily(id: string): WeightsFamily {
	const family = familyByID(id)

	if (!family) throw new Error(`no weights family ${id}`)

	return family
}

export async function stageWeightsCache(options: StageWeightsCacheOptions): Promise<StageWeightsCacheReport> {
	const { log } = options
	const repoRoot = PathBuilder.from(options.repoRoot)
	const family = readFamily(options.family ?? DEFAULT_WEIGHTS_LOCALE.toLowerCase())
	const baseLocale = family.family
	const vocabulary = FAMILY_VOCABULARY_ARTIFACT[family.encoder]
	const locales = options.locales.length ? options.locales.map((locale) => locale.toLowerCase()) : [...family.locales]

	for (const locale of locales) {
		if (!family.locales.includes(locale)) {
			throw new Error(`${locale} is not a locale of the ${family.family} family (${family.locales.join(", ")})`)
		}
	}

	if (!locales.includes(baseLocale)) {
		throw new Error(`the locales must include ${baseLocale}, the package every overlay reads its graph from`)
	}

	const cacheRoot = resolvePathBuilder(repoRoot, options.out)

	if ((await pathExists(cacheRoot)) && !options.replace) {
		throw new Error(`${cacheRoot} already exists: pass --replace to replace it, or choose a new --out`)
	}

	const overlaySource = (locale: string, name: string) =>
		options.overlayRoot ? resolvePathBuilder(options.overlayRoot, locale, name) : weightsOverlayPath(locale, name)

	const overrides = new Map<string, Map<string, PathBuilder>>()

	for (const spec of options.file) {
		const [prefix, rest] = splitLocalePrefix(spec, locales)
		const eq = rest.indexOf("=")
		const [name, source] = eq === -1 ? [basename(rest), rest] : [rest.slice(0, eq), rest.slice(eq + 1)]
		const locale = prefix ?? baseLocale

		overrides.set(locale, (overrides.get(locale) ?? new Map()).set(name, resolvePathBuilder(repoRoot, source)))
	}

	const omitAll = new Set<string>()
	const omitByLocale = new Map<string, Set<string>>()

	for (const entry of options.omit) {
		const [prefix, name] = splitLocalePrefix(entry, locales)

		if (prefix) {
			omitByLocale.set(prefix, (omitByLocale.get(prefix) ?? new Set()).add(name))
		} else {
			omitAll.add(name)
		}
	}

	// The candidate graph and the identity its derived card records.
	const baseOverrides = overrides.get(baseLocale) ?? new Map<string, PathBuilder>()
	let exportIdentity: Awaited<ReturnType<typeof readExportIdentity>> | null = null

	if (options.exportDirectory) {
		if (baseOverrides.has("model.onnx")) {
			throw new Error("--export and --file model.onnx=… both name a candidate graph; pass one")
		}

		const directory = resolvePathBuilder(repoRoot, options.exportDirectory)
		const graph = options.graph ?? EXPORT_GRAPH

		exportIdentity = await readExportIdentity(directory, graph, options.trustedProvenanceKeys)
		baseOverrides.set("model.onnx", directory(graph))
		overrides.set(baseLocale, baseOverrides)
	}

	const candidateGraph = baseOverrides.get("model.onnx") ?? null

	// Plan every package before writing, so a missing artifact refuses the root before any byte is copied.
	const plans: PackagePlan[] = []
	const missing: string[] = []

	for (const locale of locales) {
		const workspace = repoRoot("packages", `neural-weights-${locale}`)
		const manifestPath = workspace("package.json")

		if (!(await pathExists(manifestPath))) throw new Error(`no workspace for ${locale} at ${workspace}`)

		const manifest = await readPackageJSON(manifestPath)
		const inheritsBase = locale !== baseLocale && manifest.mailwoman?.baseWeights === family.graphPackage

		if (locale !== baseLocale && !inheritsBase) {
			throw new Error(`${manifestPath} doesn't declare mailwoman.baseWeights ${family.graphPackage}`)
		}

		// A glob matches no single file, and the cache holds concrete siblings only.
		const declared = (manifest.files ?? []).filter((entry) => !entry.startsWith("!") && !entry.includes("*"))
		const omitted = new Set([...omitAll, ...(omitByLocale.get(locale) ?? [])])
		const sources = new Map<string, PathBuilder>()

		for (const name of declared) {
			sources.set(name, (await isFile(workspace(name))) ? workspace(name) : overlaySource(locale, name))
		}

		for (const [name, source] of overrides.get(locale) ?? []) {
			if (inheritsBase && (name === "model.onnx" || name === vocabulary)) {
				throw new Error(
					`${locale} reads ${name} from ${family.graphPackage}; override the graph package's ${name} instead`
				)
			}

			sources.set(name, source)
		}

		if (locale === baseLocale && options.card) {
			sources.set("model-card.json", resolvePathBuilder(repoRoot, options.card))
		}

		for (const name of omitted) {
			sources.delete(name)
		}

		for (const [name, source] of sources) {
			// `pathExists` follows a link, so a link whose target is gone counts as missing.
			if (!(await pathExists(source))) {
				missing.push(`neural-weights-${locale}/${name} (from ${source})`)
			}
		}

		plans.push({ locale, workspace, inheritsBase, sources, omitted: [...omitted].toSorted() })
	}

	if (missing.length) {
		throw new Error(
			`refusing to stage a root without ${missing.length} declared artifact(s):\n  ${missing.join("\n  ")}\n` +
				"Materialize them (the package's link-dev-weights.ts, or `mwops release copy-weights`), " +
				"pass --file for each, or --omit them on purpose."
		)
	}

	const basePlan = plans.find((plan) => plan.locale === baseLocale)!
	const graphSource = basePlan.sources.get("model.onnx")

	if (!graphSource) throw new Error(`neural-weights-${baseLocale} stages no model.onnx`)

	const graph = {
		source: graphSource.toString(),
		md5: await md5File(graphSource),
		sha256: await sha256File(graphSource),
		bytes: (await tryStat(graphSource))!.size,
	}

	if (exportIdentity && exportIdentity.graphSHA256 !== graph.sha256) {
		throw new Error(`${graphSource} isn't the graph its provenance binds (sha256 ${exportIdentity.graphSHA256})`)
	}

	// The graph package's card: derived for a candidate unless one was given, and the published card otherwise.
	let cardKind: StageWeightsCacheReport["card"] = options.card ? "given" : "published"
	let derivedCard: ModelCard | null = null

	if (candidateGraph && !options.card) {
		if (!options.recipe) {
			throw new Error("--recipe <training config> is required to derive a card for a candidate graph")
		}

		const recipePath = resolvePathBuilder(repoRoot, options.recipe)

		if (!(await isFile(recipePath))) throw new Error(`--recipe names no file at ${recipePath}`)

		const publishedCardPath = options.baseCard
			? resolvePathBuilder(repoRoot, options.baseCard)
			: basePlan.workspace("model-card.json")

		derivedCard = deriveCandidateCard(await readLocalJSONFile<ModelCard>(publishedCardPath), {
			graph,
			recipe: { path: relative(repoRoot.toString(), recipePath.toString()), sha256: await sha256File(recipePath) },
			export: exportIdentity?.identity ?? null,
		})

		await fitAddressSystemTable(derivedCard, candidateGraph, publishedCardPath.toString())

		if (exportIdentity) {
			await fitOutcomesBlock(derivedCard, resolvePathBuilder(repoRoot, exportIdentity.identity.directory))
		}

		cardKind = "derived"
	}

	const staging = PathBuilder.from(stagingSiblingPath(cacheRoot))

	try {
		for (const plan of plans) {
			const packageDir = weightsCachePackageDir(staging, plan.locale)

			await makeDirectories(packageDir)
			await copyFileTo(plan.workspace("package.json"), packageDir("package.json"))

			for (const [name, source] of plan.sources) {
				if (derivedCard && plan.locale === baseLocale && name === "model-card.json") continue

				await copyFileTo(source, packageDir(name))
			}

			if (derivedCard && plan.locale === baseLocale) {
				await writeLocalJSONFile(derivedCard, packageDir("model-card.json"))
			}

			// An inheriting package reads the base's graph.
			// A link inside the root gives its own directory the same bytes, so no reader of
			// the package can grade another graph, and the link survives a move of the root.
			if (plan.inheritsBase) {
				for (const name of ["model.onnx", vocabulary]) {
					// A string target, because a path builder would resolve it against the working directory.
					await createSymbolicLink(`../neural-weights-${baseLocale}/${name}`, packageDir(name))
				}
			}
		}

		const packages = await verifyStagedRoot({ staging, cacheRoot, plans, baseLocale, vocabulary, graph })

		if (options.replace) {
			await removePathIfPresent(cacheRoot)
		}

		await movePath(staging, cacheRoot)

		log(`staged ${packages.length} package(s) of the ${family.family} family → ${cacheRoot}`)
		log(`  graph: ${graph.source}`)
		log(`  sha256 ${graph.sha256}, md5 ${graph.md5}`)
		log(`  card: ${cardKind}`)

		for (const staged of packages) {
			log(
				`  ${staged.locale}: ${staged.staged.length} artifact(s), resolves ${staged.resolvedModelSHA256.slice(0, 12)}` +
					(staged.omitted.length ? `, omitted ${staged.omitted.join(", ")}` : "")
			)
		}

		return { cacheRoot, family: family.family, graph, card: cardKind, packages }
	} catch (error) {
		await removePathIfPresent(staging)

		throw error
	}
}

interface VerifyInput {
	staging: PathBuilder
	cacheRoot: PathBuilder
	plans: PackagePlan[]
	baseLocale: string
	vocabulary: string
	graph: { sha256: string; md5: string }
}

/**
 * Checks the staged root and returns each package's record with its final path.
 *
 * @throws When the base card's md5s disagree with the staged graph files, when a package
 * resolves another graph, or when the graph's address-system head disagrees with the card.
 */
async function verifyStagedRoot(input: VerifyInput): Promise<StagedPackage[]> {
	const { staging, cacheRoot, plans, baseLocale, vocabulary, graph } = input
	const baseDir = weightsCachePackageDir(staging, baseLocale)
	const card = await readLocalJSONFile<ModelCard>(baseDir("model-card.json"))
	const problems: string[] = []

	for (const name of ["model.onnx", vocabulary]) {
		const recorded = card.files_md5?.[name]

		if (!recorded) {
			problems.push(`neural-weights-${baseLocale}/model-card.json records no files_md5 for ${name}`)

			continue
		}

		const staged = name === "model.onnx" ? graph.md5 : await md5File(baseDir(name))

		if (recorded !== staged) {
			problems.push(`neural-weights-${baseLocale}/model-card.json records ${name} md5 ${recorded}, staged ${staged}`)
		}
	}

	const packages: StagedPackage[] = []

	for (const plan of plans) {
		const packageDir = weightsCachePackageDir(staging, plan.locale)
		const modelSHA256 = await sha256File(packageDir("model.onnx"))
		const resolved = await resolveWeights({ locale: plan.locale, cacheRoot: staging })
		const resolvedModelSHA256 = await sha256File(resolved.modelPath)

		for (const [label, digest] of [
			["holds", modelSHA256],
			["resolves", resolvedModelSHA256],
		] as const) {
			if (digest !== graph.sha256) {
				problems.push(`neural-weights-${plan.locale} ${label} model.onnx sha256 ${digest}, not ${graph.sha256}`)
			}
		}

		packages.push({
			locale: plan.locale,
			packageDir: weightsCachePackageDir(cacheRoot, plan.locale),
			staged: [...plan.sources.keys(), ...(plan.inheritsBase ? ["model.onnx", vocabulary] : [])].toSorted(),
			omitted: plan.omitted,
			modelSHA256,
			resolvedModelSHA256,
		})
	}

	problems.push(...(await auditAddressSystemWidths(dirname(baseDir), [basename(baseDir)])))

	if (problems.length) {
		throw new Error(`the staged root doesn't verify:\n  ${problems.join("\n  ")}`)
	}

	return packages
}
