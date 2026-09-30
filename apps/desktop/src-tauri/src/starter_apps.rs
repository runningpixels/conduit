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
    pub html: &'static str,
}

pub const STARTER_APPS: &[StarterApp] = &[
    StarterApp {
        id: "pomodoro-timer",
        idea_id: "pomodoroTimer",
        category: AppCategory::Tools,
        icon: "25:00",
        hosts: &[],
        html: include_str!("../starter_apps/pomodoro-timer.html"),
    },
    StarterApp {
        id: "unit-converter",
        idea_id: "unitConverter",
        category: AppCategory::Tools,
        icon: "⇄",
        hosts: &[],
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
        html: include_str!("../starter_apps/weather-dashboard.html"),
    },
    StarterApp {
        id: "currency-converter",
        idea_id: "currencyConverter",
        category: AppCategory::LiveData,
        icon: "€ $",
        hosts: &["https://api.frankfurter.dev"],
        html: include_str!("../starter_apps/currency-converter.html"),
    },
    StarterApp {
        id: "snake",
        idea_id: "snakeGame",
        category: AppCategory::Play,
        icon: "▚▚▚",
        hosts: &[],
        html: include_str!("../starter_apps/snake.html"),
    },
    StarterApp {
        id: "memory-game",
        idea_id: "memoryGame",
        category: AppCategory::Play,
        icon: "◆◇",
        hosts: &[],
        html: include_str!("../starter_apps/memory-game.html"),
    },
    StarterApp {
        id: "capitals-quiz",
        idea_id: "capitalsQuiz",
        category: AppCategory::Play,
        icon: "?",
        hosts: &[],
        html: include_str!("../starter_apps/capitals-quiz.html"),
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

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<&str> = STARTER_APPS.iter().map(|s| s.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), STARTER_APPS.len());
    }
}
