#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize a release's weights artifacts from the PUBLIC Hugging Face bucket — the `--source hf`
 *   half of the #1894 preflight, and the recipe `.github/workflows/publish.yml` now calls in place of
 *   the curl-and-cp block it used to carry inline. ONE recipe, two callers: the preflight points it at
 *   a staging tree, the publish job points it at the checkout. `copy-weights.ts` is the same shape for
 *   the operator's data root; both take a destination root and touch nothing else.
 *
 *   WHAT IS FETCHED IS DERIVED, NOT LISTED. A `neural-weights-<locale>` package's `files` array is its
 *   author stating which artifacts the tarball carries, and `git ls-files` says which of those a
 *   checkout already has; the difference is exactly the set something must materialize — the same
 *   predicate `verify-tarball.ts` refuses a publish over (`literalFilesEntries`, shared with it). The
 *   v9.2.0 release published 49 of 51 workspaces before that audit refused
 *   `@mailwoman/neural-weights-en-au`, whose four declared lexicons the YAML's hand-maintained copy
 *   list did not name. A derived list cannot fall behind a manifest that way.
 *
 *   NO CREDENTIALS, NO WRITES ANYWHERE BUT THE DESTINATION ROOT. The bucket is public — the same files
 *   the browser demo loads. Nothing here writes to Hugging Face, npm, git, or R2.
 */

import { pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { readReleaseConfig } from "@mailwoman/core/release-config"
import { resolvePath } from "path-ts"

import {
	distributionOnlyRemoteNames,
	hfVersionBase,
	planWeightsMaterialization,
	readBaseModelVersion,
	resolveBaseLocale,
	type HFMaterializationReport,
} from "#weights/fetch-hf-weights/plan"
import { downloadRemote, probeRemote, verifyChecksum, writeArtifact } from "#weights/fetch-hf-weights/transfer"

export interface FetchHFWeightsOptions {
	/**
	 * The checkout the recipe is READ from — manifests, model cards, committed lexicons. Never written to unless it is
	 * also the destination.
	 */
	repoRoot?: string
	/**
	 * The model-card version naming the bucket directory. Defaults to the base package's card, which is what CI read.
	 */
	version?: string
	/**
	 * Where progress lines go. Defaults to stderr.
	 */
	log?: (line: string) => void
}

function writeStderr(line: string): void {
	process.stderr.write(`${line}\n`)
}

/**
 * Materialize every planned artifact under `destRoot`.
 *
 * Fetches each distinct bucket object ONCE and writes it to every workspace that declares it — the `cp` fan-out the
 * YAML spelled out by hand. HEAD-probes the whole remote set first so an unstaged version fails in one pass with every
 * missing object named, rather than after the first 39 MB download dies on a 404.
 */
export async function fetchHFWeights(
	destRoot: string,
	{ repoRoot = String(repoRootPath()), version, log = writeStderr }: FetchHFWeightsOptions = {}
): Promise<HFMaterializationReport> {
	const config = await readReleaseConfig(repoRoot)
	const baseLocale = await resolveBaseLocale(repoRoot, config.locales)
	const resolvedVersion = version ?? (await readBaseModelVersion(repoRoot))
	const base = await hfVersionBase(repoRoot, resolvedVersion)
	const plans = await planWeightsMaterialization(repoRoot, { version: resolvedVersion })
	// Distinct bucket objects by URL: several packages share one Latin object, and a family's object shares only a
	// basename with it.
	const objects = new Map<string, { base: string; remoteName: string }>()

	for (const plan of plans) {
		if (plan.origin.kind === "hf") {
			objects.set(`${plan.origin.base}/${plan.origin.remoteName}`, plan.origin)
		}
	}

	const probeOnly = (await distributionOnlyRemoteNames(repoRoot, baseLocale)).map((name) => `${base}/${name}`)
	const familyBases = [...new Set([...objects.values()].map((object) => object.base))].filter((b) => b !== base)

	log(`hf weights: v${resolvedVersion} → ${base}${familyBases.length ? ` (+ ${familyBases.join(", ")})` : ""}`)

	log(
		`hf weights: ${plans.length} declared artifacts, ${objects.size} distinct bucket objects, ` +
			`${probeOnly.length} distribution-only (probed, never fetched)`
	)

	const probes = await Promise.all(
		[...objects.keys(), ...probeOnly].map(async (url) => {
			const failure = await probeRemote(url)

			return { url, failure }
		})
	)

	const unreachable = probes.filter((probe) => probe.failure)

	if (unreachable.length) {
		const lines = unreachable.map((probe) => `  ✗ ${probe.url}: ${probe.failure}`)

		const probed = objects.size + probeOnly.length

		throw new Error(
			`fetch-hf-weights: ${unreachable.length} of ${probed} artifacts are not readable for v${resolvedVersion}. ` +
				`Stage them from the operator's host with \`mailwoman release hf v${resolvedVersion} …\` (RELEASING.md §3), ` +
				"then re-run. Every object below is staged flat by its basename, through the flag family that carries it — " +
				"--model / --tokenizer, --postcodes, --pair-indexes, --fsts, --gazetteer-lexicon, --country-lexicon, " +
				"--street-type-lexicon, --locality-surface-lexicon, --fisher (`mailwoman release hf --help`):\n" +
				lines.join("\n")
		)
	}

	const report: HFMaterializationReport = {
		version: resolvedVersion,
		base,
		downloaded: 0,
		written: 0,
		bytes: 0,
		checksumVerified: 0,
		checksumUndeclared: [],
	}

	const undeclared = new Set<string>()

	for (const [url, object] of objects) {
		const bytes = await downloadRemote(url)

		report.downloaded += 1
		report.bytes += bytes.byteLength

		for (const plan of plans) {
			if (
				plan.origin.kind !== "hf" ||
				plan.origin.remoteName !== object.remoteName ||
				plan.origin.base !== object.base
			) {
				continue
			}

			verifyChecksum(plan, bytes, url)

			if (plan.expectedMD5) {
				report.checksumVerified += 1
			} else {
				undeclared.add(plan.filename)
			}

			await writeArtifact(resolvePath(destRoot, plan.workspace, plan.filename), bytes)
			report.written += 1
		}

		const shown =
			object.base === base ? object.remoteName : `${object.base.split("/").slice(-2).join("/")}/${object.remoteName}`

		log(`  ✓ ${shown} (${bytes.byteLength.toLocaleString("en-US")} bytes)`)
	}

	for (const plan of plans) {
		if (plan.origin.kind !== "repo") continue

		if (!(await pathExists(plan.origin.sourcePath))) {
			throw new Error(
				`fetch-hf-weights: ${plan.workspace} declares ${plan.filename}, which release.config.json sources from the ` +
					`checkout at ${plan.origin.sourcePath} — and it is not there.`
			)
		}

		const bytes = await readLocalBuffer(plan.origin.sourcePath)

		verifyChecksum(plan, bytes, plan.origin.sourcePath)

		if (plan.expectedMD5) {
			report.checksumVerified += 1
		} else {
			undeclared.add(plan.filename)
		}

		await writeArtifact(resolvePath(destRoot, plan.workspace, plan.filename), bytes)
		report.written += 1
		report.bytes += bytes.byteLength
	}

	report.checksumUndeclared = [...undeclared].toSorted()

	return report
}

/**
 * Print a materialization receipt.
 */
export function reportHFMaterialization(
	report: HFMaterializationReport,
	log: (line: string) => void = writeStderr
): void {
	const megabytes = (report.bytes / 1_000_000).toFixed(1)

	log(
		`hf weights: wrote ${report.written} artifacts (${report.downloaded} downloads, ${megabytes} MB), ` +
			`${report.checksumVerified} md5-verified`
	)

	if (report.checksumUndeclared.length) {
		log(
			`hf weights: no model card declares an md5 for ${report.checksumUndeclared.join(", ")} — those bytes are ` +
				"staged, not verified"
		)
	}
}
