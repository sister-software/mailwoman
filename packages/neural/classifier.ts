/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `NeuralAddressClassifier` ties together the tokenizer, the ONNX inference runner, and the
 *   `@mailwoman/core` decoder. Single user-facing entrypoint: `parse(text)` returns an
 *   `AddressTree` ready for projection into JSON / tuple / XML.
 *
 *   Convenience wrappers `parseJSON` / `parseTuples` / `parseXML` project the tree on the way out.
 */

import { conventionsForSystem, type SystemCode } from "@mailwoman/codex"
import {
	buildAddressTree,
	decodeAsJSON,
	decodeAsTuples,
	decodeAsXML,
	type AddressTree,
	type ComponentTag,
	type DecoderToken,
	type SerializeJSONOpts,
	type SerializeTuplesOpts,
	type UnknownSpan,
} from "@mailwoman/core/decoder"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { proposeSpans, type ProposedSpan, WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"

// SELF-REFERENCE, not a relative path: export conditions do not apply to relative specifiers, so
// `./onnx-runner.ts` bypasses the browser counterpart. The package name is what routes this.
import { DEFAULT_INTRA_OP_THREADS, type InferResult, ONNXRunner } from "#onnx-runner"

import { confidentLocaleCountry, LOCALE_COUNTRIES, resolveSystemVerdict } from "./address-system.ts"
import { type AnchorLookup, parseAnchorLookup } from "./anchor-inference.ts"
import { normalizeInputCase } from "./case-normalize.ts"
import type {
	NeuralAddressClassifierConfig,
	ParseOpts,
	ParseWithLogitsResult,
	SpanProposerConfig,
} from "./classifier-options.ts"
import { type CountryLexicon, parseCountryLexicon } from "./country-inference.ts"
import { buildFSTEmissionPriors } from "./fst-prior.ts"
import { type GazetteerLexicon, parseGazetteerLexicon } from "./gazetteer-inference.ts"
import { STAGE2_BIO_LABELS } from "./labels.ts"
import { PairIndexResolver, peekPairIndexHeader } from "./pair-index-resolver.ts"
import type { PlacetypeCensusLike } from "./placetype-census.ts"
import {
	buildPlacetypePairPriors,
	type PlacetypePairPriorOpts,
	type PlacetypePairProbeTrace,
} from "./placetype-pair-prior.ts"
import { PostcodeBinaryResolver } from "./postcode-binary-resolver.ts"
import { repairPostcodeLabels } from "./postcode-repair.ts"
import { addEmissionMatrix, buildEmissionPriors } from "./query-shape-prior.ts"
import { parseSemiCRFTransitions, type SemiCRFTransitions } from "./semi-markov-decode.ts"
import { buildSoftFeatures, type SoftFeatureChannel } from "./soft-features.ts"
import { bridgePunctuationGaps } from "./span-bridge.ts"
import { buildSpanProposalPriors } from "./span-proposal-prior.ts"
import { buildCodexSpanLexicon } from "./span-proposer-lexicon.ts"
import { buildStreetMorphologyEmissionPriors } from "./street-morphology-prior.ts"
import { MailwomanTokenizer } from "./tokenizer.ts"
import { TRACE_PRIOR_KINDS } from "./trace.ts"
import type { NeuralParseTrace, TracePrior, TraceRepair, TraceRepairPass } from "./trace.ts"
import { repairUnitLabels } from "./unit-repair.ts"
import { buildBIOEndMask, buildBIOStartMask, buildBIOTransitionMask, softmax, viterbi } from "./viterbi.ts"
import type { ResolveWeightsOpts, ResolvedWeights } from "./weights.ts"
import { enforceWordConsistency } from "./word-consistency.ts"

export type {
	NeuralAddressClassifierConfig,
	ParseOpts,
	ParseWithLogitsResult,
	SpanProposerConfig,
} from "./classifier-options.ts"

/**
 * Structural type the classifier needs from a runner. Lets callers swap the Node-side `ONNXRunner` for a browser-side
 * runner (e.g. `@mailwoman/neural-web`'s `WebONNXRunner`) without inheritance — the classifier only ever calls
 * `infer(ids)`.
 */
export interface NeuralRunner {
	infer(
		tokenIDs: number[],
		anchor?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> },
		gazetteer?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> },
		country?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> },
		evidence?: {
			streetType?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> }
			localitySurface?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> }
		}
	): Promise<InferResult>
}

/**
 * The parse-facing tree, with the locale head's confident verdict riding along when there is one (#1684) — shared by
 * `parse` and `parseWithLogits` so the two tree paths cannot drift on the stamp.
 */
function treeWithLocaleCountry(
	text: string,
	tokens: DecoderToken[],
	calibrate: { calibrate: NonNullable<ParseOpts["calibrate"]> } | undefined,
	localeCountry: { country: string; confidence: number } | null
): AddressTree {
	return Object.assign(buildAddressTree(text, tokens, calibrate), localeCountry ? { localeCountry } : {})
}

export class NeuralAddressClassifier {
	private readonly labels: readonly string[]
	private readonly decodeMode: "viterbi" | "argmax"
	private readonly transitions: number[][]
	/**
	 * Lazily-built default Stage 2.7 config (codex lexicon, frozen scales) — see `cfg.spanProposer`.
	 */
	#defaultProposerCfg: SpanProposerConfig | undefined
	private readonly startTransitions: number[]
	private readonly endTransitions: number[]
	private readonly cfg: NeuralAddressClassifierConfig

	constructor(cfg: NeuralAddressClassifierConfig) {
		this.cfg = cfg
		this.labels = cfg.labels ?? STAGE2_BIO_LABELS
		this.decodeMode = cfg.decode ?? "viterbi"
		const structural = buildBIOTransitionMask(this.labels)

		this.transitions = cfg.transitions ? addMatrices(structural, cfg.transitions) : structural
		this.startTransitions = cfg.startTransitions ?? buildBIOStartMask(this.labels)
		this.endTransitions = cfg.endTransitions ?? buildBIOEndMask(this.labels)
	}

	/**
	 * The parsed semi-Markov segment-transition grammar (`semi-crf-transitions.json`), when the loaded bundle shipped it.
	 * Consumed by the #727 phase-4c k-best name-evidence rerank; `undefined` on a pre-v3 (span-less) bundle.
	 */
	get spanGrammar(): SemiCRFTransitions | undefined {
		return this.cfg.semiCRFGrammar
	}

	/**
	 * Path to the per-locale FST gazetteer binary (`fst-<locale>.bin`) when the resolved weights package shipped one,
	 * else `undefined`. The runtime pipeline deserializes + auto-wires it as the default `opts.fst` (opt out with `fst:
	 * false` at pipeline construction); direct `classifier.parse` callers can do the same or pass their own.
	 */
	get fstPath(): string | undefined {
		return this.cfg.fstPath
	}

	/**
	 * Path to the locale-general street-morphology FST (`fst-street-morphology.bin`) when the resolved weights package
	 * (or its base) shipped one, else `undefined`. The runtime pipeline's street-context gate (#1315) deserializes it
	 * through the shared loader ladder instead of rebuilding from the libpostal dictionaries per process.
	 */
	get streetMorphologyPath(): string | undefined {
		return this.cfg.streetMorphologyPath
	}

	/**
	 * The `model.onnx` this instance loaded, and which rung of the resolution ladder produced it.
	 *
	 * `undefined` on an instance built through the plain constructor rather than {@link loadFromWeights} — there was no
	 * resolution, so there is nothing to report, which is absence and not an unknown model.
	 */
	get resolvedWeights(): { modelPath: string; source: string } | undefined {
		return this.cfg.modelPath && this.cfg.weightsSource
			? { modelPath: this.cfg.modelPath, source: this.cfg.weightsSource }
			: undefined
	}

	/**
	 * The default-ON Stage 2.7 config: codex lexicon (us/au/nz), frozen measured scales (the prior builder's own
	 * defaults). Built once per instance, only when a parse actually needs it.
	 */
	private defaultProposer(): SpanProposerConfig {
		this.#defaultProposerCfg ??= { lexicon: buildCodexSpanLexicon() }

		return this.#defaultProposerCfg
	}

	/**
	 * One-call factory that resolves the weights package (or explicit paths), loads the tokenizer and ONNX runner, and
	 * returns a ready-to-use classifier.
	 *
	 * Resolution order: explicit paths in `opts` → `@mailwoman/neural-weights-<locale>` package → throws a single
	 * actionable error.
	 *
	 * **Node-only.** The dynamic imports keep `ONNXRunner` (onnxruntime-node) + `resolveWeights` (uses Node fs) out of
	 * the static dependency graph, so this file can be bundled for the browser by `@mailwoman/neural-web`. Calling this
	 * method in a browser will throw at runtime — use `loadNeuralClassifierFromURLs` from `@mailwoman/neural-web`
	 * instead.
	 */
	static async loadFromWeights(
		opts: ResolveWeightsOpts & {
			postcodeAnchorLookup?: AnchorLookup
			executionProviders?: string[]
			intraOpNumThreads?: number
			/**
			 * Explicit `placetype-census-<cc>.bin` path, overriding the build-local data-root lookup (`loadPlacetypeCensus`).
			 * For a harness that built a census to a scratch directory — the data root is read-only on the lab host, so
			 * "build it and point at it" is the only way to exercise a FRESH artifact. A wrong-country file is still refused
			 * by the loader's header gate.
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
			fs,
		] = await Promise.all([
			import(/* webpackIgnore: true */ "@mailwoman/core/env"),
			import(/* webpackIgnore: true */ "./weights.ts"),
			import(/* webpackIgnore: true */ "node:fs"),
		])

		/* oxlint-enable typescript/no-restricted-imports */
		const resolved: ResolvedWeights = resolveWeights(opts)

		// The vocabulary belongs to the MODEL, so an overlay that shares a base model inherits it rather than
		// restating it. A carrier package's own card describes the overlay — its version, its own artifacts —
		// and omitting `labels` there is correct; copying them in would be a second copy to go stale on the
		// next retrain. Falling back is what keeps the two facts in one place.
		const labels =
			readLabelsFromModelCard(resolved.modelCardPath) ?? readLabelsFromModelCard(resolved.baseModelCardPath)

		const crf = readCRFTransitions(resolved.crfTransitionsPath)
		// #727 stage-2: parse the span head's segment-transition grammar when the bundle ships it (v3+). Failure to parse
		// is non-fatal — the model still classifies; only the phase-4c k-best rerank goes unavailable (spanGrammar stays
		// undefined).
		let semiCRFGrammar: SemiCRFTransitions | undefined

		if (resolved.semiCRFTransitionsPath) {
			try {
				semiCRFGrammar = parseSemiCRFTransitions(
					parseJSONStrict(fs.readFileSync(resolved.semiCRFTransitionsPath, "utf8"))
				)
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
					? new PostcodeBinaryResolver(new Uint8Array(fs.readFileSync(resolved.anchorLookupPath.path))).toAnchorLookup()
					: parseAnchorLookup(parseJSONStrict(fs.readFileSync(resolved.anchorLookupPath.path, "utf8")))
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
				gazetteerLexicon = parseGazetteerLexicon(
					parseJSONStrict(fs.readFileSync(resolved.gazetteerLexiconPath, "utf8"))
				)
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
				countryLexicon = parseCountryLexicon(parseJSONStrict(fs.readFileSync(resolved.countryLexiconPath, "utf8")))
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
				streetTypeLexicon = parseGazetteerLexicon(
					parseJSONStrict(fs.readFileSync(resolved.streetTypeLexiconPath, "utf8"))
				)
			} catch (error) {
				warnUnfedChannel(
					"street_type",
					`failed to parse ${resolved.streetTypeLexiconPath}: ${(error as Error).message}`
				)
			}
		}

		let localitySurfaceLexicon: GazetteerLexicon | undefined

		if (resolved.localitySurfaceLexiconPath) {
			try {
				localitySurfaceLexicon = parseGazetteerLexicon(
					parseJSONStrict(fs.readFileSync(resolved.localitySurfaceLexiconPath, "utf8"))
				)
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
				const pairIndexBytes = new Uint8Array(fs.readFileSync(resolved.pairIndexPath))
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
		const placetypeCensus = loadPlacetypeCensus(
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
			...(addressSystemConventions
				? { addressSystemConventions: addressSystemConventions as "auto" | SystemCode }
				: {}),
		})
	}

	/**
	 * Tokenize → infer → Viterbi (or argmax) → decoder tree.
	 */
	async parse(text: string, opts?: ParseOpts): Promise<AddressTree> {
		if (!text.length) return { raw: text, roots: [] }
		// #690: title-case all-caps ASCII input so the mixed-case-trained model doesn't go OOD.
		// Detection-gated (mixed-case + non-ASCII untouched). Default-ON (#895 settled drift D2 — the geocode
		// path had run it since #713 while the pipeline factory + raw classifier defaulted off); `false`
		// restores the raw-case parse. ASCII title-case is char-for-char length-preserving, so token offsets
		// are unaffected; the tree is built from the normalized text (values come out title-cased — the
		// SHOUTING is gone, the resolver name-matches case-insensitively).
		const modelText = opts?.normalizeCase !== false ? normalizeInputCase(text) : text
		const { tokens, localeCountry } = await this.#decode(modelText, opts)

		return treeWithLocaleCountry(
			modelText,
			tokens,
			opts?.calibrate ? { calibrate: opts.calibrate } : undefined,
			localeCountry
		)
	}

	/**
	 * Like `parse`, but also returns the raw per-token logits and piece offsets needed for per-span logit aggregation
	 * (Option C joint-reconcile integration). Shares the ENTIRE decode path with `parse` (one `#decode`, #481) — repair
	 * passes included, because reconcile must consume the same tokens the argmax path serves users, under the same repair
	 * opts. `logits` stay RAW (pre-prior, pre-repair) — they are the model's emissions, not the decode's opinions.
	 */
	async parseWithLogits(text: string, opts?: ParseOpts): Promise<ParseWithLogitsResult> {
		if (!text.length) {
			return { tree: { raw: text, roots: [] }, logits: [], pieces: [] }
		}

		const { tokens, logits, pieces, localeCountry } = await this.#decode(text, opts)

		return {
			tree: treeWithLocaleCountry(
				text,
				tokens,
				opts?.calibrate ? { calibrate: opts.calibrate } : undefined,
				localeCountry
			),
			logits,
			pieces: pieces.map((p) => ({ start: p.start, end: p.end })),
		}
	}

	/**
	 * Like `parse`, but returns the full decode-path trace instead of a tree: pieces, soft-feature channels as fed, raw
	 * logits, locale head, prior participation, post-prior emissions, viterbi path, repair diffs, and the final tokens.
	 * Shares the ENTIRE decode path with `parse` (one `#decode`, #481) and mirrors `parse`'s case normalization, so
	 * `buildAddressTree(trace.text, trace.tokens)` reproduces `parse(text)`'s tree exactly — modulo `opts.calibrate`,
	 * which `parse` forwards into the tree build to recalibrate node confidences and which the trace does not carry
	 * (tokens/labels/spans still match; re-pass the calibrator to the rebuild if calibrated confidences matter).
	 * Serializable by construction — see `./trace.js` for the schema and the spec reference.
	 */
	async traceParse(text: string, opts?: ParseOpts): Promise<NeuralParseTrace> {
		const labels = [...this.labels] as string[]

		if (!text.length) {
			// Mirror #decode's contract on the degenerate input: systemSource still reflects the
			// RESOLVED conventions mode (opts over config), and every prior kind gets its
			// participation record (applied: false — nothing can fire on zero pieces).
			return {
				text,
				caseNormalized: false,
				pieces: [],
				logits: [],
				detectedSystem: null,
				systemSource: resolveSystemVerdict(
					opts?.addressSystemConventions ?? this.cfg.addressSystemConventions,
					undefined
				).systemSource,
				priors: TRACE_PRIOR_KINDS.map((kind) => ({ kind, applied: false })),
				emissions: [],
				labels,
				path: [],
				decode: this.decodeMode,
				repairs: [],
				tokens: [],
			}
		}

		const modelText = opts?.normalizeCase !== false ? normalizeInputCase(text) : text
		const { tokens, logits, pieces, trace } = await this.#decode(modelText, opts, true)

		if (!trace) throw new Error("traceParse: #decode returned no trace despite trace=true (invariant)")

		return {
			text: modelText,
			caseNormalized: modelText !== text,
			pieces: pieces.map((p) => ({ piece: p.piece, id: p.id, start: p.start, end: p.end })),
			...(trace.anchor ? { anchor: trace.anchor } : {}),
			...(trace.gazetteer ? { gazetteer: trace.gazetteer } : {}),
			...(trace.country ? { country: trace.country } : {}),
			logits,
			// The axis rides with the values (self-describing — consumers must not hardcode the order).
			...(trace.localeLogits ? { localeLogits: trace.localeLogits, localeCountries: [...LOCALE_COUNTRIES] } : {}),
			...(trace.spanScores ? { spanScores: trace.spanScores } : {}),
			detectedSystem: trace.detectedSystem,
			systemSource: trace.systemSource,
			priors: trace.priors,
			emissions: trace.emissions,
			labels,
			path: trace.path,
			decode: this.decodeMode,
			repairs: trace.repairs,
			tokens: tokens.map((t) => ({ ...t })),
		}
	}

	/**
	 * THE decode path (#481): tokenize → anchor/gazetteer features → infer → priors → CRF/argmax → tokens → repairs. Both
	 * `parse` and `parseWithLogits` consume this — never fork it; the 2026-06 audit found three drift surfaces across
	 * duplicated copies of this path.
	 */
	// Deliberately ONE function, long on purpose — every caller funnels through here so there is nowhere
	// for a second copy to drift.
	// oxlint-disable-next-line complexity -- 104, and splitting it is what drifted last time
	async #decode(
		text: string,
		opts?: ParseOpts,
		trace = false
	): Promise<{
		tokens: DecoderToken[]
		logits: number[][]
		pieces: ReturnType<MailwomanTokenizer["encode"]>["pieces"]
		/**
		 * The locale head's confident country verdict, or null — computed on EVERY parse (the #1684 scope gate reads it).
		 */
		localeCountry: { country: string; confidence: number } | null
		/**
		 * Present iff `trace` — the retained intermediates `traceParse` assembles.
		 */
		trace?: {
			anchor?: SoftFeatureChannel
			gazetteer?: SoftFeatureChannel
			country?: SoftFeatureChannel
			localeLogits?: number[]
			spanScores?: number[][][]
			detectedSystem: SystemCode | null
			systemSource: "off" | "auto" | "pinned"
			priors: TracePrior[]
			emissions: number[][]
			path: number[]
			repairs: TraceRepair[]
		}
	}> {
		const encoded = this.cfg.tokenizer.encode(text)
		// Reassigned after inference — the runner clamps to the model's fixed sequence length and
		// `pieces` has to follow it. See the clamp below.
		let pieces = encoded.pieces
		// Soft-feature channels (#718): the postcode-anchor (#239/#240) + gazetteer-anchor (#464) clues
		// the model conditions on alongside the ids, plus the near-postcode gazetteer choreography. The
		// build + choreography is the single PURE `buildSoftFeatures` (soft-features.ts) — both this
		// decode path and the ProductionScorer feed channels identically, so there is exactly one
		// choreography. Each channel is undefined when its source is unconfigured (no-op).
		//
		// The evidence-bundle channels are REGISTER-GATED (Decision A, see ParseOpts.inputMode):
		// formatted mode withholds both lexicons so the model runs its curriculum-trained absence
		// identity — the fed channels lift fragments but damage full-address parses.
		const evidenceOn = (opts?.inputMode ?? "fragmented") === "fragmented"

		const soft = buildSoftFeatures(text, pieces, {
			postcodeAnchorLookup: this.cfg.postcodeAnchorLookup,
			postcodeAnchorSpanMode: this.cfg.postcodeAnchorSpanMode,
			gazetteerLexicon: this.cfg.gazetteerLexicon,
			countryLexicon: this.cfg.countryLexicon,
			suppressGazetteerNearPostcode: this.cfg.suppressGazetteerNearPostcode,
			streetTypeLexicon: evidenceOn ? this.cfg.streetTypeLexicon : undefined,
			localitySurfaceLexicon: evidenceOn ? this.cfg.localitySurfaceLexicon : undefined,
		})

		const { logits, localeLogits, spanScores } = await this.cfg.runner.infer(
			encoded.ids,
			soft.anchor,
			soft.gazetteer,
			soft.country,
			soft.streetType || soft.localitySurface
				? { streetType: soft.streetType, localitySurface: soft.localitySurface }
				: undefined
		)

		this.assertEmissionWidth(logits)

		// INVARIANT for everything below: one row of emissions per piece. `ONNXRunner.infer` truncates its
		// input to `fixedSeqLen` and slices `logits` to what it ran, so an untruncated `pieces` breaks that
		// pairing and every lockstep consumer indexes off the end — the token build reading `logits[i]`,
		// `enforceWordConsistency` reading `emissions[pi]`.
		//
		// The limit is reachable by ordinary input: 128 pieces is roughly 330 characters, which a
		// form-concatenated delivery address clears. Dropping the tail is the runner's existing choice made
		// visible; the alternative is throwing on a valid address. Note the tail is LOST, not deferred —
		// components past the window never reach the model at all.
		//
		// `logits.length`, not a literal 128, so this holds for any `fixedSeqLen` — including models whose
		// window differs, and non-Latin scripts that reach it at far shorter character counts.
		if (pieces.length > logits.length) {
			pieces = pieces.slice(0, logits.length)
		}

		// Trace retention (spec 2026-07-03): capture-by-reference of arrays this method already
		// builds. Null when not tracing — the non-trace path allocates nothing new (every recording
		// call below sits behind a `tracePriors?` / `if (traceRepairs)` guard, so even snapshot
		// arguments are never built for a plain parse).
		const tracePriors: TracePrior[] | null = trace ? [] : null
		const traceRepairs: TraceRepair[] | null = trace ? [] : null

		const recordRepair = (pass: TraceRepairPass, before: string[], after: string[]): void => {
			if (!traceRepairs) return

			if (before.length === after.length && before.every((label, i) => label === after[i])) return
			traceRepairs.push({ pass, before, after })
		}

		// TraceRepair before/after are PER-PIECE (index-aligned with `pieces`). Token-count-preserving
		// passes can read labels 1:1, but the span bridge MERGES fragments (dropping later tokens), so
		// labels are projected back onto pieces via char offsets: each piece carries the label of the
		// token covering its start. Keeps the alignment contract true for every pass.
		const labelsPerPiece = (toks: readonly DecoderToken[]): string[] => {
			let t = 0

			return pieces.map((p) => {
				while (t + 1 < toks.length && toks[t + 1]!.start <= p.start) {
					t++
				}

				const tok = toks[t]

				return (tok && tok.start <= p.start && p.start < tok.end ? tok.label : "O") as string
			})
		}

		// `applied` reports EFFECT (see TracePrior): a composed prior counts only if any cell is nonzero.
		const matrixHasBias = (m: readonly (readonly number[])[]): boolean => m.some((row) => row.some((v) => v !== 0))

		// Address-system conventions (#511 Tier A): resolve which system's rules apply — caller-pinned
		// system, or the model's own locale-head detection under a high confidence bar. Null = no
		// constraints; the parse below is byte-identical to the pre-conventions path.
		const conventionsOpt = opts?.addressSystemConventions ?? this.cfg.addressSystemConventions
		const { detectedSystem, systemSource } = resolveSystemVerdict(conventionsOpt, localeLogits)
		const conventions = conventionsForSystem(detectedSystem)

		const queryShapePrior = opts?.queryShape
			? buildEmissionPriors(opts.queryShape, pieces, this.labels, {
					biasScale: opts.queryShapeBiasScale ?? 1,
					inputText: text,
				})
			: undefined

		let emissions = queryShapePrior ? addEmissionMatrix(logits, queryShapePrior) : logits

		tracePriors?.push({ kind: "queryShape", applied: queryShapePrior !== undefined && matrixHasBias(queryShapePrior) })

		const fstPrior = opts?.fst
			? buildFSTEmissionPriors(opts.fst, pieces, this.labels, {
					biasScale: opts.fstBiasScale ?? 1,
					...(opts.fstImportanceLengthScaleMode
						? { importanceLengthScaleMode: opts.fstImportanceLengthScaleMode }
						: {}),
					// Street-context gate (#1142): reuse the morphology FST already loaded for the
					// street-morphology prior. Inert when the morphology FST isn't loaded.
					...(opts.fstStreetMorphology && opts.fstStreetContextGate !== false
						? {
								streetContext: {
									fst: opts.fstStreetMorphology,
									...(opts.fstStreetContextPositiveScale !== undefined
										? { positiveScale: opts.fstStreetContextPositiveScale }
										: {}),
								},
							}
						: {}),
				})
			: undefined

		if (fstPrior) {
			emissions = addEmissionMatrix(emissions, fstPrior)
		}

		tracePriors?.push({ kind: "fst", applied: fstPrior !== undefined && matrixHasBias(fstPrior) })

		const morphologyPrior = opts?.fstStreetMorphology
			? buildStreetMorphologyEmissionPriors(
					opts.fstStreetMorphology,
					pieces,
					this.labels,
					opts.fstStreetMorphologyOpts ?? {}
				)
			: undefined

		if (morphologyPrior) {
			emissions = addEmissionMatrix(emissions, morphologyPrior)
		}

		tracePriors?.push({
			kind: "streetMorphology",
			applied: morphologyPrior !== undefined && matrixHasBias(morphologyPrior),
		})

		// Stage 2.7 span proposer (#518, M2+M3): typed span proposals consumed as phrase priors.
		// DEFAULT ON since 2026-06-12 (operator ruling): an omitted config builds the codex lexicon
		// lazily with the frozen measured scales; `spanProposer: false` (config or per-parse) is the
		// proposer-free baseline. Disabled = byte-stable (no proposals computed).
		const configured = this.cfg.spanProposer === false ? undefined : (this.cfg.spanProposer ?? this.defaultProposer())
		const proposerCfg = (opts?.spanProposer ?? true) ? configured : undefined
		const spanProposals: ProposedSpan[] = proposerCfg ? proposeSpans(text, proposerCfg.lexicon) : []

		if (spanProposals.length) {
			emissions = addEmissionMatrix(emissions, buildSpanProposalPriors(spanProposals, pieces, this.labels, proposerCfg))
		}

		tracePriors?.push({ kind: "spanProposer", applied: spanProposals.length > 0 })

		// (defaultProposer lives below decode helpers — one lazy build per classifier instance.)

		// Placetype-pair prior (placetype-pair-prior arc): retrieval-augmented complement to the
		// encoder — see placetype-pair-prior.ts for the full windowing/matching contract. Config-level
		// default set by loadFromWeights (its country-gated construction); per-call opts override it,
		// same "opts ?? cfg default" shape as bridgePunctuationGaps/enforceWordConsistency below. Default
		// OFF (neither set → byte-stable). Composed BEFORE the conventions mask so an ungrammatical tag it
		// might bias toward still gets masked out.
		const placetypePairOpt = opts?.placetypePair ?? this.cfg.placetypePair
		// Trace-only out-record: which probe-chain path fired (segment vs anchored vs window) — see
		// PlacetypePairProbeTrace. Only allocated when tracing, like the tracePriors list itself.
		const pairProbeTrace: PlacetypePairProbeTrace | undefined = trace ? {} : undefined
		// PCN1 census observability rung: passed to the prior so its parent-candidate probes ALSO probe the census,
		// recording what it knows onto `pairProbeTrace`. Injected only when tracing — the prior writes census
		// observations nowhere else, so on a plain `parse()` there is nothing for it to fill and no lookup to pay for.
		// It never reaches a logit; the `placetypeCensus` record below is its entire output.
		const placetypeCensusOpt = opts?.placetypeCensus ?? this.cfg.placetypeCensus

		const censusForProbe: PlacetypeCensusLike | undefined = trace && placetypeCensusOpt ? placetypeCensusOpt : undefined

		const placetypePairResult = placetypePairOpt
			? buildPlacetypePairPriors(
					{
						...placetypePairOpt,
						inputText: text,
						probeTrace: pairProbeTrace ?? placetypePairOpt.probeTrace,
						...(censusForProbe ? { census: censusForProbe } : {}),
					},
					pieces,
					this.labels
				)
			: undefined

		const placetypePairPrior = placetypePairResult?.matrix

		if (placetypePairPrior) {
			emissions = addEmissionMatrix(emissions, placetypePairPrior)
		}

		// TRANSITION-BETA: convert the prior's label-string adjustments to the decoder's index axis. Empty
		// (the overwhelmingly common case — no hit, or a beta-less index) stays `undefined` so the viterbi
		// call below is argument-identical to the pre-beta path. A label the vocabulary doesn't carry is
		// dropped, mirroring `applyWindowBias`'s own unknown-label skip.
		const pairTransitionAdjustments = placetypePairResult?.transitionAdjustments.length
			? placetypePairResult.transitionAdjustments.flatMap((adj) => {
					const toLabel = this.labels.indexOf(adj.toLabel)

					return toLabel !== -1 ? [{ timestep: adj.pieceIndex, toLabel, bonus: adj.bonus }] : []
				})
			: undefined

		const placetypePairApplied = placetypePairPrior !== undefined && matrixHasBias(placetypePairPrior)

		tracePriors?.push({
			kind: "placetypePair",
			applied: placetypePairApplied,
			// `probePath` rides only when a bias actually landed — an applied:false record stays shape-identical to
			// every trace produced before the probe chain existed.
			...(placetypePairApplied && pairProbeTrace?.firedPath ? { probePath: pairProbeTrace.firedPath } : {}),
		})

		// PCN1 census observability (2026-08-05). `applied` is HARD-CODED false, not computed: this rung composes no
		// matrix to test for a nonzero cell, and it must stay that way until a calibration rung measures a δ (the
		// artifact header deliberately ships none — see `PlacetypeCensusHeader.delta`). The observation list and its
		// probe-count denominator ride only when a census was actually wired, so a build without the artifact produces
		// `{kind, applied: false}` and every other field of the trace is unchanged.
		tracePriors?.push({
			kind: "placetypeCensus",
			applied: false,
			...(pairProbeTrace?.censusProbedParents === undefined
				? {}
				: {
						census: pairProbeTrace.censusObservations ?? [],
						censusProbedParents: pairProbeTrace.censusProbedParents,
					}),
		})

		// Conventions emission mask: tags that are ungrammatical in the detected system are removed
		// from the decoder's vocabulary outright (-1e9 ≈ log 0). Copy-on-mask — `emissions` may alias
		// `logits`, which the per-token confidence below reads unmasked.
		let conventionsMaskApplied = false

		if (conventions?.forbiddenTags?.length) {
			const forbidden = new Set<number>()

			for (const tag of conventions.forbiddenTags) {
				const b = this.labels.indexOf(`B-${tag}`)
				const i = this.labels.indexOf(`I-${tag}`)

				if (b !== -1) {
					forbidden.add(b)
				}

				if (i !== -1) {
					forbidden.add(i)
				}
			}

			if (forbidden.size) {
				conventionsMaskApplied = true
				emissions = emissions.map((row) => row.map((v, idx) => (forbidden.has(idx) ? -1e9 : v)))
			}
		}

		tracePriors?.push({ kind: "conventionsMask", applied: conventionsMaskApplied })

		let labelIndices =
			this.decodeMode === "viterbi"
				? viterbi({
						emissions,
						transitions: this.transitions,
						startTransitions: this.startTransitions,
						endTransitions: this.endTransitions,
						// TRANSITION-BETA: position-scoped entry bonuses from the placetype-pair prior (undefined
						// unless a pair hit fired on a transitionBeta-carrying index). Viterbi-only by nature — the
						// argmax path has no transitions to adjust.
						...(pairTransitionAdjustments ? { transitionAdjustments: pairTransitionAdjustments } : {}),
					}).path
				: emissions.map((row) => argmaxSoftmax(row).idx)

		// The trace's `path` is the DECODER's output — snapshot before the word-consistency healing
		// below reassigns labelIndices (the healing itself is visible as a `wordConsistency` repair).
		const decodedPath = trace ? [...labelIndices] : null

		// Per-word BIO consistency repair (#727 + the admin-token fragmentation class). Opt-in — default
		// OFF → byte-identical. Heals words whose pieces disagree (e.g. `VERMONT`→VER[loc]+MONT[region],
		// `Lozère`→Loz[loc]+ère[region]) via a confidence-weighted vote over the post-prior emissions; a
		// word whose pieces already agree is untouched. See word-consistency.ts.
		let healedConfidence: Map<number, number> | null = null

		// The default is the SHIPPED configuration, deliberately — `geocode-core.ts` resolves to this same
		// constant, so a bare classifier and the production pipeline decode identically. Anything that
		// defaults differently here is a decode no user is on, and probes written against the classifier
		// will report defects the shipped path cannot reach.
		//
		// The repair upholds an invariant no valid parse can violate: the pieces of one word carry one tag.
		// `false` opts out for callers who want the raw emissions.
		const wordConsistency =
			opts?.enforceWordConsistency ?? this.cfg.enforceWordConsistency ?? WORD_CONSISTENCY_SHIP_DEFAULT

		if (wordConsistency) {
			const beforeLabels = traceRepairs ? labelIndices.map((i) => (this.labels[i] ?? "O") as string) : []
			const wcOpts = typeof wordConsistency === "object" ? wordConsistency : undefined
			const wc = enforceWordConsistency(pieces, emissions, this.labels, labelIndices, wcOpts)
			labelIndices = wc.labelIndices
			healedConfidence = wc.healedConfidence

			if (traceRepairs) {
				recordRepair(
					"wordConsistency",
					beforeLabels,
					labelIndices.map((i) => (this.labels[i] ?? "O") as string)
				)
			}
		}

		let tokens: DecoderToken[] = pieces.map((p, i) => {
			const idx = labelIndices[i]!
			const probs = softmax(logits[i]!)

			return {
				piece: p.piece,
				start: p.start,
				end: p.end,
				label: (this.labels[idx] ?? "O") as DecoderToken["label"],
				// Healed words carry the vote's mean p(type) (length-invariant); unchanged pieces keep
				// the model's per-piece softmax confidence.
				confidence: healedConfidence?.get(i) ?? probs[idx]!,
			}
		})

		// Postcode repair runs when the caller asks for it OR the detected system declares a postcode
		// shape (#511 Tier A): a span that is a sub-match of a shape-valid string is exactly the
		// snap-only truncation class the pass exists for ("47110" decoded as "4711" + a digit-split).
		if (opts?.postcodeRepair || conventions?.postcodePattern) {
			const before = traceRepairs ? labelsPerPiece(tokens) : []
			tokens = repairPostcodeLabels(text, tokens).tokens

			if (traceRepairs) {
				recordRepair("postcodeRepair", before, labelsPerPiece(tokens))
			}
		}

		if (opts?.unitRepair) {
			const before = traceRepairs ? labelsPerPiece(tokens) : []
			tokens = repairUnitLabels(text, tokens).tokens

			if (traceRepairs) {
				recordRepair("unitRepair", before, labelsPerPiece(tokens))
			}
		}

		// Punctuation-gap span bridging (v4.4.0 corrective — see span-bridge.ts): merge same-tag
		// fragments split at unlabeled punctuation ("P.O. Box" decoding as P + O + Box). Opt-in,
		// declared in the ship config like the conventions mask. When the span proposer ran, its
		// ANNOTATION/QUOTED boundaries become merge-crossing constraints (M2's second half).
		if (opts?.bridgePunctuationGaps ?? this.cfg.bridgePunctuationGaps) {
			const blockedSpans = spanProposals.filter((p) => p.kind === "ANNOTATION_SPAN" || p.kind === "QUOTED_SPAN")
			// The bridge MERGES tokens (later fragments are dropped), so both snapshots go through the
			// per-piece projection — a merged span's label lands on every piece it covers, keeping
			// before/after index-aligned with `pieces` per the TraceRepair contract.
			const before = traceRepairs ? labelsPerPiece(tokens) : []
			tokens = bridgePunctuationGaps(text, tokens, blockedSpans.length ? { blockedSpans } : undefined)

			if (traceRepairs) {
				recordRepair("spanBridge", before, labelsPerPiece(tokens))
			}
		}

		return {
			tokens,
			logits,
			pieces,
			localeCountry: confidentLocaleCountry(localeLogits),
			...(trace
				? {
						trace: {
							...(soft.anchor ? { anchor: soft.anchor } : {}),
							...(soft.gazetteer ? { gazetteer: soft.gazetteer } : {}),
							...(soft.country ? { country: soft.country } : {}),
							...(localeLogits ? { localeLogits } : {}),
							...(spanScores ? { spanScores } : {}),
							detectedSystem,
							systemSource,
							priors: tracePriors!,
							emissions,
							path: decodedPath!,
							repairs: traceRepairs!,
						},
					}
				: {}),
		}
	}

	async parseJSON(text: string, opts?: ParseOpts): Promise<Partial<Record<ComponentTag, string>>>
	async parseJSON(
		text: string,
		opts: ParseOpts & SerializeJSONOpts
	): Promise<Partial<Record<ComponentTag, string>> & { unknown?: UnknownSpan[] }>
	async parseJSON(
		text: string,
		opts: ParseOpts & SerializeJSONOpts = {}
	): Promise<Partial<Record<ComponentTag, string>> & { unknown?: UnknownSpan[] }> {
		return decodeAsJSON(await this.parse(text, opts), opts)
	}

	async parseTuples(text: string, opts?: ParseOpts): Promise<Array<[ComponentTag, string]>>
	async parseTuples(
		text: string,
		opts: ParseOpts & SerializeTuplesOpts
	): Promise<Array<[ComponentTag | "unknown", string]>>
	async parseTuples(
		text: string,
		opts: ParseOpts & SerializeTuplesOpts = {}
	): Promise<Array<[ComponentTag | "unknown", string]>> {
		return decodeAsTuples(await this.parse(text, opts), opts)
	}

	async parseXML(text: string, opts?: ParseOpts & { xml?: Parameters<typeof decodeAsXML>[1] }): Promise<string> {
		return decodeAsXML(await this.parse(text, opts), opts?.xml)
	}

	/**
	 * Guard against a silent label/emission shape overrun. When the model emits MORE logits per token than the configured
	 * label vocabulary (e.g. a Stage 3 bundle loaded with the default Stage 2 labels), viterbi indexes past the
	 * transition matrix and dies with an opaque `Cannot read properties of undefined (reading '0')`. Fail fast here with
	 * a message that names the contract the caller violated.
	 *
	 * The opposite shape (model narrower than labels) is intentionally permitted — STAGE2_BIO_LABELS prefix-extends
	 * STAGE1_BIO_LABELS so a Stage 1 model loaded with Stage 2 labels decodes correctly via the first 15 logits. See
	 * labels.ts for the contract.
	 */
	private assertEmissionWidth(logits: readonly number[][]): void {
		if (!logits.length) return
		const width = logits[0]!.length

		if (width > this.labels.length) {
			throw new Error(
				`Label/emission mismatch: model emits ${width} logits per token but the classifier was ` +
					`configured with only ${this.labels.length} labels. Did you load a Stage 3 bundle without ` +
					`passing its model-card labels? See loadFromWeights / loadNeuralClassifierFromURLs.`
			)
		}
	}
}

function argmaxSoftmax(row: number[]): { idx: number; conf: number } {
	let maxIdx = 0
	let maxVal = row[0]!

	for (let i = 1; i < row.length; i++) {
		if (row[i]! > maxVal) {
			maxVal = row[i]!
			maxIdx = i
		}
	}

	let sumExp = 0

	for (const v of row) {
		sumExp += Math.exp(v - maxVal)
	}

	const conf = 1 / sumExp

	return { idx: maxIdx, conf }
}

/**
 * Element-wise add two square matrices. Used to compose the structural mask + learned transitions.
 */
function addMatrices(a: number[][], b: number[][]): number[][] {
	const n = a.length
	const out: number[][] = []

	for (let i = 0; i < n; i++) {
		const row = new Array<number>(n)

		for (let j = 0; j < n; j++) {
			row[j] = a[i]![j]! + b[i]![j]!
		}

		out.push(row)
	}

	return out
}
