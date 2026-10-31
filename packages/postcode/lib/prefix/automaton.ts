/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A prefix test for a postcode syntax pattern.
 *
 *   A `RegExp` answers whether a whole string matches. Completion asks a different question: whether some
 *   suffix exists that makes the string match. This module answers it by compiling the pattern's source into a
 *   Thompson NFA and running the NFA over the prefix. The prefix can complete exactly when at least one state is
 *   still live once the prefix is consumed, because every state of the automaton can reach the accepting state:
 *   each character class the postcode data uses admits at least one character, and no pattern places a
 *   consuming step after `$`.
 *
 *   The parser covers the regex subset the libaddressinput data and `written-forms.ts` use: literals, escapes
 *   (`\d`, `\s`, `\w`, `\b`, an escaped punctuation character), character classes with ranges and negation,
 *   capturing and non-capturing groups, alternation, the quantifiers `?`, `*`, `+` and `{n}`, `{n,}`,
 *   `{n,m}`, and the anchors `^` and `$`. Any other construct throws, so a new pattern outside the subset fails
 *   the test that compiles every country rather than answering wrongly. The automaton ignores case, as
 *   `postcodeSyntax` compiles it.
 *
 *   One assertion is approximated. A `\b` or `$` reached at the end of the prefix depends on the character that
 *   follows. The prefix does not contain that character, so the automaton lets the assertion pass. That can only widen the answer:
 *   no completable prefix is refused. Bahrain's pattern is the one that uses `\b`, at its two ends.
 */

type CharTest = (c: string) => boolean

type Node =
	| { readonly kind: "char"; readonly test: CharTest }
	| { readonly kind: "assert"; readonly assertion: "start" | "end" | "boundary" | "non-boundary" }
	| { readonly kind: "seq"; readonly items: readonly Node[] }
	| { readonly kind: "alt"; readonly options: readonly Node[] }
	| { readonly kind: "repeat"; readonly item: Node; readonly min: number; readonly max: number }

interface State {
	kind: "char" | "assert" | "split" | "match"
	test?: CharTest
	assertion?: "start" | "end" | "boundary" | "non-boundary"
	out: State[]
}

const isWord: CharTest = (c) => /\w/u.test(c)
const isDigit: CharTest = (c) => c >= "0" && c <= "9"
const isSpace: CharTest = (c) => /\s/u.test(c)

function caseless(c: string): string[] {
	const lower = c.toLowerCase()
	const upper = c.toUpperCase()

	return lower === upper ? [c] : [lower, upper]
}

class PatternParser {
	readonly #source: string
	#i = 0

	constructor(source: string) {
		this.#source = source
	}

	parse(): Node {
		const node = this.#alternation()

		if (this.#i < this.#source.length) {
			this.#fail("unexpected character")
		}

		return node
	}

	#fail(reason: string): never {
		throw new Error(`prefix automaton: ${reason} at ${this.#i} in /${this.#source}/`)
	}

	#peek(): string | undefined {
		return this.#source[this.#i]
	}

	#alternation(): Node {
		const options = [this.#sequence()]

		while (this.#peek() === "|") {
			this.#i++
			options.push(this.#sequence())
		}

		return options.length === 1 ? options[0]! : { kind: "alt", options }
	}

	#sequence(): Node {
		const items: Node[] = []

		for (let c = this.#peek(); c != null && c !== "|" && c !== ")"; c = this.#peek()) {
			items.push(this.#quantified(this.#atom()))
		}

		return { kind: "seq", items }
	}

	#quantified(item: Node): Node {
		const c = this.#peek()
		let min: number
		let max: number

		if (c === "?") {
			;[min, max] = [0, 1]
		} else if (c === "*") {
			;[min, max] = [0, Infinity]
		} else if (c === "+") {
			;[min, max] = [1, Infinity]
		} else if (c === "{") {
			const match = /^\{(\d+)(,(\d*))?\}/u.exec(this.#source.slice(this.#i))

			if (!match) {
				this.#fail("malformed quantifier")
			}

			min = Number(match[1])
			max = match[2] == null ? min : match[3] ? Number(match[3]) : Infinity
			this.#i += match[0].length - 1
		} else return item

		this.#i++

		if (this.#peek() === "?") {
			this.#fail("lazy quantifier")
		}

		return { kind: "repeat", item, min, max }
	}

	#atom(): Node {
		const c = this.#peek()!

		this.#i++

		if (c === "(") {
			if (this.#peek() === "?") {
				if (this.#source[this.#i + 1] !== ":") {
					this.#fail("unsupported group")
				}

				this.#i += 2
			}

			const inner = this.#alternation()

			if (this.#peek() !== ")") {
				this.#fail("unclosed group")
			}

			this.#i++

			return inner
		}

		if (c === "[") return { kind: "char", test: this.#charClass() }

		if (c === "^") return { kind: "assert", assertion: "start" }

		if (c === "$") return { kind: "assert", assertion: "end" }

		if (c === ".") return { kind: "char", test: (x) => x !== "\n" }

		if (c === "\\") {
			const e = this.#peek()

			if (e == null) {
				this.#fail("trailing escape")
			}

			this.#i++

			if (e === "b") return { kind: "assert", assertion: "boundary" }

			if (e === "B") return { kind: "assert", assertion: "non-boundary" }

			return { kind: "char", test: this.#escape(e) }
		}

		if ("*+?{".includes(c)) {
			this.#fail("quantifier without a target")
		}

		const forms = caseless(c)

		return { kind: "char", test: (x) => forms.includes(x) }
	}

	#escape(e: string): CharTest {
		if (e === "d") return isDigit

		if (e === "D") return (x) => !isDigit(x)

		if (e === "s") return isSpace

		if (e === "S") return (x) => !isSpace(x)

		if (e === "w") return isWord

		if (e === "W") return (x) => !isWord(x)

		if (/[A-Za-z0-9]/u.test(e)) {
			this.#fail(`unsupported escape \\${e}`)
		}

		return (x) => x === e
	}

	#charClass(): CharTest {
		const negated = this.#peek() === "^"

		if (negated) {
			this.#i++
		}

		const tests: CharTest[] = []

		for (let first = true; this.#peek() !== "]" || first; first = false) {
			let c = this.#peek()

			if (c == null) {
				this.#fail("unclosed class")
			}

			this.#i++

			if (c === "\\") {
				const e = this.#peek()

				if (e == null) {
					this.#fail("trailing escape")
				}

				this.#i++

				if ("dDsSwW".includes(e)) {
					tests.push(this.#escape(e))

					continue
				}

				if (/[A-Za-z0-9]/u.test(e)) {
					this.#fail(`unsupported escape \\${e}`)
				}

				c = e
			}

			if (this.#peek() === "-" && this.#source[this.#i + 1] !== "]") {
				this.#i++

				let end = this.#peek()!

				this.#i++

				if (end === "\\") {
					end = this.#peek()!

					this.#i++
				}

				const lo = c
				const hi = end

				tests.push((x) => caseless(x).some((f) => f >= lo && f <= hi))

				continue
			}

			const forms = caseless(c)

			tests.push((x) => forms.includes(x))
		}

		this.#i++

		return negated ? (x) => !tests.some((t) => t(x)) : (x) => tests.some((t) => t(x))
	}
}

interface Fragment {
	readonly start: State
	readonly ends: State[]
}

function patch(ends: readonly State[], target: State): void {
	for (const end of ends) {
		end.out.push(target)
	}
}

function build(node: Node): Fragment {
	switch (node.kind) {
		case "char": {
			const state: State = { kind: "char", test: node.test, out: [] }

			return { start: state, ends: [state] }
		}
		case "assert": {
			const state: State = { kind: "assert", assertion: node.assertion, out: [] }

			return { start: state, ends: [state] }
		}
		case "seq": {
			const entry: State = { kind: "split", out: [] }
			let ends: State[] = [entry]

			for (const item of node.items) {
				const fragment = build(item)

				patch(ends, fragment.start)
				ends = fragment.ends
			}

			return { start: entry, ends }
		}
		case "alt": {
			const entry: State = { kind: "split", out: [] }
			const ends: State[] = []

			for (const option of node.options) {
				const fragment = build(option)

				entry.out.push(fragment.start)
				ends.push(...fragment.ends)
			}

			return { start: entry, ends }
		}
		case "repeat": {
			const entry: State = { kind: "split", out: [] }
			let ends: State[] = [entry]

			for (let n = 0; n < node.min; n++) {
				const fragment = build(node.item)

				patch(ends, fragment.start)
				ends = fragment.ends
			}

			if (node.max === Infinity) {
				const loop: State = { kind: "split", out: [] }
				const fragment = build(node.item)

				patch(ends, loop)
				loop.out.push(fragment.start)
				patch(fragment.ends, loop)

				return { start: entry, ends: [loop] }
			}

			const exits: State[] = [...ends]

			for (let n = node.min; n < node.max; n++) {
				const fragment = build(node.item)

				patch(ends, fragment.start)
				ends = fragment.ends
				exits.push(...ends)
			}

			return { start: entry, ends: exits }
		}
	}
}

/**
 * A compiled pattern that answers whether a string is a prefix of some string the pattern matches whole.
 */
export class PrefixAutomaton {
	readonly #start: State

	/**
	 * Compiles `source`, the text of a regular expression, matched case-insensitively
	 * and anchored at both ends.
	 *
	 * @throws When the source uses a construct outside the supported subset.
	 */
	constructor(source: string) {
		const fragment = build(new PatternParser(source).parse())
		const match: State = { kind: "match", out: [] }

		patch(fragment.ends, match)
		this.#start = fragment.start
	}

	/**
	 * The states reachable from `states` without consuming a character, at position `pos` of `text`.
	 *
	 * A position at the end of `text` has an unknown next character, so `$` and `\b` pass there.
	 */
	#closure(states: Iterable<State>, text: string, pos: number): Set<State> {
		const seen = new Set<State>()
		const stack = [...states]
		const prev = pos > 0 ? text[pos - 1] : undefined
		const next = text[pos]

		while (stack.length) {
			const state = stack.pop()!

			if (seen.has(state)) continue
			seen.add(state)

			if (state.kind === "split") {
				stack.push(...state.out)
			} else if (state.kind === "assert") {
				const before = prev != null && isWord(prev)
				const after = next != null && isWord(next)

				const passes =
					state.assertion === "start"
						? pos === 0
						: state.assertion === "end"
							? next == null
							: next == null || (state.assertion === "boundary" ? before !== after : before === after)

				if (passes) {
					stack.push(...state.out)
				}
			}
		}

		return seen
	}

	/**
	 * Whether some suffix, possibly empty, completes `text` to a whole match.
	 */
	canComplete(text: string): boolean {
		let states = this.#closure([this.#start], text, 0)

		for (let pos = 0; pos < text.length; pos++) {
			const c = text[pos]!
			const stepped: State[] = []

			for (const state of states) {
				if (state.kind === "char" && state.test!(c)) {
					stepped.push(...state.out)
				}
			}

			if (!stepped.length) return false
			states = this.#closure(stepped, text, pos + 1)
		}

		for (const state of states) {
			if (state.kind === "char" || state.kind === "match") return true
		}

		return false
	}
}
