//! Build an IronCalc model from a workbook spec and evaluate it.
//!
//! Pure: no database, no app state. `compute` returns every cell's display
//! text (formatted by its number format, as Excel would show it), its kind, and
//! the error code of a formula that did not calculate.

use ironcalc::base::{
    cell::CellValue,
    number_format,
    types::{BorderItem, BorderStyle, CellType, Color, SheetState},
    Model,
};
use serde::Serialize;
use serde_json::Value;

use super::spec::{self, a1, Cell, CellStyle, Scalar, Sheet, Workbook};

/// Pixels per character of column width, plus the padding Excel adds.
const PX_PER_CHAR: f64 = 7.0;
const PX_PADDING: f64 = 5.0;
/// Shown when a column sets no width, in characters.
pub const DEFAULT_COLUMN_CHARS: f64 = 10.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CellKind {
    Number,
    Text,
    Bool,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ComputedCell {
    pub display: String,
    pub kind: CellKind,
    /// The cell's value: a number, text, bool, or the error code.
    pub value: Value,
    pub formula: Option<String>,
    /// `#DIV/0!`, `#NAME?`, `#REF!` ... when a formula did not calculate.
    pub error: Option<String>,
    pub style: Option<CellStyle>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComputedSheet {
    pub name: String,
    pub hidden: bool,
    pub freeze_header: bool,
    /// In characters, one per used column.
    pub column_widths: Vec<f64>,
    pub row_count: usize,
    pub col_count: usize,
    /// `row_count` rows of `col_count` cells; `None` is an empty cell.
    pub rows: Vec<Vec<Option<ComputedCell>>>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ComputedWorkbook {
    pub sheets: Vec<ComputedSheet>,
}

/// A formula cell that did not calculate.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CellError {
    pub sheet: String,
    pub cell: String,
    pub formula: String,
    pub error: String,
}

impl ComputedWorkbook {
    pub fn sheet(&self, name: &str) -> Option<&ComputedSheet> {
        self.sheets.iter().find(|s| s.name == name)
    }

    /// Every formula cell that errored, in sheet then row order.
    pub fn all_errors(&self) -> Vec<CellError> {
        let mut out = Vec::new();
        for sheet in &self.sheets {
            for (r, row) in sheet.rows.iter().enumerate() {
                for (c, cell) in row.iter().enumerate() {
                    if let Some(cell) = cell {
                        if let Some(error) = &cell.error {
                            out.push(CellError {
                                sheet: sheet.name.clone(),
                                cell: a1(r, c),
                                formula: cell.formula.clone().unwrap_or_default(),
                                error: error.clone(),
                            });
                        }
                    }
                }
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/// Excel's serial number for a `YYYY-MM-DD` string (1900 date system), or
/// `None` when it isn't a real date from 1900-03-01 on.
pub fn date_serial(text: &str) -> Option<f64> {
    let text = text.trim();
    let mut parts = text.split('-');
    let (y, m, d) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return None;
    }
    let (y, m, d): (i64, i64, i64) = (y.parse().ok()?, m.parse().ok()?, d.parse().ok()?);
    if !(1..=12).contains(&m) || d < 1 {
        return None;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days_in_month = match m {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if d > days_in_month {
        return None;
    }
    // Days from the civil calendar (Howard Hinnant's algorithm), relative to
    // 1899-12-30, which is Excel's day 0 from 1900-03-01 on.
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let serial = days - (-25_569);
    (serial >= 61).then_some(serial as f64)
}

// ---------------------------------------------------------------------------
// Building the model
// ---------------------------------------------------------------------------

fn rgb(hex: &str) -> Color {
    Color::Rgb(hex.to_string())
}

/// Map a spec style and number format onto an IronCalc cell style.
fn apply_style(base: &mut ironcalc::base::types::Style, style: Option<CellStyle>) {
    match style {
        Some(CellStyle::Header) => {
            base.font.b = true;
            base.font.color = rgb("#FFFFFF");
            base.fill.color = rgb("#1F3864");
        }
        Some(CellStyle::Input) => base.font.color = rgb("#1F4E9A"),
        Some(CellStyle::Total) => {
            base.font.b = true;
            base.border.top = Some(BorderItem {
                style: BorderStyle::Thin,
                color: rgb("#000000"),
            });
        }
        Some(CellStyle::Note) => {
            base.font.i = true;
            base.font.color = rgb("#808080");
        }
        Some(CellStyle::Good) => base.font.color = rgb("#1E7B34"),
        Some(CellStyle::Bad) => base.font.color = rgb("#C00000"),
        None => {}
    }
}

fn set_cell(
    model: &mut Model<'static>,
    sheet: &Sheet,
    si: u32,
    row0: usize,
    col0: usize,
    cell: &Cell,
) -> Result<(), String> {
    let (r, c) = (row0 as i32 + 1, col0 as i32 + 1);
    let mut format = sheet.effective_format(row0, col0);
    // A YYYY-MM-DD string with no format is a date, as when typed into Excel.
    if let (None, None, Some(Scalar::Text(t))) = (format, &cell.formula, &cell.value) {
        if date_serial(t).is_some() {
            format = Some("date");
        }
    }
    if let Some(formula) = &cell.formula {
        // A formula that won't even parse is left empty here; evaluation
        // reports the rest.
        model.update_cell_with_formula(si, r, c, formula.clone())?;
    } else {
        match &cell.value {
            Some(Scalar::Number(n)) => model.update_cell_with_number(si, r, c, *n)?,
            Some(Scalar::Bool(b)) => model.update_cell_with_bool(si, r, c, *b)?,
            Some(Scalar::Text(t)) => {
                // A YYYY-MM-DD string in a date-formatted (or unformatted) cell is a date.
                match (format, date_serial(t)) {
                    (Some("date"), Some(serial)) => {
                        model.update_cell_with_number(si, r, c, serial)?
                    }
                    _ => model.update_cell_with_text(si, r, c, t)?,
                }
            }
            None => {}
        }
    }
    if cell.style.is_some() || format.is_some() {
        let mut style = model.get_style_for_cell(si, r, c)?;
        if let Some(f) = format {
            style.num_fmt = spec::excel_format(f);
        }
        apply_style(&mut style, cell.style);
        model.set_cell_style(si, r, c, &style)?;
    }
    Ok(())
}

/// A model holding the spec's sheets, values, formulas, formats, styles,
/// widths, frozen rows and hidden sheets. Not evaluated.
pub fn build_model(workbook: &Workbook) -> Result<Model<'static>, String> {
    let mut model = Model::new_empty("workbook", "en", "UTC", "en")?;
    // All sheets first: a formula can refer to a sheet further along.
    for (i, sheet) in workbook.sheets.iter().enumerate() {
        if i == 0 {
            model.rename_sheet_by_index(0, &sheet.name)?;
        } else {
            model.add_sheet(&sheet.name)?;
        }
    }
    for (i, sheet) in workbook.sheets.iter().enumerate() {
        let si = i as u32;
        for (c, col) in sheet.columns.iter().enumerate() {
            if let Some(width) = col.width {
                model
                    .workbook
                    .worksheet_mut(si)?
                    .set_column_width(c as i32 + 1, width * PX_PER_CHAR + PX_PADDING)?;
            }
        }
        for (r, row) in sheet.rows.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                if !cell.is_blank() {
                    set_cell(&mut model, sheet, si, r, c, cell)?;
                }
            }
        }
        if sheet.freeze_header {
            model.set_frozen_rows(si, 1)?;
        }
    }
    for (i, sheet) in workbook.sheets.iter().enumerate() {
        if sheet.hidden {
            model.set_sheet_state(i as u32, SheetState::Hidden)?;
        }
    }
    Ok(model)
}

/// Build and evaluate. IronCalc is young: a panic inside it becomes an error
/// instead of taking the app down.
pub fn evaluated_model(workbook: &Workbook) -> Result<Model<'static>, String> {
    let workbook = workbook.clone();
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let mut model = build_model(&workbook)?;
        model.evaluate();
        Ok(model)
    }))
    .unwrap_or_else(|_| Err("the spreadsheet engine failed on this workbook".to_string()))
}

// ---------------------------------------------------------------------------
// Reading results
// ---------------------------------------------------------------------------

pub fn compute(workbook: &Workbook) -> Result<ComputedWorkbook, String> {
    let model = evaluated_model(workbook)?;
    let mut out = ComputedWorkbook::default();
    for (i, sheet) in workbook.sheets.iter().enumerate() {
        let si = i as u32;
        let row_count = sheet.used_rows();
        let col_count = sheet.used_cols();
        let mut rows = Vec::with_capacity(row_count);
        for r in 0..row_count {
            let mut row = Vec::with_capacity(col_count);
            for c in 0..col_count {
                let cell = sheet.cell(r, c).filter(|cell| !cell.is_blank());
                row.push(match cell {
                    Some(cell) => Some(read_cell(&model, si, r, c, cell)?),
                    None => None,
                });
            }
            rows.push(row);
        }
        let column_widths = (0..col_count)
            .map(|c| {
                sheet
                    .columns
                    .get(c)
                    .and_then(|col| col.width)
                    .unwrap_or(DEFAULT_COLUMN_CHARS)
            })
            .collect();
        out.sheets.push(ComputedSheet {
            name: sheet.name.clone(),
            hidden: sheet.hidden,
            freeze_header: sheet.freeze_header,
            column_widths,
            row_count,
            col_count,
            rows,
        });
    }
    Ok(out)
}

/// The number to hand IronCalc's formatter so ties round the way Excel's do.
///
/// Excel shows a number as its 15-significant-digit decimal and rounds a tie
/// away from zero: 142.725 (stored as 142.72499999999999) shows as $142.73
/// and 1234.5 as $1,235 with no decimals. IronCalc formats the binary value
/// and rounds ties to even, giving $142.72 and $1,234. Rounding to 15 digits
/// and stepping one ulp away from zero puts a tie on the side Excel rounds
/// to; a value that isn't a tie is unaffected.
fn excel_rounding_value(n: f64) -> f64 {
    if !n.is_finite() || n == 0.0 {
        return n;
    }
    let rounded = number_format::to_precision(n, 15);
    f64::from_bits(rounded.to_bits() + 1)
}

fn read_cell(
    model: &Model<'static>,
    si: u32,
    row0: usize,
    col0: usize,
    cell: &Cell,
) -> Result<ComputedCell, String> {
    let (r, c) = (row0 as i32 + 1, col0 as i32 + 1);
    let raw = model.get_cell_value_by_index(si, r, c)?;
    let display = match raw {
        CellValue::Number(n) => {
            let format = model.get_style_for_cell(si, r, c)?.num_fmt;
            number_format::format_number(excel_rounding_value(n), &format, "en").text
        }
        _ => model.get_formatted_cell_value(si, r, c)?,
    };
    let is_error =
        cell.formula.is_some() && matches!(model.get_cell_type(si, r, c)?, CellType::ErrorValue);
    let (kind, value) = match raw {
        CellValue::Number(n) => (
            CellKind::Number,
            serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number),
        ),
        CellValue::Boolean(b) => (CellKind::Bool, Value::Bool(b)),
        CellValue::String(s) => (CellKind::Text, Value::String(s)),
        CellValue::None => (CellKind::Text, Value::String(String::new())),
    };
    let (kind, error) = if is_error {
        let code = match &value {
            Value::String(s) => s.clone(),
            _ => display.clone(),
        };
        (CellKind::Error, Some(code))
    } else {
        (kind, None)
    };
    Ok(ComputedCell {
        display,
        kind,
        value,
        formula: cell.formula.clone(),
        error,
        style: cell.style,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wb(sheets: Value) -> Workbook {
        Workbook::from_value(&json!({ "sheets": sheets })).unwrap()
    }

    fn display(c: &ComputedWorkbook, sheet: &str, cell: &str) -> String {
        let (r, col) = spec::parse_a1(cell).unwrap();
        c.sheet(sheet).unwrap().rows[r][col]
            .as_ref()
            .map(|x| x.display.clone())
            .unwrap_or_default()
    }

    fn cell<'a>(c: &'a ComputedWorkbook, sheet: &str, a: &str) -> &'a ComputedCell {
        let (r, col) = spec::parse_a1(a).unwrap();
        c.sheet(sheet).unwrap().rows[r][col].as_ref().unwrap()
    }

    /// The spike's menu-board spec: an Assumptions sheet feeding a BOM.
    fn menu_board() -> Workbook {
        wb(json!([
            { "name": "Assumptions", "columns": [{"width": 28}, {"width": 12, "format": "currency"}],
              "rows": [
                [{"value": "Item", "style": "header"}, {"value": "Value", "style": "header"}],
                ["Display", {"value": 700, "style": "input"}],
                ["Player", {"value": 120, "style": "input"}],
                ["Install labour", {"value": 90, "style": "input"}],
                ["Tax rate", {"value": 0.0825, "format": "percent1", "style": "input"}]
              ]},
            { "name": "BOM", "freeze_header": true,
              "columns": [{"width": 28}, {"width": 6}, {"width": 12, "format": "currency"}, {"width": 12, "format": "currency"}],
              "rows": [
                [{"value": "Item", "style": "header"}, {"value": "Qty", "style": "header"},
                 {"value": "Unit", "style": "header"}, {"value": "Cost", "style": "header"}],
                ["43\" display", 2, {"formula": "=Assumptions!B2"}, {"formula": "=B2*C2"}],
                ["Media player", 2, {"formula": "=Assumptions!B3"}, {"formula": "=B3*C3"}],
                ["Install", 1, {"formula": "=Assumptions!B4"}, {"formula": "=B4*C4"}],
                [null, null, {"value": "Subtotal", "style": "total"}, {"formula": "=SUM(D2:D4)", "style": "total"}],
                [null, null, "Tax", {"formula": "=D5*Assumptions!B5"}],
                [null, null, {"value": "Total", "style": "total"}, {"formula": "=D5+D6", "style": "total"}]
              ]}
        ]))
    }

    #[test]
    fn menu_board_values_match_hand_calculation() {
        let c = compute(&menu_board()).unwrap();
        // 2*700 + 2*120 + 90 = 1730; tax 8.25% = 142.725; total 1872.725.
        assert_eq!(display(&c, "BOM", "D2"), "$1,400.00");
        assert_eq!(display(&c, "BOM", "D3"), "$240.00");
        assert_eq!(display(&c, "BOM", "D4"), "$90.00");
        assert_eq!(display(&c, "BOM", "D5"), "$1,730.00");
        assert_eq!(display(&c, "BOM", "D6"), "$142.73");
        assert_eq!(display(&c, "BOM", "D7"), "$1,872.73");
        assert_eq!(display(&c, "BOM", "C2"), "$700.00");
        assert_eq!(display(&c, "Assumptions", "B5"), "8.3%");
        assert_eq!(display(&c, "BOM", "A2"), "43\" display");
        let total = cell(&c, "BOM", "D7");
        assert_eq!(total.kind, CellKind::Number);
        assert_eq!(total.formula.as_deref(), Some("=D5+D6"));
        assert_eq!(total.style, Some(CellStyle::Total));
        assert!((total.value.as_f64().unwrap() - 1872.725).abs() < 1e-9);
        assert!(c.all_errors().is_empty());
        let bom = c.sheet("BOM").unwrap();
        assert!(bom.freeze_header);
        assert_eq!((bom.row_count, bom.col_count), (7, 4));
        assert_eq!(bom.column_widths, vec![28.0, 6.0, 12.0, 12.0]);
        assert!(bom.rows[4][0].is_none());
    }

    #[test]
    fn formats_display_like_excel() {
        let c = compute(&wb(json!([{ "name": "F", "rows": [[
            {"value": 1234.5, "format": "currency"},
            {"value": 1234.5, "format": "currency0"},
            {"value": 0.286, "format": "percent"},
            {"value": 0.2861, "format": "percent1"},
            {"value": 1234567, "format": "integer"},
            {"value": 1234.5, "format": "decimal"},
            {"value": 2.5, "format": "0.00\" kg\""},
            {"value": true},
            {"value": "plain"}
        ]]}])))
        .unwrap();
        let shown: Vec<String> = (0..9)
            .map(|i| display(&c, "F", &format!("{}1", spec::col_letters(i))))
            .collect();
        assert_eq!(
            shown,
            [
                "$1,234.50",
                "$1,235",
                "29%",
                "28.6%",
                "1,234,567",
                "1,234.50",
                "2.50 kg",
                "TRUE",
                "plain"
            ]
        );
        assert_eq!(cell(&c, "F", "H1").kind, CellKind::Bool);
        assert_eq!(cell(&c, "F", "I1").kind, CellKind::Text);
    }

    #[test]
    fn date_strings_become_dates_unless_formatted_otherwise() {
        assert_eq!(date_serial("2026-11-02"), Some(46328.0));
        assert_eq!(date_serial("2000-01-01"), Some(36526.0));
        assert_eq!(date_serial("1900-03-01"), Some(61.0));
        assert_eq!(date_serial("2026-02-30"), None);
        assert_eq!(date_serial("26-11-02"), None);
        assert_eq!(date_serial("hello"), None);
        let c = compute(&wb(json!([{ "name": "D", "columns": [null, null, null, {"format": "date"}],
            "rows": [
              [{"value": "2026-11-02", "format": "date"}, "2026-11-02", {"formula": "=A1+30", "format": "date"}],
              ["x", {"value": "2026-11-02", "format": "text"}, "2026-13-01", "2026-12-25"]
            ]}])))
        .unwrap();
        assert_eq!(display(&c, "D", "A1"), "2026-11-02");
        assert_eq!(cell(&c, "D", "A1").kind, CellKind::Number);
        // No format on B1: a date all the same, shown as written.
        assert_eq!(cell(&c, "D", "B1").kind, CellKind::Number);
        assert_eq!(display(&c, "D", "B1"), "2026-11-02");
        // A text format keeps it text; a non-date stays text.
        assert_eq!(cell(&c, "D", "B2").kind, CellKind::Text);
        assert_eq!(cell(&c, "D", "C2").kind, CellKind::Text);
        // D2 takes the column's date format.
        assert_eq!(cell(&c, "D", "D2").kind, CellKind::Number);
        assert_eq!(display(&c, "D", "D2"), "2026-12-25");
        assert_eq!(display(&c, "D", "C1"), "2026-12-02");
    }

    #[test]
    fn injection_strings_stay_text() {
        let c = compute(&wb(json!([{ "name": "S", "rows": [
            [1, 2, "=A1+B1", "=SUM(A1:B1)", "+1+1", "@SUM(A1)"]
        ]}])))
        .unwrap();
        for col in ["C1", "D1", "E1", "F1"] {
            let x = cell(&c, "S", col);
            assert_eq!(x.kind, CellKind::Text, "{col}");
            assert!(x.formula.is_none(), "{col}");
        }
        assert_eq!(display(&c, "S", "C1"), "=A1+B1");
        assert_eq!(display(&c, "S", "D1"), "=SUM(A1:B1)");
        assert_eq!(display(&c, "S", "E1"), "+1+1");
    }

    #[test]
    fn errors_are_reported_not_fatal() {
        let c = compute(&wb(json!([{ "name": "E", "rows": [
            [1, 0],
            [{"formula": "=A1/B1"}, {"formula": "=FOOBAR(1)"}, {"formula": "=Nowhere!A1"}, {"formula": "=SUM(A1:B1)"}]
        ]}])))
        .unwrap();
        let errors = c.all_errors();
        let by_cell = |a: &str| errors.iter().find(|e| e.cell == a).unwrap();
        assert_eq!(by_cell("A2").error, "#DIV/0!");
        assert_eq!(by_cell("B2").error, "#NAME?");
        assert_eq!(by_cell("B2").formula, "=FOOBAR(1)");
        assert_eq!(by_cell("C2").error, "#REF!");
        assert_eq!(errors.len(), 3);
        assert_eq!(cell(&c, "E", "A2").kind, CellKind::Error);
        assert_eq!(display(&c, "E", "D2"), "1");
    }

    #[test]
    fn common_functions_calculate() {
        let c = compute(&wb(json!([{ "name": "F", "rows": [
            [1, "x"], [2, "y"], [3, "x"], [4, "y"], [5, "x"],
            [{"formula": "=SUMIF(B1:B5,\"x\",A1:A5)"}, {"formula": "=VLOOKUP(3,A1:B5,2,FALSE)"},
             {"formula": "=XLOOKUP(4,A1:A5,B1:B5)"}, {"formula": "=IFERROR(1/0,\"e\")"},
             {"formula": "=ROUND(2.345,2)"}, {"formula": "=SUMPRODUCT(A1:A5,A1:A5)"},
             {"formula": "=INDEX(A1:A5,MATCH(3,A1:A5,0))"}, {"formula": "=TEXT(1234.5,\"#,##0.00\")"}],
            [{"formula": "=PMT(0.05/12,60,-20000)", "format": "currency"}, {"formula": "=DATE(2026,11,2)", "format": "date"},
             {"formula": "=COUNTIF(B1:B5,\"y\")"}, {"formula": "=IF(A1>0,\"pos\",\"neg\")"}]
        ]}])))
        .unwrap();
        assert_eq!(display(&c, "F", "A6"), "9");
        assert_eq!(display(&c, "F", "B6"), "x");
        assert_eq!(display(&c, "F", "C6"), "y");
        assert_eq!(display(&c, "F", "D6"), "e");
        assert_eq!(display(&c, "F", "E6"), "2.35");
        assert_eq!(display(&c, "F", "F6"), "55");
        assert_eq!(display(&c, "F", "G6"), "3");
        assert_eq!(display(&c, "F", "H6"), "1,234.50");
        assert_eq!(display(&c, "F", "A7"), "$377.42");
        assert_eq!(display(&c, "F", "B7"), "2026-11-02");
        assert_eq!(display(&c, "F", "C7"), "2");
        assert_eq!(display(&c, "F", "D7"), "pos");
        assert!(c.all_errors().is_empty(), "{:?}", c.all_errors());
    }

    #[test]
    fn style_only_cells_are_kept_and_blank_cells_are_empty() {
        let c = compute(&wb(json!([{ "name": "S", "rows": [
            [{"style": "header"}, null, 1]
        ]}])))
        .unwrap();
        let s = c.sheet("S").unwrap();
        assert_eq!(s.col_count, 3);
        assert_eq!(
            s.rows[0][0].as_ref().unwrap().style,
            Some(CellStyle::Header)
        );
        assert_eq!(s.rows[0][0].as_ref().unwrap().display, "");
        assert!(s.rows[0][1].is_none());
    }

    #[test]
    fn hidden_sheets_and_cross_sheet_forward_references_work() {
        let c = compute(&wb(json!([
            { "name": "Main", "rows": [[{"formula": "=Data!A1*2"}]] },
            { "name": "Data", "hidden": true, "rows": [[21]] }
        ])))
        .unwrap();
        assert_eq!(display(&c, "Main", "A1"), "42");
        assert!(c.sheet("Data").unwrap().hidden);
    }
}
