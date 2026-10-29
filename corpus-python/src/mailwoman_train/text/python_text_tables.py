"""Write the Rust tables that reproduce this interpreter's character predicates and case mappings.

The training encoder in `packages/mtf/crates/mtf-channels` splits words, strips punctuation, lowercases lexicon
keys and matches postcode shapes the way the Python loader did. Those operations read the interpreter's Unicode
database, and Rust's standard library carries a different Unicode version. The crate therefore reads
`src/python_text/tables.rs`, generated here from every scalar value this interpreter knows:

- `str.isspace`, `str.isalnum`, `str.isdecimal`, `str.isalpha` and `str.isdigit` as sorted inclusive ranges, and the
  characters whose Unicode name starts with a CJK script prefix (`is_cjk_named`);
- the characters the tokenizer's byte-fallback report skips, and the script block each other character's name
  places it in (`exposure.phenomena.SCRIPT_NAME_PREFIXES`, which `detect_script` there also reads);
- the cased and case-ignorable properties `str.lower` reads for the final-sigma rule;
- the full lowercase, uppercase and case-folding mapping of each character whose mapping is not itself;
- the writing system of each letter (`character_script`), which the mixed-script audit reads.

Surrogate code points are left out, because a Rust `char` cannot hold one and decoded UTF-8 never contains one.

`--check` regenerates the tables in memory and exits non-zero when they differ from the committed file, which
makes the comparison over every scalar value a test (`test_python_text_tables.py`).

Usage: `python -m mailwoman_train.text.python_text_tables [--check]`
"""

from __future__ import annotations

import argparse
import platform
import sys
import unicodedata
from collections.abc import Callable, Iterator

from ..exposure.phenomena import SCRIPT_NAME_PREFIXES
from ..paths import repo_root_path

#: The generated module, relative to the repository root.
TABLES_PATH = ("packages", "mtf", "crates", "mtf-channels", "src", "python_text", "tables.rs")

_SURROGATES = range(0xD800, 0xE000)


def scalar_values() -> Iterator[int]:
    """Every Unicode scalar value, in order."""
    for code in range(sys.maxunicode + 1):
        if code not in _SURROGATES:
            yield code


def ranges(predicate: Callable[[str], bool]) -> list[tuple[int, int]]:
    """The inclusive ranges of scalar values whose one-character string satisfies `predicate`."""
    out: list[tuple[int, int]] = []
    for code in scalar_values():
        if not predicate(chr(code)):
            continue
        if out and out[-1][1] == code - 1:
            out[-1] = (out[-1][0], code)
        elif out and out[-1][1] == 0xD7FF and code == 0xE000:
            # The surrogates are not scalar values, so a range may span them.
            out[-1] = (out[-1][0], code)
        else:
            out.append((code, code))
    return out


def is_cased(char: str) -> bool:
    """Unicode Cased, which `str.islower`, `str.isupper` and `str.istitle` read for one character."""
    return char.islower() or char.isupper() or char.istitle()


def is_case_ignorable(char: str) -> bool:
    """Unicode Case_Ignorable, observed through the final-sigma rule of `str.lower`.

    `str.lower` maps U+03A3 to final sigma when a cased character precedes it and none follows, skipping
    case-ignorable characters on both sides. A character after the sigma is skipped exactly when it is
    case-ignorable, so it is case-ignorable when the sigma stays final before it and turns medial once a cased
    letter follows it.
    """
    final_before_end = ("AΣ" + char).lower()[1] == "ς"
    medial_before_cased = ("AΣ" + char + "B").lower()[1] == "σ"
    return final_before_end and medial_before_cased


#: The name prefixes the grouping augmentation reads as CJK text, through `unicodedata.name`.
CJK_NAME_PREFIXES = ("CJK UNIFIED", "HIRAGANA", "KATAKANA", "HANGUL")


def is_cjk_named(char: str) -> bool:
    """Whether the character's Unicode name starts with one of `CJK_NAME_PREFIXES`."""
    return unicodedata.name(char, "").startswith(CJK_NAME_PREFIXES)


def is_script_skipped(char: str) -> bool:
    """Whether the byte-fallback report leaves the character out: a space, number, punctuation, separator or symbol."""
    return char.isspace() or unicodedata.category(char).startswith(("N", "P", "Z", "S"))


def script_block(char: str) -> int:
    """The character's index in `SCRIPT_NAME_PREFIXES`, or -1 for a character no prefix names."""
    name = unicodedata.name(char, "")
    for index, (_, prefixes) in enumerate(SCRIPT_NAME_PREFIXES):
        if name.startswith(prefixes):
            return index
    return -1


#: The writing systems the mixed-script audit names, in match order: a letter whose Unicode name contains a marker
#: belongs to that marker's script. `Other` is last. The audit's `character_script` rule moved here with it.
LETTER_SCRIPT_MARKERS: tuple[tuple[str, str], ...] = (
    ("LATIN", "Latin"),
    ("CJK UNIFIED IDEOGRAPH", "Han"),
    ("CJK COMPATIBILITY IDEOGRAPH", "Han"),
    ("HIRAGANA", "Hiragana"),
    ("KATAKANA", "Katakana"),
    ("HANGUL", "Hangul"),
    ("CYRILLIC", "Cyrillic"),
    ("ARABIC", "Arabic"),
    ("HEBREW", "Hebrew"),
    ("GREEK", "Greek"),
    ("DEVANAGARI", "Devanagari"),
    ("THAI", "Thai"),
    ("ARMENIAN", "Armenian"),
    ("GEORGIAN", "Georgian"),
    ("ETHIOPIC", "Ethiopic"),
    ("BENGALI", "Bengali"),
    ("GURMUKHI", "Gurmukhi"),
    ("GUJARATI", "Gujarati"),
    ("TAMIL", "Tamil"),
    ("TELUGU", "Telugu"),
    ("KANNADA", "Kannada"),
    ("MALAYALAM", "Malayalam"),
    ("SINHALA", "Sinhala"),
    ("KHMER", "Khmer"),
    ("LAO", "Lao"),
    ("MYANMAR", "Myanmar"),
)

#: The script names `LETTER_SCRIPT` indexes, deduplicated in first-match order, then `Other`.
LETTER_SCRIPTS: tuple[str, ...] = (*dict.fromkeys(script for _, script in LETTER_SCRIPT_MARKERS), "Other")


def character_script(char: str) -> str | None:
    """The writing system of a letter, or None for a character whose category is not a letter.

    A letter whose name holds no marker reads its compatibility decomposition: Spanish º and ª decompose to Latin
    letters, so they are Latin rather than `Other`. A decomposition into one script names that script, and any
    other letter is `Other`.
    """
    if not unicodedata.category(char).startswith("L"):
        return None
    name = unicodedata.name(char, "")
    for marker, script in LETTER_SCRIPT_MARKERS:
        if marker in name:
            return script
    compatibility = unicodedata.normalize("NFKD", char)
    if compatibility != char:
        scripts = {sc for item in compatibility if (sc := character_script(item)) is not None}
        if len(scripts) == 1:
            return scripts.pop()
    return "Other"


def letter_script(char: str) -> int:
    """The character's index in `LETTER_SCRIPTS`, or -1 for a character that is not a letter."""
    script = character_script(char)
    return -1 if script is None else LETTER_SCRIPTS.index(script)


def tagged_ranges(classify: Callable[[str], int]) -> list[tuple[int, int, int]]:
    """The inclusive ranges of scalar values `classify` maps to one non-negative tag, with that tag."""
    out: list[tuple[int, int, int]] = []
    for code in scalar_values():
        tag = classify(chr(code))
        if tag < 0:
            continue
        if out and out[-1][2] == tag and (out[-1][1] == code - 1 or (out[-1][1] == 0xD7FF and code == 0xE000)):
            out[-1] = (out[-1][0], code, tag)
        else:
            out.append((code, code, tag))
    return out


def mapping(convert: Callable[[str], str]) -> list[tuple[int, str]]:
    """Every scalar value whose one-character conversion differs from itself, with the converted string."""
    out: list[tuple[int, str]] = []
    for code in scalar_values():
        char = chr(code)
        converted = convert(char)
        if converted != char:
            out.append((code, converted))
    return out


def _rust_ranges(name: str, values: list[tuple[int, int]]) -> str:
    body = "\n".join(f"\t(0x{a:04X}, 0x{b:04X})," for a, b in values)
    return f"pub static {name}: &[(u32, u32)] = &[\n{body}\n];\n"


def _rust_tagged_ranges(name: str, values: list[tuple[int, int, int]]) -> str:
    body = "\n".join(f"\t(0x{a:04X}, 0x{b:04X}, {tag})," for a, b, tag in values)
    return f"pub static {name}: &[(u32, u32, u8)] = &[\n{body}\n];\n"


def _rust_code_points(value: str) -> str:
    """A string as a Rust array literal of `0x` code points, which the spelling check reads as numbers."""
    return "&[" + ", ".join(f"0x{ord(c):04X}" for c in value) + "]"


def _rust_mapping(name: str, values: list[tuple[int, str]]) -> str:
    body = "\n".join(f"\t(0x{code:04X}, {_rust_code_points(text)})," for code, text in values)
    return f"pub static {name}: &[(u32, &[u32])] = &[\n{body}\n];\n"


def render() -> str:
    """The generated Rust module for this interpreter."""
    parts = [
        "// Generated by `python -m mailwoman_train.text.python_text_tables`; regenerate rather than edit.\n",
        f"// Python {platform.python_version()}, Unicode {unicodedata.unidata_version}.\n\n",
        f'pub const UNICODE_VERSION: &str = "{unicodedata.unidata_version}";\n\n',
        _rust_ranges("SPACE", ranges(str.isspace)),
        "\n",
        _rust_ranges("ALNUM", ranges(str.isalnum)),
        "\n",
        _rust_ranges("DECIMAL", ranges(str.isdecimal)),
        "\n",
        _rust_ranges("ALPHA", ranges(str.isalpha)),
        "\n",
        _rust_ranges("DIGIT", ranges(str.isdigit)),
        "\n",
        _rust_ranges("CJK_NAMED", ranges(is_cjk_named)),
        "\n",
        _rust_ranges("CASED", ranges(is_cased)),
        "\n",
        _rust_ranges("CASE_IGNORABLE", ranges(is_case_ignorable)),
        "\n",
        _rust_ranges("SCRIPT_SKIPPED", ranges(is_script_skipped)),
        "\n",
        _rust_tagged_ranges("SCRIPT_BLOCK", tagged_ranges(script_block)),
        "\n",
        _rust_mapping("LOWER", mapping(str.lower)),
        "\n",
        _rust_mapping("UPPER", mapping(str.upper)),
        "\n",
        _rust_tagged_ranges("LETTER_SCRIPT", tagged_ranges(letter_script)),
        "\n",
        _rust_mapping("CASEFOLD", mapping(str.casefold)),
    ]
    return "".join(parts)


def _without_python_version(text: str) -> str:
    """The module without its Python patch-version line, which a patch release changes without moving a table."""
    return "".join(line for line in text.splitlines(keepends=True) if not line.startswith("// Python "))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="exit 1 when the committed tables differ")
    args = parser.parse_args(argv)
    path = repo_root_path(*TABLES_PATH)
    text = render()
    if args.check:
        committed = path.read_text(encoding="utf-8")
        if _without_python_version(committed) != _without_python_version(text):
            print(f"{path} differs from the tables this interpreter produces; regenerate it", file=sys.stderr)
            return 1
        print(f"{path} matches Unicode {unicodedata.unidata_version}")
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
