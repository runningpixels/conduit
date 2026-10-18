//! The research report's own words — headings, the byline, source notes — in
//! the app's language. The model writes the summary and findings in the
//! question's language (see the planner and writer prompts); these are the
//! parts [`super::report::render`] adds around them.

use provider_core::schema::LanguageSetting;

pub struct ReportLabels {
    /// Byline: date, cited-source count, depth.
    pub researched: fn(&str, usize, &str) -> String,
    pub quick: &'static str,
    pub standard: &'static str,
    pub deep: &'static str,
    pub summary: &'static str,
    pub findings: &'static str,
    pub disagreements: &'static str,
    pub open_questions: &'static str,
    /// After an open question: the hosts of its pages that could not be read.
    pub unread_pages: fn(&str) -> String,
    pub sources: &'static str,
    pub none_cited: &'static str,
    pub also_read: &'static str,
    /// A cited source's line: "fetched <date>".
    pub fetched: &'static str,
    pub no_text: &'static str,
    pub unreadable: &'static str,
    pub skipped: &'static str,
    pub low_credibility: &'static str,
}

pub static EN: ReportLabels = ReportLabels {
    researched: |date, n, depth| {
        format!(
            "Researched {date} · {n} source{} · {depth}",
            if n == 1 { "" } else { "s" }
        )
    },
    quick: "Quick",
    standard: "Standard",
    deep: "Deep",
    summary: "Summary",
    findings: "Findings",
    disagreements: "Where sources disagree",
    open_questions: "Open questions",
    unread_pages: |hosts| format!("pages that could not be read: {hosts}"),
    sources: "Sources",
    none_cited: "No source is cited.",
    also_read: "Also read, not cited:",
    fetched: "fetched",
    no_text: "no readable text",
    unreadable: "could not be read",
    skipped: "skipped",
    low_credibility: "low credibility",
};

static DE: ReportLabels = ReportLabels {
    researched: |date, n, depth| {
        format!(
            "Recherchiert am {date} · {n} {} · {depth}",
            if n == 1 { "Quelle" } else { "Quellen" }
        )
    },
    quick: "Schnell",
    standard: "Standard",
    deep: "Gründlich",
    summary: "Zusammenfassung",
    findings: "Ergebnisse",
    disagreements: "Wo Quellen sich widersprechen",
    open_questions: "Offene Fragen",
    unread_pages: |hosts| format!("Seiten, die nicht gelesen werden konnten: {hosts}"),
    sources: "Quellen",
    none_cited: "Keine Quelle zitiert.",
    also_read: "Ebenfalls gelesen, nicht zitiert:",
    fetched: "abgerufen am",
    no_text: "kein lesbarer Text",
    unreadable: "konnte nicht gelesen werden",
    skipped: "übersprungen",
    low_credibility: "wenig glaubwürdig",
};

static ES: ReportLabels = ReportLabels {
    researched: |date, n, depth| {
        format!(
            "Investigado el {date} · {n} {} · {depth}",
            if n == 1 { "fuente" } else { "fuentes" }
        )
    },
    quick: "Rápida",
    standard: "Estándar",
    deep: "A fondo",
    summary: "Resumen",
    findings: "Hallazgos",
    disagreements: "Dónde discrepan las fuentes",
    open_questions: "Preguntas abiertas",
    unread_pages: |hosts| format!("páginas que no se pudieron leer: {hosts}"),
    sources: "Fuentes",
    none_cited: "No se cita ninguna fuente.",
    also_read: "También leídas, sin citar:",
    fetched: "consultada el",
    no_text: "sin texto legible",
    unreadable: "no se pudo leer",
    skipped: "omitida",
    low_credibility: "poco fiable",
};

static FR: ReportLabels = ReportLabels {
    researched: |date, n, depth| {
        format!(
            "Recherche du {date} · {n} {} · {depth}",
            if n == 1 { "source" } else { "sources" }
        )
    },
    quick: "Rapide",
    standard: "Standard",
    deep: "Approfondie",
    summary: "Résumé",
    findings: "Résultats",
    disagreements: "Où les sources divergent",
    open_questions: "Questions ouvertes",
    unread_pages: |hosts| format!("pages illisibles : {hosts}"),
    sources: "Sources",
    none_cited: "Aucune source n’est citée.",
    also_read: "Également lues, non citées :",
    fetched: "consultée le",
    no_text: "aucun texte lisible",
    unreadable: "illisible",
    skipped: "ignorée",
    low_credibility: "peu fiable",
};

static JA: ReportLabels = ReportLabels {
    researched: |date, n, depth| format!("{date} に調査 · 出典 {n} 件 · {depth}"),
    quick: "クイック",
    standard: "標準",
    deep: "詳細",
    summary: "概要",
    findings: "調査結果",
    disagreements: "出典間で食い違う点",
    open_questions: "未解決の問い",
    unread_pages: |hosts| format!("読み込めなかったページ: {hosts}"),
    sources: "出典",
    none_cited: "引用された出典はありません。",
    also_read: "読んだが引用していないページ:",
    fetched: "取得日",
    no_text: "読める本文なし",
    unreadable: "読み込めませんでした",
    skipped: "スキップ",
    low_credibility: "信頼性が低い",
};

static KO: ReportLabels = ReportLabels {
    researched: |date, n, depth| format!("{date} 조사 · 출처 {n}개 · {depth}"),
    quick: "빠르게",
    standard: "표준",
    deep: "심층",
    summary: "요약",
    findings: "조사 결과",
    disagreements: "출처 간 의견이 다른 부분",
    open_questions: "남은 질문",
    unread_pages: |hosts| format!("읽지 못한 페이지: {hosts}"),
    sources: "출처",
    none_cited: "인용된 출처가 없습니다.",
    also_read: "읽었지만 인용하지 않은 페이지:",
    fetched: "가져온 날짜",
    no_text: "읽을 수 있는 텍스트 없음",
    unreadable: "읽지 못함",
    skipped: "건너뜀",
    low_credibility: "신뢰도 낮음",
};

static PT_BR: ReportLabels = ReportLabels {
    researched: |date, n, depth| {
        format!(
            "Pesquisado em {date} · {n} {} · {depth}",
            if n == 1 { "fonte" } else { "fontes" }
        )
    },
    quick: "Rápida",
    standard: "Padrão",
    deep: "Aprofundada",
    summary: "Resumo",
    findings: "Resultados",
    disagreements: "Onde as fontes divergem",
    open_questions: "Perguntas em aberto",
    unread_pages: |hosts| format!("páginas que não puderam ser lidas: {hosts}"),
    sources: "Fontes",
    none_cited: "Nenhuma fonte é citada.",
    also_read: "Também lidas, não citadas:",
    fetched: "acessada em",
    no_text: "sem texto legível",
    unreadable: "não pôde ser lida",
    skipped: "ignorada",
    low_credibility: "pouco confiável",
};

static ZH_CN: ReportLabels = ReportLabels {
    researched: |date, n, depth| format!("调研于 {date} · {n} 个来源 · {depth}"),
    quick: "快速",
    standard: "标准",
    deep: "深入",
    summary: "摘要",
    findings: "发现",
    disagreements: "来源之间的分歧",
    open_questions: "待解答的问题",
    unread_pages: |hosts| format!("无法读取的页面：{hosts}"),
    sources: "来源",
    none_cited: "未引用任何来源。",
    also_read: "已阅读但未引用：",
    fetched: "获取于",
    no_text: "没有可读文本",
    unreadable: "无法读取",
    skipped: "已跳过",
    low_credibility: "可信度低",
};

/// The labels for a UI locale code (`de`, `pt-BR`…); English for anything else.
pub fn for_locale(code: &str) -> &'static ReportLabels {
    match code {
        "de" => &DE,
        "es" => &ES,
        "fr" => &FR,
        "ja" => &JA,
        "ko" => &KO,
        "pt-BR" => &PT_BR,
        "zh-CN" => &ZH_CN,
        _ => &EN,
    }
}

/// The labels for the language setting. `System` has no locale on this side
/// (the webview resolves it), so it is English unless the caller knows better.
pub fn for_setting(setting: LanguageSetting) -> &'static ReportLabels {
    match setting {
        LanguageSetting::De => &DE,
        LanguageSetting::Es => &ES,
        LanguageSetting::Fr => &FR,
        LanguageSetting::Ja => &JA,
        LanguageSetting::Ko => &KO,
        LanguageSetting::PtBr => &PT_BR,
        LanguageSetting::ZhCn => &ZH_CN,
        LanguageSetting::En | LanguageSetting::System => &EN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_locale_has_its_own_headings() {
        for code in ["de", "es", "fr", "ja", "ko", "pt-BR", "zh-CN"] {
            assert_ne!(for_locale(code).summary, EN.summary, "{code}");
        }
        assert_eq!(for_locale("xx").summary, "Summary");
        assert_eq!(
            (EN.researched)("2026-10-01", 1, EN.quick),
            "Researched 2026-10-01 · 1 source · Quick"
        );
        assert_eq!(
            (DE.researched)("2026-10-01", 3, DE.deep),
            "Recherchiert am 2026-10-01 · 3 Quellen · Gründlich"
        );
    }
}
