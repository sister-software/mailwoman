/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { setImmediate } from "node:timers/promises"

import { Spinner } from "@inkjs/ui"
import { type AddressTree, decodeAsJSON, decodeAsTuples, decodeAsXML, proposalsToTree } from "@mailwoman/core/decoder"
import { $public } from "@mailwoman/core/env"
import { collectProposals, filterByPolicy } from "@mailwoman/core/parser"
import { InMemoryPolicyRegistry, type PolicyMode } from "@mailwoman/core/policy"
import type { ComponentTag, Section } from "@mailwoman/core/types"
import { createNeuralProposalClassifier, NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver, type Resolver, type ResolverBackend } from "@mailwoman/resolver"
import { Text } from "ink"
import { createAddressParser, createDiagnosticReport, createRuntimePipeline } from "mailwoman"
import { useEffect, useState } from "react"
import zod from "zod"

import { createResolverBackend, resolveCandidateDBPath } from "../resolver-backend.js"
import type { CommandComponent } from "../sdk/cli.js"

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
	isolated: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Skip the runtime pipeline; run the legacy rule-only parser. For debugging when the pipeline path looks suspect."
		),
	neural: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"[Legacy] Force the neural-classifier-only path (skips Stage 1 + 2 + 2.5 of the pipeline). Implied by the default unless --isolated is set."
		),
	noNeural: zod
		.boolean()
		.optional()
		.default(false)
		.describe("In pipeline mode, skip the neural classifier (run normalize + queryShape + kind + resolver only)."),
	format: zod
		.enum(["json", "tuple", "xml"])
		.optional()
		.default("json")
		.describe("Output projection. Applies to all paths except --isolated (which always emits JSON)."),
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
				"5-iteration warmup is excluded from the stats. Default path only (incompatible with --isolated / --policy)."
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

		if (!m) throw new Error(`Invalid --policy spec ${spec}; expected <component>=<mode>`)
		const [, component, mode] = m

		if (!POLICY_MODES.includes(mode as PolicyMode)) {
			throw new Error(`Unknown policy mode ${mode}; valid: ${POLICY_MODES.join(", ")}`)
		}
		out.push({ component: component as ComponentTag, mode: mode as PolicyMode })
	}

	return out
}

const ParseCommand: CommandComponent<typeof ParseConfigSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const [output, setOutput] = useState<string>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		if (error) {
			// Render the error once, then exit non-zero so callers (scripts, CI) see the failure.
			// Mirrors the pattern in corpus/run.tsx — setImmediate() yields so the React render flushes
			// to stderr/stdout before the process tears down.
			setImmediate().then(() => process.exit(1))
		}
	}, [error])

	useEffect(() => {
		const input = args[0]!

		if (options.benchmark !== undefined) {
			if (options.isolated || (options.policy && options.policy.length > 0) || options.neural) {
				// Intentional: surface the validation error through the same render-then-exit pattern
				// as the async setError paths below (see the useEffect on [error] above). The
				// "cascading renders" the rule warns about are not a real cost here because the
				// effect short-circuits with `return`.
				// eslint-disable-next-line react-hooks/set-state-in-effect
				setError(
					"--benchmark requires the default runtime-pipeline path (incompatible with --isolated / --policy / --neural)"
				)

				return
			}
			runBenchmark(input, options, options.benchmark)
				.then(setOutput)
				.catch((err) => setError(err.message))

			return
		}

		// --isolated: legacy rule-only path (the pre-pipeline default).
		if (options.isolated) {
			runIsolated(input, options)
				.then(setOutput)
				.catch((err) => setError(err.message))

			return
		}

		// --policy implies the legacy proposal/policy path.
		if (options.policy && options.policy.length > 0) {
			const policyOverrides = parsePolicySpecs(options.policy)
			runNeural(input, options, policyOverrides)
				.then(setOutput)
				.catch((err) => setError(err.message))

			return
		}

		// --neural without --policy: legacy direct-neural path (kept for parity with old behavior).
		if (options.neural) {
			runNeural(input, options, [])
				.then(setOutput)
				.catch((err) => setError(err.message))

			return
		}

		// Default: runtime pipeline.
		runPipeline(input, options)
			.then(setOutput)
			.catch((err) => setError(err.message))
	}, [args, options])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (!output) {
		return <Spinner />
	}

	return <Text>{output}</Text>
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
		throw new Error(
			"--resolve needs a WOF SQLite path. Set $MAILWOMAN_WOF_DB or pass --resolve-db <path>. " +
				"Download from https://data.geocode.earth/wof/dist/sqlite/ and pre-build the FTS5 index " +
				"with `npx mailwoman-wof-build-fts <path>`."
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

	if (options.candidates !== undefined) opts.candidatesPerLookup = options.candidates + 1
	const dc = resolverDefaultCountry(options, !!resolveCandidateDBPath())

	if (dc) opts.defaultCountry = dc

	// #895: the library default is ON; only the explicit --no-admin-coherence pin needs threading.
	if (options.adminCoherence === false) opts.adminCoherence = false

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
		throw new Error(
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

/** Legacy rule-only path. Used by --isolated and as a graceful fallback when neural is unavailable. */
async function runIsolated(input: string, options: zod.infer<typeof ParseConfigSchema>): Promise<string> {
	const parser = createAddressParser()
	const parseOpts = options.locale ? { locale: options.locale } : {}

	if (options.debug) {
		return parser.parse(input, { verbose: true, ...parseOpts }).then(createDiagnosticReport)
	}

	return parser.parse(input, parseOpts).then((results) => JSON.stringify(results, null, 2))
}

/**
 * Default path: runtime pipeline. Lazy-loads neural classifier (graceful fallback to the legacy rule-only path if
 * weights aren't present) + optional resolver. Returns the parsed tree serialized in the requested format.
 */
async function runPipeline(input: string, options: zod.infer<typeof ParseConfigSchema>): Promise<string> {
	const classifier = options.noNeural ? undefined : await tryLoadNeural(options)

	// Graceful fallback: if neither neural nor resolver is in play, the pipeline emits an empty tree
	// for structured addresses (no encoder + no resolver = nothing to classify token-by-token). Hand
	// off to the legacy rule path so the CLI still produces useful output. Two exceptions stay on the
	// pipeline:
	//   - `--debug`: the operator explicitly asked for the PipelineResult JSON shape; routing to the
	//     legacy diagnostic report would silently change the output schema. Fast-path inputs
	//     (postcode_only, locality_only) still produce a populated tree from QueryShape alone.
	//   - future fast-path inputs once we add more rule-based kinds.
	if (!classifier && !options.resolve && !options.debug) {
		return runIsolated(input, options)
	}

	const wantAlternatives = options.candidates !== undefined
	const resolveOpts: { candidatesPerLookup?: number; defaultCountry?: string } = {}

	if (wantAlternatives) resolveOpts.candidatesPerLookup = (options.candidates ?? 5) + 1

	// Scope the resolver so a bare region abbreviation (`NY`) resolves to the intended country's place
	// rather than a higher-priority foreign homonym. Inferred from --locale unless --default-country
	// overrides (or is `none`). Only meaningful on the --resolve path; harmless otherwise.
	if (options.resolve) {
		const dc = resolverDefaultCountry(options, !!resolveCandidateDBPath())

		if (dc) resolveOpts.defaultCountry = dc
	}
	const pipelineOpts: { locale?: string; resolveOpts?: { candidatesPerLookup?: number; defaultCountry?: string } } = {
		locale: options.locale,
	}

	if (resolveOpts.candidatesPerLookup !== undefined || resolveOpts.defaultCountry !== undefined) {
		pipelineOpts.resolveOpts = resolveOpts
	}

	if (options.resolve) {
		return withResolver(options, async (resolver) => {
			const fst = await tryBuildFST(options)
			const pipeline = createRuntimePipeline({ classifier, resolver, fst })
			const result = await pipeline(input, pipelineOpts)

			return options.debug
				? JSON.stringify(serializeResult(result, options.format), null, 2)
				: serializeTree(result.tree, options.format, { includeAlternatives: wantAlternatives })
		})
	}

	const fst = await tryBuildFST(options)
	const pipeline = createRuntimePipeline({ classifier, fst })
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
		for (let i = 0; i < BENCHMARK_WARMUP_ITERATIONS; i++) await runOne(pipeline)

		if (typeof global.gc === "function") global.gc()
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
		? await withResolver(options, (resolver) => collect(createRuntimePipeline({ classifier, resolver })))
		: await collect(createRuntimePipeline({ classifier }))

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
