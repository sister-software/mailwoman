/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Postal address parser.
 */

// Address Parser using Chevrotain
import { createToken, CstParser, IToken, ITokenConfig, Lexer, TokenType } from "chevrotain"

export interface InvariantTokenResult<TokenKind extends string = string> {
	/**
	 * The machine-readable name of the token.
	 */
	readonly kind: TokenKind
	readonly type: TokenType
}

export function createInvariantTokenType<T extends ITokenConfig>(config: Readonly<T>): InvariantTokenResult<T["name"]> {
	const token = createToken(config)

	Object.assign(token, {
		[Symbol.for("nodejs.util.inspect.custom")]: () => {
			return `TokenType(${config.label || config.name})`
		},
	})

	const result: InvariantTokenResult<T["name"]> = {
		kind: config.name,
		type: token,
	}

	return result
}

export const WhiteSpace = createInvariantTokenType({
	name: "white_space",
	label: "White Space",
	pattern: /\s+/,
	group: Lexer.SKIPPED,
})

export const QuotedText = createInvariantTokenType({
	name: "quoted_text",
	label: "Quoted Text",
	pattern: /"[^"]*"/,
})

export const ParenthesizedText = createInvariantTokenType({
	name: "parenthesized_text",
	label: "Parenthesized Text",
	pattern: /\([^)]*\)/,
})

export const BracketedText = createInvariantTokenType({
	name: "bracketed_text",
	label: "Bracketed Text",
	pattern: /\[[^\]]*\]/,
})

const Comma = createInvariantTokenType({
	// Important: Comma must be defined before Word
	name: "comma",
	label: "Comma",
	pattern: /,/,
})

export const Word = createInvariantTokenType({
	name: "word",
	label: "Word",
	// Word must not include commas in its pattern
	pattern: /[^\s()[\]",]+/,
})

// Token order is important for the lexer
const TokenInvariants = [
	// ---
	WhiteSpace,
	QuotedText,
	ParenthesizedText,
	BracketedText,
	Comma,
	Word,
] as const satisfies readonly InvariantTokenResult[]

export type AddressTokenKind = (typeof TokenInvariants)[number]["kind"]

/**
 * A token type for the address parser.
 */
export interface AddressTokenType<TokenKind extends AddressTokenKind = AddressTokenKind> extends TokenType {
	/**
	 * A machine-friendly token kind identifier.
	 */
	readonly name: TokenKind
}

/**
 * A parsed instance of a token type.
 */
export interface AddressToken
	extends Pick<IToken, "startOffset" | "startLine" | "startColumn" | "endOffset" | "endLine" | "endColumn"> {
	/**
	 * A machine-friendly token kind identifier.
	 */
	readonly kind: AddressTokenKind
	/**
	 * The value of the parsed token.
	 */
	readonly value: string
	/**
	 * The original content of the token.
	 */
	readonly original: string
}

const TokenTypes: TokenType[] = TokenInvariants.map((token) => token.type)

/**
 * Type predicate to determine if a token is of a specific type.
 *
 * @param tokenKind The token kind ID to check against.
 * @param instance The token instance to check.
 */
export function isTokenKind<N extends AddressTokenKind, T extends AddressToken>(
	tokenKind: N,
	instance: T
): instance is T & { tokenType: AddressTokenType<N> } {
	return instance.kind === tokenKind
}

/**
 * Singleton lexer for address parsing.
 */
const AddressLexer = new Lexer(TokenTypes)

// Parser
export class AddressParser extends CstParser {
	constructor() {
		super(TokenTypes)

		// Grammar definition
		this.RULE("address", () => {
			this.MANY(() => {
				this.OR([
					{ ALT: () => this.CONSUME(Word.type) },
					{ ALT: () => this.CONSUME(QuotedText.type) },
					{ ALT: () => this.CONSUME(ParenthesizedText.type) },
					{ ALT: () => this.CONSUME(BracketedText.type) },
					{ ALT: () => this.CONSUME(Comma.type) },
				])
			})
		})

		// Must initialize the parser
		this.performSelfAnalysis()
	}

	/**
	 * Perform self-analysis of the parser.
	 */
	declare address: () => void
}

export function parsePostalAddress(input: string): AddressToken[] {
	const parser = new AddressParser()
	// Tokenize the input
	const lexingResult = AddressLexer.tokenize(input)

	// Set the input tokens
	parser.input = lexingResult.tokens

	// Parse the address
	parser.address()

	// Check for errors
	if (parser.errors.length > 0) {
		throw new Error("Parsing errors detected: " + parser.errors.map((err) => err.message).join("\n"))
	}

	// Extract the tokens from the CST
	const { tokens } = lexingResult

	return tokens.map(({ image, ...token }): AddressToken => {
		let value = image

		// Remove quotes/parentheses/brackets from the special tokens if needed
		switch (token.tokenType) {
			case QuotedText.type:
			case ParenthesizedText.type:
			case BracketedText.type:
				value = value.substring(1, value.length - 1) // Remove quotes/parentheses/brackets
				break
		}

		return {
			...token,
			kind: token.tokenType.name as AddressTokenKind,
			value,
			original: image,
		}
	})
}
