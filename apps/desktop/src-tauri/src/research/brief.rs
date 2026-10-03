//! The brief: what a run sets out to answer. The planner call drafts it from
//! the question alone (it never sees page text); the user edits and approves
//! it, and [`checked`] cleans what comes back.

use provider_core::schema::{ResearchBrief, ResearchDepth};
use serde_json::{json, Value};

use super::{ask_json, clip, one_line, urls, ResearchIo};

/// Most sub-questions a brief may have.
pub const MAX_SUB_QUESTIONS: usize = 6;
/// Longest question, sub-question and scope kept.
pub const MAX_QUESTION_CHARS: usize = 2_000;
pub const MAX_SUB_QUESTION_CHARS: usize = 300;
const MAX_SCOPE_CHARS: usize = 200;
const MAX_DOMAINS: usize = 20;

const PLANNER_SYSTEM: &str = "You plan web research. You only write a plan; you do not search or \
answer. Reply with JSON only.";

fn planner_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "subQuestions": {
                "type": "array", "minItems": 1, "maxItems": MAX_SUB_QUESTIONS,
                "items": { "type": "string" }
            },
            "scope": { "type": ["string", "null"] },
            "preferDomains": { "type": "array", "items": { "type": "string" } },
            "avoidDomains": { "type": "array", "items": { "type": "string" } },
            "depth": { "enum": ["quick", "standard", "deep"] }
        },
        "required": ["subQuestions", "depth"]
    })
}

fn planner_prompt(question: &str) -> String {
    format!(
        "Plan research for this question:\n<question>\n{question}\n</question>\n\n\
Write 2 to {MAX_SUB_QUESTIONS} short sub-questions that together answer it. Each one must be \
answerable from web pages and work as a web search on its own.\n\
scope: limits the question states or clearly implies (a place, a time span), else null.\n\
preferDomains / avoidDomains: web sites the question asks to use or avoid (like \"who.int\"), \
else empty lists.\n\
depth: \"quick\" for a simple fact, \"standard\" for most questions, \"deep\" for a broad survey."
    )
}

/// Draft a brief for `question`. A reply that can't be read still gives a
/// brief (the question as its one sub-question) for the user to edit; `Err`
/// only when the model call itself failed.
pub async fn plan(io: &dyn ResearchIo, question: &str) -> Result<ResearchBrief, String> {
    let data = ask_json(
        io,
        PLANNER_SYSTEM,
        &planner_prompt(question),
        &planner_schema(),
    )
    .await?;
    let data = data.unwrap_or(Value::Null);
    let strings = |key: &str| -> Vec<String> {
        data[key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let draft = ResearchBrief {
        question: question.to_string(),
        sub_questions: strings("subQuestions"),
        scope: data["scope"].as_str().map(str::to_string),
        prefer_domains: strings("preferDomains"),
        avoid_domains: strings("avoidDomains"),
        depth: data["depth"]
            .as_str()
            .and_then(ResearchDepth::parse)
            .unwrap_or_default(),
    };
    Ok(tidy(draft))
}

/// A planner draft made usable: trimmed, deduplicated, clipped; the question
/// itself when no sub-question survives.
fn tidy(brief: ResearchBrief) -> ResearchBrief {
    let question = clip(one_line(&brief.question).as_str(), MAX_QUESTION_CHARS);
    let mut subs = sub_questions(&brief.sub_questions);
    if subs.is_empty() {
        subs.push(clip(&question, MAX_SUB_QUESTION_CHARS));
    }
    ResearchBrief {
        question,
        sub_questions: subs,
        scope: scope(brief.scope.as_deref()),
        prefer_domains: domains(&brief.prefer_domains),
        avoid_domains: domains(&brief.avoid_domains),
        depth: brief.depth,
    }
}

fn sub_questions(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in raw {
        let s = clip(&one_line(s), MAX_SUB_QUESTION_CHARS);
        if s.is_empty() || out.iter().any(|o| o.eq_ignore_ascii_case(&s)) {
            continue;
        }
        out.push(s);
        if out.len() == MAX_SUB_QUESTIONS {
            break;
        }
    }
    out
}

fn scope(raw: Option<&str>) -> Option<String> {
    raw.map(one_line)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("null"))
        .map(|s| clip(&s, MAX_SCOPE_CHARS))
}

fn domains(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for d in raw.iter().filter_map(|d| urls::clean_domain(d)) {
        if !out.contains(&d) {
            out.push(d);
        }
    }
    out.truncate(MAX_DOMAINS);
    out
}

/// A brief the user sent back, cleaned, or why it can't run.
pub fn checked(brief: &ResearchBrief) -> Result<ResearchBrief, String> {
    if brief.question.trim().is_empty() {
        return Err("The research needs a question.".to_string());
    }
    let nonempty = brief
        .sub_questions
        .iter()
        .filter(|s| !s.trim().is_empty())
        .count();
    if nonempty == 0 {
        return Err("Add at least one sub-question.".to_string());
    }
    if nonempty > MAX_SUB_QUESTIONS {
        return Err(format!(
            "Keep it to {MAX_SUB_QUESTIONS} sub-questions or fewer."
        ));
    }
    let tidied = tidy(brief.clone());
    Ok(tidied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brief(subs: &[&str]) -> ResearchBrief {
        ResearchBrief {
            question: "  What   changed? ".into(),
            sub_questions: subs.iter().map(|s| s.to_string()).collect(),
            scope: Some("  ".into()),
            prefer_domains: vec!["https://www.Who.int/x".into(), "who.int".into()],
            avoid_domains: vec![],
            depth: ResearchDepth::Quick,
        }
    }

    #[test]
    fn checked_cleans_and_bounds_the_brief() {
        let ok = checked(&brief(&["A?", " a? ", "", "B?"])).unwrap();
        assert_eq!(ok.question, "What changed?");
        assert_eq!(ok.sub_questions, vec!["A?", "B?"]);
        assert_eq!(ok.scope, None);
        assert_eq!(ok.prefer_domains, vec!["who.int"]);
        assert!(checked(&brief(&["", " "])).is_err());
        assert!(checked(&brief(&["1", "2", "3", "4", "5", "6", "7"])).is_err());
    }

    #[test]
    fn a_draft_without_sub_questions_uses_the_question() {
        let t = tidy(brief(&[]));
        assert_eq!(t.sub_questions, vec!["What changed?"]);
    }
}
