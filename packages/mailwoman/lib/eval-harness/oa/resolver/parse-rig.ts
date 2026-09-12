/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The parse-and-resolve rig a run grades through — the ship-config scorer, the gazetteer backend behind the
 *   resolver, and the parse/resolve options the flags pin.
 */

import type { ScorerOverrides } from "@mailwoman/neural/scorer"
import { createWOFResolver } from "@mailwoman/resolver"

import { buildLocalityMatcher } from "#eval-harness/oa/resolver/admin-match"
import type { OAResolverEvalOptions } from "#eval-harness/oa/resolver/options"
import type { LookupCensus } from "#eval-harness/oa/resolver/profile"

/**
 * Assemble the scorer, the gazetteer-backed resolver and the per-call option bags one run parses and resolves every row
 * through. `wofPaths` is threaded in rather than re-derived: database 0 is BOTH the resolver's admin gazetteer and the
 * locality matcher's altname/ancestry source, and the two must be the same file for a name-match allowance to mean
 * anything.
 *
 * Every tri-state pin below resolves to `undefined` when neither flag is passed, which leaves the library default in
 * force. A check leg that says which side it graded is the point of a tri-state — a silent config shift inside a check
 * battery is the #718 sin.
 */
export async function buildParseRig(
	options: OAResolverEvalOptions,
	wofPaths: string[],
	reportError: (line: string) => void
) {
	// Full SHIP-CONFIG via the canonical ProductionScorer (#722): createScorer reads the model-card's
	// `requires` block and feeds EVERY declared channel — anchor + gazetteer + conventions(=auto) +
	// suppress-gaz-near-postcode — and fails closed (strict) if a declared channel can't be fed. This
	// grades the parse the library + server actually ship, not the hand-built anchor-only classifier
	// this eval used before. `--model-anchor-lookup` still pins the anchor source (else createScorer's
	// default /mnt pilot + the repo gazetteer lexicon). `--ablate-to-anchor` drops back to anchor-only
	// (gazetteer + conventions OFF) for the #722 before/after comparison.
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const modelAnchorPath = options.modelAnchorLookup || ""
	const ablateToAnchor = options.ablateToAnchor ?? false
	// `--anchor-off` (#887): the sanctioned anchor ablation — `overrides.anchor=false` through
	// createScorer (a loud warning, not a throw). Replaces the pre-#718 empty-anchor.json idiom,
	// which the fail-closed check now refuses (an empty lookup parses to size 0 → UnfedChannelError).
	const anchorOff = options.anchorOff ?? false

	const overrides: ScorerOverrides = {
		...(ablateToAnchor ? { gazetteer: false, conventions: false } : {}),
		...(anchorOff ? { anchor: false } : {}),
	}

	const neural = await createScorer({
		modelPath: options.model || "",
		tokenizerPath: options.tokenizer || "",
		modelCardPath: options.modelCard || "",
		...(modelAnchorPath ? { anchorLookupPath: modelAnchorPath } : {}),
		...(options.adminFST ? { fstPath: options.adminFST } : {}),
		strict: true,
		tier: "server",
		...(ablateToAnchor || anchorOff ? { overrides } : {}),
	})

	if (options.adminFST) {
		reportError(`[scorer] FST gazetteer pinned: ${options.adminFST} (assembled arms only)`)
	}

	reportError(
		ablateToAnchor
			? "[scorer] ABLATED to anchor-only (gazetteer + conventions OFF) — #722 before/after baseline"
			: "[scorer] full ship-config via createScorer (anchor + gazetteer + conventions=auto + suppress)"
	)

	if (anchorOff) {
		reportError("[scorer] anchor channel ABLATED (--anchor-off → overrides.anchor=false, #887 declared ablation)")
	}

	// `--candidate-db <candidate.db>` swaps the FTS backend for the byte-range candidate-table lookup
	// (the SAME backend + ranking the browser demo uses). This is the "CLI matches demo" check: run the
	// eval both ways and confirm US locality/coord don't regress before defaulting the CLI to it.
	const candidateDB = options.candidateDB || ""
	// `--postal-city-alias-db <db>` (#475) attaches the opt-in postal-city alias scorer on the FTS
	// path: a user-typed postal city resolves to its geographic locality. Run the eval with and
	// without to measure the lift. No-op on the candidate backend (it folds aliases at build time).
	const postalCityAliasDB = options.postalCityAliasDB || ""

	const { WOFSQLitePlaceLookup, WOFCandidateTableLookup, WOFPostalCityAliasLookup } =
		await import("@mailwoman/resolver-wof-sqlite")

	const postalCityAliases = postalCityAliasDB
		? new WOFPostalCityAliasLookup({ databasePath: postalCityAliasDB })
		: undefined

	const backend = candidateDB
		? new WOFCandidateTableLookup({ databasePath: candidateDB })
		: new WOFSQLitePlaceLookup({
				databasePath: wofPaths.length === 1 ? wofPaths[0]! : wofPaths,
				postalCityAliases,
			})

	if (candidateDB) {
		reportError(`[backend] candidate-table lookup over ${candidateDB} (demo-parity ranking)`)
	}

	if (postalCityAliases) {
		reportError(`[backend] postal-city alias scorer enabled (#475): ${postalCityAliasDB}`)
	}

	// Under `profileJSON` only: count the gazetteer queries one row costs, and how many of them repeat a key an earlier
	// row already asked. That separates "the resolver is called often" from "the resolver answers the same question
	// often", which are different fixes. The proxy binds every method to the real backend — `WOFSQLitePlaceLookup` holds
	// private fields, and a method invoked with the proxy as `this` cannot read them.
	const lookupCensus: LookupCensus | null = options.profileJSON || "" ? { calls: 0, keys: new Set<string>() } : null
	const lookupMemo = (options.lookupMemo ?? false) ? new Map<string, Promise<unknown>>() : null

	const wrappedBackend =
		lookupCensus || lookupMemo
			? new Proxy(backend, {
					get(target, property) {
						const value = Reflect.get(target, property, target)

						if (typeof value !== "function") return value

						if (property !== "findPlace") return value.bind(target)

						return async (...args: unknown[]) => {
							const key = JSON.stringify(args[0])

							if (lookupCensus) {
								lookupCensus.calls++
								lookupCensus.keys.add(key)
							}

							if (!lookupMemo) return value.apply(target, args)

							// The in-flight promise is memoized, not its result: two rows can ask the same question before
							// either answer lands, and caching the promise collapses those into one query.
							let pending = lookupMemo.get(key)

							if (!pending) {
								pending = value.apply(target, args) as Promise<unknown>
								lookupMemo.set(key, pending)
							}

							const hits = await pending

							// A fresh array per caller: the hit objects are shared, but an in-place sort stays local.
							return Array.isArray(hits) ? [...hits] : hits
						}
					},
				})
			: backend

	const resolver = createWOFResolver(wrappedBackend)

	const localityMatches = buildLocalityMatcher(wofPaths[0]!)

	// #690/#895: normalizeCase is tri-state so an eval leg can PIN either side of the library default
	// (default-ON at the classifier since #895). `--normalize-case` pins ON, `--raw-case` pins OFF,
	// neither = the library default. Silent config shifts in a check battery are the #718 sin — pin
	// explicitly in pre-registered legs.
	const normalizeCase = (options.normalizeCase ?? false) ? true : (options.rawCase ?? false) ? false : undefined

	const parseOpts = {
		postcodeRepair: true,
		...(normalizeCase !== undefined ? { normalizeCase } : {}),
	} as Parameters<typeof neural.parse>[1]

	// `defaultCountry` is the hard country filter applied to admin lookups when the parse carries no
	// resolved country node. It MUST match the dataset's locale — hardcoding "US" silently filters a
	// non-US eval to US places (a German "Berlin" then loses to a tiny US Berlin). Settable via
	// `--default-country <ISO|none>`; `none` disables the filter so ranking alone decides.
	const dc = options.defaultCountry || "US"
	// `--hierarchy-completion` (#405, generalizes #387's `--city-state-fallback`): recover the locality
	// the parser drops for a DUAL-ROLE place (city-state or capital-seat province), via the precomputed
	// coincident-roles relation (#403). Opt-in, default-off → by default this eval is byte-identical;
	// pass it to measure the before/after. Applied to BOTH the neural and rules resolve paths (they
	// share `resolveOpts`), so the comparison stays fair. `--city-state-fallback` kept as an alias.
	const hierarchyCompletion = options.hierarchyCompletion ?? false

	// #895: adminCoherence is default-ON in the resolver now (drift D1 settled). Tri-state pin for check
	// legs: `--admin-coherence` ON, `--no-admin-coherence` OFF, neither = the library default.
	const adminCoherence =
		(options.adminCoherence ?? false) ? true : (options.noAdminCoherence ?? false) ? false : undefined

	// #42: default-ON in the resolver since 2026-08-05, so the pin is a full tri-state like adminCoherence's —
	// `--postcode-country-coherence` ON, `--postcode-country-coherence-off` OFF, neither = the library default.
	const postcodeCountryCoherence =
		(options.postcodeCountryCoherence ?? false)
			? true
			: (options.noPostcodeCountryCoherence ?? false)
				? false
				: undefined

	const resolveOpts = {
		...(dc && dc.toLowerCase() !== "none" ? { defaultCountry: dc } : {}),
		...(hierarchyCompletion ? { hierarchyCompletion: true } : {}),
		...(adminCoherence !== undefined ? { adminCoherence } : {}),
		...(postcodeCountryCoherence !== undefined ? { postcodeCountryCoherence } : {}),
	}

	return { neural, resolver, localityMatches, parseOpts, defaultCountry: dc, resolveOpts, lookupCensus }
}
