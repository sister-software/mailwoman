/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which CLI verbs this server may run.
 *
 *   The boundary the whole surface is built on: **gather evidence, never change state that anything else reads.** The
 *   CLI's surface is larger than this server's and will stay that way, so a passthrough is worth having — but a
 *   passthrough with no allowlist would hand back every build, publish and ledger write the boundary excludes.
 *
 *   ALLOW-list rather than deny-list, on purpose. A deny-list is wrong by default: the day someone adds
 *   `mw gazetteer nuke`, a deny-list permits it and an allow-list does not. The cost is that a new read-only verb has
 *   to be added here before it can be used, which is the correct direction for the mistake to point.
 */

/**
 * Verb paths that only read. Matched against the leading arguments, so `eval` covers `eval gauntlet`, `eval gate` and
 * the rest — with the one exception carved out below.
 */
const ALLOWED_PREFIXES: readonly string[][] = [
	["parse"],
	["geocode"],
	["reverse"],
	["doctor"],
	["eval"],
	["gazetteer", "stats"],
	["poi"],
]

/**
 * Denied even though a prefix above would otherwise admit them.
 *
 * `eval ledger-append` is the one that matters and the reason this list exists at all: it is nested under an allowed
 * verb and it WRITES `evals/scores-by-version.json`, the score ledger. `mwdev_gate` deliberately reports that command
 * rather than running it, and this stops the passthrough from becoming the back door around that decision.
 */
const DENIED_PREFIXES: readonly string[][] = [
	["eval", "ledger-append"],
	["gazetteer", "build"],
	["coverage", "build"],
	["tiles", "publish"],
	["data", "pull"],
	["release"],
	["corpus"],
]

function matchesPrefix(args: readonly string[], prefix: readonly string[]): boolean {
	return prefix.every((part, index) => args[index] === part)
}

export interface AllowlistVerdict {
	allowed: boolean
	/**
	 * Why, in the words a caller needs. Populated on a refusal AND on an allow, so a log of calls records the boundary
	 * that was applied rather than only the ones that tripped it.
	 */
	reason: string
}

/**
 * Decide whether an argument vector may run.
 *
 * Flags are ignored for matching: only the leading non-flag words identify a verb, so `--help` anywhere is allowed and
 * a denied verb cannot be smuggled past by putting a flag in front of it.
 */
export function checkCLIAllowlist(args: readonly string[]): AllowlistVerdict {
	const verbs = args.filter((argument) => !argument.startsWith("-"))

	if (!verbs.length) {
		// `mw --help` and bare `mw` only print usage.
		return { allowed: true, reason: "No verb — help or usage output only." }
	}

	const denied = DENIED_PREFIXES.find((prefix) => matchesPrefix(verbs, prefix))

	if (denied) {
		return {
			allowed: false,
			reason:
				`\`${denied.join(" ")}\` changes state that something else reads, which is outside this server's boundary. ` +
				(denied.join(" ") === "eval ledger-append"
					? "The gate reports this command pre-filled precisely so an operator runs it at promote time; running it " +
						"here would route around that."
					: "Run it yourself if you mean to."),
		}
	}

	const allowed = ALLOWED_PREFIXES.find((prefix) => matchesPrefix(verbs, prefix))

	if (!allowed) {
		return {
			allowed: false,
			reason:
				`\`${verbs[0]}\` is not on the read-only allowlist (${ALLOWED_PREFIXES.map((p) => p.join(" ")).join(", ")}). ` +
				"This is an allowlist rather than a denylist, so a verb nobody has vetted is refused rather than permitted.",
		}
	}

	return { allowed: true, reason: `\`${allowed.join(" ")}\` is on the read-only allowlist.` }
}
