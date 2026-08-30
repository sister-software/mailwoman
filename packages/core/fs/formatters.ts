/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * A kibibyte. Named so a `< 1024` guard reads as a threshold rather than a magic number — several fetchers use it to
 * reject a response too small to be the archive they asked for.
 */
export const BYTES_PER_KIB = 1024

export interface ByteFormatterOptions {
	/**
	 * Prefix an explicit `+` on a positive value. For a DELTA, where the sign is the information. A negative always
	 * carries its own sign.
	 */
	signed?: boolean
	/**
	 * Override the formatter's locale for this call.
	 */
	locales?: Intl.LocalesArgument
}

/**
 * Byte counts as a human reads them, in whichever of the two bases the number was actually measured in.
 *
 * Both bases, spelled correctly. A formatter that divides by 1024 and prints `KB` is off by 2.4% at KB and 10% by TB,
 * and the label is the only thing telling a reader which it did — so the choice is named at the call site:
 *
 * - {@linkcode ByteFormatter.formatIEC} for anything a MACHINE measured — heap, file size on disk, buffer length.
 * - {@linkcode ByteFormatter.formatSI} for a size a VENDOR reports. Disk capacity, download sizes and GitHub's own API
 *   are quoted in powers of ten; rendering GitHub's `41.3 GB` as `38.5 GiB` is correct arithmetic and the wrong
 *   answer.
 *
 * Rendering goes through `Intl.NumberFormat`, so the unit and the decimal separator follow the locale. Pass an explicit
 * locale when a caller needs a stable string — a test asserting an exact rendering, not a line printed for a human.
 */
export class ByteFormatter {
	public static SI_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const
	public static IEC_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const

	protected static shared = new ByteFormatter()

	/**
	 * Formats a file size in bytes into a human-readable string with appropriate SI units (B, kB, MB, GB, TB).
	 *
	 * @param bytes The file size in bytes.
	 * @param options Formatting options.
	 */
	public static formatSI(bytes: number, options?: ByteFormatterOptions): string {
		return ByteFormatter.shared.formatSI(bytes, options)
	}

	/**
	 * Formats a file size in bytes into a human-readable string with appropriate IEC units (B, KiB, MiB, GiB, TiB).
	 *
	 * @param bytes The file size in bytes.
	 * @param options Formatting options.
	 */
	public static formatIEC(bytes: number, options?: ByteFormatterOptions): string {
		return ByteFormatter.shared.formatIEC(bytes, options)
	}

	protected locales?: Intl.LocalesArgument

	constructor(locales?: Intl.LocalesArgument) {
		this.locales = locales
	}

	/**
	 * Formats a file size in bytes into a human-readable string with appropriate SI units (B, kB, MB, GB, TB).
	 *
	 * @param bytes The file size in bytes.
	 */
	public formatSI(bytes: number, options?: ByteFormatterOptions): string {
		const units = ByteFormatter.SI_UNITS

		let value = bytes
		let unit = 0

		while (Math.abs(value) >= 1000 && unit < units.length - 1) {
			value /= 1000

			unit++
		}

		return new Intl.NumberFormat(options?.locales ?? this.locales, {
			style: "unit",
			unit: units[unit],
			maximumFractionDigits: 1,
			signDisplay: options?.signed ? "exceptZero" : "auto",
		}).format(value)
	}

	/**
	 * Formats a file size in bytes into a human-readable string with appropriate IEC units (B, KiB, MiB, GiB, TiB).
	 *
	 * @param bytes The file size in bytes.
	 */
	public formatIEC(bytes: number, options?: ByteFormatterOptions): string {
		let value = bytes
		let unit = 0

		// oxlint-disable-next-line sister-software/no-unnamed-threshold -- Well known.
		while (Math.abs(value) >= 1024 && unit < ByteFormatter.IEC_UNITS.length - 1) {
			value /= 1024

			unit++
		}

		const formatted = new Intl.NumberFormat(options?.locales ?? this.locales, {
			maximumFractionDigits: 1,
			signDisplay: options?.signed ? "exceptZero" : "auto",
		}).format(value)

		return `${formatted} ${ByteFormatter.IEC_UNITS[unit]}`
	}
}
