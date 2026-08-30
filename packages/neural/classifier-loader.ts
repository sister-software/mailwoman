/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The Node-only classifier factory: resolve the weights package, load the tokenizer and ONNX runner, wire every
 *   evidence channel, and hand back a ready `NeuralAddressClassifier`. Split from `classifier.ts` so the class stays
 *   browser-bundlable; the class's `loadFromWeights` static reaches this module through a `webpackIgnore` dynamic
 *   import, which is the same crossing the module itself uses for `onnxruntime-node`.
 */

import type { SystemCode } from "@mailwoman/codex"
import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"

import { DEFAULT_INTRA_OP_THREADS, ONNXRunner } from "#onnx-runner"

import { parseAnchorLookup, type AnchorLookup } from "./anchor-inference.ts"
import { NeuralAddressClassifier } from "./classifier.ts"
import { parseCountryLexicon } from "./country-inference.ts"
import type { CountryLexicon } from "./country-inference.ts"
import { parseGazetteerLexicon } from "./gazetteer-inference.ts"
import type { GazetteerLexicon } from "./gazetteer-inference.ts"
import { peekPairIndexHeader, PairIndexResolver } from "./pair-index-resolver.ts"
import type { PlacetypePairPriorOpts } from "./placetype-pair-prior.ts"
import { PostcodeBinaryResolver } from "./postcode-binary-resolver.ts"
import { parseSemiCRFTransitions, type SemiCRFTransitions } from "./semi-markov-decode.ts"
import { MailwomanTokenizer } from "./tokenizer.ts"
import type { ResolvedWeights, ResolveWeightsOpts } from "./weights.ts"

/**
 * One-call factory that resolves the weights package (or explicit paths), loads the tokenizer and ONNX runner, and
 * returns a ready-to-use classifier.
 *
 * Resolution order: explicit paths in `opts` → `@mailwoman/neural-weights-<locale>` package → throws a single
 * actionable error.
 *
 * **Node-only.** The dynamic imports keep `ONNXRunner` (onnxruntime-node) + `resolveWeights` (uses Node fs) out of the
 * static dependency graph, so this file can be bundled for the browser by `@mailwoman/neural-web`. Calling this method
 * in a browser will throw at runtime — use `loadNeuralClassifierFromURLs` from `@mailwoman/neural-web` instead.
 */
export async function loadClassifierFromWeights(
	opts: ResolveWeightsOpts & {
		postcodeAnchorLookup?: AnchorLookup
		executionProviders?: string[]
		intraOpNumThreads?: number
		/**
		 * Explicit `placetype-census-<cc>.bin` path, overriding the build-local data-root lookup (`loadPlacetypeCensus`).
		 * For a harness that built a census to a scratch directory — the data root is read-only on the lab host, so "build
		 * it and point at it" is the only way to exercise a FRESH artifact. A wrong-country file is still refused by the
		 * loader's header gate.
		 */
		placetypeCensusPath?: string
	} = {}
): Promise<NeuralAddressClassifier> {
	// The sanctioned crossing into the three Node-only modules. `webpackIgnore` leaves the import
	// statement intact, so it becomes a runtime native ESM import: resolvable in Node, and never
	// followed into the browser chunk graph, where `node:fs` and `onnxruntime-node`'s binaries would
	// fail to parse. A STATIC import of any of the three would be followed, which the lint rule guards.

	/* oxlint-disable typescript/no-restricted-imports -- webpackIgnore keeps these out of the bundle */
	const [
		{ $public },
		{
			resolveWeights,
			readLabelsFromModelCard,
			readCRFTransitions,
			readRequiredChannels,
			unfedAnchorDetail,
			unfedChannelWarner,
			loadPlacetypeCensus,
		},
	] = await Promise.all([
		import(/* webpackIgnore: true */ "@mailwoman/core/env"),
		import(/* webpackIgnore: true */ "./weights.ts"),
	])

	/* oxlint-enable typescript/no-restricted-imports */
	const resolved: ResolvedWeights = resolveWeights(opts)

	// The vocabulary belongs to the MODEL, so an overlay that shares a base model inherits it rather than
	// restating it. A carrier package's own card describes the overlay — its version, its own artifacts —
	// and omitting `labels` there is correct; copying them in would be a second copy to go stale on the
	// next retrain. Falling back is what keeps the two facts in one place.
	const labels = readLabelsFromModelCard(resolved.modelCardPath) ?? readLabelsFromModelCard(resolved.baseModelCardPath)

	const crf = await readCRFTransitions(resolved.crfTransitionsPath)
	// #727 stage-2: parse the span head's segment-transition grammar when the bundle ships it (v3+). Failure to parse
	// is non-fatal — the model still classifies; only the phase-4c k-best rerank goes unavailable (spanGrammar stays
	// undefined).
	let semiCRFGrammar: SemiCRFTransitions | undefined

	if (resolved.semiCRFTransitionsPath) {
		try {
			semiCRFGrammar = parseSemiCRFTransitions(await readLocalJSONFile(resolved.semiCRFTransitionsPath))
		} catch (error) {
			console.error(
				`[mailwoman/neural] loadFromWeights: failed to parse ${resolved.semiCRFTransitionsPath} — ` +
					`the #727 phase-4c k-best rerank is unavailable (spanGrammar undefined): ${(error as Error).message}`
			)
		}
	}

	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(resolved.tokenizerPath),
		ONNXRunner.create(resolved.modelPath, {
			executionProviders: opts.executionProviders,
			// Cap the intra-op pool. Left unset, ORT sizes it to the core count, so N concurrent processes
			// each claim the whole machine — the multiplier behind the CLI spawn-test timeouts. Measured
			// 2026-08-03 over 120 parses: 1 thread costs 18.3 ms/parse against 9.3 for all-cores (a 97%
			// regression — the parallelism IS doing work), 2 costs 12.5, and 4 is 9.2 — flat against the
			// default while claiming a quarter of the threads. So the cap is free at 4 and expensive at 1;
			// do not "simplify" it downward without re-running that curve.
			// Explicit opt > deployment env > compromise default. The env layer exists because the right
			// value is a property of how many processes share the host, which this library cannot see.
			intraOpNumThreads: opts.intraOpNumThreads ?? $public.MAILWOMAN_INTRA_OP_THREADS ?? DEFAULT_INTRA_OP_THREADS,
		}),
	])

	// --- Soft-feed (#718 D1): feed the channels the SHIPPED model was trained against ----------
	// The anchor-trained en-us model goes OOD when scored anchor-OFF (the #566/#685 crater: country
	// ~0, region 71, locality 57 vs the server-tier 68/90/77). The browser loader already feeds the
	// channels from URLs; this is the Node-side mirror so EVERY consumer (ResolveRouter,
	// GeocodeRouter, geocode.tsx, the CLI) transparently gains them with no callsite change.
	//
	// SOFT: each channel is best-effort. A caller-passed `postcodeAnchorLookup` always wins. When
	// the model-card declares a channel REQUIRED but the package didn't ship its data, we warn ONCE
	// (mirroring neural-web's `warnOnUnfedTrainedChannels`) and run that channel OFF — never crash.
	const declared = readRequiredChannels(resolved.modelCardPath)

	let postcodeAnchorLookup = opts.postcodeAnchorLookup

	// Bound to THIS package, because the channel name alone is not enough: one process routinely loads several
	// (the gauntlet grades six locale overlays), and a warning naming none of them is read as being about
	// whichever package the reader has in mind — see `unfedChannelWarner`.
	const warnUnfedChannel = unfedChannelWarner(`${opts.locale ?? "en-us"} (${resolved.packageDir ?? resolved.source})`)

	if (!postcodeAnchorLookup && resolved.anchorLookupPath) {
		try {
			postcodeAnchorLookup = resolved.anchorLookupPath.binary
				? new PostcodeBinaryResolver(
						new Uint8Array(await readLocalBuffer(resolved.anchorLookupPath.path))
					).toAnchorLookup()
				: parseAnchorLookup(await readLocalJSONFile(resolved.anchorLookupPath.path))
		} catch (error) {
			warnUnfedChannel("anchor", `failed to parse ${resolved.anchorLookupPath.path}: ${(error as Error).message}`)
		}
	}

	// #1516: what this warning may speak about is what THIS package's OWN card declares it ships — not what the
	// shared encoder `requires`, which every overlay inherits. `unfedAnchorDetail` owns that decision (and
	// returns undefined for the packages that ship no binary on purpose, e.g. en-gb under #1476).
	const anchorDetail =
		declared?.anchor?.required && !(postcodeAnchorLookup && postcodeAnchorLookup.size)
			? unfedAnchorDetail(resolved.packageDir)
			: undefined

	if (anchorDetail) {
		warnUnfedChannel("anchor", anchorDetail)
	}

	let gazetteerLexicon: GazetteerLexicon | undefined

	if (resolved.gazetteerLexiconPath) {
		try {
			gazetteerLexicon = parseGazetteerLexicon(await readLocalJSONFile(resolved.gazetteerLexiconPath))
		} catch (error) {
			warnUnfedChannel("gazetteer", `failed to parse ${resolved.gazetteerLexiconPath}: ${(error as Error).message}`)
		}
	}

	// Pocket tier is anchor-only: `resolveWeights` already withholds the gazetteer path, so a
	// declared-required gazetteer is EXPECTED to be unfed there — don't warn. Otherwise warn.
	if (declared?.gazetteer?.required && !gazetteerLexicon && opts.tier !== "pocket") {
		warnUnfedChannel(
			"gazetteer",
			resolved.gazetteerLexiconPath
				? `lexicon at ${resolved.gazetteerLexiconPath} could not be parsed`
				: `no anchor-lexicon-v1.json found in the weights package`
		)
	}

	// Country-lexicon channel (#1104): same soft-feed pattern. Ships with the server tier; pocket is anchor-only.
	let countryLexicon: CountryLexicon | undefined

	if (resolved.countryLexiconPath) {
		try {
			countryLexicon = parseCountryLexicon(await readLocalJSONFile(resolved.countryLexiconPath))
		} catch (error) {
			warnUnfedChannel("country", `failed to parse ${resolved.countryLexiconPath}: ${(error as Error).message}`)
		}
	}

	if (declared?.country?.required && !countryLexicon && opts.tier !== "pocket") {
		warnUnfedChannel(
			"country",
			resolved.countryLexiconPath
				? `lexicon at ${resolved.countryLexiconPath} could not be parsed`
				: `no country-surface-lexicon-v1.json found in the weights package`
		)
	}

	// Evidence-bundle lexicons (Option-A, Phase 2): same soft-feed pattern; degrade-absent for every
	// pre-bundle package. `requires`-declared enforcement arrives with the first bundle-trained card.
	let streetTypeLexicon: GazetteerLexicon | undefined

	if (resolved.streetTypeLexiconPath) {
		try {
			streetTypeLexicon = parseGazetteerLexicon(await readLocalJSONFile(resolved.streetTypeLexiconPath))
		} catch (error) {
			warnUnfedChannel("street_type", `failed to parse ${resolved.streetTypeLexiconPath}: ${(error as Error).message}`)
		}
	}

	let localitySurfaceLexicon: GazetteerLexicon | undefined

	if (resolved.localitySurfaceLexiconPath) {
		try {
			localitySurfaceLexicon = parseGazetteerLexicon(await readLocalJSONFile(resolved.localitySurfaceLexiconPath))
		} catch (error) {
			warnUnfedChannel(
				"locality_surface",
				`failed to parse ${resolved.localitySurfaceLexiconPath}: ${(error as Error).message}`
			)
		}
	}

	// Placetype-pair index sibling (placetype-pair-prior arc): construct a PairIndexResolver
	// when the package shipped one for this country. HARD COUNTRY GATE — an index built for one
	// country must never bias a parse resolved for a different locale (a mismatch is a packaging bug,
	// not something to apply anyway): the index header's `country` must equal the resolved locale's
	// country subtag, or the default is skipped with a single warning naming both. Unlike the
	// anchor/gazetteer/country soft-feed channels above, there is no "declared required" fail-closed
	// case here — the prior is opt-in plumbing, so a missing/mismatched index degrades silently to the
	// byte-stable no-prior default, loud only via the gate warning.
	//
	// Header peek before construction: the country check reads ONLY the magic +
	// header block via `peekPairIndexHeader` — no entry parsing, no Map build — so a mismatched index
	// never pays the full-parse cost just to be discarded. The `PairIndexResolver` constructor (which
	// DOES walk every entry) only runs once the gate has already confirmed the country match.
	let placetypePair: PlacetypePairPriorOpts | undefined

	if (resolved.pairIndexPath) {
		try {
			const pairIndexBytes = new Uint8Array(await readLocalBuffer(resolved.pairIndexPath))
			const peekedHeader = peekPairIndexHeader(pairIndexBytes)
			const localeCountry = (opts.locale ?? "en-us").toLowerCase().split("-")[1] ?? ""

			if (peekedHeader.country === localeCountry) {
				// `parentDelta` (#46, the whole-edge parent bias) rides the ARTIFACT, exactly as `delta` and
				// `transitionBeta` do — the prior reads `PairIndexResolver.parentDelta` off the header, so a
				// calibrated locale (us/gb/nz/fr at 5) is default-on and an unmeasured one (de/in/es/it, no header
				// field) stays off, with no code here knowing which is which. The env is an OVERRIDE for eval
				// sweeps only and wins when set; see `MAILWOMAN_PAIR_PARENT_DELTA` in `core/env/schema.ts`.
				placetypePair = {
					index: new PairIndexResolver(pairIndexBytes),
					...($public.MAILWOMAN_PAIR_PARENT_DELTA === undefined
						? {}
						: { parentDelta: $public.MAILWOMAN_PAIR_PARENT_DELTA }),
				}
			} else {
				console.warn(
					`[mailwoman/neural] loadFromWeights: pair-index country "${peekedHeader.country}" ` +
						`(${resolved.pairIndexPath}) does not match the resolved locale's country "${localeCountry}" — ` +
						`skipping the placetype-pair prior default.`
				)
			}
		} catch (error) {
			console.error(
				`[mailwoman/neural] loadFromWeights: failed to parse ${resolved.pairIndexPath}: ${(error as Error).message}`
			)
		}
	}

	// PCN1 placetype census (observability rung, 2026-08-05): BUILD-LOCAL, not a weights-package sibling — the
	// loader and the reasons live together in `loadPlacetypeCensus`. Absent artifact → `undefined` → the feature is
	// entirely inert, silently, because not having built it is the normal state for every consumer.
	const placetypeCensus = await loadPlacetypeCensus(
		(opts.locale ?? "en-us").toLowerCase().split("-")[1] ?? "",
		opts.placetypeCensusPath
	)

	// Near-postcode gazetteer choreography + conventions mode: drive them off the card's declared
	// SHIP-CONFIG (mirrors createScorer / the browser loader defaults), inert when the source
	// channel is absent. Byte-stable for a non-anchor card (no `requires` → all undefined/false).
	// The anchor span mode is card-declared too, never inferred: an undeclared card leaves it
	// undefined and the channel keeps the alnum-run scan verbatim.
	const suppressGazetteerNearPostcode = declared?.suppress_gazetteer_near_postcode ?? false
	const addressSystemConventions = declared?.conventions?.required ? (declared.conventions.mode ?? "auto") : undefined

	return new NeuralAddressClassifier({
		tokenizer,
		runner,
		labels,
		transitions: crf?.transitions,
		startTransitions: crf?.startTransitions,
		endTransitions: crf?.endTransitions,
		...(semiCRFGrammar ? { semiCRFGrammar } : {}),
		...(postcodeAnchorLookup ? { postcodeAnchorLookup, postcodeAnchorSpanMode: declared?.anchor?.span_mode } : {}),
		...(gazetteerLexicon ? { gazetteerLexicon } : {}),
		...(streetTypeLexicon ? { streetTypeLexicon } : {}),
		...(localitySurfaceLexicon ? { localitySurfaceLexicon } : {}),
		...(countryLexicon ? { countryLexicon } : {}),
		...(placetypePair ? { placetypePair } : {}),
		...(placetypeCensus ? { placetypeCensus } : {}),
		...(resolved.fstPath ? { fstPath: resolved.fstPath } : {}),
		...(resolved.streetMorphologyPath ? { streetMorphologyPath: resolved.streetMorphologyPath } : {}),
		modelPath: resolved.modelPath,
		weightsSource: resolved.source,
		...(suppressGazetteerNearPostcode ? { suppressGazetteerNearPostcode } : {}),
		// The card's `mode` is an open string; a non-SystemCode value degrades to a null conventions row
		// downstream (`conventionsForSystem` on an unknown code), never a throw — so the widening cast is
		// runtime-safe. An overlay card may pin a concrete system here (en-gb pins "gb", #1275) when the
		// locale head's auto detection under-fires for the bundle's own locale.
		...(addressSystemConventions ? { addressSystemConventions: addressSystemConventions as "auto" | SystemCode } : {}),
	})
}
