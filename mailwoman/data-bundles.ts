/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mailwoman data` command group's bundle registry (#task-6) — the consumer download path
 *   `mailwoman doctor`'s fix hints have pointed at (a bare `curl`) since the candidate/POI checks
 *   were written, without a command behind it. This module is the PURE half: what a bundle is, where
 *   its artifacts live on the public bucket, where they land on disk, and the present/missing/stale
 *   decision. `commands/data/pull.tsx` and `commands/data/status.tsx` own the IO (network + fs).
 *
 *   SURVEY (2026-08-03, this task): a one-time enumeration of what the public bucket serves, recorded
 *   here as the paper trail behind the `BUNDLES` table below. Every artifact resolves against
 *   `PUBLIC_BUCKET_BASE_URL` — a public, unauthenticated HTTPS base. No bucket name, no credentials,
 *   nothing a consumer of this package configures. 413 files total. What's there, by top-level prefix:
 *
 *   - `gazetteer/<date>/candidate.db` — 12 dated builds, `2026-06-20b` .. `2026-07-07a`. Only the
 *     LATEST is live (matches `doctor/checks.ts`'s `CANDIDATE_URL` before this change): 1,652,916,224
 *     bytes. The older dates are retained history, not alternates to offer.
 *   - `poi/<date>/poi.db` — 2 dated builds, `2026-07-19a` and `2026-07-20a` (latest, matches the
 *     demo's `POI_LAYER_VERSION`): 3,889,184,768 bytes.
 *   - `street/us/<slug>/{situs,interp}.db` — the 50-state + DC + VI national street tier, 52 slugs,
 *     103 files, 41,261,826,048 bytes total. `vi` ships `situs.db` only (no TIGER interpolation
 *     shard for the territory — a real gap, not an omission here). Sizes recorded per-slug below.
 *   - `street/fr/2026-07-10/situs.db` — the FR national BAN rooftop shard (situs-only, no
 *     interpolation tier; matches the demo's `NATIONAL_STREET_SHARD_VERSION`), 6,952,509,440 bytes.
 *     `street/fr/national/situs.db` also exists (an older, pre-dated-convention upload) but nothing
 *     current points at it — not registered here.
 *   - `en-us/<version>/*` — the MODEL release assets (weights, tokenizer, FST, postcode binaries).
 *     Out of scope: those install via `npm install @mailwoman/neural-weights-en-us`
 *     (`doctor/checks.ts`'s `WEIGHTS_FIX`), not `mailwoman data pull`.
 *   - `pair-index/*.bin`, `sqljs/*` — small binaries the DEMO stages same-origin; not a
 *     server-side download consumers of this CLI would ever want as a "bundle".
 *
 *   NOT SHIPPED (checked, absent): no `timezone`/`nuts`/`un-locode` artifact anywhere under
 *   `mailwoman/` in the bucket — `@mailwoman/timezone-lookup` and `@mailwoman/nuts-lookup` build
 *   their own data locally today. No bundle is defined for them; inventing a path here would be
 *   exactly the mistake this task's brief warns against. Also checked and absent: an `.md5` sidecar
 *   for ANY object in the bucket (`{Path}.md5` — zero matches across all 413 files, and `rclone
 *   lsjson --hash` reports no native hash either, since these are multipart uploads). So every
 *   `BUNDLES` entry below carries `md5Sidecar: false` today; `needsDownload`'s md5-comparison branch
 *   exists and is unit-tested against synthetic remote state for the day a bundle publishes one (see
 *   `scripts/publish-demo-assets-to-r2.py` / `gazetteer publish` — neither writes a sidecar yet).
 *
 *   LOCAL PATH CONVENTIONS — confirmed by reading the actual consumers, not assumed:
 *
 *   - `candidate`: `<dataRoot>/wof/candidate.db` — `doctor/runner.ts`'s `conventionCandidatePath`.
 *   - `poi`: `<dataRoot>/poi/poi.db` — `doctor/runner.ts`'s `poiPath()`.
 *   - `us`: `<dataRoot>/address-points/address-points-us-<slug>.db` and
 *     `<dataRoot>/interpolation/interpolation-us-<slug>.db` — `geocode-core.ts`'s
 *     `selectAddressPointsDB`/`selectInterpolationDB`, the SAME convention `resolveShardPath`
 *     (`data-release.ts`) understands for the `"address-points"`/`"interpolation"` families. A
 *     `releases.json` pinning either family to a version routes the download to the VERSIONED
 *     filename (`resolveBundleArtifacts`, below) so a later `mailwoman geocode` run resolves it.
 *   - `fr`: `<dataRoot>/ban/address-points-fr.db` — `ban/scripts/build-address-point-shard.ts`'s own
 *     default `--out` (`dataRootPath("ban", "address-points-fr.db")`), which is also where
 *     `BANShardProvider` looks. `mailwoman geocode` wires that provider (`commands/geocode.tsx`
 *     imports `@mailwoman/ban/sdk` and passes `nationalShards`), so pulling this bundle is sufficient
 *     — a French address resolves to the `address_point` tier with no further configuration
 *     (re-verified 2026-08-04 on four Paris addresses, uncertainty 1 m). What FR still lacks is the
 *     INTERPOLATION tier: a BAN miss falls straight through to admin rather than estimating along the
 *     street, because no French interpolation shard is built.
 */

import type { DataReleaseManifest } from "./data-release.ts"

/**
 * The public, unauthenticated bucket every bundle artifact resolves against — the same host `doctor/checks.ts`'s
 * (now-removed) `CANDIDATE_URL`/`POI_URL` and the demo's `ASSET_BASE_URL` (`docs/src/shared/resources.tsx`) point at.
 * No credentials: this is the read side of the R2 bucket `commands/tiles/publish.tsx`/`commands/gazetteer/publish.tsx`
 * write to.
 */
export const PUBLIC_BUCKET_BASE_URL = "https://public.sister.software/mailwoman/"

/**
 * One downloadable file within a {@link DataBundle}.
 */
export interface BundleArtifact {
	/**
	 * The R2 object key, relative to {@link PUBLIC_BUCKET_BASE_URL} (e.g. `"gazetteer/2026-07-07a/candidate.db"`).
	 */
	remotePath: string
	/**
	 * Where the artifact lands, relative to the data root (e.g. `"wof/candidate.db"`). For a `family`-tagged (`"us"`
	 * bundle) artifact this is the LEGACY unversioned path; {@link resolveBundleArtifacts} substitutes the manifest-pinned
	 * versioned name when one is configured.
	 */
	localPath: string
	/**
	 * Whether the bucket publishes a `<remotePath>.md5` sidecar to verify against. `false` for every artifact today
	 * (surveyed 2026-08-03 — see the module docstring); the field exists so a bundle that starts publishing one needs no
	 * shape change, only a flip.
	 */
	md5Sidecar: boolean
	/**
	 * Byte size at survey time — for the dry-run plan and `data status`'s human-readable sizes only. NOT a integrity
	 * check target (a rebuild at the same dated path would be a bug, since these paths are meant to be immutable, but
	 * this field is not how a mismatch would be caught — the HEAD `Content-Length` at pull time is).
	 */
	approxBytes: number
	/**
	 * The `data-release.ts` family this artifact belongs to (`"address-points"` | `"interpolation"`), for the `us`
	 * bundle's per-state shards only. Absent for every other bundle (candidate/poi/fr are single fixed-path artifacts
	 * with no local version-pinning story).
	 */
	family?: "address-points" | "interpolation"
	/**
	 * The 2-letter US state/territory slug this artifact belongs to, alongside {@link family}.
	 */
	stateSlug?: string
}

/**
 * A named, downloadable slice of Mailwoman's public data — what `mailwoman data pull <name>` fetches.
 */
export interface DataBundle {
	name: string
	description: string
	artifacts: BundleArtifact[]
}

/**
 * Per-state hosted street-tier sizes (bytes), from the 2026-08-03 bucket survey — the source table
 * {@link usStreetArtifacts} expands into `BundleArtifact` entries. `interp` is absent for `vi` (no TIGER interpolation
 * shard hosted for the territory — a real, confirmed gap, not a table-entry someone forgot).
 */
const US_STREET_SHARD_SIZES: Record<string, { situs: number; interp?: number }> = {
	ak: { situs: 78_602_240, interp: 26_771_456 },
	al: { situs: 660_025_344, interp: 256_548_864 },
	ar: { situs: 396_853_248, interp: 201_338_880 },
	az: { situs: 907_603_968, interp: 207_245_312 },
	ca: { situs: 3_471_339_520, interp: 779_272_192 },
	co: { situs: 716_697_600, interp: 216_334_336 },
	ct: { situs: 256_991_232, interp: 94_732_288 },
	dc: { situs: 119_889_920, interp: 7_426_048 },
	de: { situs: 125_595_648, interp: 29_114_368 },
	fl: { situs: 3_226_046_464, interp: 511_512_576 },
	ga: { situs: 173_764_608, interp: 365_641_728 },
	hi: { situs: 77_320_192, interp: 13_205_504 },
	ia: { situs: 358_260_736, interp: 193_032_192 },
	id: { situs: 93_683_712, interp: 82_628_608 },
	il: { situs: 1_134_772_224, interp: 373_002_240 },
	in: { situs: 767_078_400, interp: 301_297_664 },
	ks: { situs: 240_205_824, interp: 147_968_000 },
	ky: { situs: 545_275_904, interp: 292_974_592 },
	la: { situs: 63_488_000, interp: 165_015_552 },
	ma: { situs: 865_357_824, interp: 163_999_744 },
	md: { situs: 594_812_928, interp: 147_357_696 },
	me: { situs: 165_101_568, interp: 86_224_896 },
	mi: { situs: 229_376_000, interp: 305_459_200 },
	mn: { situs: 646_877_184, interp: 269_025_280 },
	mo: { situs: 399_859_712, interp: 305_311_744 },
	ms: { situs: 271_257_600, interp: 175_767_552 },
	mt: { situs: 146_735_104, interp: 88_612_864 },
	nc: { situs: 1_380_876_288, interp: 512_188_416 },
	nd: { situs: 103_890_944, interp: 76_918_784 },
	ne: { situs: 187_617_280, interp: 103_297_024 },
	nh: { situs: 20_480, interp: 57_618_432 },
	nj: { situs: 932_855_808, interp: 166_936_576 },
	nm: { situs: 249_671_680, interp: 83_804_160 },
	nv: { situs: 6_553_600, interp: 69_890_048 },
	ny: { situs: 1_440_923_648, interp: 317_833_216 },
	oh: { situs: 1_248_694_272, interp: 404_860_928 },
	ok: { situs: 354_828_288, interp: 162_582_528 },
	or: { situs: 1_034_625_024, interp: 173_268_992 },
	pa: { situs: 269_873_152, interp: 482_373_632 },
	ri: { situs: 79_159_296, interp: 28_938_240 },
	sc: { situs: 47_661_056, interp: 255_586_304 },
	sd: { situs: 21_811_200, interp: 71_929_856 },
	tn: { situs: 887_808_000, interp: 365_576_192 },
	tx: { situs: 2_568_024_064, interp: 721_600_512 },
	ut: { situs: 363_622_400, interp: 86_228_992 },
	va: { situs: 933_728_256, interp: 371_740_672 },
	vi: { situs: 618_496 },
	vt: { situs: 72_945_664, interp: 58_507_264 },
	wa: { situs: 735_141_888, interp: 267_419_648 },
	wi: { situs: 340_619_264, interp: 184_680_448 },
	wv: { situs: 227_700_736, interp: 120_385_536 },
	wy: { situs: 51_003_392, interp: 37_691_392 },
}

/**
 * Expand {@link US_STREET_SHARD_SIZES} into the `us` bundle's artifact list: `remotePath` mirrors the bucket's
 * `street/us/<slug>/{situs,interp}.db` layout; `localPath` mirrors `geocode-core.ts`'s
 * `address-points-us-<slug>.db`/`interpolation-us-<slug>.db` legacy (unversioned) convention.
 */
function usStreetArtifacts(): BundleArtifact[] {
	const artifacts: BundleArtifact[] = []

	for (const [slug, sizes] of Object.entries(US_STREET_SHARD_SIZES)) {
		artifacts.push({
			remotePath: `street/us/${slug}/situs.db`,
			localPath: `address-points/address-points-us-${slug}.db`,
			md5Sidecar: false,
			approxBytes: sizes.situs,
			family: "address-points",
			stateSlug: slug,
		})

		if (sizes.interp) {
			artifacts.push({
				remotePath: `street/us/${slug}/interp.db`,
				localPath: `interpolation/interpolation-us-${slug}.db`,
				md5Sidecar: false,
				approxBytes: sizes.interp,
				family: "interpolation",
				stateSlug: slug,
			})
		}
	}

	return artifacts
}

/**
 * The bundle registry. Every artifact here was CONFIRMED against the live bucket on 2026-08-03 (see the module
 * docstring) — no invented paths. `timezone` (named in this task's brief as a candidate bundle) is absent on purpose:
 * nothing under `mailwoman/` in the bucket serves it.
 */
export const BUNDLES: Record<string, DataBundle> = {
	candidate: {
		name: "candidate",
		description:
			"Global admin candidate gazetteer — population-first place resolution + postcode coverage across 244 countries (~1.65 GB).",
		artifacts: [
			{
				remotePath: "gazetteer/2026-07-07a/candidate.db",
				localPath: "wof/candidate.db",
				md5Sidecar: false,
				approxBytes: 1_652_916_224,
			},
		],
	},
	poi: {
		name: "poi",
		description: "Overture-places POI layer — 13.68M rows across US/CA/MX/FR (~3.89 GB).",
		artifacts: [
			{
				remotePath: "poi/2026-07-20a/poi.db",
				localPath: "poi/poi.db",
				md5Sidecar: false,
				approxBytes: 3_889_184_768,
			},
		],
	},
	fr: {
		name: "fr",
		description: "French national rooftop address-point shard (BAN) — situs-only, no interpolation tier (~6.95 GB).",
		artifacts: [
			{
				remotePath: "street/fr/2026-07-10/situs.db",
				localPath: "ban/address-points-fr.db",
				md5Sidecar: false,
				approxBytes: 6_952_509_440,
			},
		],
	},
	us: {
		name: "us",
		description:
			"US national street tier — per-state rooftop address-point (situs) + TIGER interpolation shards, " +
			"50 states + DC + VI (103 files, ~41.3 GB total). Use --only <slug> to pull a single state.",
		artifacts: usStreetArtifacts(),
	},
}

/**
 * Resolve `${PUBLIC_BUCKET_BASE_URL}${artifact.remotePath}` — the one place that string gets built.
 */
export function artifactURL(artifact: BundleArtifact): string {
	return `${PUBLIC_BUCKET_BASE_URL}${artifact.remotePath}`
}

/**
 * Map a bundle's artifacts against a (possibly `null`) local `releases.json` manifest, resolving each `family`-tagged
 * artifact's {@link BundleArtifact.localPath} to the VERSIONED filename (`resolveShardPath`'s naming convention:
 * `<family>/<family>-us-<slug>-<version>.db`) when the manifest pins that family to a version — so a download lands
 * exactly where `resolveShardPath` (`data-release.ts`) will find it on the next `mailwoman geocode` run. Artifacts with
 * no `family` (candidate/poi/fr — single fixed-path downloads) pass through unchanged; a family artifact with no
 * matching manifest entry also passes through unchanged (the legacy unversioned path, `resolveShardPath`'s fallback).
 *
 * Pure: no filesystem access. This computes the intended DESTINATION path; whether something already exists there (or
 * at a differently-versioned path `resolveShardPath` would also accept) is the caller's `existsSync`/
 * `resolveShardPath` check, not this function's.
 */
export function resolveBundleArtifacts(bundle: DataBundle, manifest: DataReleaseManifest | null): BundleArtifact[] {
	return bundle.artifacts.map((artifact) => {
		if (!artifact.family || !artifact.stateSlug) return artifact

		const version = manifest?.[artifact.family]

		if (!version) return artifact

		return {
			...artifact,
			localPath: `${artifact.family}/${artifact.family}-us-${artifact.stateSlug}-${version}.db`,
		}
	})
}

/**
 * Filter a resolved artifact list to those whose `remotePath`, `localPath`, or `stateSlug` contains `only`
 * (case-insensitive). `undefined`/empty `only` returns `artifacts` unchanged. Lets `data pull us --only nh` target one
 * state instead of the whole 41 GB tier — the CLI-facing complement to the bundle-level granularity above.
 */
export function filterArtifacts(artifacts: readonly BundleArtifact[], only: string | undefined): BundleArtifact[] {
	if (!only) return [...artifacts]

	const needle = only.toLowerCase()

	return artifacts.filter(
		(a) =>
			a.remotePath.toLowerCase().includes(needle) ||
			a.localPath.toLowerCase().includes(needle) ||
			a.stateSlug?.toLowerCase() === needle
	)
}

/**
 * What's on disk for one artifact, gathered by the caller (a `statSync` + optional `md5File`) — kept separate from the
 * gathering itself so {@link needsDownload} stays pure and unit-testable without a filesystem.
 */
export interface LocalArtifactState {
	exists: boolean
	sizeBytes?: number
	md5?: string
}

/**
 * What the remote object currently reports, gathered by the caller (an HTTP HEAD via `APIClient`, and — when
 * {@link BundleArtifact.md5Sidecar} is true — a fetch of the `.md5` sidecar text).
 */
export interface RemoteArtifactState {
	contentLength?: number
	md5?: string
}

/**
 * Decide whether an artifact needs downloading: absent locally → yes. An available md5 (sidecar present) is the
 * authoritative signal once local exists — mismatch → yes, match → no, checked BEFORE content-length so a bundle that
 * publishes a sidecar can't be short-circuited by a coincidentally-matching size. With no md5 to compare, fall back to
 * a `Content-Length` size comparison. With NEITHER signal available, the artifact is treated as up to date (the caller
 * is expected to surface a "couldn't verify" warning in that case, not force a redundant multi-GB re-fetch).
 */
export function needsDownload(local: LocalArtifactState, remote: RemoteArtifactState): boolean {
	if (!local.exists) return true

	if (remote.md5 !== undefined) {
		return local.md5 !== remote.md5
	}

	if (remote.contentLength !== undefined && local.sizeBytes !== undefined) {
		return local.sizeBytes !== remote.contentLength
	}

	return false
}
