//! Starter apps: ready-made mini-apps that ship inside the signed binary.
//!
//! Each is one page under `starter_apps/`, compiled in. "Add" copies it into
//! the user's apps (origin `starter`), after which it is an ordinary app: same
//! sandbox, same ADR-010 network prompt on first use. A starter's name and
//! description are the matching Ideas strings, translated by the renderer.

use provider_core::schema::AppCategory;

pub struct StarterApp {
    /// Stable id, stored on the installed copy (`apps.starter_id`).
    pub id: &'static str,
    /// The Ideas catalog entry this starter is the ready-made version of.
    pub idea_id: &'static str,
    pub category: AppCategory,
    /// The tile's mark.
    pub icon: &'static str,
    /// The https origins the page declares (its `conduit-network` meta tags).
    pub hosts: &'static [&'static str],
    /// The capabilities the page declares (its `conduit-capability` meta
    /// tags), e.g. `&["storage"]`. All starters declare none today.
    pub capabilities: &'static [&'static str],
    /// The launch inputs the page declares (ADR-013), as the JSON array from
    /// its `application/conduit-inputs+json` script block. `"[]"` for every
    /// starter but weather, which declares `city` and `units`.
    pub inputs_json: &'static str,
    pub html: &'static str,
}

pub const STARTER_APPS: &[StarterApp] = &[
    StarterApp {
        id: "pomodoro-timer",
        idea_id: "pomodoroTimer",
        category: AppCategory::Tools,
        icon: "25:00",
        hosts: &[],
        capabilities: &[],
        inputs_json: "[]",
        html: include_str!("../starter_apps/pomodoro-timer.html"),
    },
    StarterApp {
        id: "unit-converter",
        idea_id: "unitConverter",
        category: AppCategory::Tools,
        icon: "⇄",
        hosts: &[],
        capabilities: &[],
        inputs_json: "[]",
        html: include_str!("../starter_apps/unit-converter.html"),
    },
    StarterApp {
        id: "weather-dashboard",
        idea_id: "weatherDashboard",
        category: AppCategory::LiveData,
        icon: "18°",
        hosts: &[
            "https://api.open-meteo.com",
            "https://geocoding-api.open-meteo.com",
        ],
        capabilities: &[],
        // Keep in sync with the `application/conduit-inputs+json` block in
        // weather-dashboard.html (guarded by
        // `starter_inputs_json_matches_the_page_declaration` below).
        inputs_json: r#"[{"id":"city","label":"City","type":"string","default":"Paris","required":true},{"id":"units","label":"Units","type":"enum","options":["metric","imperial"],"default":"metric"}]"#,
        html: include_str!("../starter_apps/weather-dashboard.html"),
    },
    StarterApp {
        id: "currency-converter",
        idea_id: "currencyConverter",
        category: AppCategory::LiveData,
        icon: "€ $",
        hosts: &["https://api.frankfurter.dev"],
        capabilities: &[],
        inputs_json: "[]",
        html: include_str!("../starter_apps/currency-converter.html"),
    },
    StarterApp {
        id: "snake",
        idea_id: "snakeGame",
        category: AppCategory::Play,
        icon: "▚▚▚",
        hosts: &[],
        capabilities: &[],
        inputs_json: "[]",
        html: include_str!("../starter_apps/snake.html"),
    },
    StarterApp {
        id: "memory-game",
        idea_id: "memoryGame",
        category: AppCategory::Play,
        icon: "◆◇",
        hosts: &[],
        capabilities: &[],
        inputs_json: "[]",
        html: include_str!("../starter_apps/memory-game.html"),
    },
    StarterApp {
        id: "capitals-quiz",
        idea_id: "capitalsQuiz",
        category: AppCategory::Play,
        icon: "?",
        hosts: &[],
        capabilities: &[],
        inputs_json: "[]",
        html: include_str!("../starter_apps/capitals-quiz.html"),
    },
    StarterApp {
        id: "budget-tracker",
        idea_id: "budgetTracker",
        category: AppCategory::Tools,
        icon: "+ −",
        hosts: &[],
        capabilities: &["storage"],
        inputs_json: "[]",
        html: include_str!("../starter_apps/budget-tracker.html"),
    },
];

pub fn find(id: &str) -> Option<&'static StarterApp> {
    STARTER_APPS.iter().find(|s| s.id == id)
}

#[cfg(test)]
mod tests {
    use super::STARTER_APPS;

    /// The origins a page declares in `<meta name="conduit-network"
    /// content="origin — reason">` tags.
    fn declared(html: &str) -> Vec<String> {
        let mut out = Vec::new();
        for (i, _) in html.match_indices("name=\"conduit-network\"") {
            let rest = &html[i..];
            let start = rest.find("content=\"").map(|c| c + 9);
            if let Some(start) = start {
                let content = &rest[start..];
                let end = content.find('"').unwrap_or(content.len());
                let origin = content[..end].split_whitespace().next().unwrap_or("");
                out.push(origin.to_string());
            }
        }
        out.sort();
        out
    }

    #[test]
    fn every_starter_declares_exactly_its_hosts() {
        for s in STARTER_APPS {
            let mut hosts: Vec<String> = s.hosts.iter().map(|h| h.to_string()).collect();
            hosts.sort();
            assert_eq!(declared(s.html), hosts, "{}: declared hosts", s.id);
        }
    }

    /// The sandbox has no storage, no dialogs and no outside scripts; a
    /// starter that relies on one breaks silently, so it fails here instead.
    #[test]
    fn starters_stay_inside_the_sandbox() {
        for s in STARTER_APPS {
            for banned in [
                "localStorage",
                "sessionStorage",
                "indexedDB",
                "document.cookie",
                "alert(",
                "confirm(",
                "window.open",
                "<script src",
                "<link ",
                "@import",
                "<iframe",
            ] {
                assert!(!s.html.contains(banned), "{} uses {banned}", s.id);
            }
            assert!(s.html.len() < 40 * 1024, "{} is over 40 KB", s.id);
            assert!(
                !s.html.trim_start().starts_with("<!doctype"),
                "{} must be a body fragment",
                s.id
            );
        }
    }

    /// The capabilities a page declares in `<meta name="conduit-capability"
    /// content="name — reason">` tags.
    fn declared_capabilities(html: &str) -> Vec<String> {
        let mut out = Vec::new();
        for (i, _) in html.match_indices("name=\"conduit-capability\"") {
            let rest = &html[i..];
            if let Some(start) = rest.find("content=\"").map(|c| c + 9) {
                let content = &rest[start..];
                let end = content.find('"').unwrap_or(content.len());
                out.push(
                    content[..end]
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .to_string(),
                );
            }
        }
        out.sort();
        out
    }

    #[test]
    fn every_starter_declares_exactly_its_capabilities() {
        for s in STARTER_APPS {
            let mut caps: Vec<String> = s.capabilities.iter().map(|c| c.to_string()).collect();
            caps.sort();
            assert_eq!(
                declared_capabilities(s.html),
                caps,
                "{}: declared capabilities",
                s.id
            );
        }
    }

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<&str> = STARTER_APPS.iter().map(|s| s.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), STARTER_APPS.len());
    }

    /// The JSON array a page declares in its `application/conduit-inputs+json`
    /// script block, if any.
    fn declared_inputs_block(html: &str) -> Option<serde_json::Value> {
        let start_tag = html.find("type=\"application/conduit-inputs+json\"")?;
        let after_tag = &html[start_tag..];
        let content_start = after_tag.find('>')? + 1;
        let content = &after_tag[content_start..];
        let end = content.find("</script>")?;
        serde_json::from_str(content[..end].trim()).ok()
    }

    /// `StarterApp::inputs_json` (ADR-013) is what `apps::install_starter` and
    /// `apps::refresh_starter` put in the manifest; it must be exactly what the
    /// page itself declares, or the two would silently drift.
    #[test]
    fn starter_inputs_json_matches_the_page_declaration() {
        for s in STARTER_APPS {
            let declared: serde_json::Value = serde_json::from_str(s.inputs_json)
                .unwrap_or_else(|e| panic!("{}: inputs_json doesn't parse: {e}", s.id));
            match declared_inputs_block(s.html) {
                Some(from_page) => assert_eq!(
                    from_page, declared,
                    "{}: inputs_json vs the page's own declaration",
                    s.id
                ),
                None => assert_eq!(
                    declared,
                    serde_json::json!([]),
                    "{}: page declares no inputs block, but inputs_json isn't []",
                    s.id
                ),
            }
        }
    }

    #[test]
    fn starter_inputs_json_is_a_valid_declaration() {
        for s in STARTER_APPS {
            let inputs: Vec<provider_core::schema::AppInput> = serde_json::from_str(s.inputs_json)
                .unwrap_or_else(|e| panic!("{}: inputs_json isn't valid AppInput[]: {e}", s.id));
            provider_core::app_inputs::validate_declaration(&inputs)
                .unwrap_or_else(|e| panic!("{}: {e}", s.id));
        }
    }
}
