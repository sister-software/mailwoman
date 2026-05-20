/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Spinner } from "@inkjs/ui"
import { type AddressTree, decodeAsJson, decodeAsTuples, decodeAsXml, proposalsToTree } from "@mailwoman/core/decoder"
import { collectProposals, filterByPolicy } from "@mailwoman/core/parser"
import { InMemoryPolicyRegistry, type PolicyMode } from "@mailwoman/core/policy"
import { createWofResolver, type Resolver, type ResolverBackend } from "@mailwoman/core/resolver"
import type { ComponentTag, Section } from "@mailwoman/core/types"
import { createNeuralProposalClassifier, NeuralAddressClassifier } from "@mailwoman/neural"
import { Text } from "ink"
import { createAddressParser, createDiagnosticReport } from "mailwoman"
import { setImmediate } from "node:timers/promises"
import { useEffect, useState } from "react"
import zod from "zod"
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
	neural: zod
		.boolean()
		.optional()
		.default(false)
		.describe("Route through the neural classifier instead of the rule-based parser."),
	format: zod
		.enum(["json", "tuple", "xml"])
		.optional()
		.default("json")
		.describe("Output projection for --neural. Ignored without --neural."),
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

		if (options.policy && options.policy.length > 0 && !options.neural) {
			// eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount validation; refactor pending
			setError("--policy requires --neural in this version (rule-side policy integration is a follow-up).")
			return
		}

		if (options.resolve && !options.neural) {
			// eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount validation; refactor pending
			setError(
				"--resolve requires --neural. The rule-based parser doesn't produce the AddressTree shape the resolver needs."
			)
			return
		}

		if (options.neural) {
			const policyOverrides = options.policy ? parsePolicySpecs(options.policy) : []
			runNeural(input, options, policyOverrides)
				.then(setOutput)
				.catch((err) => setError(err.message))
			return
		}

		const parser = createAddressParser()
		const parseOpts = options.locale ? { locale: options.locale } : {}

		if (options.debug) {
			parser
				.parse(input, { verbose: true, ...parseOpts })
				.then(createDiagnosticReport)
				.then(setOutput)
				.catch((err) => setError(err.message))
		} else {
			parser
				.parse(input, parseOpts)
				.then((results) => setOutput(JSON.stringify(results, null, 2)))
				.catch((err) => setError(err.message))
		}
	}, [
		args,
		options.debug,
		options.locale,
		options.neural,
		options.format,
		options.model,
		options.tokenizer,
		options.policy,
		options.resolve,
		options.resolveDb,
	])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (!output) {
		return <Spinner />
	}

	return <Text>{output}</Text>
}

function resolveWofPath(options: zod.infer<typeof ParseConfigSchema>): string {
	const path = options.resolveDb ?? process.env["MAILWOMAN_WOF_DB"]
	if (!path) {
		throw new Error(
			"--resolve needs a WOF SQLite path. Set $MAILWOMAN_WOF_DB or pass --resolve-db <path>. " +
				"Download from https://data.geocode.earth/wof/dist/sqlite/ and pre-build the FTS5 index " +
				"with `npx mailwoman-wof-build-fts <path>`."
		)
	}
	return path
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

	const lookup = new mod.WofSqlitePlaceLookup({ databasePath: resolveWofPath(options) })
	try {
		// PlaceLookup is structurally compatible with ResolverBackend — the cast is just to satisfy
		// the type, no runtime conversion.
		const resolver = createWofResolver(lookup as unknown as ResolverBackend)
		return await fn(resolver)
	} finally {
		lookup.close()
	}
}

function serializeTree(tree: AddressTree, format: "json" | "tuple" | "xml"): string {
	switch (format) {
		case "xml":
			return decodeAsXml(tree)
		case "tuple":
			return JSON.stringify(decodeAsTuples(tree), null, 2)
		default:
			return JSON.stringify(decodeAsJson(tree), null, 2)
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
				return neural.parseXml(input)
			case "tuple":
				return JSON.stringify(await neural.parseTuples(input), null, 2)
			default:
				return JSON.stringify(await neural.parseJson(input), null, 2)
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
		tree = await withResolver(options, (resolver) => resolver.resolveTree(tree))
	}

	return serializeTree(tree, options.format)
}

export default ParseCommand
