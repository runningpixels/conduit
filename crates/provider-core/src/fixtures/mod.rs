use crate::schema::ProviderEvent;
use serde_json;

pub fn events_to_jsonl(events: &[ProviderEvent]) -> String {
    events
        .iter()
        .map(|event| serde_json::to_string(event).expect("serialize event"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn assert_events_match(actual: &[ProviderEvent], expected_jsonl: &str) {
    let expected: Vec<ProviderEvent> = expected_jsonl
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("parse expected event"))
        .collect();

    assert_eq!(actual.len(), expected.len(), "event count mismatch");
    for (i, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
        assert_eq!(a, e, "event mismatch at index {i}");
    }
}
