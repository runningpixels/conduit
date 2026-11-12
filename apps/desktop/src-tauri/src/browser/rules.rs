// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! When a browser action goes ahead, asks, or is refused (design B2 §3).
//!
//! Fixed rules decide; the model never rates its own risk. In order:
//! 1. Refused: typing into a password field (the person signs in instead),
//!    or typing text that contains one of the person's saved API keys.
//! 2. Always asks: clicking something named like money or account changes
//!    (the risky-words list, in each UI language), and submitting a form that
//!    has a password field.
//! 3. A form without a password field submits freely on a listed site; on any
//!    other site it asks, offering to add the site.
//! 4. The first action on a site that isn't listed (or allowed earlier in this
//!    run) asks, offering to add it.
//! 5. Everything else goes ahead.

use crate::workflows::actions::BrowserAskReason;

/// What the page script reported about the element an action targets.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ElementFacts {
    pub role: String,
    pub name: String,
    /// It is a password field.
    pub password: bool,
    /// Clicking it submits a form (a submit button or input in a form).
    pub submits: bool,
    /// It sits in a form.
    pub in_form: bool,
    /// Its form has a password field.
    pub form_has_password: bool,
    /// The name of the form's submit button, when it has one (what Enter
    /// in one of its fields would press).
    pub submit_name: Option<String>,
}

/// A browser action, as the rules see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act<'a> {
    Click,
    Type { text: &'a str, press_enter: bool },
    Choose,
    Scroll,
    GoBack,
}

/// What the rules decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Go,
    Ask {
        reason: BrowserAskReason,
        /// The risky word found, for the card.
        word: Option<String>,
        /// "Always on this site" may be offered.
        offer_site: bool,
    },
    /// Refused without asking; the text is for the model.
    Refuse(String),
}

/// The site-list question for this host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Site {
    /// In the workflow's site list.
    Listed,
    /// Allowed once earlier in this run.
    AllowedThisRun,
    /// Neither.
    New,
}

pub const PASSWORD_REFUSAL: &str = "Agents never type into password fields. To get past a sign-in, call ask_to_sign_in so the person signs in themselves.";
pub const SECRET_REFUSAL: &str = "That text contains one of the person's saved API keys, so it wasn't typed. Never type keys or passwords into pages.";

/// Decide an action on an element (`None` for scroll and back).
pub fn judge(
    act: Act<'_>,
    element: Option<&ElementFacts>,
    site: Site,
    secrets: &[String],
) -> Decision {
    if matches!(act, Act::Scroll | Act::GoBack) {
        return Decision::Go;
    }
    let element = element.cloned().unwrap_or_default();
    if let Act::Type { text, .. } = act {
        if element.password {
            return Decision::Refuse(PASSWORD_REFUSAL.to_string());
        }
        if contains_secret(text, secrets) {
            return Decision::Refuse(SECRET_REFUSAL.to_string());
        }
    }
    let (submits, pressed) = match act {
        Act::Click => (element.submits, Some(element.name.as_str())),
        Act::Type {
            press_enter: true, ..
        } if element.in_form => (true, element.submit_name.as_deref()),
        _ => (false, None),
    };
    if let Some(word) = pressed.and_then(risky_word) {
        return Decision::Ask {
            reason: BrowserAskReason::Risky,
            word: Some(word.to_string()),
            offer_site: false,
        };
    }
    if submits {
        if element.form_has_password {
            return Decision::Ask {
                reason: BrowserAskReason::Submit,
                word: None,
                offer_site: false,
            };
        }
        return match site {
            Site::Listed => Decision::Go,
            Site::AllowedThisRun | Site::New => Decision::Ask {
                reason: BrowserAskReason::Submit,
                word: None,
                offer_site: true,
            },
        };
    }
    match site {
        Site::Listed | Site::AllowedThisRun => Decision::Go,
        Site::New => Decision::Ask {
            reason: BrowserAskReason::NewSite,
            word: None,
            offer_site: true,
        },
    }
}

/// Whether `text` contains one of `secrets` (ignoring blank or very short
/// ones, which would match by chance).
pub fn contains_secret(text: &str, secrets: &[String]) -> bool {
    secrets
        .iter()
        .map(|s| s.trim())
        .filter(|s| s.chars().count() >= 8)
        .any(|s| text.contains(s))
}

/// A site-list entry, cleaned: a lower-case host, or `*.host`. Refuses
/// schemes, paths, ports and anything that isn't a host.
pub fn normalize_site(entry: &str) -> Result<String, String> {
    let entry = entry.trim().trim_end_matches('.').to_lowercase();
    let (wild, host) = match entry.strip_prefix("*.") {
        Some(rest) => (true, rest),
        None => (false, entry.as_str()),
    };
    let ok = !host.is_empty()
        && host.contains('.')
        && host.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_alphanumeric() || c == '-')
        });
    if !ok {
        return Err(format!(
            "“{entry}” isn't a site. Write a host such as example.com or *.example.com."
        ));
    }
    Ok(if wild {
        format!("*.{host}")
    } else {
        host.to_string()
    })
}

/// Whether `host` is covered by the site list. `example.com` covers itself
/// and `www.example.com`; `*.example.com` covers it and every subdomain.
pub fn site_listed(host: &str, sites: &[String]) -> bool {
    let host = host.trim_end_matches('.').to_lowercase();
    sites.iter().any(|entry| {
        let Ok(entry) = normalize_site(entry) else {
            return false;
        };
        match entry.strip_prefix("*.") {
            Some(base) => host == base || host.ends_with(&format!(".{base}")),
            None => host == entry || host == format!("www.{entry}"),
        }
    })
}

/// The host "Always on this site" adds: the host without a leading `www.`.
pub fn site_to_offer(host: &str) -> String {
    let host = host.trim_end_matches('.').to_lowercase();
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

/// Names that spend money or change an account, in each UI language. Latin
/// entries match whole words (a trailing `*` matches a word's start); the
/// others match anywhere, since those scripts don't space words.
const RISKY_WORDS: &[&str] = &[
    // English
    "buy",
    "purchase",
    "pay",
    "pay now",
    "order",
    "place order",
    "checkout",
    "check out",
    "subscribe",
    "donate",
    "book",
    "book now",
    "reserve",
    "sign up",
    "register",
    "create account",
    "delete",
    "remove",
    "cancel subscription",
    "close account",
    "transfer",
    "send",
    "post",
    "publish",
    "confirm purchase",
    // German
    "kaufen",
    "kauf*",
    "bestell*",
    "bezahl*",
    "zahlen",
    "zur kasse",
    "abonnieren",
    "spenden",
    "buchen",
    "registrieren",
    "konto erstellen",
    "löschen",
    "entfernen",
    "kündigen",
    "überweis*",
    "senden",
    "absenden",
    "veröffentlichen",
    "posten",
    // Spanish
    "comprar",
    "pagar",
    "realizar pedido",
    "finalizar compra",
    "suscrib*",
    "donar",
    "reservar",
    "registrarse",
    "regístrate",
    "crear cuenta",
    "eliminar",
    "borrar",
    "quitar",
    "cancelar suscripción",
    "cerrar cuenta",
    "transferir",
    "enviar",
    "publicar",
    // French
    "acheter",
    "payer",
    "commander",
    "passer commande",
    "paiement",
    "abonner",
    "s'abonner",
    "faire un don",
    "réserver",
    "inscri*",
    "s'inscrire",
    "créer un compte",
    "supprimer",
    "retirer",
    "résilier",
    "fermer le compte",
    "virement",
    "transférer",
    "envoyer",
    "publier",
    // Portuguese (Brazil)
    "finalizar pedido",
    "assinar",
    "doar",
    "cadastr*",
    "criar conta",
    "excluir",
    "apagar",
    "remover",
    "cancelar assinatura",
    "encerrar conta",
    "postar",
    // Japanese
    "購入",
    "買う",
    "支払",
    "注文",
    "決済",
    "登録",
    "申し込",
    "申込",
    "予約",
    "寄付",
    "削除",
    "解約",
    "退会",
    "送金",
    "振込",
    "送信",
    "投稿",
    "公開",
    "アカウント作成",
    // Korean
    "구매",
    "결제",
    "주문",
    "구독",
    "기부",
    "예약",
    "가입",
    "계정 만들기",
    "삭제",
    "제거",
    "해지",
    "탈퇴",
    "송금",
    "이체",
    "보내기",
    "전송",
    "게시",
    "공개",
    // Chinese (Simplified)
    "购买",
    "支付",
    "付款",
    "下单",
    "结算",
    "订阅",
    "捐赠",
    "预订",
    "注册",
    "创建账户",
    "删除",
    "移除",
    "取消订阅",
    "注销",
    "转账",
    "发送",
    "发布",
    "提交订单",
];

/// The first risky word in an element's name, if any.
pub fn risky_word(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase().replace('’', "'");
    let words: Vec<&str> = lower
        .split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .filter(|w| !w.is_empty())
        .collect();
    RISKY_WORDS.iter().copied().find(|entry| {
        if !entry.is_ascii()
            && !entry
                .chars()
                .any(|c| c.is_ascii_alphabetic() || is_latin(c))
        {
            return lower.contains(entry);
        }
        let (stem, prefix) = match entry.strip_suffix('*') {
            Some(stem) => (stem, true),
            None => (*entry, false),
        };
        let parts: Vec<&str> = stem.split(' ').collect();
        words.windows(parts.len()).any(|window| {
            window.iter().zip(&parts).enumerate().all(|(i, (w, p))| {
                if prefix && i == parts.len() - 1 {
                    w.starts_with(p)
                } else {
                    w == p
                }
            })
        })
    })
}

fn is_latin(c: char) -> bool {
    matches!(c, '\u{00C0}'..='\u{024F}')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn button(name: &str) -> ElementFacts {
        ElementFacts {
            role: "button".into(),
            name: name.into(),
            ..Default::default()
        }
    }

    #[test]
    fn risky_words_match_whole_words_in_each_language() {
        assert_eq!(risky_word("Buy now"), Some("buy"));
        assert_eq!(risky_word("Place your order"), Some("order"));
        assert_eq!(risky_word("Sign up for free"), Some("sign up"));
        assert_eq!(risky_word("Jetzt bestellen"), Some("bestell*"));
        assert_eq!(risky_word("Finalizar compra"), Some("finalizar compra"));
        assert_eq!(risky_word("S’abonner"), Some("s'abonner"));
        assert_eq!(risky_word("Cadastre-se"), Some("cadastr*"));
        assert_eq!(risky_word("今すぐ購入する"), Some("購入"));
        assert_eq!(risky_word("결제하기"), Some("결제"));
        assert_eq!(risky_word("立即购买"), Some("购买"));
        // Whole words only: these are harmless.
        assert_eq!(risky_word("Bookmarks"), None);
        assert_eq!(risky_word("Payments history"), None);
        assert_eq!(risky_word("Next page"), None);
        assert_eq!(risky_word("Search"), None);
    }

    #[test]
    fn password_fields_and_keys_are_refused() {
        let password = ElementFacts {
            password: true,
            ..button("Password")
        };
        let typing = Act::Type {
            text: "hunter2",
            press_enter: false,
        };
        assert_eq!(
            judge(typing, Some(&password), Site::Listed, &[]),
            Decision::Refuse(PASSWORD_REFUSAL.to_string())
        );
        let key = "sk-or-v1-abcdef0123456789".to_string();
        let leaking = Act::Type {
            text: "my key is sk-or-v1-abcdef0123456789 ok",
            press_enter: false,
        };
        assert_eq!(
            judge(
                leaking,
                Some(&button("Comment")),
                Site::Listed,
                std::slice::from_ref(&key)
            ),
            Decision::Refuse(SECRET_REFUSAL.to_string())
        );
        // Short or blank "secrets" never match by chance.
        assert!(!contains_secret("a b c", &["".into(), "abc".into()]));
    }

    #[test]
    fn risky_clicks_always_ask_even_on_listed_sites() {
        let decision = judge(
            Act::Click,
            Some(&button("Delete account")),
            Site::Listed,
            &[],
        );
        assert_eq!(
            decision,
            Decision::Ask {
                reason: BrowserAskReason::Risky,
                word: Some("delete".into()),
                offer_site: false
            }
        );
    }

    #[test]
    fn forms_submit_freely_only_on_listed_sites_without_passwords() {
        let search = ElementFacts {
            role: "textbox".into(),
            name: "Search".into(),
            in_form: true,
            submit_name: Some("Search".into()),
            ..Default::default()
        };
        let enter = Act::Type {
            text: "rust",
            press_enter: true,
        };
        assert_eq!(judge(enter, Some(&search), Site::Listed, &[]), Decision::Go);
        assert_eq!(
            judge(enter, Some(&search), Site::New, &[]),
            Decision::Ask {
                reason: BrowserAskReason::Submit,
                word: None,
                offer_site: true
            }
        );
        assert!(matches!(
            judge(enter, Some(&search), Site::AllowedThisRun, &[]),
            Decision::Ask {
                reason: BrowserAskReason::Submit,
                ..
            }
        ));
        let login = ElementFacts {
            submits: true,
            in_form: true,
            form_has_password: true,
            ..button("Continue")
        };
        assert_eq!(
            judge(Act::Click, Some(&login), Site::Listed, &[]),
            Decision::Ask {
                reason: BrowserAskReason::Submit,
                word: None,
                offer_site: false
            }
        );
        // Enter in a form whose button is risky asks as risky.
        let checkout = ElementFacts {
            submit_name: Some("Place order".into()),
            ..search
        };
        assert!(matches!(
            judge(enter, Some(&checkout), Site::Listed, &[]),
            Decision::Ask {
                reason: BrowserAskReason::Risky,
                ..
            }
        ));
    }

    #[test]
    fn new_sites_ask_once_then_go() {
        let link = ElementFacts {
            role: "link".into(),
            name: "Docs".into(),
            ..Default::default()
        };
        assert_eq!(
            judge(Act::Click, Some(&link), Site::New, &[]),
            Decision::Ask {
                reason: BrowserAskReason::NewSite,
                word: None,
                offer_site: true
            }
        );
        assert_eq!(
            judge(Act::Click, Some(&link), Site::AllowedThisRun, &[]),
            Decision::Go
        );
        assert_eq!(judge(Act::Scroll, None, Site::New, &[]), Decision::Go);
        assert_eq!(judge(Act::GoBack, None, Site::New, &[]), Decision::Go);
    }

    #[test]
    fn site_list_matching() {
        let sites = vec!["github.com".to_string(), "*.wikipedia.org".to_string()];
        assert!(site_listed("github.com", &sites));
        assert!(site_listed("www.github.com", &sites));
        assert!(!site_listed("gist.github.com", &sites));
        assert!(!site_listed("evilgithub.com", &sites));
        assert!(site_listed("en.wikipedia.org", &sites));
        assert!(site_listed("wikipedia.org", &sites));
        assert!(!site_listed("wikipedia.org.evil.com", &sites));
        assert_eq!(site_to_offer("WWW.Example.com"), "example.com");
    }

    #[test]
    fn site_entries_are_checked() {
        assert_eq!(normalize_site(" Example.COM ").unwrap(), "example.com");
        assert_eq!(normalize_site("*.example.com").unwrap(), "*.example.com");
        for bad in [
            "https://example.com",
            "example.com/path",
            "example.com:443",
            "localhost",
            "*",
            "",
            "-a.com",
        ] {
            assert!(normalize_site(bad).is_err(), "{bad}");
        }
    }
}
