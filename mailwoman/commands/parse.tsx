/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Spinner } from "@inkjs/ui"
import { type AddressTree, decodeAsJSON, decodeAsTuples, decodeAsXML, proposalsToTree } from "@mailwoman/core/decoder"
import { $public } from "@mailwoman/core/env"
import { collectProposals, filterByPolicy, InMemoryPolicyRegistry, type PolicyMode } from "@mailwoman/core/policy"
import type { ComponentTag, Section } from "@mailwoman/core/types"
import { createNeuralProposalClassifier, NeuralAddressClassifier } from "@mailwoman/neural"
import { weightsPackageName } from "@mailwoman/neural/weights"
import { createWOFResolver, type Resolver, type ResolverBackend } from "@mailwoman/resolver"
import { Text } from "ink"
import { createRuntimePipeline } from "mailwoman"
import React from "react"
import zod from "zod"

import { type CommandComponent, commandError, useCommandTask } from "../cli-kit/index.ts"
import { probeWeights, WeightsGuard, type WeightsOutcome } from "../cli-kit/weights-guard.tsx"
import { createResolverBackend, resolveCandidateDBPath } from "../resolver-backend.ts"

const POLICY_MODES: readonly PolicyMode[] = ["rule_only", "neural_only", "both", "neural_preferred", "rule_preferred"]
const POLICY_SPEC_RE = /^([a-z_]+)=([a-z_]+)$/u

const ArgumentsSchema = zod.array(zod.string().describe("A formatted postal address"))
export { ArgumentsSchema as args, ParseConfigSchema as options }

const ParseConfigSchema = zod.object({
	debug: zod.boolean().optional().default(false).describe("Enable verbose debugging output"),
	locale: zod
		.string()
		.regex(/^[a-z]{2}(-[A-Z]{2})?$/u, "Expected a BCP-47 tag like en-US or fr-FR")
		.optional()
		.default("en-US")
		.describe("Locale tag matching a weights package (en-US, fr-FR). Default en-US."),
	defaultCountry: zod
		.string()
		.optional()
		.describe(
			"ISO-3166 country to scope the WOF resolver when the parse carries no resolved country node — " +
				"e.g. 'US' so a bare 'NY' resolves to the US state, not a higher-priority foreign homonym. " +
				"Requires --resolve. Defaults from --locale's region subtag (en-US → US); pass 'none' to disable " +
				"the filter and let ranking alone decide."
		),
	adminCoherence: zod
		.boolean()
		.optional()
		.default(true)
		.describe(
			"Joint admin-consistency re-pick during --resolve (#263/#822: 'Portland, ME' binds to Maine, not Messina). " +
				"ON by default (#895); pass --no-admin-coherence to restore the greedy population-first ranking."
		),
	neural: zod
		.boolean()
		.optional()
		.default(false)
		.describe("[Legacy] Force the neural-classifier-only path (skips Stage 1 + 2 + 2.5 of the pipeline)."),
	noNeural: zod
		.boolean()
		.optional()
		.default(false)
		.describe("In pipeline mode, skip the neural classifier (run normalize + queryShape + kind + resolver only)."),
	poi: zod
		.boolean()
		.optional()
		.default(true)
		.describe(
			"poi_query detection (poiQueryKind flag). DEFAULT-ON since 2026-07-20 (promotion battery: 0/4507 golden " +
				"misroutes, 6/6 demo presets byte-identical). Pass --no-poi to restore the pre-flag address-only kind classification."
		),
	downloadWeights: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"If the locale's neural weights aren't installed, download them into ~/.cache/mailwoman/weights " +
				"without prompting, then parse. Non-interactive-safe (CI, pipes)."
		),
	degraded: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Run the structural pipeline stages only (normalize, query-shape, kind, grouper) without the neural " +
				"encoder, even when weights are installed. A stderr banner names what's degraded."
		),
	format: zod.enum(["json", "tuple", "xml"]).optional().default("json").describe("Output projection."),
	model: zod.string().optional().describe("Explicit model.onnx path (--neural only). Overrides --locale resolution."),
	tokenizer: zod
		.string()
		.optional()
		.describe("Explicit tokenizer.model path (--neural only). Overrides --locale resolution."),
	policy: zod
		.array(zod.string().regex(POLICY_SPEC_RE, "Expected <component>=<mode> e.g. postcode=neural_preferred"))
		.optional()
		.describe(
			"Per-component policy override, repeatable. <component>=<mode> where mode is one of: " +
				POLICY_MODES.join(", ") +
				". Requires --neural."
		),
	resolve: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Run the parsed tree through the WOF resolver (Phase 4.3) — decorates matched nodes with wof:<id> + lat/lon. Requires --neural."
		),
	resolveDb: zod
		.string()
		.optional()
		.describe(
			"Path to a WOF SQLite distribution for --resolve. Defaults to $MAILWOMAN_WOF_DB; errors if neither is set."
		),
	streetEvidenceRerank: zod
		.boolean()
		.optional()
		.default(true)
		.describe(
			"#727 phase-4c: rerank the STREET on BAN name-existence evidence (FR street-centroids). DEFAULT-ON: a no-op " +
				"unless a v3+ span-head model + street-centroids-fr.db are both present (byte-stable otherwise). " +
				"Splices only an atlas-confirmed street into the argmax tree. Pass --no-street-evidence-rerank to disable."
		),
	candidates: zod.coerce
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe(
			"Surface up to N alternative resolutions per resolved node (Springfield-class disambiguation). " +
				"Requires --resolve. Output format-dependent: json emits node.alternatives arrays, xml emits " +
				"<alternative> child elements, tuple unchanged."
		),
	benchmark: zod.coerce
		.number()
		.int()
		.min(1)
		.max(10000)
		.optional()
		.describe(
			"Run the pipeline N times against the input and emit per-stage p50/p95/p99 + total wall + heap delta. " +
				"5-iteration warmup is excluded from the stats. Default path only (incompatible with --policy)."
		),
})

interface PolicyOverride {
	component: ComponentTag
	mode: PolicyMode
}

function parsePolicySpecs(specs: readonly string[]): PolicyOverride[] {
	const out: PolicyOverride[] = []

	for (const spec of specs) {
		const m = POLICY_SPEC_RE.exec(spec)

		if (!m) throw commandError(`Invalid --policy spec ${spec}; expected <component>=<mode>`)
		const [, component, mode] = m

		if (!POLICY_MODES.includes(mode as PolicyMode)) {
			throw commandError(`Unknown policy mode ${mode}; valid: ${POLICY_MODES.join(", ")}`)
		}
		out.push({ component: component as ComponentTag, mode: mode as PolicyMode })
	}

	return out
}

const ParseCommand: CommandComponent<typeof ParseConfigSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	// The weights guard wraps the DEFAULT pipeline path only — explicit --model/--tokenizer paths and
	// the legacy/benchmark/noNeural paths keep their existing loading semantics untouched (plan 3;
	// non-interactive absent-weights behavior stays byte-identical to pre-guard until plan 4).
	const guardEligible =
		options.benchmark === undefined &&
		!(options.policy && options.policy.length > 0) &&
		!options.neural &&
		!options.noNeural &&
		!options.model &&
		!options.tokenizer

	if (guardEligible && (options.degraded || options.downloadWeights || !probeWeights(options.locale).ok)) {
		return (
			<WeightsGuard locale={options.locale} autoDownload={options.downloadWeights} forceDegraded={options.degraded}>
				{(outcome) => <ParseTask options={options} args={args} weightsOutcome={outcome} />}
			</WeightsGuard>
		)
	}

	return <ParseTask options={options} args={args} weightsOutcome="neural" />
}

/** The actual parse work, one hook-owning component below the guard so the prompt can render first. */
function ParseTask({
	options,
	args,
	weightsOutcome,
}: {
	options: zod.infer<typeof ParseConfigSchema>
	args: zod.infer<typeof ArgumentsSchema>
	weightsOutcome: WeightsOutcome
}): React.ReactElement {
	const state = useCommandTask(async () => {
		const input = args[0]!

		if (options.benchmark !== undefined) {
			if ((options.policy && options.policy.length > 0) || options.neural) {
				throw commandError(
					"--benchmark requires the default runtime-pipeline path (incompatible with --policy / --neural)"
				)
			}

			return runBenchmark(input, options, options.benchmark)
		}

		// --policy implies the neural proposal/policy path.
		if (options.policy && options.policy.length > 0) {
			const policyOverrides = parsePolicySpecs(options.policy)

			return runNeural(input, options, policyOverrides)
		}

		// --neural without --policy: legacy direct-neural path (kept for parity with old behavior).
		if (options.neural) {
			return runNeural(input, options, [])
		}

		// Guard said degraded (user declined the download, download failed, or --degraded): the real
		// pipeline minus the encoder. "unavailable" falls through to runPipeline's legacy chain.
		if (weightsOutcome === "declined") {
			return runDegraded(input, options)
		}

		// Default: runtime pipeline.
		return runPipeline(input, options)
	})

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	if (state.status !== "done") {
		return <Spinner />
	}

	return <Text>{state.result}</Text>
}

/**
 * ISO-3166 country for the resolver's `defaultCountry`, inferred from a BCP-47 locale's region subtag (en-US → US,
 * fr-FR → FR, de-DE → DE). Returns `undefined` when the locale carries no 2-letter region subtag (so the resolver stays
 * global rather than guessing from a language alone). Script subtags (`Hant`, `Latn`) are ignored.
 */
export function localeToCountry(locale: string | undefined): string | undefined {
	if (!locale) return undefined
	const parts = locale.split("-")
	const region = parts.length > 1 ? parts[parts.length - 1] : undefined

	return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : undefined
}

/**
 * The resolver's `defaultCountry` for this invocation: the explicit `--default-country` if set (with `none` meaning "no
 * filter"), otherwise inferred from `--locale`. Without it, a bare region abbreviation (`NY`) resolves to whatever the
 * gazetteer ranks highest globally — often a foreign homonym (a Scottish locality) rather than the US state. The FTS
 * backend therefore needs the locale default to match the demo.
 *
 * `candidateActive` flips that off: the candidate-table backend resolves population-first AND country-agnostic (the
 * demo's GLOBAL behavior — bare "Moscow" → the Russian city), so when it's the backend AND the user gave no explicit
 * country we impose NO default. An explicit `--default-country` (or `none`) still wins. This is what makes the
 * candidate-backed CLI match the demo out of the box.
 */
export function resolverDefaultCountry(
	options: { defaultCountry?: string; locale?: string },
	candidateActive = false
): string | undefined {
	if (options.defaultCountry === "none") return undefined

	if (options.defaultCountry) return options.defaultCountry

	return candidateActive ? undefined : localeToCountry(options.locale)
}

function resolveWOFPath(options: zod.infer<typeof ParseConfigSchema>): string {
	const path = options.resolveDb ?? $public.MAILWOMAN_WOF_DB

	if (!path) {
		throw commandError(
			"--resolve needs a WOF SQLite path. Set $MAILWOMAN_WOF_DB or pass --resolve-db <path>. " +
				"Download from https://data.geocode.earth/wof/dist/sqlite/ and pre-build the FTS5 index " +
				"with `mailwoman gazetteer build fts <path>`."
		)
	}

	return path
}

async function tryBuildFST(
	options: zod.infer<typeof ParseConfigSchema>
): Promise<import("@mailwoman/resolver-wof-sqlite/fst-matcher").FSTMatcher | undefined> {
	const dbPath = options.resolveDb ?? $public.MAILWOMAN_WOF_DB

	if (!dbPath) return undefined

	try {
		const { existsSync } = await import("node:fs")

		if (!existsSync(dbPath)) return undefined
		const { buildFSTFromWOF } = await import("@mailwoman/resolver-wof-sqlite/fst-builder")
		const { matcher } = buildFSTFromWOF({ dbPath })

		return matcher
	} catch {
		return undefined
	}
}

/**
 * Tree → resolved tree via the WOF backend. When `options.candidates` is set, asks the resolver for top-(N+1)
 * candidates per node so the runner-ups land on `AddressNode.alternatives` (where N is the requested alternative count;
 * +1 because the top winner is also in the limit).
 */
async function resolveWithCandidates(
	resolver: Resolver,
	tree: AddressTree,
	options: zod.infer<typeof ParseConfigSchema>
): Promise<AddressTree> {
	const opts: { candidatesPerLookup?: number; defaultCountry?: string; adminCoherence?: boolean } = {}

	if (options.candidates !== undefined) {
		opts.candidatesPerLookup = options.candidates + 1
	}
	const dc = resolverDefaultCountry(options, !!resolveCandidateDBPath())

	if (dc) {
		opts.defaultCountry = dc
	}

	// #895: the library default is ON; only the explicit --no-admin-coherence pin needs threading.
	if (options.adminCoherence === false) {
		opts.adminCoherence = false
	}

	return resolver.resolveTree(tree, opts)
}

async function withResolver<T>(
	options: zod.infer<typeof ParseConfigSchema>,
	fn: (resolver: Resolver) => Promise<T>
): Promise<T> {
	// Dynamic import so `@mailwoman/resolver-wof-sqlite` stays a true optional peer dep — users who
	// never set --resolve don't pay for kysely + the resolver bundle.
	let mod: typeof import("@mailwoman/resolver-wof-sqlite")

	try {
		mod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		throw commandError(
			"--resolve requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
				"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
		)
	}

	// $MAILWOMAN_CANDIDATE_DB → the demo-parity candidate backend (no WOF admin path required); else FTS.
	const lookup = createResolverBackend(mod, {
		wofPaths: resolveCandidateDBPath() ? "" : resolveWOFPath(options),
	})

	try {
		// PlaceLookup is structurally compatible with ResolverBackend — the cast is just to satisfy
		// the type, no runtime conversion.
		const resolver = createWOFResolver(lookup)

		return await fn(resolver)
	} finally {
		lookup.close()
	}
}

function serializeTree(
	tree: AddressTree,
	format: "json" | "tuple" | "xml",
	opts: { includeAlternatives?: boolean } = {}
): string {
	switch (format) {
		case "xml":
			return decodeAsXML(tree, { includeAlternatives: opts.includeAlternatives })
		case "tuple":
			return JSON.stringify(decodeAsTuples(tree), null, 2)
		default:
			// JSON: when --candidates is requested, dump the full AddressTree (carries alternatives
			// on each node). Otherwise stay libpostal-compat (flat tag→value).
			return opts.includeAlternatives ? JSON.stringify(tree, null, 2) : JSON.stringify(decodeAsJSON(tree), null, 2)
	}
}

/**
 * Encoder-less structural parse (plan 3): the REAL pipeline stages (normalize → query-shape → locale-gate → kind →
 * grouper fast-paths) with no neural classifier. The tree carries what the structural stages can prove (postcode_only /
 * locality_only fast-paths populate it; free-form addresses may yield an empty tree). Banner goes to stderr so stdout
 * stays machine-parseable.
 */
async function runDegraded(input: string, options: zod.infer<typeof ParseConfigSchema>): Promise<string> {
	console.error(
		"⚠ degraded parse: the neural encoder is not loaded — output carries structural-pipeline results only.\n" +
			`  Upgrade: npm install ${weightsPackageName(options.locale)}   or   mailwoman parse --download-weights <address>`
	)

	const pipeline = createRuntimePipeline({ poiQueryKind: options.poi })
	const result = await pipeline(input, { locale: options.locale })

	return options.debug
		? JSON.stringify(serializeResult(result, options.format), null, 2)
		: serializeTree(result.tree, options.format, { includeAlternatives: false })
}

/**
 * Default path: runtime pipeline. Lazy-loads the neural classifier + optional resolver. Returns the parsed tree
 * serialized in the requested format. When the encoder is unavailable, degrades to the structural-pipeline stages
 * (normalize → query-shape → kind → grouper fast-paths) rather than any rules parser.
 */
async function runPipeline(input: string, options: zod.infer<typeof ParseConfigSchema>): Promise<string> {
	const classifier = options.noNeural ? undefined : await tryLoadNeural(options)

	// When the encoder isn't loaded and there's no resolver/debug work to do, the full pipeline can
	// only emit QueryShape fast-path structure. Route to the degraded structural path (with its banner)
	// so the CLI still produces useful output for the fast-path kinds (postcode_only, locality_only).
	// `--debug` stays on the pipeline so the operator gets the requested PipelineResult JSON shape.
	if (!classifier && !options.resolve && !options.debug) {
		return runDegraded(input, options)
	}

	const wantAlternatives = options.candidates !== undefined
	const resolveOpts: { candidatesPerLookup?: number; defaultCountry?: string } = {}

	if (wantAlternatives) {
		resolveOpts.candidatesPerLookup = (options.candidates ?? 5) + 1
	}

	// Scope the resolver so a bare region abbreviation (`NY`) resolves to the intended country's place
	// rather than a higher-priority foreign homonym. Inferred from --locale unless --default-country
	// overrides (or is `none`). Only meaningful on the --resolve path; harmless otherwise.
	if (options.resolve) {
		const dc = resolverDefaultCountry(options, !!resolveCandidateDBPath())

		if (dc) {
			resolveOpts.defaultCountry = dc
		}
	}
	const pipelineOpts: { locale?: string; resolveOpts?: { candidatesPerLookup?: number; defaultCountry?: string } } = {
		locale: options.locale,
	}

	if (resolveOpts.candidatesPerLookup !== undefined || resolveOpts.defaultCountry !== undefined) {
		pipelineOpts.resolveOpts = resolveOpts
	}

	// #727 phase-4c: the rerank is DEFAULT-ON — `createRuntimePipeline` lazy-loads the bundled FR index when the model
	// ships a span head (a no-op otherwise). `--no-street-evidence-rerank` passes `false` to disable it.
	const streetEvidence = options.streetEvidenceRerank ? undefined : (false as const)

	if (options.resolve) {
		return withResolver(options, async (resolver) => {
			const fst = await tryBuildFST(options)
			const pipeline = createRuntimePipeline({ classifier, resolver, fst, streetEvidence, poiQueryKind: options.poi })
			const result = await pipeline(input, pipelineOpts)

			return options.debug
				? JSON.stringify(serializeResult(result, options.format), null, 2)
				: serializeTree(result.tree, options.format, { includeAlternatives: wantAlternatives })
		})
	}

	const fst = await tryBuildFST(options)
	const pipeline = createRuntimePipeline({ classifier, fst, streetEvidence, poiQueryKind: options.poi })
	const result = await pipeline(input, pipelineOpts)

	return options.debug
		? JSON.stringify(serializeResult(result, options.format), null, 2)
		: serializeTree(result.tree, options.format, { includeAlternatives: wantAlternatives })
}

const BENCHMARK_WARMUP_ITERATIONS = 5

function percentile(sortedAsc: ReadonlyArray<number>, p: number): number {
	if (sortedAsc.length === 0) return 0
	const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))

	return sortedAsc[idx]!
}

function formatMs(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`

	if (ms < 10) return `${ms.toFixed(2)}ms`

	if (ms < 100) return `${ms.toFixed(1)}ms`

	return `${Math.round(ms)}ms`
}

function formatBytes(b: number): string {
	const sign = b < 0 ? "-" : "+"
	const abs = Math.abs(b)

	if (abs < 1024) return `${sign}${abs}B`

	if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)}KB`

	return `${sign}${(abs / 1024 / 1024).toFixed(1)}MB`
}

/**
 * Run the runtime pipeline N times against a single input and report per-stage timing percentiles + heap delta. The
 * first 5 iterations are warmup (excluded from stats) so JIT + lazy-imports settle before measurement. Useful for
 * catching regressions when training models or coordinator changes affect inference cost.
 */
async function runBenchmark(
	input: string,
	options: zod.infer<typeof ParseConfigSchema>,
	iterations: number
): Promise<string> {
	const classifier = options.noNeural ? undefined : await tryLoadNeural(options)

	const runOne = async (
		pipeline: ReturnType<typeof createRuntimePipeline>
	): Promise<{ timing: Record<string, number>; total: number; path: string }> => {
		const t0 = performance.now()
		const result = await pipeline(input, { locale: options.locale })
		const total = performance.now() - t0

		return { timing: { ...result.timing }, total, path: result.path }
	}

	const collect = async (
		pipeline: ReturnType<typeof createRuntimePipeline>
	): Promise<{
		stageRuns: Map<string, number[]>
		totals: number[]
		paths: Map<string, number>
		heapDelta: number
	}> => {
		for (let i = 0; i < BENCHMARK_WARMUP_ITERATIONS; i++) {
			await runOne(pipeline)
		}

		if (typeof global.gc === "function") {
			global.gc()
		}
		const heapBefore = process.memoryUsage().heapUsed

		const stageRuns = new Map<string, number[]>()
		const totals: number[] = []
		const paths = new Map<string, number>()

		for (let i = 0; i < iterations; i++) {
			const r = await runOne(pipeline)
			totals.push(r.total)
			paths.set(r.path, (paths.get(r.path) ?? 0) + 1)

			for (const [stage, ms] of Object.entries(r.timing)) {
				let arr = stageRuns.get(stage)

				if (!arr) {
					arr = []
					stageRuns.set(stage, arr)
				}
				arr.push(ms)
			}
		}

		const heapAfter = process.memoryUsage().heapUsed

		return { stageRuns, totals, paths, heapDelta: heapAfter - heapBefore }
	}

	const collected = options.resolve
		? await withResolver(options, (resolver) =>
				collect(createRuntimePipeline({ classifier, resolver, poiQueryKind: options.poi }))
			)
		: await collect(createRuntimePipeline({ classifier, poiQueryKind: options.poi }))

	const lines: string[] = []
	lines.push(`mailwoman parse --benchmark: ${iterations} iterations + ${BENCHMARK_WARMUP_ITERATIONS} warmup`)
	lines.push(`input: ${JSON.stringify(input)}`)
	lines.push(
		`classifier: ${classifier ? `loaded (${options.locale})` : "none"}    resolver: ${options.resolve ? "wired" : "none"}`
	)
	const pathSummary = Array.from(collected.paths.entries())
		.map(([p, n]) => `${p}=${n}`)
		.join(" ")
	lines.push(`path breakdown: ${pathSummary}`)
	lines.push("")
	lines.push("stage              p50       p95       p99       max")
	lines.push("─────────────────  ────────  ────────  ────────  ────────")

	for (const [stage, ms] of Array.from(collected.stageRuns.entries()).sort()) {
		const sorted = [...ms].sort((a, b) => a - b)
		lines.push(
			[
				stage.padEnd(17),
				formatMs(percentile(sorted, 50)).padStart(8),
				formatMs(percentile(sorted, 95)).padStart(8),
				formatMs(percentile(sorted, 99)).padStart(8),
				formatMs(sorted[sorted.length - 1] ?? 0).padStart(8),
			].join("  ")
		)
	}
	const totalsSorted = [...collected.totals].sort((a, b) => a - b)
	lines.push("─────────────────  ────────  ────────  ────────  ────────")
	lines.push(
		[
			"TOTAL".padEnd(17),
			formatMs(percentile(totalsSorted, 50)).padStart(8),
			formatMs(percentile(totalsSorted, 95)).padStart(8),
			formatMs(percentile(totalsSorted, 99)).padStart(8),
			formatMs(totalsSorted[totalsSorted.length - 1] ?? 0).padStart(8),
		].join("  ")
	)
	lines.push("")
	lines.push(`heap delta (post-warmup → post-bench): ${formatBytes(collected.heapDelta)}`)

	return lines.join("\n")
}

/** Try to load the neural classifier; return undefined (with stderr note) if weights are absent. */
async function tryLoadNeural(
	options: zod.infer<typeof ParseConfigSchema>
): Promise<NeuralAddressClassifier | undefined> {
	try {
		return await NeuralAddressClassifier.loadFromWeights({
			locale: options.locale,
			modelPath: options.model,
			tokenizerPath: options.tokenizer,
		})
	} catch {
		// Graceful degradation: pipeline runs normalize + queryShape + kind + resolver only.
		// The caller sees `tree.roots` populated from QueryShape fast-paths (postcode_only,
		// locality_only) but nothing from the encoder.
		return undefined
	}
}

/**
 * Serialize the full pipeline result for `--debug`. Shows tree + timing + path + kind so callers can see which stage
 * owned which output.
 */
function serializeResult(
	result: Awaited<ReturnType<ReturnType<typeof createRuntimePipeline>>>,
	format: "json" | "tuple" | "xml"
): unknown {
	return {
		input: result.input,
		normalized: result.normalized,
		queryShape: { ...result.queryShape, tokenClasses: undefined }, // tokenClasses is verbose
		locale: result.locale,
		kind: result.kind,
		...(result.poiIntent ? { poiIntent: result.poiIntent } : {}),
		path: result.path,
		timing: result.timing,
		tree: format === "xml" ? decodeAsXML(result.tree) : result.tree,
	}
}

async function runNeural(
	input: string,
	options: zod.infer<typeof ParseConfigSchema>,
	policyOverrides: readonly PolicyOverride[]
): Promise<string> {
	const neural = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale,
		modelPath: options.model,
		tokenizerPath: options.tokenizer,
	})

	// Fast path: no policy AND no resolve → preserve containment nesting via NeuralAddressClassifier
	// 's direct projection helpers (returns the serialized string in one call).
	if (policyOverrides.length === 0 && !options.resolve) {
		switch (options.format) {
			case "xml":
				return neural.parseXML(input)
			case "tuple":
				return JSON.stringify(await neural.parseTuples(input), null, 2)
			default:
				return JSON.stringify(await neural.parseJSON(input), null, 2)
		}
	}

	// Slow paths build the tree explicitly so we can resolve / re-project before serialization.
	let tree: AddressTree

	if (policyOverrides.length > 0) {
		// Policy path: containment nesting is lost — see proposals-to-tree.ts for why.
		const proposalCls = createNeuralProposalClassifier({ id: `neural-cli-${options.locale}`, classifier: neural })
		// Without rule classifiers in the CLI loop, the registry's default rule_only would drop every
		// neural proposal and produce empty output. Default every component to neural_only when
		// --neural --policy is used, then layer the user's overrides on top.
		const policy = InMemoryPolicyRegistry.withDefaults()

		for (const entry of policy.entries()) {
			policy.set({ component: entry.component, mode: "neural_only" })
		}

		for (const o of policyOverrides) {
			policy.set({ component: o.component, mode: o.mode })
		}

		const wholeInputSection = { body: input, start: 0, end: input.length } as unknown as Section
		const proposals = await collectProposals([wholeInputSection], [proposalCls], { locale: options.locale })
		const filtered = filterByPolicy(proposals, policy, options.locale)
		tree = proposalsToTree(input, filtered)
	} else {
		// Resolve path without policy — keep containment by going through the decoder directly.
		tree = await neural.parse(input)
	}

	if (options.resolve) {
		tree = await withResolver(options, (resolver) => resolveWithCandidates(resolver, tree, options))
	}

	return serializeTree(tree, options.format, { includeAlternatives: options.candidates !== undefined })
}

export default ParseCommand
