/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-locale releases manifest stores the version pointer beside versioned asset directories. It is the one place
 *   its wire keys are read. Every spelling a published manifest has used stays readable here, because a wire
 *   key is a string interface and a reader that drops one turns a release's gazetteer off with no error.
 */

import type { FamilyEncoder } from "@mailwoman/neural/weights/families"

import { DEFAULT_LOCALE } from "#browser-runtime/classify"
import { fetchWithRetry } from "#browser-runtime/fetch"
import { pairIndexBaseURL, pairIndexManifestURL, releasesManifestURL } from "#browser-runtime/resources"

export interface ReleaseInfo {
	version: string
	label: string
	description: string
	modelSize: string
	tokenizerVocab: number
	steps: number
	hasFST: boolean
	hasWOFDB: boolean
	hasAnchor?: boolean
	/**
	 * The postcode-anchor binaries in the release directory, such as `postcode-gb.bin`.
	 */
	postcodeAnchors?: string[]
	/**
	 * The PFX1 postcode-prefix indexes in the release directory, such as `postcode-prefix-us.bin`.
	 *
	 * The anchor-region prior reads them.
	 * A release published before the field holds none.
	 */
	postcodePrefixes?: string[]
	/**
	 * PCB1 postcode binaries in the release directory that only the postcode-only fallback reads.
	 *
	 * An example is `postcode-jp.bin`.
	 * The classifier's anchor channel reads `postcodeAnchors` and never these.
	 *
	 * A country listed here gains a centroid for a bare postcode while the model's inputs stay as trained.
	 */
	postcodeCentroids?: string[]
	hasPolygons?: boolean
	/**
	 * Whether the release directory also holds the split model.
	 *
	 * `encoder.onnx` reads `inputs_embeds`.
	 * `embeddings-hot.bin` and `embeddings.rows` hold the embedding rows.
	 *
	 * The directory keeps `model.onnx`, so a runtime that predates the split still loads it.
	 */
	splitEmbeddings?: boolean
	/**
	 * How the release's graph reads its input.
	 *
	 * `sentencepiece` reads subword ids from `tokenizer.model`, and `char` reads
	 * code points indexed by `char-vocab.json`.
	 * An entry published before the field is a SentencePiece release.
	 */
	encoder?: FamilyEncoder
	/**
	 * Whether the release directory holds `calibration.json`, the model's held-out reliability table.
	 *
	 * An entry published before the field is read as holding one, because every such release shipped a table.
	 */
	hasCalibration?: boolean
	/**
	 * Runtime capabilities the release's model needs, such as `locale_hint` for a graph with that input.
	 * A runtime lacking one cannot load the release.
	 */
	requiresRuntime?: string[]
}

/**
 * The capabilities this browser runtime provides.
 *
 * A release whose `requiresRuntime` lists one missing from this list is passed over
 * when the manifest picks the default release.
 *
 * `char_encoder` is the character-encoder load path.
 * A character family's release requires it.
 */
export const BROWSER_RUNTIME_CAPABILITIES: readonly string[] = ["locale_hint", "char_encoder"]

/**
 * Reports whether this runtime provides every capability a release requires.
 */
export function runtimeSupports(release: Pick<ReleaseInfo, "requiresRuntime">): boolean {
	return (release.requiresRuntime ?? []).every((capability) => BROWSER_RUNTIME_CAPABILITIES.includes(capability))
}

/**
 * The postcode-anchor binaries published before entries had a `postcodeAnchors` field.
 * An entry that sets `hasAnchor` without the list held these.
 */
const PRE_LIST_POSTCODE_ANCHORS: readonly string[] = ["postcode-us.bin", "postcode-de.bin", "postcode-fr.bin"]

/**
 * The postcode-anchor binaries a release's classifier load fetches, as file names in its directory.
 *
 * An entry with `postcodeAnchors` returns that list.
 * An older entry that sets only `hasAnchor` returns the files those releases shipped.
 */
export function postcodeAnchorFilesOf(
	release: Pick<ReleaseInfo, "hasAnchor" | "postcodeAnchors"> | null
): readonly string[] {
	if (release?.postcodeAnchors) return release.postcodeAnchors

	return release?.hasAnchor === true ? PRE_LIST_POSTCODE_ANCHORS : []
}

/**
 * The postcode-prefix indexes a release's classifier load fetches, as file names in its directory.
 *
 * A release published before the manifest listed them fetches none,
 * and the anchor-region prior stays off for it.
 */
export function postcodePrefixFilesOf(release: Pick<ReleaseInfo, "postcodePrefixes"> | null): readonly string[] {
	return release?.postcodePrefixes ?? []
}

/**
 * The PCB1 binaries a release's postcode-only fallback reads beside the classifier's
 * anchors, as file names in its directory.
 */
export function postcodeCentroidFilesOf(release: Pick<ReleaseInfo, "postcodeCentroids"> | null): readonly string[] {
	return release?.postcodeCentroids ?? []
}

export interface ReleasesManifest {
	locale: string
	defaultVersion: string
	releases: ReleaseInfo[]
}

/**
 * The raw wire shape of one releases.json entry — either key generation may appear.
 */
export interface WireReleaseEntry extends Omit<ReleaseInfo, "hasFST" | "hasWOFDB"> {
	hasFST?: boolean
	hasWOFDB?: boolean
	/**
	 * Pre-2026-07-04 manifests published lowercase-acronym keys.
	 *
	 * @deprecated use `hasFST` instead
	 */
	// oxlint-disable-next-line sister-software/no-title-case-acronym -- legacy wire key published before whole-acronym casing
	hasFst?: boolean
	/**
	 * Pre-2026-07-04 manifests published lowercase-acronym keys.
	 *
	 * @deprecated use `hasWOFDB` instead
	 */
	// oxlint-disable-next-line sister-software/no-title-case-acronym -- legacy wire key published before whole-acronym casing
	hasWofDb?: boolean
	/**
	 * The spelling the live 2026-08-11 manifest uses (WOF caps, lowercase b).
	 *
	 * A wire key is a string interface.
	 * Every spelling ever published must stay readable here.
	 */
	hasWOFDb?: boolean
}

/**
 * The raw wire shape of a fetched releases.json.
 */
export interface WireReleasesManifest {
	locale: string
	defaultVersion: string
	releases: WireReleaseEntry[]
}

/**
 * Normalize a fetched releases.json into house-cased {@link ReleasesManifest} fields.
 *
 * All manifest consumption goes through here.
 * The wire tolerance lives in exactly one place.
 *
 * Everything past this boundary uses the acronym convention (`hasFST` / `hasWOFDB`).
 *
 * Why the tolerance: the 2026-07-01 acronym sweep renamed the reads while the
 * published R2 manifest kept the old keys.
 * Every release read `undefined`, silently disabling the demo's WOF cascade and the FST
 * for three days (zero console errors; "no WOF hits" was the only symptom).
 *
 * The fix is not to freeze the wire keys but to migrate them deliberately: the publisher now writes
 * house-cased keys, this normalizer accepts both generations (old HF mirrors still use the legacy keys).
 * The interface test pins all three parties.
 */
export function normalizeReleasesManifest(raw: WireReleasesManifest): ReleasesManifest {
	const pointed = raw.releases.find((release) => release.version === raw.defaultVersion)

	// A page running older code than the release needs falls back to the newest release it can load.
	// The manifest lists releases newest first.
	const defaultVersion =
		!pointed || runtimeSupports(pointed)
			? raw.defaultVersion
			: (raw.releases.find((release) => runtimeSupports(release))?.version ?? raw.defaultVersion)

	return {
		locale: raw.locale,
		defaultVersion,
		releases: raw.releases.map((r) => ({
			...r,
			hasFST: r.hasFST ?? r.hasFst ?? false,
			// The 2026-08-11 v9.1.0 manifest (live until the next model release) writes
			// `hasWOFDb` — WOF caps, lowercase b.
			// The 08-14 casing sweep renamed reader and writer to `hasWOFDB` but missed this third live spelling.
			// The demo's whole WOF cascade then stayed off silently for four days.
			hasWOFDB: r.hasWOFDB ?? r.hasWOFDb ?? r.hasWofDb ?? false,
		})),
	}
}

/**
 * Fetch + normalize a locale's releases manifest, the base locale's by default.
 *
 * `cache: "reload"` bypasses the (immutable-Cache-Control) http cache for the version
 * pointer so a returning visitor sees a `defaultVersion` bump.
 *
 * A locale the bucket publishes no manifest for answers null.
 */
export async function fetchReleasesManifest(locale: string = DEFAULT_LOCALE): Promise<ReleasesManifest | null> {
	const res = await fetchWithRetry(releasesManifestURL(locale), { cache: "reload" })

	return res.ok ? normalizeReleasesManifest((await res.json()) as WireReleasesManifest) : null
}

/**
 * The manifest the publisher writes beside one pair-index generation.
 *
 * It lists the countries whose binaries the generation holds, so the runtime
 * requests those files and no others.
 */
export interface PairIndexManifest {
	/**
	 * The generation, the dated directory segment the binaries live under.
	 */
	version: string
	/**
	 * Lowercase alpha-2 codes, one per `pair-index-<cc>.bin` in the generation.
	 */
	countries: string[]
}

function isPairIndexManifest(raw: unknown): raw is PairIndexManifest {
	if (typeof raw !== "object" || raw === null) return false

	const candidate = raw as Partial<PairIndexManifest>

	return (
		typeof candidate.version === "string" &&
		Array.isArray(candidate.countries) &&
		candidate.countries.every((cc) => typeof cc === "string")
	)
}

/**
 * Fetch the manifest of one pair-index generation.
 *
 * Answers `null`, with a console warning that gives the URL, when the bucket answers
 * an error status or a body that is not a manifest.
 * A generation without a readable manifest then loads no pair index, and the pair
 * prior is a soft decode channel, so the classifier still loads.
 */
export async function fetchPairIndexManifest(version: string): Promise<PairIndexManifest | null> {
	const url = pairIndexManifestURL(pairIndexBaseURL(version))
	const res = await fetchWithRetry(url)

	if (!res.ok) {
		console.warn(
			`[browser-runtime] pair-index manifest ${url} answered ${res.status} — no placetype-pair index loads for ` +
				`generation ${version}`
		)

		return null
	}

	const raw: unknown = await res.json()

	if (!isPairIndexManifest(raw)) {
		console.warn(`[browser-runtime] pair-index manifest ${url} is not a {version, countries} document — ignored`)

		return null
	}

	return { version: raw.version, countries: [...raw.countries] }
}
