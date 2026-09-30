//! Validation for app launch-input declarations and values (ADR-013).
//!
//! Two independent checks. [`validate_declaration`] checks a whole
//! [`AppInput`] list is well-formed — called when an app is saved or updated
//! from its source, before the declaration is trusted enough to store in a
//! manifest. [`validate_value`] checks one JSON value fits one already-
//! declared input — called by `set_app_inputs` and by [`effective_value`] /
//! [`is_missing`], which resolve what a page actually sees from whatever is
//! stored.
//!
//! Every error here is a plain, undecorated sentence; the command layer is
//! what prefixes it with `invalid: ` per the bridge error-code convention.

use crate::schema::{AppInput, AppInputKind};
use serde_json::Value;

/// A declaration may have at most this many inputs.
pub const MAX_INPUTS: usize = 20;
/// An id is 1 to this many characters.
pub const MAX_ID_CHARS: usize = 40;
/// A label is 1 to this many characters once trimmed.
pub const MAX_LABEL_CHARS: usize = 60;
/// A `string` value is at most this many characters.
pub const MAX_STRING_CHARS: usize = 500;
/// An `enum` input declares at most this many options.
pub const MAX_OPTIONS: usize = 50;
/// Each `enum` option is 1 to this many characters once trimmed.
pub const MAX_OPTION_CHARS: usize = 60;

fn valid_id(id: &str) -> bool {
    let len = id.chars().count();
    (1..=MAX_ID_CHARS).contains(&len)
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Not required to already be trimmed (this is a display label, not a key);
/// only that it isn't blank and fits once whitespace is discounted.
fn valid_label(label: &str) -> bool {
    let trimmed = label.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= MAX_LABEL_CHARS
}

/// Check a full input declaration: at most [`MAX_INPUTS`] entries, each a
/// valid id/label, unique ids, `options` present if and only if the kind is
/// `enum` (and then 1-50 options, each 1-60 characters trimmed), and — when
/// present — a `default` that is itself a valid value of the input.
pub fn validate_declaration(inputs: &[AppInput]) -> Result<(), String> {
    if inputs.len() > MAX_INPUTS {
        return Err(format!("An app can declare at most {MAX_INPUTS} inputs."));
    }
    let mut seen_ids: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for input in inputs {
        if !valid_id(&input.id) {
            return Err(format!(
                "{:?} isn't a valid input id (1-{MAX_ID_CHARS} letters, digits, - or _).",
                input.id
            ));
        }
        if !seen_ids.insert(input.id.as_str()) {
            return Err(format!(
                "Input id {:?} is declared more than once.",
                input.id
            ));
        }
        if !valid_label(&input.label) {
            return Err(format!(
                "{:?}'s label must be 1-{MAX_LABEL_CHARS} characters.",
                input.id
            ));
        }
        match (input.kind, &input.options) {
            (AppInputKind::Enum, Some(options)) => {
                if options.is_empty() || options.len() > MAX_OPTIONS {
                    return Err(format!(
                        "{:?} must declare 1-{MAX_OPTIONS} options.",
                        input.id
                    ));
                }
                for option in options {
                    let trimmed = option.trim();
                    if trimmed.is_empty() || trimmed.chars().count() > MAX_OPTION_CHARS {
                        return Err(format!(
                            "{:?}'s options must each be 1-{MAX_OPTION_CHARS} characters.",
                            input.id
                        ));
                    }
                }
            }
            (AppInputKind::Enum, None) => {
                return Err(format!(
                    "{:?} is an enum but declares no options.",
                    input.id
                ));
            }
            (_, Some(_)) => {
                return Err(format!(
                    "{:?} declares options but isn't an enum.",
                    input.id
                ));
            }
            (_, None) => {}
        }
        if let Some(default) = &input.default {
            validate_value(input, default)
                .map_err(|e| format!("{:?}'s default is invalid: {e}", input.id))?;
        }
    }
    Ok(())
}

/// Check `value` fits `input`'s declared kind: `string` at most 500
/// characters, `number` finite, `boolean` a JSON bool, `enum` one of the
/// declared options, `date` a real `YYYY-MM-DD` calendar date.
pub fn validate_value(input: &AppInput, value: &Value) -> Result<(), String> {
    match input.kind {
        AppInputKind::String => match value {
            Value::String(s) if s.chars().count() <= MAX_STRING_CHARS => Ok(()),
            Value::String(_) => Err(format!("must be at most {MAX_STRING_CHARS} characters")),
            _ => Err("must be a string".to_string()),
        },
        AppInputKind::Number => match value.as_f64() {
            Some(n) if n.is_finite() => Ok(()),
            Some(_) => Err("must be a finite number".to_string()),
            None => Err("must be a number".to_string()),
        },
        AppInputKind::Boolean => match value {
            Value::Bool(_) => Ok(()),
            _ => Err("must be true or false".to_string()),
        },
        AppInputKind::Enum => match value {
            Value::String(s) => {
                let options = input.options.as_deref().unwrap_or(&[]);
                if options.iter().any(|o| o == s) {
                    Ok(())
                } else {
                    Err("must be one of the declared options".to_string())
                }
            }
            _ => Err("must be a string".to_string()),
        },
        AppInputKind::Date => match value {
            Value::String(s) if is_real_calendar_date(s) => Ok(()),
            Value::String(_) => Err("must be a real YYYY-MM-DD date".to_string()),
            _ => Err("must be a string".to_string()),
        },
    }
}

/// Whether `s` is exactly `YYYY-MM-DD` and names a real calendar date (leap
/// years included). No date library: this is the one shape ever checked, and
/// a hand-rolled check keeps `provider-core` from taking on a dependency for
/// it.
fn is_real_calendar_date(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let digits =
        |part: &str| part.bytes().all(|b| b.is_ascii_digit()) && part.parse::<u32>().is_ok();
    if !digits(&s[0..4]) || !digits(&s[5..7]) || !digits(&s[8..10]) {
        return false;
    }
    let year: u32 = s[0..4].parse().unwrap();
    let month: u32 = s[5..7].parse().unwrap();
    let day: u32 = s[8..10].parse().unwrap();
    if !(1..=12).contains(&month) {
        return false;
    }
    let leap = (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => unreachable!(),
    };
    (1..=days_in_month).contains(&day)
}

/// The effective value for `input`, given its stored value (if any): the
/// stored value when it's still present and still fits the input, else the
/// input's own default, else `None` — the page sees nothing for this input
/// (ADR-013: "a stored value is used only while its input is still declared
/// and the value still fits it; otherwise the default applies").
pub fn effective_value(input: &AppInput, stored: Option<&Value>) -> Option<Value> {
    if let Some(value) = stored {
        if validate_value(input, value).is_ok() {
            return Some(value.clone());
        }
    }
    input.default.clone()
}

/// Whether `input` is required but has neither a valid stored value nor a
/// default. `AppSummary.inputs_missing` is true when any declared input is.
pub fn is_missing(input: &AppInput, stored: Option<&Value>) -> bool {
    input.required && effective_value(input, stored).is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn string_input(id: &str) -> AppInput {
        AppInput {
            id: id.to_string(),
            label: "City".to_string(),
            kind: AppInputKind::String,
            required: false,
            default: None,
            options: None,
        }
    }

    fn enum_input(options: &[&str]) -> AppInput {
        AppInput {
            id: "units".to_string(),
            label: "Units".to_string(),
            kind: AppInputKind::Enum,
            required: false,
            default: None,
            options: Some(options.iter().map(|s| s.to_string()).collect()),
        }
    }

    #[test]
    fn ids_are_1_to_40_word_chars() {
        assert!(valid_id("city"));
        assert!(valid_id("a"));
        assert!(valid_id(&"a".repeat(40)));
        assert!(!valid_id(""));
        assert!(!valid_id(&"a".repeat(41)));
        assert!(!valid_id("has space"));
        assert!(!valid_id("has.dot"));
        assert!(valid_id("has-dash_and_underscore"));
    }

    #[test]
    fn labels_are_1_to_60_chars_trimmed_non_empty() {
        assert!(valid_label("City"));
        assert!(valid_label(&"x".repeat(60)));
        assert!(!valid_label(""));
        assert!(!valid_label("   "));
        assert!(!valid_label(&"x".repeat(61)));
    }

    #[test]
    fn at_most_twenty_inputs() {
        let inputs: Vec<AppInput> = (0..20).map(|i| string_input(&format!("i{i}"))).collect();
        assert!(validate_declaration(&inputs).is_ok());
        let too_many: Vec<AppInput> = (0..21).map(|i| string_input(&format!("i{i}"))).collect();
        assert!(validate_declaration(&too_many).is_err());
    }

    #[test]
    fn ids_must_be_unique() {
        let inputs = vec![string_input("city"), string_input("city")];
        let err = validate_declaration(&inputs).unwrap_err();
        assert!(err.contains("more than once"));
    }

    #[test]
    fn options_present_iff_enum() {
        let mut not_enum = string_input("x");
        not_enum.options = Some(vec!["a".to_string()]);
        assert!(validate_declaration(std::slice::from_ref(&not_enum)).is_err());

        let missing_options = AppInput {
            options: None,
            ..enum_input(&["metric"])
        };
        assert!(validate_declaration(&[missing_options]).is_err());

        let empty_options = enum_input(&[]);
        assert!(validate_declaration(&[empty_options]).is_err());

        let too_many: Vec<String> = (0..51).map(|i| format!("o{i}")).collect();
        let refs: Vec<&str> = too_many.iter().map(String::as_str).collect();
        assert!(validate_declaration(&[enum_input(&refs)]).is_err());

        assert!(validate_declaration(&[enum_input(&["metric", "imperial"])]).is_ok());
    }

    #[test]
    fn defaults_must_be_valid_values() {
        let mut input = enum_input(&["metric", "imperial"]);
        input.default = Some(json!("bogus"));
        assert!(validate_declaration(&[input.clone()]).is_err());
        input.default = Some(json!("metric"));
        assert!(validate_declaration(&[input]).is_ok());
    }

    #[test]
    fn string_values_are_capped_at_500_chars() {
        let input = string_input("note");
        assert!(validate_value(&input, &json!("hello")).is_ok());
        assert!(validate_value(&input, &json!("x".repeat(500))).is_ok());
        assert!(validate_value(&input, &json!("x".repeat(501))).is_err());
        assert!(validate_value(&input, &json!(5)).is_err());
    }

    #[test]
    fn number_values_must_be_finite() {
        let input = AppInput {
            kind: AppInputKind::Number,
            ..string_input("count")
        };
        assert!(validate_value(&input, &json!(5)).is_ok());
        assert!(validate_value(&input, &json!(5.5)).is_ok());
        assert!(validate_value(&input, &json!(f64::NAN)).is_err());
        assert!(validate_value(&input, &json!("5")).is_err());
    }

    #[test]
    fn boolean_values_must_be_bool() {
        let input = AppInput {
            kind: AppInputKind::Boolean,
            ..string_input("flag")
        };
        assert!(validate_value(&input, &json!(true)).is_ok());
        assert!(validate_value(&input, &json!("true")).is_err());
    }

    #[test]
    fn enum_values_must_be_a_declared_option() {
        let input = enum_input(&["metric", "imperial"]);
        assert!(validate_value(&input, &json!("metric")).is_ok());
        assert!(validate_value(&input, &json!("kelvin")).is_err());
    }

    #[test]
    fn date_values_must_be_real_calendar_dates() {
        let input = AppInput {
            kind: AppInputKind::Date,
            ..string_input("dob")
        };
        assert!(validate_value(&input, &json!("2026-02-28")).is_ok());
        assert!(
            validate_value(&input, &json!("2024-02-29")).is_ok(),
            "2024 is a leap year"
        );
        assert!(
            validate_value(&input, &json!("2023-02-29")).is_err(),
            "2023 is not a leap year"
        );
        assert!(
            validate_value(&input, &json!("2000-02-29")).is_ok(),
            "2000 is a leap year (div 400)"
        );
        assert!(
            validate_value(&input, &json!("1900-02-29")).is_err(),
            "1900 is not (div 100, not 400)"
        );
        assert!(
            validate_value(&input, &json!("2026-13-01")).is_err(),
            "month 13"
        );
        assert!(
            validate_value(&input, &json!("2026-04-31")).is_err(),
            "April has 30 days"
        );
        assert!(
            validate_value(&input, &json!("2026-1-1")).is_err(),
            "must be zero-padded"
        );
        assert!(validate_value(&input, &json!("not-a-date")).is_err());
    }

    #[test]
    fn effective_value_prefers_stored_then_default_then_none() {
        let mut input = string_input("city");
        input.default = Some(json!("Paris"));
        assert_eq!(
            effective_value(&input, Some(&json!("Lisbon"))),
            Some(json!("Lisbon"))
        );
        assert_eq!(effective_value(&input, None), Some(json!("Paris")));
        // An invalid stored value (too long) falls back to the default.
        assert_eq!(
            effective_value(&input, Some(&json!("x".repeat(501)))),
            Some(json!("Paris"))
        );

        let no_default = string_input("note");
        assert_eq!(effective_value(&no_default, None), None);
    }

    #[test]
    fn is_missing_only_when_required_and_nothing_resolves() {
        let mut required = string_input("city");
        required.required = true;
        assert!(is_missing(&required, None), "no default, no value");
        required.default = Some(json!("Paris"));
        assert!(!is_missing(&required, None), "has a default");

        let mut optional = string_input("note");
        optional.required = false;
        assert!(!is_missing(&optional, None), "optional is never missing");
    }
}
