//! Charts on a sheet: the spec types, parsing and validation, and how a chart
//! follows its data when rows are inserted or deleted.
//!
//! A chart reads one category range and one to six value ranges, all on the
//! sheet that holds it, and is drawn in the panel and written to the .xlsx as
//! a native Excel chart. Pure, like the rest of `sheets`.
//!
//! A stored chart always satisfies `Chart::check`: every range is either a
//! single column or row of 1 to 50 cells or the text `#REF!` (its rows were
//! deleted), and when every range is real they are all the same length. An
//! edit that breaks that marks the chart `#REF!` instead of being refused;
//! the computed view then reports the chart's error.

use serde_json::{Map, Value};

use super::{
    ops::widen_ranges,
    spec::{self, Sheet, Workbook},
};

pub const MAX_POINTS: usize = 50;
pub const MAX_SERIES: usize = 6;
pub const MAX_CHARTS_PER_SHEET: usize = 10;
pub const MAX_ID_CHARS: usize = 40;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_SERIES_NAME_CHARS: usize = 100;
/// What a range becomes when its rows are gone.
pub const REF_ERROR: &str = "#REF!";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartKind {
    Bar,
    Line,
    Pie,
}

impl ChartKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChartKind::Bar => "bar",
            ChartKind::Line => "line",
            ChartKind::Pie => "pie",
        }
    }

    pub fn parse(s: &str) -> Option<ChartKind> {
        match s.trim().to_lowercase().as_str() {
            "bar" | "column" => Some(ChartKind::Bar),
            "line" => Some(ChartKind::Line),
            "pie" => Some(ChartKind::Pie),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChartSeries {
    pub name: Option<String>,
    /// `B2:B7`, or `#REF!`.
    pub values: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Chart {
    pub id: String,
    pub kind: ChartKind,
    pub title: String,
    /// `A2:A7`, or `#REF!`.
    pub categories: String,
    pub series: Vec<ChartSeries>,
    /// The cell the chart's top-left corner sits on in Excel, such as `E2`.
    pub anchor: String,
}

/// A column or row of cells, 0-based and inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub row0: usize,
    pub col0: usize,
    pub row1: usize,
    pub col1: usize,
}

impl Range {
    pub fn len(&self) -> usize {
        (self.row1 - self.row0 + 1) * (self.col1 - self.col0 + 1)
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    /// The cells in order, top to bottom or left to right, as (row0, col0).
    pub fn cells(&self) -> Vec<(usize, usize)> {
        let mut out = Vec::with_capacity(self.len());
        for r in self.row0..=self.row1 {
            for c in self.col0..=self.col1 {
                out.push((r, c));
            }
        }
        out
    }

    /// `A2:A7`, or `A2` for one cell.
    pub fn to_a1(&self) -> String {
        let from = spec::a1(self.row0, self.col0);
        if self.len() == 1 {
            from
        } else {
            format!("{from}:{}", spec::a1(self.row1, self.col1))
        }
    }
}

/// Read `A2:A7` (any case, `$` allowed) or a single cell. `what` names the
/// range in an error, such as "categories".
pub fn parse_range(text: &str, what: &str) -> Result<Range, String> {
    let text = text.trim();
    if text.contains('!') && !text.starts_with('#') {
        return Err(format!(
            "{what} '{text}': ranges are on the chart's own sheet; leave the sheet name out (for example A2:A7)"
        ));
    }
    let bad = || format!("{what} '{text}' isn't a range like A2:A7");
    let (a, b) = text.split_once(':').unwrap_or((text, text));
    let (r0, c0) = spec::parse_a1(a).ok_or_else(bad)?;
    let (r1, c1) = spec::parse_a1(b).ok_or_else(bad)?;
    let range = Range {
        row0: r0.min(r1),
        col0: c0.min(c1),
        row1: r0.max(r1),
        col1: c0.max(c1),
    };
    if range.row0 != range.row1 && range.col0 != range.col1 {
        return Err(format!(
            "{what} '{text}' must be one column or one row of cells, not a block"
        ));
    }
    if range.len() > MAX_POINTS {
        return Err(format!(
            "{what} '{text}' has {} cells; a chart takes 1 to {MAX_POINTS} points",
            range.len()
        ));
    }
    Ok(range)
}

/// A stored range: real, or `#REF!`.
pub fn stored_range(text: &str) -> Option<Range> {
    if text == REF_ERROR {
        None
    } else {
        parse_range(text, "range").ok()
    }
}

fn what_of(id: &str) -> String {
    if id.is_empty() {
        "Chart".to_string()
    } else {
        format!("Chart '{id}'")
    }
}

fn read_range_field(value: &Value, what: &str, allow_ref: bool) -> Result<String, String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("{what} must be a range such as A2:A7"))?
        .trim();
    if allow_ref && text == REF_ERROR {
        return Ok(REF_ERROR.to_string());
    }
    Ok(parse_range(text, what)?.to_a1())
}

fn check_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.chars().count() <= MAX_ID_CHARS
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "chart id '{id}' must be 1 to {MAX_ID_CHARS} letters, digits, - or _"
        ))
    }
}

/// `E2` normalised, or an error.
pub fn check_anchor(anchor: &str) -> Result<String, String> {
    let (row0, col0) = spec::parse_a1(anchor).ok_or_else(|| {
        format!("anchor '{anchor}' isn't a cell reference; use something like E2")
    })?;
    if row0 >= spec::MAX_ROWS || col0 >= spec::MAX_COLS {
        return Err(format!(
            "anchor '{anchor}' is past the limits of {} rows and {} columns",
            spec::MAX_ROWS,
            spec::MAX_COLS
        ));
    }
    Ok(spec::a1(row0, col0))
}

/// Where a new chart goes when the model gives no anchor: one empty column
/// right of the data, below any chart already there.
pub fn default_anchor(sheet: &Sheet) -> String {
    let col0 = (sheet.used_cols() + 1).min(spec::MAX_COLS - 1);
    let row0 = (sheet.charts.len() * 16).min(spec::MAX_ROWS - 1);
    spec::a1(row0, col0)
}

impl Chart {
    /// Read one chart. `allow_ref` lets a range be `#REF!`, as in a stored
    /// workbook; a model's `add_chart` never may. `default_anchor` is used
    /// when the chart names none.
    pub fn from_value(
        value: &Value,
        allow_ref: bool,
        default_anchor: &dyn Fn() -> String,
    ) -> Result<Chart, String> {
        let obj = value
            .as_object()
            .ok_or("a chart must be an object with type, title, categories and series")?;
        for key in obj.keys() {
            if !matches!(
                key.as_str(),
                "id" | "type" | "title" | "categories" | "series" | "anchor"
            ) {
                return Err(format!(
                    "unknown chart field '{key}' (a chart has id, type, title, categories, series and anchor)"
                ));
            }
        }
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        check_id(&id)?;
        let what = what_of(&id);
        let kind_text = obj.get("type").and_then(Value::as_str).unwrap_or_default();
        let kind = ChartKind::parse(kind_text)
            .ok_or_else(|| format!("{what}: type must be bar, line or pie"))?;
        let title = match obj.get("title") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(t)) => t.trim().to_string(),
            Some(_) => return Err(format!("{what}: title must be text")),
        };
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err(format!(
                "{what}: title is longer than {MAX_TITLE_CHARS} characters"
            ));
        }
        let categories = read_range_field(
            obj.get("categories").ok_or_else(|| {
                format!("{what}: categories is missing; give the labels' range such as A2:A7")
            })?,
            &format!("{what} categories"),
            allow_ref,
        )?;
        let items = obj.get("series").and_then(Value::as_array).ok_or_else(|| {
            format!("{what}: series must be a list like [{{\"values\": \"B2:B7\"}}]")
        })?;
        let mut series = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            let at = format!("{what} series {}", i + 1);
            let o = item.as_object().ok_or_else(|| {
                format!(
                    "{at}: expected an object like {{\"name\": \"Sales\", \"values\": \"B2:B7\"}}"
                )
            })?;
            for key in o.keys() {
                if !matches!(key.as_str(), "name" | "values") {
                    return Err(format!(
                        "{at}: unknown field '{key}' (a series has name and values)"
                    ));
                }
            }
            let name = match o.get("name") {
                None | Some(Value::Null) => None,
                Some(Value::String(n)) if n.trim().is_empty() => None,
                Some(Value::String(n)) => Some(n.trim().to_string()),
                Some(_) => return Err(format!("{at}: name must be text")),
            };
            if name
                .as_deref()
                .is_some_and(|n| n.chars().count() > MAX_SERIES_NAME_CHARS)
            {
                return Err(format!(
                    "{at}: name is longer than {MAX_SERIES_NAME_CHARS} characters"
                ));
            }
            let values = read_range_field(
                o.get("values").ok_or_else(|| {
                    format!("{at}: values is missing; give the numbers' range such as B2:B7")
                })?,
                &format!("{at} values"),
                allow_ref,
            )?;
            series.push(ChartSeries { name, values });
        }
        let anchor = match obj.get("anchor") {
            None | Some(Value::Null) => default_anchor(),
            Some(Value::String(a)) if a.trim().is_empty() => default_anchor(),
            Some(Value::String(a)) => check_anchor(a.trim())?,
            Some(_) => return Err(format!("{what}: anchor must be a cell such as E2")),
        };
        let chart = Chart {
            id,
            kind,
            title,
            categories,
            series,
            anchor,
        };
        chart.check()?;
        Ok(chart)
    }

    /// The invariants every stored chart keeps (see the module docs).
    pub fn check(&self) -> Result<(), String> {
        let what = what_of(&self.id);
        if self.series.is_empty() {
            return Err(format!("{what}: add at least one series"));
        }
        if self.series.len() > MAX_SERIES {
            return Err(format!(
                "{what} has {} series; the limit is {MAX_SERIES}",
                self.series.len()
            ));
        }
        if self.kind == ChartKind::Pie && self.series.len() != 1 {
            return Err(format!(
                "{what}: a pie chart takes exactly one series; use a bar or line chart to compare several"
            ));
        }
        let mut lens = Vec::new();
        if let Some(r) = stored_range(&self.categories) {
            lens.push(("categories".to_string(), r.len()));
        }
        for (i, s) in self.series.iter().enumerate() {
            if let Some(r) = stored_range(&s.values) {
                lens.push((format!("series {} values", i + 1), r.len()));
            }
        }
        if let Some((first_name, first)) = lens.first() {
            if let Some((name, len)) = lens.iter().find(|(_, len)| len != first) {
                return Err(format!(
                    "{what}: {name} has {len} cells but {first_name} has {first}; every range needs the same number of cells"
                ));
            }
        }
        Ok(())
    }

    pub fn to_value(&self) -> Value {
        let series: Vec<Value> = self
            .series
            .iter()
            .map(|s| {
                let mut o = Map::new();
                if let Some(name) = &s.name {
                    o.insert("name".into(), Value::String(name.clone()));
                }
                o.insert("values".into(), Value::String(s.values.clone()));
                Value::Object(o)
            })
            .collect();
        serde_json::json!({
            "id": self.id,
            "type": self.kind.as_str(),
            "title": self.title,
            "categories": self.categories,
            "series": series,
            "anchor": self.anchor,
        })
    }

    /// Why the chart can't be drawn, or `None` when its ranges are real.
    pub fn error(&self) -> Option<String> {
        let gone =
            self.categories == REF_ERROR || self.series.iter().any(|s| s.values == REF_ERROR);
        gone.then(|| {
            format!(
                "Rows this chart used were deleted or no longer line up. Recreate it with add_chart using id '{}'.",
                self.id
            )
        })
    }

    fn map_ranges(&mut self, f: &dyn Fn(&str) -> String) {
        self.categories = f(&self.categories);
        for s in &mut self.series {
            s.values = f(&s.values);
        }
        // Ranges that moved apart in length can't be one chart any more.
        if self.check().is_err() {
            self.categories = REF_ERROR.to_string();
        }
    }

    /// Rows were inserted before row `at` (1-based), `count` of them.
    pub fn rows_inserted(&mut self, at: usize, count: usize) {
        self.map_ranges(&|text| shift_text(text, |r| insert_range(text, r, at, count)));
        self.anchor = shift_anchor(&self.anchor, |row0| {
            if row0 + 1 >= at {
                row0 + count
            } else {
                row0
            }
        });
    }

    /// `count` rows were deleted starting at row `from` (1-based).
    pub fn rows_deleted(&mut self, from: usize, count: usize) {
        let (d0, d1) = (from - 1, from - 1 + count);
        self.map_ranges(&|text| shift_text(text, |r| delete_range(r, d0, count)));
        self.anchor = shift_anchor(&self.anchor, |row0| {
            if row0 >= d1 {
                row0 - count
            } else if row0 >= d0 {
                d0
            } else {
                row0
            }
        });
    }
}

fn shift_text(text: &str, f: impl Fn(Range) -> Option<String>) -> String {
    match stored_range(text) {
        Some(range) => f(range).unwrap_or_else(|| REF_ERROR.to_string()),
        None => REF_ERROR.to_string(),
    }
}

fn shift_anchor(anchor: &str, f: impl Fn(usize) -> usize) -> String {
    match spec::parse_a1(anchor) {
        Some((row0, col0)) => spec::a1(f(row0).min(spec::MAX_ROWS - 1), col0),
        None => anchor.to_string(),
    }
}

/// A range after `count` rows go in before row `at`. A range that ends on the
/// row just above (a total sits below it) is stretched over the new rows, as
/// formulas are in `ops::insert_rows`; otherwise this is the plain move:
/// rows at or below `at` shift, and a range that spans `at` grows.
fn insert_range(text: &str, r: Range, at: usize, count: usize) -> Option<String> {
    if at >= 2 {
        let widened = widen_ranges(text, at - 1, count);
        if widened != text {
            return parse_range(&widened, "range").ok().map(|r| r.to_a1());
        }
    }
    let a = at - 1;
    let mut r = r;
    if r.row0 >= a {
        r.row0 += count;
        r.row1 += count;
    } else if r.row1 >= a {
        r.row1 += count;
    }
    Some(r.to_a1())
}

/// A range after rows `d0..d0 + count` (0-based) are deleted: the rows that
/// are left close up, and a range with none left is gone.
fn delete_range(r: Range, d0: usize, count: usize) -> Option<String> {
    let d1 = d0 + count;
    let mut r = r;
    if r.row1 < d0 {
        // Above the deleted rows.
    } else if r.row0 >= d1 {
        r.row0 -= count;
        r.row1 -= count;
    } else if r.row0 >= d0 && r.row1 < d1 {
        return None;
    } else {
        if r.row0 >= d0 {
            r.row0 = d0;
        }
        r.row1 = if r.row1 >= d1 { r.row1 - count } else { d0 - 1 };
    }
    Some(r.to_a1())
}

// ---------------------------------------------------------------------------
// Workbook-level rules
// ---------------------------------------------------------------------------

/// Chart rules that need the whole workbook: ids unique across sheets, a
/// bounded number per sheet, and each chart keeping its invariants.
pub fn validate(workbook: &Workbook) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for sheet in &workbook.sheets {
        if sheet.charts.len() > MAX_CHARTS_PER_SHEET {
            return Err(format!(
                "Sheet '{}' has {} charts; the limit is {MAX_CHARTS_PER_SHEET}",
                sheet.name,
                sheet.charts.len()
            ));
        }
        for chart in &sheet.charts {
            check_id(&chart.id)?;
            if !seen.insert(chart.id.to_lowercase()) {
                return Err(format!(
                    "chart id '{}' is used twice; ids are unique in a spreadsheet",
                    chart.id
                ));
            }
            chart.check()?;
        }
    }
    Ok(())
}

/// The first `chartN` not used by any chart in the workbook.
pub fn next_id(workbook: &Workbook) -> String {
    let used: std::collections::HashSet<String> = workbook
        .sheets
        .iter()
        .flat_map(|s| s.charts.iter().map(|c| c.id.to_lowercase()))
        .collect();
    (1..)
        .map(|n| format!("chart{n}"))
        .find(|id| !used.contains(id))
        .unwrap_or_else(|| "chart".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chart(categories: &str, values: &str) -> Chart {
        Chart::from_value(
            &json!({"id": "c1", "type": "bar", "title": "T", "categories": categories,
                    "series": [{"values": values}], "anchor": "E2"}),
            false,
            &|| "Z1".to_string(),
        )
        .unwrap()
    }

    #[test]
    fn ranges_parse_and_normalise() {
        let r = parse_range(" $b$7:$b$2 ", "values").unwrap();
        assert_eq!(r.to_a1(), "B2:B7");
        assert_eq!(r.len(), 6);
        assert_eq!(parse_range("c3", "values").unwrap().to_a1(), "C3");
        assert_eq!(parse_range("A1:E1", "values").unwrap().len(), 5);
        let e = parse_range("A1:B3", "categories").unwrap_err();
        assert!(e.contains("one column or one row"), "{e}");
        let e = parse_range("Sheet1!A1:A3", "categories").unwrap_err();
        assert!(e.contains("leave the sheet name out"), "{e}");
        let e = parse_range("A1:A60", "values").unwrap_err();
        assert!(e.contains("1 to 50"), "{e}");
        assert!(parse_range("nonsense", "values")
            .unwrap_err()
            .contains("isn't a range"));
    }

    #[test]
    fn a_chart_round_trips_and_the_checks_apply() {
        let c = chart("a2:a7", "b2:b7");
        assert_eq!(c.categories, "A2:A7");
        let again = Chart::from_value(&c.to_value(), true, &|| "Z1".into()).unwrap();
        assert_eq!(again, c);

        let bad = |v: Value| Chart::from_value(&v, false, &|| "E2".into()).unwrap_err();
        let base = |extra: Value| {
            let mut v = json!({"id": "c1", "type": "bar", "title": "T", "categories": "A2:A4",
                               "series": [{"values": "B2:B4"}]});
            for (k, x) in extra.as_object().unwrap() {
                v[k] = x.clone();
            }
            v
        };
        assert!(bad(base(json!({"type": "donut"}))).contains("bar, line or pie"));
        assert!(
            bad(base(json!({"series": [{"values": "B2:B5"}]}))).contains("same number of cells")
        );
        assert!(bad(base(json!({"series": []}))).contains("at least one series"));
        let seven: Vec<Value> = (0..7).map(|_| json!({"values": "B2:B4"})).collect();
        assert!(bad(base(json!({"series": seven}))).contains("limit is 6"));
        assert!(bad(base(
            json!({"type": "pie", "series": [{"values": "B2:B4"}, {"values": "C2:C4"}]})
        ))
        .contains("exactly one series"));
        assert!(bad(base(json!({"categories": "#REF!"}))).contains("isn't a range"));
        assert!(bad(base(json!({"anchor": "??"}))).contains("anchor"));
        assert!(bad(base(json!({"id": "bad id"}))).contains("chart id"));
        // The anchor falls back to the default.
        let c = Chart::from_value(&base(json!({})), false, &|| "H1".into()).unwrap();
        assert_eq!(c.anchor, "H1");
    }

    #[test]
    fn inserting_rows_moves_widens_and_marks() {
        // Rows added inside the data grow the range.
        let mut c = chart("A2:A7", "B2:B7");
        c.rows_inserted(4, 2);
        assert_eq!(
            (c.categories.as_str(), c.series[0].values.as_str()),
            ("A2:A9", "B2:B9")
        );
        // Added just below the data (a total sits there): the range takes them in.
        let mut c = chart("A2:A7", "B2:B7");
        c.rows_inserted(8, 1);
        assert_eq!(c.series[0].values, "B2:B8");
        // Above the data: everything moves down.
        let mut c = chart("A2:A7", "B2:B7");
        c.rows_inserted(2, 3);
        assert_eq!(c.series[0].values, "B5:B10");
        assert_eq!(c.anchor, "E5");
        // Well below the data: nothing changes.
        let mut c = chart("A2:A7", "B2:B7");
        c.rows_inserted(20, 3);
        assert_eq!(c.series[0].values, "B2:B7");
        assert_eq!(c.anchor, "E2");
        // Ranges that drift apart in length mark the chart.
        let mut c = chart("A2:A5", "B3:B6");
        c.rows_inserted(3, 1);
        assert!(c.error().is_some());
    }

    #[test]
    fn deleting_rows_shrinks_closes_up_and_marks() {
        let mut c = chart("A2:A7", "B2:B7");
        c.rows_deleted(4, 2);
        assert_eq!(c.categories, "A2:A5");
        assert!(c.error().is_none());
        let mut c = chart("A5:A8", "B5:B8");
        c.rows_deleted(2, 2);
        assert_eq!(c.series[0].values, "B3:B6");
        // The tail of the range goes.
        let mut c = chart("A2:A7", "B2:B7");
        c.rows_deleted(6, 5);
        assert_eq!(c.series[0].values, "B2:B5");
        // The head goes.
        let mut c = chart("A2:A7", "B2:B7");
        c.rows_deleted(1, 3);
        assert_eq!(c.series[0].values, "B1:B4");
        // All of it goes: a reported error, and the chart still validates.
        let mut c = chart("A2:A4", "B2:B4");
        c.rows_deleted(2, 3);
        assert_eq!(c.categories, REF_ERROR);
        assert!(c.error().unwrap().contains("add_chart"));
        assert!(c.check().is_ok());
        c.rows_inserted(2, 1);
        assert_eq!(c.categories, REF_ERROR);
    }
}
