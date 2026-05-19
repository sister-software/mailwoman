/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type * as zod from "zod"

/**
 * Type-helper to infer the positional arguments of a command.
 */
export type PositionalArguments<T extends zod.ZodTypeAny> = {
	args: zod.infer<T>
}

/**
 * React component for a command with positional arguments.
 */
export type PositionalCommandComponent<T extends zod.ZodTypeAny> = React.FC<PositionalArguments<T>>

/**
 * Type-helper to infer the options of a command.
 */
export type CommandProps<
	OptionProps extends zod.AnyZodObject,
	PositionalProps extends zod.ZodTypeAny | unknown = unknown,
> = {
	options: zod.infer<OptionProps>
	args: PositionalProps extends zod.ZodTypeAny ? zod.infer<PositionalProps> : unknown[]
}

/**
 * React component for a command with options.
 */
export type CommandComponent<
	OptionProps extends zod.AnyZodObject,
	PositionalProps extends zod.ZodTypeAny | unknown = unknown,
> = React.FC<CommandProps<OptionProps, PositionalProps>>
