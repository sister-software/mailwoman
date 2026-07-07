/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared Gauntlet harness: build the full-pipeline geocode deps (optionally with a CANDIDATE model, so a
 *   gate can compare candidate-vs-production on the same inputs) and run one address end-to-end. The
 *   Gauntlet grades the ASSEMBLED output — coordinate + tier — not raw parse F1, the lesson this project
 *   paid for once (#566 / reconcile-retirement).
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { OSMShardProvider } from "@mailwoman/osm/sdk"
import { createWOFResolver } from "@mailwoman/resolver"
import { type GeocodeResult, geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import { createResolverBackend, mailwomanDataRoot, wofShardPaths } from "mailwoman/resolver-backend"

export interface GauntletDeps {
	geocode(input: string): Promise<GeocodeResult>
	close(): void
}

/**
 * #1024 drift guard: the materialized `neural-weights-en-us/model.onnx` the gate is about to grade MUST match the
 * model-card's `files_md5["model.onnx"]` — the card (source of truth) and `release.config.json` (what copy-weights.ts
 * materializes from) drifted once and the superseded model shipped past a silent gate. Throws loudly on mismatch so the
 * release before:release step (RELEASING.md) blocks the ship. Only the shipped default is checked; a `--candidate` run
 * grades a different artifact by design. Soft-returns when the card / field is absent (a card-format problem is not
 * this guard's job) — the model file itself is always present here (the caller `existsSync`-gated it).
 */
function assertShippedModelMatchesCard(materializedMd5: string): void {
	const cardPath = resolve("neural-weights-en-us/model-card.json")

	if (!existsSync(cardPath)) return
	const card = JSON.parse(readFileSync(cardPath, "utf8")) as { version?: string; files_md5?: Record<string, string> }
	const expected = card.files_md5?.["model.onnx"]

	if (typeof expected !== "string") return

	if (materializedMd5 !== expected) {
		throw new Error(
			`[gauntlet] materialized model md5 ${materializedMd5} ≠ model-card files_md5["model.onnx"] ${expected} ` +
				`(neural-weights-en-us/model-card.json, v${card.version ?? "?"}). The card is the source of truth; ` +
				`release.config.json / the dev-weights symlink has DRIFTED from it (#1024). Re-materialize the card's model ` +
				`(scripts/copy-weights.ts) or fix release.config.json weights.model before gating/shipping.`
		)
	}
}

/**
 * Build the geocode deps. `modelPath` swaps ONLY the ONNX (same tokenizer/card/anchor/gazetteer soft-feed), so the
 * held-out gate can grade a candidate against production fairly; omit it for the shipped default.
 */
export async function buildGauntletDeps(opts: { modelPath?: string } = {}): Promise<GauntletDeps> {
	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	// Transparency: stamp the model under test so a stale dev symlink (the d6812bc7 trap — the default
	// loadFromWeights symlink can point at an old training base, not the shipped model) is never silent.
	const effModel = opts.modelPath ? resolve(opts.modelPath) : resolve("neural-weights-en-us/model.onnx")

	if (existsSync(effModel)) {
		const md5 = createHash("md5").update(readFileSync(effModel)).digest("hex")
		console.error(`[gauntlet] model under test: ${effModel.split("/").slice(-2).join("/")} (md5 ${md5.slice(0, 8)})`)

		// #1024: the transparency stamp exposed a config↔card drift once (release.config.json still pointed at
		// v220 a64ad2e6 while the v5.4.0 promote shipped v230 ea785a70), so copy-weights.ts materialized the
		// SUPERSEDED model and this gate SILENTLY graded it — a full bisect detour. Make the stamp ASSERT: the
		// shipped default must match the model-card's files_md5 (the card is the source of truth). A `--candidate`
		// run intentionally grades a different artifact, so it is exempt. This gate is wired as the release
		// before:release step (RELEASING.md), so failing here guards BOTH the gate and the ship.
		if (!opts.modelPath) {
			assertShippedModelMatchesCard(md5)
		}
	}
	const classifier = opts.modelPath
		? await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", modelPath: resolve(opts.modelPath) })
		: await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const resolver = createWOFResolver(
		createResolverBackend(resolverMod, { wofPaths: wofShardPaths().filter(existsSync) })
	)
	const shardProvider = new ShardProvider(resolverMod, mailwomanDataRoot())
	const osmProvider = new OSMShardProvider(mailwomanDataRoot())

	return {
		geocode: (input: string) =>
			geocodeAddress(input, { classifier, resolver, shards: shardProvider.for, osmShards: osmProvider.for }),
		close: () => {
			shardProvider.close()
			osmProvider.close()
		},
	}
}

/** The slice of the assembled result the Gauntlet asserts on. */
export interface GauntletResult {
	lat: number | null
	lon: number | null
	tier: GeocodeResult["resolution_tier"]
	locality: string | null
	region: string | null
	country: string | null
	postcode: string | null
}

export async function runOne(input: string, deps: GauntletDeps): Promise<GauntletResult> {
	const g = await deps.geocode(input)

	return {
		lat: g.lat,
		lon: g.lon,
		tier: g.resolution_tier,
		locality: g.locality,
		region: g.region,
		country: g.hierarchy.find((h) => h.tag === "country")?.value ?? null,
		postcode: g.postcode,
	}
}
