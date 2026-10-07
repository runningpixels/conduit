//! A small text template engine for workflow step prompts and outputs.
//!
//! Workflows string steps together by letting a later step's prompt or
//! output template reference an earlier step's result (`{{steps.fetch.text}}`)
//! or loop over a list an earlier step produced (`{{#each steps.search.hits}}`).
//! The templates are authored by users (or generated once by a model) and then
//! run unattended, so this engine has two jobs beyond substitution: fail loud
//! with a path a human can act on when a reference doesn't resolve
//! ([`TemplateError::Missing`] / [`TemplateError::NotAList`]), and let the
//! workflow runner ask "what does this template need?" *before* running
//! anything, via [`references`], so a bad reference can be caught at save
//! time instead of mid-run.
//!
//! There is no HTML escaping here — templates render into plain text /
//! markdown that goes back into a prompt or a file, never into a browser DOM.

use serde_json::Value;

/// Errors rendering or analyzing a template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateError {
    /// A `{{path}}` (or `{{#each path}}`) that resolves to nothing.
    Missing(String),
    /// `{{#each path}}` whose value is not an array.
    NotAList(String),
    /// Unbalanced or malformed tags, with a short description.
    Syntax(String),
    /// A `{{path}}` that goes through a step that was skipped after an error.
    Skipped {
        step: String,
        reason: String,
        path: String,
    },
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TemplateError::Missing(path) => write!(f, "Nothing called {path} yet"),
            TemplateError::NotAList(path) => write!(f, "{path} is not a list"),
            TemplateError::Syntax(msg) => write!(f, "Template syntax error: {msg}"),
            TemplateError::Skipped { step, reason, path } => write!(
                f,
                "Step \"{step}\" was skipped ({reason}), so {{{{{path}}}}} has nothing to show."
            ),
        }
    }
}

impl std::error::Error for TemplateError {}

/// One parsed `{{ ... }}` tag.
enum Tag<'a> {
    /// `{{ path }}`
    Var(&'a str),
    /// `{{#each path}}`
    EachOpen(&'a str),
    /// `{{/each}}`
    EachClose,
    /// An escaped brace pair (`\{{` or `\}}`), rendered as the braces alone.
    Literal(&'static str),
}

/// Appended to errors that a literal `{{` in the text may have caused.
const ESCAPE_HINT: &str = "To write {{ as text, put a backslash before it: \\{{";

/// The 1-based character position of byte offset `byte` in `template`.
fn char_position(template: &str, byte: usize) -> usize {
    template[..byte].chars().count() + 1
}

/// Find the next `{{ ... }}` tag starting at or after `from`. Returns the
/// tag's parsed contents plus the byte range of the whole `{{...}}` span.
/// A stray unmatched `{` or `}` (not part of a `{{`/`}}` pair) is not a tag
/// and is treated as plain text. `\{{` and `\}}` escape literal braces.
fn next_tag(
    template: &str,
    from: usize,
) -> Result<Option<(Tag<'_>, std::ops::Range<usize>)>, TemplateError> {
    let bytes = template.as_bytes();
    let mut i = from;
    while i + 1 < template.len() {
        if bytes[i] == b'\\' && i + 2 < template.len() {
            if bytes[i + 1] == b'{' && bytes[i + 2] == b'{' {
                return Ok(Some((Tag::Literal("{{"), i..i + 3)));
            }
            if bytes[i + 1] == b'}' && bytes[i + 2] == b'}' {
                return Ok(Some((Tag::Literal("}}"), i..i + 3)));
            }
        }
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            let close = template[i + 2..]
                .find("}}")
                .map(|p| p + i + 2)
                .ok_or_else(|| {
                    TemplateError::Syntax(format!(
                        "unclosed {{{{ at character {}. {ESCAPE_HINT}",
                        char_position(template, i)
                    ))
                })?;
            let inner = template[i + 2..close].trim();
            let end = close + 2;
            if inner.is_empty() {
                return Err(TemplateError::Syntax(format!(
                    "empty {{{{}}}} tag at character {}. {ESCAPE_HINT}",
                    char_position(template, i)
                )));
            }
            let tag = if let Some(path) = inner.strip_prefix("#each") {
                let path = path.trim();
                if path.is_empty() {
                    return Err(TemplateError::Syntax("{{#each}} needs a path".to_string()));
                }
                if !is_valid_path(path) {
                    return Err(TemplateError::Syntax(format!(
                        "invalid path in {{{{#each {path}}}}} at character {}",
                        char_position(template, i)
                    )));
                }
                Tag::EachOpen(path)
            } else if inner == "/each" {
                Tag::EachClose
            } else if inner.starts_with('#') || inner.starts_with('/') {
                return Err(TemplateError::Syntax(format!(
                    "unknown tag {{{{{inner}}}}} at character {}. The supported tags are {{{{path}}}}, {{{{#each path}}}} and {{{{/each}}}}. {ESCAPE_HINT}",
                    char_position(template, i)
                )));
            } else {
                if !is_valid_path(inner) {
                    return Err(TemplateError::Syntax(format!(
                        "invalid path {{{{{inner}}}}} at character {}. {ESCAPE_HINT}",
                        char_position(template, i)
                    )));
                }
                Tag::Var(inner)
            };
            return Ok(Some((tag, i..end)));
        }
        i += 1;
    }
    Ok(None)
}

fn is_valid_path(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    path.split('.').all(|seg| {
        !seg.is_empty()
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    })
}

/// Resolve a dot path against a JSON value. A purely numeric segment indexes
/// an array; otherwise it looks up an object key.
fn resolve<'a>(ctx: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = ctx;
    for seg in path.split('.') {
        cur = if let Ok(idx) = seg.parse::<usize>() {
            cur.as_array()?.get(idx)?
        } else {
            cur.as_object()?.get(seg)?
        };
    }
    Some(cur)
}

/// The error for a path that resolves to nothing: when the path runs through
/// an object marked `"skipped": true` (a step that failed and was skipped),
/// that is the reason; otherwise the plain "nothing called".
fn missing(ctx: &Value, path: &str) -> TemplateError {
    let mut cur = ctx;
    for seg in path.split('.') {
        cur = match cur {
            Value::Object(map) => match map.get(seg) {
                Some(v) => v,
                None => break,
            },
            Value::Array(items) => match seg.parse::<usize>().ok().and_then(|i| items.get(i)) {
                Some(v) => v,
                None => break,
            },
            _ => break,
        };
        if cur.get("skipped") == Some(&Value::Bool(true)) {
            let reason = cur
                .get("error")
                .and_then(Value::as_str)
                .filter(|r| !r.is_empty())
                .unwrap_or("it failed");
            return TemplateError::Skipped {
                step: seg.to_string(),
                reason: reason.to_string(),
                path: path.to_string(),
            };
        }
    }
    TemplateError::Missing(path.to_string())
}

fn value_to_text(ctx: &Value, path: &str) -> Result<String, TemplateError> {
    match resolve(ctx, path) {
        None => Err(missing(ctx, path)),
        Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.clone()),
        Some(v @ (Value::Number(_) | Value::Bool(_))) => Ok(v.to_string()),
        Some(v @ (Value::Object(_) | Value::Array(_))) => {
            Ok(serde_json::to_string(v).expect("json values always serialize"))
        }
    }
}

/// Render a template with an `{{#each}}` region parsed once and its body
/// re-rendered per element.
fn render_inner(template: &str, ctx: &Value) -> Result<String, TemplateError> {
    let mut out = String::new();
    let mut pos = 0;
    while let Some((tag, span)) = next_tag(template, pos)? {
        out.push_str(&template[pos..span.start]);
        match tag {
            Tag::Var(path) => {
                out.push_str(&value_to_text(ctx, path)?);
                pos = span.end;
            }
            Tag::EachOpen(path) => {
                let (body, after) = find_each_body(template, span.end)?;
                let list = resolve(ctx, path);
                let list = match list {
                    None => return Err(missing(ctx, path)),
                    Some(Value::Null) => return Err(TemplateError::Missing(path.to_string())),
                    Some(Value::Array(arr)) => arr,
                    Some(_) => return Err(TemplateError::NotAList(path.to_string())),
                };
                let base = ctx.as_object().cloned().ok_or_else(|| {
                    TemplateError::Syntax("context must be an object".to_string())
                })?;
                for (index, item) in list.iter().enumerate() {
                    let mut loop_ctx = base.clone();
                    loop_ctx.insert("item".to_string(), item.clone());
                    loop_ctx.insert("index".to_string(), Value::from(index));
                    out.push_str(&render_inner(body, &Value::Object(loop_ctx))?);
                }
                pos = after;
            }
            Tag::EachClose => {
                return Err(TemplateError::Syntax(
                    "{{/each}} without a matching {{#each}}".to_string(),
                ));
            }
            Tag::Literal(text) => {
                out.push_str(text);
                pos = span.end;
            }
        }
    }
    out.push_str(&template[pos..]);
    Ok(out)
}

/// Given the position right after `{{#each path}}`, find the matching
/// `{{/each}}`, accounting for nested `each` blocks. Returns the body text
/// and the position right after the closing tag.
fn find_each_body(template: &str, from: usize) -> Result<(&str, usize), TemplateError> {
    let mut depth = 1usize;
    let mut pos = from;
    loop {
        let Some((tag, span)) = next_tag(template, pos)? else {
            return Err(TemplateError::Syntax(
                "{{#each}} without a matching {{/each}}".to_string(),
            ));
        };
        match tag {
            Tag::EachOpen(_) => depth += 1,
            Tag::EachClose => {
                depth -= 1;
                if depth == 0 {
                    return Ok((&template[from..span.start], span.end));
                }
            }
            Tag::Var(_) | Tag::Literal(_) => {}
        }
        pos = span.end;
    }
}

/// Render against a JSON context.
pub fn render(template: &str, ctx: &Value) -> Result<String, TemplateError> {
    render_inner(template, ctx)
}

/// The distinct top-level paths a template reads from the context, in
/// first-use order — for validating references before a run. Paths inside an
/// `{{#each}}` body that start with `item` or `index` are that loop's, not
/// the context's, and are excluded; the `{{#each path}}` path itself is
/// included.
pub fn references(template: &str) -> Result<Vec<String>, TemplateError> {
    let mut out = Vec::new();
    collect_references(template, 0, false, &mut out)?;
    Ok(out)
}

/// Walk the template collecting paths. `in_loop` suppresses `item`/`index`
/// paths (they refer to the nearest enclosing loop, not the outer context).
fn collect_references(
    template: &str,
    from: usize,
    in_loop: bool,
    out: &mut Vec<String>,
) -> Result<usize, TemplateError> {
    let mut pos = from;
    loop {
        let Some((tag, span)) = next_tag(template, pos)? else {
            return Ok(template.len());
        };
        match tag {
            Tag::Var(path) => {
                if !(in_loop && is_loop_local(path)) && !out.iter().any(|p| p == path) {
                    out.push(path.to_string());
                }
                pos = span.end;
            }
            Tag::EachOpen(path) => {
                if !(in_loop && is_loop_local(path)) && !out.iter().any(|p| p == path) {
                    out.push(path.to_string());
                }
                pos = collect_references(template, span.end, true, out)?;
            }
            Tag::Literal(_) => pos = span.end,
            Tag::EachClose => {
                if in_loop {
                    return Ok(span.end);
                }
                return Err(TemplateError::Syntax(
                    "{{/each}} without a matching {{#each}}".to_string(),
                ));
            }
        }
    }
}

fn is_loop_local(path: &str) -> bool {
    let head = path.split('.').next().unwrap_or("");
    head == "item" || head == "index"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_plain_path() {
        let ctx = json!({ "steps": { "fetch": { "text": "hello" } } });
        assert_eq!(
            render("say {{ steps.fetch.text }}!", &ctx).unwrap(),
            "say hello!"
        );
    }

    #[test]
    fn renders_array_index() {
        let ctx =
            json!({ "steps": { "fetch": { "pages": [{ "title": "A" }, { "title": "B" }] } } });
        assert_eq!(render("{{steps.fetch.pages.1.title}}", &ctx).unwrap(), "B");
    }

    #[test]
    fn renders_number_bool_and_object_as_json() {
        let ctx = json!({ "n": 42, "b": true, "o": { "x": 1 } });
        assert_eq!(render("{{n}}", &ctx).unwrap(), "42");
        assert_eq!(render("{{b}}", &ctx).unwrap(), "true");
        assert_eq!(render("{{o}}", &ctx).unwrap(), "{\"x\":1}");
    }

    #[test]
    fn missing_path_is_an_error() {
        let ctx = json!({});
        let err = render("{{steps.fetch.text}}", &ctx).unwrap_err();
        assert_eq!(err, TemplateError::Missing("steps.fetch.text".to_string()));
        assert_eq!(err.to_string(), "Nothing called steps.fetch.text yet");
    }

    #[test]
    fn null_value_renders_empty_but_absent_key_is_missing() {
        let ctx = json!({ "x": null, "o": { "t": null } });
        assert_eq!(render("[{{x}}][{{o.t}}]", &ctx).unwrap(), "[][]");
        assert_eq!(
            render("{{o.nope}}", &ctx).unwrap_err(),
            TemplateError::Missing("o.nope".to_string())
        );
    }

    #[test]
    fn a_path_through_a_skipped_step_says_why() {
        let ctx = json!({
            "steps": { "fetch": { "skipped": true, "error": "no network", "text": "" } },
            "item": { "summary": { "skipped": true, "error": "model said no", "text": "" } },
        });
        assert_eq!(
            render("{{steps.fetch.pages}}", &ctx).unwrap_err().to_string(),
            "Step \"fetch\" was skipped (no network), so {{steps.fetch.pages}} has nothing to show."
        );
        assert_eq!(
            render("{{item.summary.data.x}}", &ctx)
                .unwrap_err()
                .to_string(),
            "Step \"summary\" was skipped (model said no), so {{item.summary.data.x}} has nothing to show."
        );
        assert_eq!(
            render("{{#each steps.fetch.pages}}x{{/each}}", &ctx)
                .unwrap_err()
                .to_string(),
            "Step \"fetch\" was skipped (no network), so {{steps.fetch.pages}} has nothing to show."
        );
        // The text of a skipped step is empty, not missing.
        assert_eq!(render("[{{item.summary.text}}]", &ctx).unwrap(), "[]");
    }

    #[test]
    fn a_backslash_writes_literal_braces() {
        let ctx = json!({ "n": 1 });
        assert_eq!(
            render(r"say \{{name}} and {{n}} \}}", &ctx).unwrap(),
            "say {{name}} and 1 }}"
        );
        assert_eq!(references(r"\{{a}} {{b}}").unwrap(), vec!["b".to_string()]);
        assert_eq!(
            render(r"{{#each l}}\{{{{item}}{{/each}}", &json!({ "l": [1] })).unwrap(),
            "{{1"
        );
    }

    #[test]
    fn syntax_errors_use_character_positions_and_mention_the_escape() {
        let err = render("h\u{e9}llo w\u{f6}rld {{name", &json!({}))
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            "Template syntax error: unclosed {{ at character 13. To write {{ as text, put a backslash before it: \\{{"
        );
        let err = render("{{#if x}}y{{/if}}", &json!({}))
            .unwrap_err()
            .to_string();
        assert!(err.contains("unknown tag {{#if x}}"), "{err}");
        assert!(
            err.contains("{{path}}, {{#each path}} and {{/each}}"),
            "{err}"
        );
        let err = render(r#"{"a": {{ "b": 1 }}}"#, &json!({}))
            .unwrap_err()
            .to_string();
        assert!(err.contains("\\{{"), "{err}");
    }

    #[test]
    fn each_exposes_item_and_index() {
        let ctx = json!({ "items": ["a", "b", "c"] });
        let out = render("{{#each items}}{{index}}:{{item}} {{/each}}", &ctx).unwrap();
        assert_eq!(out, "0:a 1:b 2:c ");
    }

    #[test]
    fn nested_each_shadows_outer_item() {
        let ctx = json!({
            "outer": [
                { "inner": ["x", "y"] },
                { "inner": ["z"] }
            ]
        });
        let out = render(
            "{{#each outer}}[{{#each item.inner}}{{item}}{{/each}}]{{/each}}",
            &ctx,
        )
        .unwrap();
        assert_eq!(out, "[xy][z]");
    }

    #[test]
    fn empty_list_renders_empty() {
        let ctx = json!({ "items": [] });
        assert_eq!(
            render("before{{#each items}}{{item}}{{/each}}after", &ctx).unwrap(),
            "beforeafter"
        );
    }

    #[test]
    fn each_over_non_list_is_an_error() {
        let ctx = json!({ "items": "not a list" });
        assert_eq!(
            render("{{#each items}}{{item}}{{/each}}", &ctx).unwrap_err(),
            TemplateError::NotAList("items".to_string())
        );
    }

    #[test]
    fn unclosed_tag_is_syntax_error() {
        let ctx = json!({});
        match render("hello {{name", &ctx).unwrap_err() {
            TemplateError::Syntax(_) => {}
            other => panic!("expected Syntax, got {other:?}"),
        }
    }

    #[test]
    fn stray_each_close_is_syntax_error() {
        let ctx = json!({});
        match render("{{/each}}", &ctx).unwrap_err() {
            TemplateError::Syntax(_) => {}
            other => panic!("expected Syntax, got {other:?}"),
        }
    }

    #[test]
    fn stray_braces_are_plain_text() {
        let ctx = json!({});
        assert_eq!(render("a { b } c", &ctx).unwrap(), "a { b } c");
    }

    #[test]
    fn references_includes_each_path_and_dedups_in_first_use_order() {
        let tpl = "{{a.b}} {{#each list}}{{item.x}} {{index}} {{outer}}{{/each}} {{a.b}}";
        let refs = references(tpl).unwrap();
        assert_eq!(
            refs,
            vec!["a.b".to_string(), "list".to_string(), "outer".to_string()]
        );
    }

    #[test]
    fn references_excludes_loop_locals() {
        let refs =
            references("{{#each steps.search.hits}}{{item.title}} {{index}}{{/each}}").unwrap();
        assert_eq!(refs, vec!["steps.search.hits".to_string()]);
    }
}
