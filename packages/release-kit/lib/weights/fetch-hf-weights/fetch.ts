#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { readReleaseConfig } from "@mailwoman/core/release-config"
import { type PathBuilderLike, resolvePath } from "path-ts"

import {
	distributionOnlyRemoteNames,
	hfVersionBase,
	planWeightsMaterialization,
	readBaseModelVersion,
	resolveBaseLocale,
	type HFMaterializationReport,
} from "#weights/fetch-hf-weights/plan"
import { downloadRemote, probeRemote, verifyChecksum, writeArtifact } from "#weights/fetch-hf-weights/transfer"

/**
 * Options for {@link fetchHFWeights}.
 */
export interface FetchHFWeightsOptions {
	/**
	 * The checkout that supplies manifests, model cards and committed lexicons.
	 *
	 * The fetch writes to it only when it is also the destination.
	 */
	repoRoot?: PathBuilderLike

	/**
	 * The model-card version that selects the bucket directory.
	 *
	 * It defaults to the version in the base package's model card.
	 */
	version?: string

	/**
	 * Receives progress lines.
	 * It defaults to stderr.
	 */
	log?: (line: string) => void
}

function writeStderr(line: string): void {
	process.stderr.write(`${line}\n`)
}

/**
 * Downloads each distinct planned weights object once and writes it into every workspace that declares it.
 *
 * It also copies the artifacts sourced from the checkout, and it verifies checksums for both.
 *
 * It probes every remote object before downloading anything, so an unstaged
 * version fails once and lists every missing object.
 */
export async function fetchHFWeights(
	destRoot: string,
	{ repoRoot = repoRootPath(), version, log = writeStderr }: FetchHFWeightsOptions = {}
): Promise<HFMaterializationReport> {
	const config = await readReleaseConfig(repoRoot)
	const baseLocale = await resolveBaseLocale(repoRoot, config.locales)
	const resolvedVersion = version ?? (await readBaseModelVersion(repoRoot))
	const base = await hfVersionBase(repoRoot, resolvedVersion)
	const plans = await planWeightsMaterialization(repoRoot, { version: resolvedVersion })

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
 * Logs a summary of a materialization report.
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
