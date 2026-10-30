// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The script and case-folding operations the training audits read, against the answers CPython 3.12.3 gave.
//!
//! Each row was recorded from `audits.mixed_script.script_runs`, `exposure.phenomena.detect_script`,
//! `address_systems.is_latin_text` and `str.casefold` before the mixed-script audit moved to TypeScript. The tables
//! themselves are compared over every scalar value by `python_text_tables --check`.

use mtf_channels::python_text::{casefold, detect_script, is_latin_text, letter_script, script_runs};

/// `(text, script_runs, detect_script, is_latin_text, casefold)`.
const CASES: &[(&str, &[&str], &str, bool, &str)] = &[
	(
		"Four Seasons Inn四季酒家",
		&["Latin", "Han"],
		"mixed",
		false,
		"four seasons inn四季酒家",
	),
	("Calle 5º, Madrid", &["Latin"], "latin", false, "calle 5º, madrid"),
	("東京都千代田区", &["Han"], "cjk", false, "東京都千代田区"),
	("Straße", &["Latin"], "latin", true, "strasse"),
	("ΣΑΣ ς", &["Greek"], "greek", false, "σασ σ"),
	("12 - 34", &[], "other", false, "12 - 34"),
	(
		"Москва ул. Tverskaya",
		&["Cyrillic", "Latin"],
		"mixed",
		false,
		"москва ул. tverskaya",
	),
	("ǅungla ﬁne µ", &["Latin", "Greek"], "latin", false, "ǆungla fine μ"),
	("Ꭰ", &["Other"], "other", false, "Ꭰ"),
];

#[test]
fn every_operation_gives_the_recorded_python_answer() {
	for &(text, runs, script, latin, folded) in CASES {
		assert_eq!(script_runs(text), runs, "script_runs({text:?})");
		assert_eq!(detect_script(text), script, "detect_script({text:?})");
		assert_eq!(is_latin_text(text), latin, "is_latin_text({text:?})");
		assert_eq!(casefold(text), folded, "casefold({text:?})");
	}
}

/// The deleted `test_audit_mixed_script.py`: an apostrophe, a hyphen, an accented capital and the ordinal indicator
/// each stay inside one Latin run.
#[test]
fn punctuation_and_latin_marks_keep_one_latin_run() {
	for text in ["L'oscar", "Champs-Élysées", "Formación 1º de Mayo"] {
		assert_eq!(script_runs(text), ["Latin"], "script_runs({text:?})");
	}
}

#[test]
fn a_character_that_is_not_a_letter_has_no_letter_script() {
	assert_eq!(letter_script('5'), None);
	assert_eq!(letter_script(','), None);
	assert_eq!(letter_script('º'), Some("Latin"));
}
