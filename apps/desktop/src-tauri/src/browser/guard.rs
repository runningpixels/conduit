// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! The navigation guard: every request a page makes (the page itself, its
//! redirects, scripts, frames, workers) is held by the browser until the
//! address policy of `web_fetch` has looked at it. Only public http(s)
//! addresses go through; anything else fails with `BlockedByClient`.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;

use url::{Host, Url};

use crate::artifact_network::{is_public_ip, AddressPolicy};

/// What the guard says about one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Refused, with the reason in plain words.
    Block(String),
}

/// What the address alone settles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Syntax {
    Allow,
    Block(String),
    /// A name: it must resolve to public addresses only.
    Resolve(String),
}

/// Whether debug builds may reach loopback (the integration test's server).
#[cfg(debug_assertions)]
pub fn loopback_allowed() -> bool {
    std::env::var("CONDUIT_BROWSER_ALLOW_LOOPBACK").is_ok_and(|v| v == "1")
}

#[cfg(not(debug_assertions))]
pub fn loopback_allowed() -> bool {
    false
}

/// The checks that need no lookup: scheme, credentials, local names, IP
/// literals. `allow_loopback` is only ever true in a debug build.
pub fn check_syntax(raw: &str, allow_loopback: bool) -> Syntax {
    let Ok(url) = Url::parse(raw) else {
        return Syntax::Block("not a valid address".to_string());
    };
    match url.scheme() {
        // Not network: nothing to reach.
        "data" | "blob" => return Syntax::Allow,
        // Websockets (`Network.webSocketCreated`) follow the same rule.
        "http" | "https" | "ws" | "wss" => {}
        other => return Syntax::Block(format!("{other}: addresses are not allowed")),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Syntax::Block("addresses with a user name or password are not allowed".to_string());
    }
    let Some(host) = url.host() else {
        return Syntax::Block("the address has no host".to_string());
    };
    match host {
        Host::Ipv4(ip) => literal(IpAddr::V4(ip), allow_loopback),
        Host::Ipv6(ip) => literal(IpAddr::V6(ip), allow_loopback),
        Host::Domain(name) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            let local = name == "localhost" || name.ends_with(".localhost");
            if local && allow_loopback {
                return Syntax::Allow;
            }
            if local || name.ends_with(".local") || name.ends_with(".internal") {
                return Syntax::Block(format!(
                    "{name} is on this machine or network and cannot be opened"
                ));
            }
            Syntax::Resolve(name)
        }
    }
}

fn literal(ip: IpAddr, allow_loopback: bool) -> Syntax {
    if (allow_loopback && ip.is_loopback()) || is_public_ip(ip) {
        Syntax::Allow
    } else {
        Syntax::Block(format!(
            "{ip} is a private or local address and cannot be opened"
        ))
    }
}

/// The verdict on a name once it has resolved to `addrs`: a name that answers
/// even one non-public address is not a public name.
pub fn judge_addresses(host: &str, addrs: &[IpAddr], allow_loopback: bool) -> Decision {
    if addrs.is_empty() {
        return Decision::Block(format!("{host} did not resolve to any address"));
    }
    match addrs
        .iter()
        .find(|ip| !(is_public_ip(**ip) || (allow_loopback && ip.is_loopback())))
    {
        Some(bad) => Decision::Block(format!(
            "{host} points to {bad}, a private or local address"
        )),
        None => Decision::Allow,
    }
}

/// Decides requests; remembers each host's verdict for as long as it lives
/// (one browser launch).
#[derive(Default)]
pub struct Guard {
    hosts: Mutex<HashMap<String, Decision>>,
}

impl Guard {
    pub async fn check(&self, raw: &str) -> Decision {
        let allow_loopback = loopback_allowed();
        match check_syntax(raw, allow_loopback) {
            Syntax::Allow => Decision::Allow,
            Syntax::Block(why) => Decision::Block(why),
            Syntax::Resolve(host) => {
                if let Some(known) = self.hosts.lock().ok().and_then(|h| h.get(&host).cloned()) {
                    return known;
                }
                let decision = Self::resolve(&host, allow_loopback).await;
                if let Ok(mut hosts) = self.hosts.lock() {
                    hosts.insert(host, decision.clone());
                }
                decision
            }
        }
    }

    async fn resolve(host: &str, allow_loopback: bool) -> Decision {
        // The same resolver and policy `web_fetch` uses, so one rule decides.
        let policy = AddressPolicy {
            public_only: !allow_loopback,
        };
        match crate::artifact_network::resolve_checked(host, 443, policy).await {
            Ok(_) => Decision::Allow,
            Err(why) => Decision::Block(why),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(raw: &str) -> bool {
        matches!(check_syntax(raw, false), Syntax::Block(_))
    }

    #[test]
    fn public_names_are_resolved_and_public_literals_pass() {
        assert_eq!(
            check_syntax("https://Example.com/a?b=1", false),
            Syntax::Resolve("example.com".into())
        );
        assert_eq!(
            check_syntax("http://news.ycombinator.com", false),
            Syntax::Resolve("news.ycombinator.com".into())
        );
        assert_eq!(check_syntax("https://8.8.8.8/", false), Syntax::Allow);
        assert_eq!(
            check_syntax("https://[2606:4700:4700::1111]/", false),
            Syntax::Allow
        );
    }

    #[test]
    fn private_and_local_addresses_are_refused() {
        for raw in [
            "http://10.0.0.5/",
            "https://192.168.1.1/admin",
            "http://172.16.0.1/",
            "http://127.0.0.1:8080/",
            "http://169.254.169.254/latest/meta-data",
            "http://100.64.0.1/",
            "http://0.0.0.0/",
            "http://localhost/",
            "http://LOCALHOST:3000/",
            "http://app.localhost/",
            "http://printer.local/",
            "http://db.internal/",
            "http://[::1]/",
            "http://[fe80::1]/",
            "http://[fd00::1]/",
            "http://[::ffff:10.0.0.1]/",
            // Other spellings of 127.0.0.1 the URL parser normalises.
            "http://2130706433/",
            "http://0x7f.1/",
            "http://127.1/",
        ] {
            assert!(blocked(raw), "{raw}");
        }
    }

    #[test]
    fn credentials_and_other_schemes_are_refused() {
        assert!(blocked("https://user:pw@example.com/"));
        assert!(blocked("https://user@example.com/"));
        assert!(blocked("ftp://example.com/file"));
        assert!(blocked("file:///C:/Windows/win.ini"));
        assert!(blocked("javascript:alert(1)"));
        assert!(blocked("chrome://settings"));
        assert!(blocked("about:blank"));
        assert!(blocked("not a url"));
    }

    #[test]
    fn websockets_follow_the_http_rule() {
        assert_eq!(
            check_syntax("wss://stream.example.com/feed", false),
            Syntax::Resolve("stream.example.com".into())
        );
        assert_eq!(check_syntax("ws://8.8.8.8:80/", false), Syntax::Allow);
        for raw in [
            "ws://10.255.255.1/",
            "wss://192.168.0.10:8443/socket",
            "ws://127.0.0.1:9222/devtools/browser/x",
            "ws://localhost:3000/",
            "wss://router.local/",
            "ws://[::1]/",
            "wss://user:pw@example.com/",
        ] {
            assert!(blocked(raw), "{raw}");
        }
        assert_eq!(check_syntax("ws://127.0.0.1:9/", true), Syntax::Allow);
    }

    #[test]
    fn data_and_blob_subresources_are_not_network() {
        assert_eq!(check_syntax("data:text/plain,hi", false), Syntax::Allow);
        assert_eq!(
            check_syntax("blob:https://example.com/1234", false),
            Syntax::Allow
        );
    }

    #[test]
    fn loopback_opens_only_when_asked() {
        assert!(blocked("http://127.0.0.1:9/"));
        assert_eq!(check_syntax("http://127.0.0.1:9/", true), Syntax::Allow);
        assert_eq!(check_syntax("http://localhost:9/", true), Syntax::Allow);
        // Still not the rest of the private network.
        assert!(matches!(
            check_syntax("http://10.0.0.1/", true),
            Syntax::Block(_)
        ));
    }

    #[test]
    fn a_name_with_any_private_answer_is_refused() {
        let public: IpAddr = "93.184.216.34".parse().unwrap();
        let private: IpAddr = "10.1.2.3".parse().unwrap();
        assert_eq!(judge_addresses("a.test", &[public], false), Decision::Allow);
        assert!(matches!(
            judge_addresses("a.test", &[public, private], false),
            Decision::Block(_)
        ));
        assert!(matches!(
            judge_addresses("a.test", &[], false),
            Decision::Block(_)
        ));
    }

    #[tokio::test]
    async fn guard_blocks_names_without_a_lookup() {
        let guard = Guard::default();
        assert!(matches!(
            guard.check("http://localhost/").await,
            Decision::Block(_)
        ));
        assert!(matches!(
            guard.check("http://10.0.0.1/").await,
            Decision::Block(_)
        ));
        assert_eq!(guard.check("data:text/html,x").await, Decision::Allow);
    }
}
