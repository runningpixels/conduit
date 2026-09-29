//! "Ask me" steps: a run stops to ask the user something and carries on with
//! the answer (the step's `answer` output).
//!
//! The question waits like a permission question does (`waiting`): the run
//! shows as paused, the page lists it with its choices or a text box, and a
//! notification says so when the window isn't in front. Nobody answering in
//! time takes the step's `default` answer, or fails the step without one.

use serde::Serialize;

use super::waiting::{Pending, Waiting};

/// Longest typed answer kept.
pub const MAX_ANSWER_CHARS: usize = 2000;

/// A run waiting for the answer to a question.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub step_id: String,
    pub question: String,
    /// The answers to pick from; empty for a typed answer.
    pub choices: Vec<String>,
    /// Taken when nobody answers before `expires_at`.
    pub default: Option<String>,
    pub requested_at: String,
    pub expires_at: String,
}

impl Pending for PendingQuestion {
    fn run_id(&self) -> &str {
        &self.run_id
    }
    fn requested_at(&self) -> &str {
        &self.requested_at
    }
}

/// Runs waiting for an answer to an "Ask me" step, by run id.
pub type Questions = Waiting<PendingQuestion, String>;

/// `answer` checked against `question`: trimmed, not empty, not too long, and
/// one of the choices when there are choices.
pub fn checked_answer(question: &PendingQuestion, answer: &str) -> Result<String, String> {
    let answer = answer.trim();
    if answer.is_empty() {
        return Err("The answer is empty.".to_string());
    }
    if answer.chars().count() > MAX_ANSWER_CHARS {
        return Err(format!(
            "Keep the answer under {MAX_ANSWER_CHARS} characters."
        ));
    }
    if !question.choices.is_empty() && !question.choices.iter().any(|c| c == answer) {
        return Err("That isn't one of the choices.".to_string());
    }
    Ok(answer.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(choices: &[&str]) -> PendingQuestion {
        PendingQuestion {
            run_id: "r1".into(),
            workflow_id: "w1".into(),
            workflow_name: "Morning".into(),
            step_id: "ask".into(),
            question: "Which topic?".into(),
            choices: choices.iter().map(|c| c.to_string()).collect(),
            default: None,
            requested_at: "2026-09-29T08:00:00.000Z".into(),
            expires_at: "2026-09-30T08:00:00.000Z".into(),
        }
    }

    #[test]
    fn answers_are_trimmed_and_must_be_a_choice_when_there_are_choices() {
        assert_eq!(checked_answer(&question(&[]), "  Rust  ").unwrap(), "Rust");
        assert!(checked_answer(&question(&[]), "   ").is_err());
        assert!(checked_answer(&question(&[]), &"x".repeat(MAX_ANSWER_CHARS + 1)).is_err());
        assert_eq!(
            checked_answer(&question(&["Rust", "Go"]), "Go").unwrap(),
            "Go"
        );
        assert!(checked_answer(&question(&["Rust", "Go"]), "Zig").is_err());
    }

    #[tokio::test]
    async fn a_question_is_answered_through_the_registry() {
        let questions = Questions::default();
        let rx = questions.ask(question(&[]));
        assert_eq!(questions.get("r1").unwrap().question, "Which topic?");
        assert!(questions.answer("r1", "Rust".into()));
        assert_eq!(rx.await.unwrap(), "Rust");
        assert!(questions.list().is_empty());
    }
}
