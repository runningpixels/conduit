//! Spreadsheets in chat. The model writes a workbook spec through typed tools
//! (`agent_tools`), the spec is stored as an artifact of kind `spreadsheet`,
//! and everything here is pure: parse and validate (`spec`), calculate with
//! IronCalc (`compute`), write .xlsx (`xlsx`), change a spec (`ops`).

pub mod chart_xlsx;
pub mod charts;
pub mod compute;
pub mod ops;
pub mod spec;
pub mod xlsx;

use serde::Serialize;

use compute::{CellError, CellKind, ComputedWorkbook};
use spec::CellStyle;

/// The artifact kind and the MIME type its JSON content is stored with.
pub const ARTIFACT_KIND: &str = "spreadsheet";
pub const ARTIFACT_MIME: &str = "application/json";

/// The workbook an artifact holds, or why it isn't one.
pub fn workbook_of(
    artifact: &crate::db::repository::artifacts::Artifact,
) -> Result<spec::Workbook, String> {
    if artifact.kind != ARTIFACT_KIND {
        return Err(format!(
            "artifact '{}' is '{}', not a spreadsheet",
            artifact.id, artifact.kind
        ));
    }
    let json = artifact
        .content_json
        .as_ref()
        .ok_or_else(|| "This spreadsheet has no content yet.".to_string())?;
    spec::Workbook::from_value(json)
}

/// Most rows of a sheet sent to the panel.
pub const VIEW_MAX_ROWS: usize = 5_000;
/// Most errors reported at once.
pub const MAX_REPORTED_ERRORS: usize = 20;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetCellView {
    pub display: String,
    pub kind: CellKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<CellStyle>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetSheetView {
    pub name: String,
    pub freeze_header: bool,
    pub column_widths: Vec<f64>,
    pub row_count: usize,
    pub col_count: usize,
    pub rows: Vec<Vec<Option<SpreadsheetCellView>>>,
    pub truncated_rows: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub charts: Vec<SpreadsheetChartView>,
}

/// A chart ready to draw: labels and numbers, a gap as `null`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetChartView {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub title: String,
    pub categories: Vec<String>,
    pub series: Vec<SpreadsheetSeriesView>,
    pub anchor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetSeriesView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub values: Vec<Option<f64>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetView {
    pub title: Option<String>,
    pub sheets: Vec<SpreadsheetSheetView>,
    pub errors: Vec<CellError>,
}

impl Serialize for CellStyle {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// The panel's view of a computed workbook: hidden sheets left out, rows
/// capped, the first errors listed.
pub fn build_view(title: Option<String>, computed: &ComputedWorkbook) -> SpreadsheetView {
    let sheets = computed
        .sheets
        .iter()
        .filter(|sheet| !sheet.hidden)
        .map(|sheet| {
            let rows: Vec<Vec<Option<SpreadsheetCellView>>> = sheet
                .rows
                .iter()
                .take(VIEW_MAX_ROWS)
                .map(|row| {
                    row.iter()
                        .map(|cell| {
                            cell.as_ref().map(|c| SpreadsheetCellView {
                                display: c.display.clone(),
                                kind: c.kind,
                                formula: c.formula.clone(),
                                style: c.style,
                            })
                        })
                        .collect()
                })
                .collect();
            SpreadsheetSheetView {
                name: sheet.name.clone(),
                freeze_header: sheet.freeze_header,
                column_widths: sheet.column_widths.clone(),
                row_count: sheet.row_count,
                col_count: sheet.col_count,
                truncated_rows: sheet.row_count - rows.len(),
                charts: sheet
                    .charts
                    .iter()
                    .map(|c| SpreadsheetChartView {
                        id: c.id.clone(),
                        kind: c.kind.as_str(),
                        title: c.title.clone(),
                        categories: c.categories.clone(),
                        series: c
                            .series
                            .iter()
                            .map(|s| SpreadsheetSeriesView {
                                name: s.name.clone(),
                                values: s.values.clone(),
                            })
                            .collect(),
                        anchor: c.anchor.clone(),
                        error: c.error.clone(),
                    })
                    .collect(),
                rows,
            }
        })
        .collect();
    let mut errors = computed.all_errors();
    errors.truncate(MAX_REPORTED_ERRORS);
    SpreadsheetView {
        title,
        sheets,
        errors,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_view_serialises_as_the_panel_contract() {
        let wb = spec::Workbook::from_value(&json!({ "sheets": [
            { "name": "A", "freeze_header": true, "columns": [{"width": 12}],
              "rows": [[{"value": "H", "style": "header"}, null, 1],
                       [{"formula": "=C1/0", "format": "currency"}]] },
            { "name": "Secret", "hidden": true, "rows": [[1]] }
        ]}))
        .unwrap();
        let view = build_view(Some("T".into()), &compute::compute(&wb).unwrap());
        let v = serde_json::to_value(&view).unwrap();
        assert_eq!(v["title"], "T");
        assert_eq!(v["sheets"].as_array().unwrap().len(), 1);
        let sheet = &v["sheets"][0];
        assert_eq!(sheet["freezeHeader"], true);
        assert_eq!(sheet["columnWidths"], json!([12.0, 10.0, 10.0]));
        assert_eq!(sheet["rowCount"], 2);
        assert_eq!(sheet["colCount"], 3);
        assert_eq!(sheet["truncatedRows"], 0);
        assert_eq!(
            sheet["rows"][0][0],
            json!({"display": "H", "kind": "text", "style": "header"})
        );
        assert!(sheet["rows"][0][1].is_null());
        assert_eq!(sheet["rows"][0][2]["kind"], "number");
        assert_eq!(sheet["rows"][1][0]["kind"], "error");
        assert_eq!(sheet["rows"][1][0]["display"], "#DIV/0!");
        assert_eq!(sheet["rows"][1][0]["formula"], "=C1/0");
        assert!(sheet["rows"][1][1].is_null());
        assert_eq!(
            v["errors"],
            json!([{"sheet": "A", "cell": "A2", "formula": "=C1/0", "error": "#DIV/0!"}])
        );
    }

    #[test]
    fn charts_reach_the_view_with_values_and_errors() {
        let wb = spec::Workbook::from_value(&json!({ "sheets": [{ "name": "A",
            "rows": [["x", 1], ["y", {"formula": "=B1*3"}], ["z", "t"]],
            "charts": [
              {"id": "c1", "type": "bar", "title": "T", "categories": "A1:A3",
               "series": [{"name": "N", "values": "B1:B3"}], "anchor": "D1"},
              {"id": "c2", "type": "pie", "title": "", "categories": "#REF!",
               "series": [{"values": "B1:B3"}], "anchor": "D20"}
            ]}] }))
        .unwrap();
        let view = build_view(None, &compute::compute(&wb).unwrap());
        let v = serde_json::to_value(&view).unwrap();
        let charts = &v["sheets"][0]["charts"];
        assert_eq!(
            charts[0],
            json!({"id": "c1", "type": "bar", "title": "T", "categories": ["x", "y", "z"],
                   "series": [{"name": "N", "values": [1.0, 3.0, null]}], "anchor": "D1"})
        );
        assert_eq!(charts[1]["type"], "pie");
        assert!(charts[1]["error"].as_str().unwrap().contains("add_chart"));
        assert_eq!(charts[1]["categories"], json!([]));
        // A sheet without charts sends no key at all.
        let plain =
            spec::Workbook::from_value(&json!({ "sheets": [{ "name": "A", "rows": [[1]] }] }))
                .unwrap();
        let v = serde_json::to_value(build_view(None, &compute::compute(&plain).unwrap())).unwrap();
        assert!(v["sheets"][0].get("charts").is_none());
    }

    #[test]
    fn a_sheet_within_the_row_limit_is_sent_whole() {
        // The workbook limit (5,000 rows) equals the view cap, so the cap is
        // a backstop for specs stored by a future, looser version.
        let rows: Vec<serde_json::Value> = (0..4_999).map(|i| json!([i])).collect();
        let wb = spec::Workbook::from_value(&json!({ "sheets": [{ "name": "A", "rows": rows }] }))
            .unwrap();
        let view = build_view(None, &compute::compute(&wb).unwrap());
        assert_eq!(view.sheets[0].truncated_rows, 0);
        assert!(view.title.is_none());
    }
}
