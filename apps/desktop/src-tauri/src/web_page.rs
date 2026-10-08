//! Fetch one web page and turn it into readable text.
//!
//! Shared by the chat `web_fetch` tool and the workflow "Fetch page" step so
//! both go through the same network path: [`artifact_network::perform`] —
//! https to public addresses only (a name that resolves to a private or local
//! address is refused, and each redirect hop is checked again), pinned DNS,
//! and the response size and time caps. A page the model reads may tell it to
//! fetch `http://192.168.1.1/...`; this is what stops that request.
//!
//! PDFs are read too (reports, budgets and papers often are PDFs), with the
//! same care as importing one into Documents: parsed off the async runtime,
//! under a timeout, with panics from the parser caught. A scanned PDF with no
//! text layer comes back as a page with no text, which callers already treat
//! as "nothing readable".

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};

use crate::artifact_network::{self, AddressPolicy, ArtifactFetchRequest};
use crate::workflows::extract;

/// A fetched page, reduced to what a model needs.
#[derive(Debug, Clone)]
pub struct Page {
    /// The URL that finally answered, after redirects.
    pub url: String,
    pub title: Option<String>,
    /// Readable text, at most the `max_chars` asked for.
    pub text: String,
    /// Absolute links found on an HTML page (empty for plain text).
    pub links: Vec<String>,
    /// The response's media type, lowercase and without parameters
    /// (`text/html`, `text/csv`); empty when the site sent none.
    pub content_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The request did not complete: refused address, DNS, timeout, size cap.
    Network(String),
    /// The site answered with an error status.
    Status { status: u16, text: String },
    /// The body was not valid base64 from the network layer.
    Unreadable,
    /// The response is not text (an image, a download).
    NotAPage(String),
    /// The response is a PDF the parser could not read.
    BadPdf(String),
}

/// Longest a PDF may take to parse. The parse can't be interrupted, so a
/// pathological file keeps one blocking thread busy past this; the caller
/// moves on.
const PDF_PARSE_TIMEOUT: Duration = Duration::from_secs(20);

impl FetchError {
    /// Worth retrying: a network failure, a server error, or "slow down".
    pub fn is_transient(&self) -> bool {
        match self {
            FetchError::Network(_) => true,
            FetchError::Status { status, .. } => *status >= 500 || *status == 429,
            FetchError::Unreadable | FetchError::NotAPage(_) | FetchError::BadPdf(_) => false,
        }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Network(message) => f.write_str(message),
            FetchError::Status { status, text } => write!(f, "the site answered {status} {text}"),
            FetchError::Unreadable => f.write_str("the page could not be read"),
            FetchError::NotAPage(content_type) => {
                write!(f, "it is not a web page ({content_type})")
            }
            FetchError::BadPdf(reason) => write!(f, "the PDF could not be read ({reason})"),
        }
    }
}

/// `http://` becomes `https://`: the network path only speaks https, and most
/// sites a model names with `http://` serve the same page over https.
pub fn upgrade_to_https(url: &str) -> String {
    match url.get(..7) {
        Some(scheme) if scheme.eq_ignore_ascii_case("http://") => format!("https://{}", &url[7..]),
        _ => url.to_string(),
    }
}

/// Fetch `url` and return its readable text. `principal` names the reader for
/// the network layer's per-reader rate limit (`workflow-run:<id>`, `chat`).
pub async fn fetch(
    url: &str,
    principal: &str,
    policy: AddressPolicy,
    max_chars: usize,
) -> Result<Page, FetchError> {
    let request = ArtifactFetchRequest {
        principal: principal.to_string(),
        url: url.to_string(),
        method: "GET".to_string(),
        headers: vec![(
            "Accept".to_string(),
            "text/html,text/plain;q=0.9,application/pdf;q=0.8,*/*;q=0.5".to_string(),
        )],
        body: None,
    };
    let response = artifact_network::perform_capped(
        &request,
        policy,
        &|_| true,
        artifact_network::MAX_DOCUMENT_RESPONSE_BYTES,
    )
    .await
    .map_err(FetchError::Network)?;
    if response.status >= 400 {
        return Err(FetchError::Status {
            status: response.status,
            text: response.status_text,
        });
    }
    let bytes = B64
        .decode(&response.body)
        .map_err(|_| FetchError::Unreadable)?;
    let content_type = response
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.to_ascii_lowercase())
        .unwrap_or_default();
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if content_type.contains("application/pdf") || bytes.starts_with(b"%PDF-") {
        let text = pdf_text(bytes).await?;
        return Ok(Page {
            title: pdf_title(&response.url),
            url: response.url,
            text: text.chars().take(max_chars).collect(),
            links: Vec::new(),
            content_type: media_type,
        });
    }
    let body = String::from_utf8_lossy(&bytes);
    // Data (a CSV, JSON or plain-text file) is handed over as it is: reading
    // it as an article would throw away the rows.
    if is_data(&media_type, &response.url) {
        return Ok(Page {
            url: response.url,
            title: None,
            text: body.chars().take(max_chars).collect(),
            links: Vec::new(),
            content_type: media_type,
        });
    }
    let is_html = content_type.contains("html") || body.trim_start().starts_with('<');
    let (title, text, links) = if is_html {
        let page = extract::extract_readable(&body, &response.url);
        (page.title, page.text, page.links)
    } else if content_type.is_empty()
        || content_type.starts_with("text/")
        || content_type.contains("json")
    {
        (None, body.trim().to_string(), Vec::new())
    } else {
        return Err(FetchError::NotAPage(content_type));
    };
    Ok(Page {
        url: response.url,
        title,
        text: text.chars().take(max_chars).collect(),
        links,
        content_type: media_type,
    })
}

/// Whether a response is data to pass on untouched: by its media type, or,
/// when the site sent none (or a generic download type), by the file
/// extension in the URL.
pub(crate) fn is_data(media_type: &str, url: &str) -> bool {
    match media_type {
        "text/csv"
        | "text/tab-separated-values"
        | "text/plain"
        | "application/json"
        | "application/csv" => true,
        m if m.ends_with("+json") => true,
        "" | "application/octet-stream" | "binary/octet-stream" => {
            let path = url::Url::parse(url)
                .map(|u| u.path().to_ascii_lowercase())
                .unwrap_or_default();
            [".csv", ".tsv", ".json", ".txt"]
                .iter()
                .any(|ext| path.ends_with(ext))
        }
        _ => false,
    }
}

/// The text of a PDF, tidied: trailing spaces and runs of blank lines go.
async fn pdf_text(bytes: Vec<u8>) -> Result<String, FetchError> {
    let parse = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            pdf_extract::extract_text_from_mem(&bytes)
        }))
    });
    let text = match tokio::time::timeout(PDF_PARSE_TIMEOUT, parse).await {
        Err(_) => return Err(FetchError::BadPdf("it took too long".into())),
        Ok(Err(_)) | Ok(Ok(Err(_))) => {
            return Err(FetchError::BadPdf("the file is damaged".into()))
        }
        Ok(Ok(Ok(Err(e)))) => return Err(FetchError::BadPdf(e.to_string())),
        Ok(Ok(Ok(Ok(text)))) => text,
    };
    let mut out = String::with_capacity(text.len());
    let mut blank_lines = 0;
    for line in text.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blank_lines += 1;
            if blank_lines > 1 {
                continue;
            }
        } else {
            blank_lines = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    Ok(out.trim().to_string())
}

/// A PDF has no `<title>` we read; its file name is the next best thing:
/// `2026-Introduced-Budget.pdf` → "2026 Introduced Budget".
fn pdf_title(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let name = parsed.path_segments()?.rev().find(|s| !s.is_empty())?;
    let name = name.replace("%20", " ");
    let stem = name
        .strip_suffix(".pdf")
        .or_else(|| name.strip_suffix(".PDF"))
        .unwrap_or(&name);
    let title = stem.replace(['-', '_'], " ");
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    (!title.is_empty()).then_some(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_only_plain_http() {
        assert_eq!(
            upgrade_to_https("http://example.com/a"),
            "https://example.com/a"
        );
        assert_eq!(
            upgrade_to_https("HTTP://example.com"),
            "https://example.com"
        );
        assert_eq!(
            upgrade_to_https("https://example.com"),
            "https://example.com"
        );
        assert_eq!(upgrade_to_https("ftp://example.com"), "ftp://example.com");
        assert_eq!(upgrade_to_https("http"), "http");
    }

    #[test]
    fn transient_errors_are_network_server_and_rate_limit() {
        assert!(FetchError::Network("timeout".into()).is_transient());
        let status = |status| FetchError::Status {
            status,
            text: String::new(),
        };
        assert!(status(503).is_transient());
        assert!(status(429).is_transient());
        assert!(!status(404).is_transient());
        assert!(!FetchError::NotAPage("image/png".into()).is_transient());
    }

    #[tokio::test]
    async fn refuses_loopback_and_private_addresses() {
        for url in [
            "https://127.0.0.1/",
            "https://localhost/admin",
            "https://10.0.0.1/",
            "https://192.168.1.1/",
            "https://169.254.169.254/latest/meta-data/",
            "https://[::1]/",
        ] {
            let result = fetch(url, "test", AddressPolicy::APP, 1000).await;
            assert!(
                matches!(result, Err(FetchError::Network(_))),
                "{url} should be refused, got {result:?}"
            );
        }
    }

    /// A one-page PDF saying `line`, with a correct cross-reference table.
    fn tiny_pdf(line: &str) -> Vec<u8> {
        let content = format!("BT /F1 18 Tf 72 700 Td ({line}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R \
             /Resources << /Font << /F1 5 0 R >> >> >>"
                .to_string(),
            format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            ),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
                .to_string(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for offset in offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        pdf
    }

    /// Serves `body` with `content_type` to every request on loopback.
    async fn serve(content_type: &'static str, body: Vec<u8>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let _ = socket.read(&mut buf).await;
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                });
            }
        });
        format!("http://{addr}")
    }

    const LOOPBACK: AddressPolicy = AddressPolicy { public_only: false };

    #[tokio::test]
    async fn reads_the_text_of_a_pdf() {
        let base = serve(
            "application/pdf",
            tiny_pdf("Hoboken general tax rate is 1.80 percent"),
        )
        .await;
        let page = fetch(
            &format!("{base}/files/2026-Tax-Rates.pdf"),
            "test",
            LOOPBACK,
            10_000,
        )
        .await
        .expect("the PDF is read");
        assert!(
            page.text
                .contains("Hoboken general tax rate is 1.80 percent"),
            "{:?}",
            page.text
        );
        assert_eq!(page.title.as_deref(), Some("2026 Tax Rates"));
    }

    #[tokio::test]
    async fn a_pdf_is_recognised_by_its_header_whatever_the_content_type() {
        let base = serve("application/octet-stream", tiny_pdf("Read anyway")).await;
        let page = fetch(&format!("{base}/download"), "test", LOOPBACK, 10_000)
            .await
            .expect("sniffed as a PDF");
        assert!(page.text.contains("Read anyway"), "{:?}", page.text);
    }

    #[tokio::test]
    async fn a_damaged_pdf_is_an_error_not_a_crash() {
        let base = serve(
            "application/pdf",
            b"%PDF-1.4\nthis is not really a pdf".to_vec(),
        )
        .await;
        let result = fetch(&format!("{base}/broken.pdf"), "test", LOOPBACK, 10_000).await;
        assert!(matches!(result, Err(FetchError::BadPdf(_))), "{result:?}");
        assert!(!result.unwrap_err().is_transient());
    }

    #[test]
    fn pdf_titles_come_from_the_file_name() {
        assert_eq!(
            pdf_title("https://example.gov/wp-content/uploads/2026/05/2026-Introduced-Budget.pdf")
                .as_deref(),
            Some("2026 Introduced Budget")
        );
        assert_eq!(
            pdf_title("https://example.com/Annual%20Report_2025.PDF").as_deref(),
            Some("Annual Report 2025")
        );
        assert_eq!(pdf_title("https://example.com/"), None);
    }

    #[tokio::test]
    async fn csv_and_json_come_back_as_they_are() {
        let csv = "\u{feff}Week,Revenue\n1,100\n\n<b>2</b>,250\n";
        let base = serve("text/csv; charset=utf-8", csv.as_bytes().to_vec()).await;
        let page = fetch(&format!("{base}/report"), "test", LOOPBACK, 10_000)
            .await
            .unwrap();
        assert_eq!(page.text, csv, "no reading, no trimming");
        assert_eq!(page.content_type, "text/csv");
        assert_eq!(page.title, None);
        assert!(page.links.is_empty());

        let json = r#"{"rows": [{"a": 1}]}"#;
        for content_type in ["application/json", "application/vnd.api+json", "text/plain"] {
            let base = serve(content_type, json.as_bytes().to_vec()).await;
            let page = fetch(&format!("{base}/x"), "test", LOOPBACK, 10_000)
                .await
                .unwrap();
            assert_eq!(
                (page.text.as_str(), page.content_type.as_str()),
                (json, content_type)
            );
        }
        let base = serve("text/tab-separated-values", b"a\tb\n1\t2\n".to_vec()).await;
        let page = fetch(&format!("{base}/t"), "test", LOOPBACK, 10_000)
            .await
            .unwrap();
        assert_eq!(page.text, "a\tb\n1\t2\n");
    }

    #[tokio::test]
    async fn a_data_file_url_is_data_when_the_site_names_no_type() {
        let csv = b"a,b\n1,2\n".to_vec();
        for path in [
            "/export.csv",
            "/EXPORT.CSV?download=1",
            "/data.json",
            "/notes.txt",
        ] {
            let base = serve("application/octet-stream", csv.clone()).await;
            let page = fetch(&format!("{base}{path}"), "test", LOOPBACK, 10_000)
                .await
                .unwrap_or_else(|e| panic!("{path}: {e}"));
            assert_eq!(page.text, "a,b\n1,2\n", "{path}");
            assert_eq!(page.content_type, "application/octet-stream");
        }
        // Without a data extension, a download is still not a page.
        let base = serve("application/octet-stream", csv).await;
        let result = fetch(&format!("{base}/download"), "test", LOOPBACK, 10_000).await;
        assert!(matches!(result, Err(FetchError::NotAPage(_))), "{result:?}");
    }

    #[tokio::test]
    async fn html_is_still_read_as_an_article() {
        let html = "<html><head><title>News</title><script>track()</script></head>\
                    <body><nav>Home</nav><article><h1>Big story</h1><p>It happened today.</p></article></body></html>";
        let base = serve("text/html; charset=utf-8", html.as_bytes().to_vec()).await;
        let page = fetch(&format!("{base}/story.csv"), "test", LOOPBACK, 10_000)
            .await
            .unwrap();
        assert_eq!(page.title.as_deref(), Some("News"));
        assert!(page.text.contains("Big story") && !page.text.contains("track()"));
        assert_eq!(page.content_type, "text/html");
    }

    #[tokio::test]
    async fn refuses_plain_http() {
        let result = fetch("http://example.com/", "test", AddressPolicy::APP, 1000).await;
        assert!(matches!(result, Err(FetchError::Network(_))), "{result:?}");
    }
}
