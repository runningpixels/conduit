//! Which search results a run reads: one copy of each page, public web
//! addresses only, the user's domain preferences, and a spread of hosts.

use std::net::IpAddr;

use url::Url;

/// The same page under every address a search can give for it: no fragment,
/// no `utm_*` tracking parameters, no trailing slash, lowercase host, no
/// `www.`. Used to compare, never to fetch. `None` for anything that isn't
/// an http(s) address with a host.
pub fn canonical(url: &str) -> Option<String> {
    let mut parsed = Url::parse(url.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = host_of(&parsed)?;
    parsed.set_fragment(None);
    let kept: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(k, _)| !k.to_ascii_lowercase().starts_with("utm_"))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let query = if kept.is_empty() {
        String::new()
    } else {
        let mut q = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in &kept {
            q.append_pair(k, v);
        }
        format!("?{}", q.finish())
    };
    let path = parsed.path().trim_end_matches('/');
    let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
    // http and https are one page here: the fetch upgrades to https anyway.
    Some(format!("{host}{port}{path}{query}"))
}

/// The host a page is counted under: lowercase, without `www.`.
pub fn host(url: &str) -> Option<String> {
    Url::parse(url.trim()).ok().as_ref().and_then(host_of)
}

fn host_of(url: &Url) -> Option<String> {
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    Some(host.strip_prefix("www.").unwrap_or(&host).to_string())
}

/// A user-typed domain (`https://www.Example.com/x`) as a bare host.
pub fn clean_domain(domain: &str) -> Option<String> {
    let d = domain.trim().to_ascii_lowercase();
    let d = d
        .strip_prefix("https://")
        .or_else(|| d.strip_prefix("http://"))
        .unwrap_or(&d);
    let d = d.split(['/', '?', '#']).next().unwrap_or_default();
    let d = d.strip_prefix("www.").unwrap_or(d).trim_matches('.');
    (!d.is_empty() && !d.contains(char::is_whitespace)).then(|| d.to_string())
}

/// `host` is `domain` or one of its subdomains.
pub fn host_matches(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|rest| rest.ends_with('.'))
}

/// An address a run may read: http(s) to a named or public host. The fetch
/// layer refuses private addresses again (after DNS too); this only keeps an
/// obviously local address from ever being tried.
pub fn is_public_web_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url.trim()) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    match parsed.host() {
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            !(name == "localhost"
                || name.ends_with(".localhost")
                || name.ends_with(".local")
                || name.ends_with(".internal")
                || name.ends_with(".lan")
                || !name.contains('.'))
        }
        Some(url::Host::Ipv4(ip)) => is_public_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_public_ip(IpAddr::V6(ip)),
        None => false,
    }
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (64..128).contains(&o[1])))
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (seg[0] & 0xfe00) == 0xfc00
                || (seg[0] & 0xffc0) == 0xfe80
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| !is_public_ip(IpAddr::V4(v4))))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_drops_fragment_trailing_slash_and_tracking() {
        let a = canonical("https://www.Example.com/news/story/?utm_source=x&id=7#comments");
        let b = canonical("http://example.com/news/story?id=7&utm_medium=email");
        assert_eq!(a, b);
        assert_eq!(a.as_deref(), Some("example.com/news/story?id=7"));
        assert_eq!(
            canonical("https://example.com/"),
            canonical("https://example.com")
        );
        assert_ne!(
            canonical("https://example.com/a"),
            canonical("https://example.com/b")
        );
        assert_eq!(canonical("mailto:someone@example.com"), None);
        assert_eq!(canonical("not a url"), None);
    }

    #[test]
    fn domains_match_themselves_and_subdomains_only() {
        assert!(host_matches("example.com", "example.com"));
        assert!(host_matches("news.example.com", "example.com"));
        assert!(!host_matches("badexample.com", "example.com"));
        assert_eq!(
            clean_domain(" https://www.Example.com/path ").as_deref(),
            Some("example.com")
        );
        assert_eq!(clean_domain("   "), None);
    }

    #[test]
    fn local_and_private_addresses_are_not_web_pages() {
        for url in [
            "http://192.168.1.1/admin",
            "https://10.0.0.5/",
            "https://127.0.0.1:8080/",
            "https://localhost/",
            "https://printer.local/",
            "https://[::1]/",
            "https://169.254.169.254/latest/meta-data/",
            "https://intranet/",
            "file:///etc/passwd",
        ] {
            assert!(!is_public_web_url(url), "{url}");
        }
        assert!(is_public_web_url("https://example.com/a"));
        assert!(is_public_web_url("https://93.184.216.34/"));
    }
}
