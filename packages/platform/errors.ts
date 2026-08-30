/**
 * Error thrown when a platform capability has no implementation for the selected runtime.
 */
export class NotImplementedError extends Error {
	public constructor(packageName: string) {
		super(`The platform capability "${packageName}" is not implemented for this runtime.`)
		this.name = "NotImplementedError"
	}
}
