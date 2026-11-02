//! The pure functions behind each spreadsheet tool. They change a `Workbook`
//! in place and validate the result; on `Err` the caller drops its copy, so a
//! refused change is never saved.
//!
//! Renaming or deleting a sheet and inserting or deleting rows move formulas'
//! references. IronCalc already knows how, so those operations build a model
//! from the spec, let IronCalc make the change, and read every formula back
//! into the spec. See `read_back`.

use ironcalc::base::Model;
use serde_json::Value;

use super::{
    compute::build_model,
    spec::{self, Cell, Sheet, Workbook},
};

/// Add rows after the last used row of a sheet.
pub fn append_rows(wb: &mut Workbook, sheet: &str, rows: &Value) -> Result<(), String> {
    let idx = wb.find_sheet(sheet)?;
    let name = wb.sheets[idx].name.clone();
    let used = wb.sheets[idx].used_rows();
    let parsed = spec::parse_rows(rows, &name, used, 0)?;
    let target = &mut wb.sheets[idx];
    target.rows.truncate(used);
    target.rows.extend(parsed);
    spec::validate(wb)
}

/// Overwrite a block starting at `start` (A1). A `null` clears its cell; any
/// other cell replaces what was there, format and style included.
pub fn update_cells(
    wb: &mut Workbook,
    sheet: &str,
    start: &str,
    rows: &Value,
) -> Result<(), String> {
    let idx = wb.find_sheet(sheet)?;
    let name = wb.sheets[idx].name.clone();
    let (row0, col0) = spec::parse_a1(start)
        .ok_or_else(|| format!("start '{start}' isn't a cell reference; use something like B2"))?;
    let parsed = spec::parse_rows(rows, &name, row0, col0)?;
    if parsed.is_empty() {
        return Err("rows is empty; pass at least one row of cells".to_string());
    }
    let width = parsed.iter().map(Vec::len).max().unwrap_or(0);
    if row0 + parsed.len() > spec::MAX_ROWS || col0 + width > spec::MAX_COLS {
        return Err(format!(
            "Sheet '{name}': the block reaches {} and the limits are {} rows and {} columns",
            spec::a1(row0 + parsed.len() - 1, (col0 + width).saturating_sub(1)),
            spec::MAX_ROWS,
            spec::MAX_COLS
        ));
    }
    let target = &mut wb.sheets[idx];
    for (r, row) in parsed.into_iter().enumerate() {
        for (c, cell) in row.into_iter().enumerate() {
            *target.cell_mut(row0 + r, col0 + c) = cell;
        }
    }
    spec::validate(wb)
}

/// Set cells scattered around a sheet: `cells` is a list of objects, each a
/// cell as in `rows` plus its address, like `{"cell": "D4", "value": 25}`.
pub fn update_cell_list(wb: &mut Workbook, sheet: &str, cells: &Value) -> Result<(), String> {
    let idx = wb.find_sheet(sheet)?;
    let name = wb.sheets[idx].name.clone();
    let list = cells.as_array().ok_or_else(|| {
        "cells must be a list like [{\"cell\": \"D4\", \"value\": 25}]".to_string()
    })?;
    if list.is_empty() {
        return Err("cells is empty; pass at least one cell".to_string());
    }
    let mut parsed = Vec::with_capacity(list.len());
    for (i, item) in list.iter().enumerate() {
        let mut obj = item.as_object().cloned().ok_or_else(|| {
            format!(
                "cells item {}: expected an object like {{\"cell\": \"D4\", \"value\": 25}}",
                i + 1
            )
        })?;
        let at = obj
            .remove("cell")
            .and_then(|v| v.as_str().map(str::to_string))
            .ok_or_else(|| {
                format!(
                    "cells item {}: give the cell's address, such as \"cell\": \"D4\"",
                    i + 1
                )
            })?;
        let (row0, col0) = spec::parse_a1(&at).ok_or_else(|| {
            format!(
                "cells item {}: '{at}' isn't a cell reference; use something like D4",
                i + 1
            )
        })?;
        if row0 >= spec::MAX_ROWS || col0 >= spec::MAX_COLS {
            return Err(format!(
                "Sheet '{name}': {at} is past the limits of {} rows and {} columns",
                spec::MAX_ROWS,
                spec::MAX_COLS
            ));
        }
        let cell = if obj.is_empty() {
            Cell::default()
        } else {
            spec::parse_cell(&Value::Object(obj), &name, row0, col0)?
        };
        parsed.push((row0, col0, cell));
    }
    let target = &mut wb.sheets[idx];
    for (row0, col0, cell) in parsed {
        *target.cell_mut(row0, col0) = cell;
    }
    spec::validate(wb)
}

/// Add a sheet at `position` (0-based; the end by default).
pub fn add_sheet(
    wb: &mut Workbook,
    name: &str,
    columns: Option<&Value>,
    rows: Option<&Value>,
    position: Option<usize>,
) -> Result<(), String> {
    let name = name.trim();
    spec::check_sheet_name(name)?;
    if wb.sheet_index(name).is_some() {
        return Err(format!("A sheet called '{name}' already exists"));
    }
    let sheet = Sheet {
        name: name.to_string(),
        columns: match columns {
            Some(v) if !v.is_null() => spec::parse_columns(v, name)?,
            _ => Vec::new(),
        },
        rows: match rows {
            Some(v) if !v.is_null() => spec::parse_rows(v, name, 0, 0)?,
            _ => Vec::new(),
        },
        ..Sheet::default()
    };
    let at = position.unwrap_or(wb.sheets.len()).min(wb.sheets.len());
    wb.sheets.insert(at, sheet);
    spec::validate(wb)
}

/// Structural changes to one sheet. Applied in this order: columns,
/// freeze_header, delete_rows (rows numbered as they are now), insert_rows
/// (numbered after the delete), rename_to. `delete` stands alone.
#[derive(Debug, Default)]
pub struct EditSheet {
    pub rename_to: Option<String>,
    pub delete: bool,
    pub columns: Option<Value>,
    pub freeze_header: Option<bool>,
    /// (from, count), 1-based.
    pub delete_rows: Option<(usize, usize)>,
    /// (at, rows): inserted before row `at` (1-based).
    pub insert_rows: Option<(usize, Value)>,
}

pub fn edit_sheet(wb: &mut Workbook, sheet: &str, edit: EditSheet) -> Result<(), String> {
    let idx = wb.find_sheet(sheet)?;
    if edit.delete {
        if edit.rename_to.is_some()
            || edit.columns.is_some()
            || edit.freeze_header.is_some()
            || edit.delete_rows.is_some()
            || edit.insert_rows.is_some()
        {
            return Err(
                "delete can't be combined with other changes; call edit_sheet again".to_string(),
            );
        }
        return delete_sheet(wb, idx);
    }
    if edit.rename_to.is_none()
        && edit.columns.is_none()
        && edit.freeze_header.is_none()
        && edit.delete_rows.is_none()
        && edit.insert_rows.is_none()
    {
        return Err(
            "nothing to change: pass rename_to, delete, columns, freeze_header, delete_rows or insert_rows"
                .to_string(),
        );
    }
    if let Some(columns) = &edit.columns {
        wb.sheets[idx].columns = spec::parse_columns(columns, &wb.sheets[idx].name)?;
    }
    if let Some(freeze) = edit.freeze_header {
        wb.sheets[idx].freeze_header = freeze;
    }
    if let Some((from, count)) = edit.delete_rows {
        delete_rows(wb, idx, from, count)?;
    }
    if let Some((at, rows)) = &edit.insert_rows {
        insert_rows(wb, idx, *at, rows)?;
    }
    if let Some(new_name) = &edit.rename_to {
        rename_sheet(wb, idx, new_name)?;
    }
    spec::validate(wb)
}

fn rename_sheet(wb: &mut Workbook, idx: usize, new_name: &str) -> Result<(), String> {
    let new_name = new_name.trim();
    spec::check_sheet_name(new_name)?;
    if wb.sheet_index(new_name).is_some_and(|other| other != idx) {
        return Err(format!("A sheet called '{new_name}' already exists"));
    }
    let mut model = build_model(wb)?;
    model.rename_sheet_by_index(idx as u32, new_name)?;
    let mut names: Vec<Option<String>> = wb.sheets.iter().map(|s| Some(s.name.clone())).collect();
    names[idx] = Some(new_name.to_string());
    read_back(wb, &model, &names, &|_, r| Some(r));
    wb.sheets[idx].name = new_name.to_string();
    Ok(())
}

fn delete_sheet(wb: &mut Workbook, idx: usize) -> Result<(), String> {
    if wb.sheets.len() == 1 {
        return Err("This is the only sheet; a spreadsheet needs at least one".to_string());
    }
    if wb
        .sheets
        .iter()
        .enumerate()
        .all(|(i, s)| i == idx || s.hidden)
    {
        return Err("That would leave no visible sheet".to_string());
    }
    let mut model = build_model(wb)?;
    model.delete_sheet(idx as u32)?;
    let mut names: Vec<Option<String>> = wb.sheets.iter().map(|s| Some(s.name.clone())).collect();
    names[idx] = None;
    read_back(wb, &model, &names, &|_, r| Some(r));
    wb.sheets.remove(idx);
    spec::validate(wb)
}

fn insert_rows(wb: &mut Workbook, idx: usize, at: usize, rows: &Value) -> Result<(), String> {
    let name = wb.sheets[idx].name.clone();
    let used = wb.sheets[idx].used_rows();
    if at == 0 || at > used + 1 {
        return Err(format!(
            "Sheet '{name}': insert_rows.at must be between 1 and {} (rows are numbered from 1)",
            used + 1
        ));
    }
    let parsed = spec::parse_rows(rows, &name, at - 1, 0)?;
    if parsed.is_empty() {
        return Err("insert_rows.rows is empty; pass at least one row".to_string());
    }
    let count = parsed.len();
    if used + count > spec::MAX_ROWS {
        return Err(format!(
            "Sheet '{name}' would have {} rows; the limit is {}",
            used + count,
            spec::MAX_ROWS
        ));
    }
    let mut model = build_model(wb)?;
    model.insert_rows(idx as u32, at as i32, count as i32)?;
    let names: Vec<Option<String>> = wb.sheets.iter().map(|s| Some(s.name.clone())).collect();
    read_back(wb, &model, &names, &|s, r| {
        Some(if s == idx && r >= at - 1 {
            r + count
        } else {
            r
        })
    });
    let target = &mut wb.sheets[idx];
    target.rows.truncate(used);
    target.rows.splice(at - 1..at - 1, parsed);
    Ok(())
}

fn delete_rows(wb: &mut Workbook, idx: usize, from: usize, count: usize) -> Result<(), String> {
    let name = wb.sheets[idx].name.clone();
    let used = wb.sheets[idx].used_rows();
    if from == 0 || count == 0 {
        return Err(
            "delete_rows needs from and count of 1 or more (rows are numbered from 1)".to_string(),
        );
    }
    if from > used {
        return Err(format!(
            "Sheet '{name}' has {used} rows; there is nothing to delete from row {from}"
        ));
    }
    let from0 = from - 1;
    let count = count.min(used - from0);
    let mut model = build_model(wb)?;
    model.delete_rows(idx as u32, from as i32, count as i32)?;
    let names: Vec<Option<String>> = wb.sheets.iter().map(|s| Some(s.name.clone())).collect();
    read_back(wb, &model, &names, &|s, r| {
        if s != idx || r < from0 {
            Some(r)
        } else if r < from0 + count {
            None
        } else {
            Some(r - count)
        }
    });
    let target = &mut wb.sheets[idx];
    target.rows.truncate(used);
    target.rows.drain(from0..from0 + count);
    Ok(())
}

/// Copy the formulas IronCalc now holds back into the spec. `new_names[i]` is
/// sheet `i`'s name in the model (`None` if the change deleted it);
/// `row_map(sheet, row0)` is where that sheet's row moved to (`None` if it
/// was deleted). Cells keep their position in the spec; only the formula text
/// is replaced, so rows are moved separately by the caller.
fn read_back(
    wb: &mut Workbook,
    model: &Model<'static>,
    new_names: &[Option<String>],
    row_map: &dyn Fn(usize, usize) -> Option<usize>,
) {
    let model_names = model.workbook.get_worksheet_names();
    for (s, new_name) in new_names.iter().enumerate() {
        let Some(model_index) = new_name
            .as_deref()
            .and_then(|n| model_names.iter().position(|m| m == n))
            .map(|i| i as u32)
        else {
            continue;
        };
        for r in 0..wb.sheets[s].rows.len() {
            let Some(new_row) = row_map(s, r) else {
                continue;
            };
            for c in 0..wb.sheets[s].rows[r].len() {
                let cell: &mut Cell = &mut wb.sheets[s].rows[r][c];
                if cell.formula.is_none() {
                    continue;
                }
                if let Ok(Some(formula)) =
                    model.get_cell_formula(model_index, new_row as i32 + 1, c as i32 + 1)
                {
                    cell.formula = Some(formula);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sheets::compute::{compute, CellKind, ComputedWorkbook};
    use serde_json::json;

    fn wb(sheets: Value) -> Workbook {
        Workbook::from_value(&json!({ "sheets": sheets })).unwrap()
    }

    fn shown(c: &ComputedWorkbook, sheet: &str, a1: &str) -> String {
        let (r, col) = spec::parse_a1(a1).unwrap();
        c.sheet(sheet).unwrap().rows[r][col]
            .as_ref()
            .map(|x| x.display.clone())
            .unwrap_or_default()
    }

    fn formula(w: &Workbook, sheet: &str, a1: &str) -> Option<String> {
        let (r, col) = spec::parse_a1(a1).unwrap();
        let s = &w.sheets[w.find_sheet(sheet).unwrap()];
        s.cell(r, col).and_then(|c| c.formula.clone())
    }

    fn budget() -> Workbook {
        wb(json!([
            { "name": "Inputs", "rows": [["Rate", 0.1], ["Base", 1000]] },
            { "name": "Calc", "rows": [
                [{"value": "Item", "style": "header"}, {"value": "Amount", "style": "header"}],
                ["a", 10],
                ["b", 20],
                ["c", 30],
                [{"value": "Total", "style": "total"}, {"formula": "=SUM(B2:B4)", "style": "total"}],
                ["Tax", {"formula": "=B5*Inputs!B1"}],
                ["Base", {"formula": "=Inputs!B2+B5"}]
            ]}
        ]))
    }

    #[test]
    fn append_rows_adds_after_the_last_row() {
        let mut w = budget();
        append_rows(
            &mut w,
            "calc",
            &json!([["d", 40], [null, {"formula": "=B8*2"}]]),
        )
        .unwrap();
        let calc = &w.sheets[1];
        assert_eq!(calc.used_rows(), 9);
        assert_eq!(calc.rows[7][0].value, Some(spec::Scalar::Text("d".into())));
        let c = compute(&w).unwrap();
        assert_eq!(shown(&c, "Calc", "B9"), "80");

        let e = append_rows(&mut w, "Nope", &json!([[1]])).unwrap_err();
        assert!(e.contains("Nope") && e.contains("Inputs, Calc"), "{e}");
        let e = append_rows(&mut w, "Calc", &json!([[1, {"formula": "=[x]A1"}]])).unwrap_err();
        assert!(e.contains("'Calc'") && e.contains("B10"), "{e}");
    }

    #[test]
    fn append_rows_enforces_the_row_limit() {
        let mut w = wb(json!([{ "name": "S", "rows": [[1]] }]));
        let rows: Vec<Value> = (0..spec::MAX_ROWS).map(|_| json!([1])).collect();
        assert!(append_rows(&mut w, "S", &json!(rows))
            .unwrap_err()
            .contains("5000"));
    }

    #[test]
    fn update_cells_overwrites_a_block_and_null_clears() {
        let mut w = budget();
        update_cells(
            &mut w,
            "Calc",
            "b3",
            &json!([[99, {"value": "n", "style": "note"}], [null, "x"]]),
        )
        .unwrap();
        let calc = &w.sheets[1];
        assert_eq!(calc.rows[2][1].value, Some(spec::Scalar::Number(99.0)));
        assert_eq!(calc.rows[2][2].style, Some(spec::CellStyle::Note));
        assert!(calc.rows[3][1].is_blank());
        assert_eq!(calc.rows[3][2].value, Some(spec::Scalar::Text("x".into())));
        // Cells outside the block are left alone.
        assert_eq!(calc.rows[1][1].value, Some(spec::Scalar::Number(10.0)));
        // Past the end grows the sheet.
        update_cells(&mut w, "Calc", "E12", &json!([[1]])).unwrap();
        assert_eq!(w.sheets[1].used_rows(), 12);

        let e = update_cells(&mut w, "Calc", "ZZ", &json!([[1]])).unwrap_err();
        assert!(e.contains("ZZ"), "{e}");
        let e = update_cells(&mut w, "Calc", "C2", &json!([[1, [2]]])).unwrap_err();
        assert!(e.contains("D2"), "{e}");
        let e = update_cells(&mut w, "Calc", "A1", &json!([])).unwrap_err();
        assert!(e.contains("empty"), "{e}");
    }

    #[test]
    fn a_cell_list_sets_scattered_cells_in_one_call() {
        let mut w = budget();
        update_cell_list(
            &mut w,
            "Calc",
            &json!([
                {"cell": "b3", "value": 99},
                {"cell": "E12", "formula": "=B3*2", "format": "currency"},
                {"cell": "C4"}
            ]),
        )
        .unwrap();
        let calc = &w.sheets[1];
        assert_eq!(calc.rows[2][1].value, Some(spec::Scalar::Number(99.0)));
        assert_eq!(calc.rows[11][4].formula.as_deref(), Some("=B3*2"));
        assert!(calc.rows[3][2].is_blank());
        assert_eq!(shown(&compute(&w).unwrap(), "Calc", "E12"), "$198.00");

        let e = update_cell_list(&mut w, "Calc", &json!([{"value": 1}])).unwrap_err();
        assert!(e.contains("item 1") && e.contains("address"), "{e}");
        let e = update_cell_list(
            &mut w,
            "Calc",
            &json!([{"cell": "A1"}, {"cell": "Q", "value": 1}]),
        )
        .unwrap_err();
        assert!(e.contains("item 2"), "{e}");
        let e =
            update_cell_list(&mut w, "Calc", &json!([{"cell": "A1", "bold": true}])).unwrap_err();
        assert!(e.contains("bold"), "{e}");
        assert!(update_cell_list(&mut w, "Calc", &json!([]))
            .unwrap_err()
            .contains("empty"));
    }

    #[test]
    fn update_cells_can_fix_an_error_formula() {
        let mut w = wb(json!([{ "name": "S", "rows": [[2, {"formula": "=FOOBAR(A1)"}]] }]));
        assert_eq!(compute(&w).unwrap().all_errors()[0].error, "#NAME?");
        update_cells(&mut w, "S", "B1", &json!([[{"formula": "=A1*3"}]])).unwrap();
        let c = compute(&w).unwrap();
        assert!(c.all_errors().is_empty());
        assert_eq!(shown(&c, "S", "B1"), "6");
    }

    #[test]
    fn unknown_function_reports_name_error() {
        let w = wb(json!([{ "name": "S", "rows": [[{"formula": "=NOSUCHFN(1)"}]] }]));
        let errors = compute(&w).unwrap().all_errors();
        assert_eq!(errors.len(), 1);
        assert_eq!(
            (errors[0].sheet.as_str(), errors[0].cell.as_str()),
            ("S", "A1")
        );
        assert_eq!(errors[0].error, "#NAME?");
    }

    #[test]
    fn add_sheet_places_and_checks() {
        let mut w = budget();
        add_sheet(
            &mut w,
            "Summary",
            Some(&json!([{"width": 20}])),
            Some(&json!([["Total", {"formula": "=Calc!B5"}]])),
            Some(1),
        )
        .unwrap();
        let names: Vec<&str> = w.sheets.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["Inputs", "Summary", "Calc"]);
        assert_eq!(shown(&compute(&w).unwrap(), "Summary", "B1"), "60");
        // Past the end goes last.
        add_sheet(&mut w, "Last", None, None, Some(50)).unwrap();
        assert_eq!(w.sheets.last().unwrap().name, "Last");
        assert!(add_sheet(&mut w, "summary", None, None, None)
            .unwrap_err()
            .contains("already"));
        assert!(add_sheet(&mut w, "a/b", None, None, None).is_err());
        let mut many = wb(json!([{ "name": "S0", "rows": [] }]));
        for i in 1..spec::MAX_SHEETS {
            add_sheet(&mut many, &format!("S{i}"), None, None, None).unwrap();
        }
        assert!(add_sheet(&mut many, "Extra", None, None, None)
            .unwrap_err()
            .contains("20"));
    }

    #[test]
    fn rename_updates_formulas_that_refer_to_the_sheet() {
        let mut w = budget();
        edit_sheet(
            &mut w,
            "Inputs",
            EditSheet {
                rename_to: Some("Assumptions".into()),
                ..EditSheet::default()
            },
        )
        .unwrap();
        assert_eq!(w.sheets[0].name, "Assumptions");
        assert_eq!(
            formula(&w, "Calc", "B6").as_deref(),
            Some("=B5*Assumptions!B1")
        );
        assert_eq!(
            formula(&w, "Calc", "B7").as_deref(),
            Some("=Assumptions!B2+B5")
        );
        // Same-sheet references are untouched.
        assert_eq!(formula(&w, "Calc", "B5").as_deref(), Some("=SUM(B2:B4)"));
        let c = compute(&w).unwrap();
        assert!(c.all_errors().is_empty());
        assert_eq!(shown(&c, "Calc", "B6"), "6");
        assert_eq!(shown(&c, "Calc", "B7"), "1060");
    }

    #[test]
    fn rename_to_a_name_with_a_space_quotes_it() {
        let mut w = budget();
        edit_sheet(
            &mut w,
            "Inputs",
            EditSheet {
                rename_to: Some("My Inputs".into()),
                ..EditSheet::default()
            },
        )
        .unwrap();
        assert_eq!(
            formula(&w, "Calc", "B6").as_deref(),
            Some("=B5*'My Inputs'!B1")
        );
        assert!(compute(&w).unwrap().all_errors().is_empty());
        // The stored spec reloads and still calculates.
        let again = Workbook::from_value(&w.to_value()).unwrap();
        assert_eq!(shown(&compute(&again).unwrap(), "Calc", "B6"), "6");
    }

    #[test]
    fn rename_refuses_bad_or_taken_names() {
        let mut w = budget();
        for bad in ["calc", "", "a:b"] {
            let r = edit_sheet(
                &mut w,
                "Inputs",
                EditSheet {
                    rename_to: Some(bad.into()),
                    ..EditSheet::default()
                },
            );
            assert!(r.is_err(), "{bad:?}");
        }
        // Changing only the case of its own name is fine.
        edit_sheet(
            &mut w,
            "Inputs",
            EditSheet {
                rename_to: Some("INPUTS".into()),
                ..EditSheet::default()
            },
        )
        .unwrap();
        assert_eq!(formula(&w, "Calc", "B6").as_deref(), Some("=B5*INPUTS!B1"));
    }

    #[test]
    fn insert_rows_shifts_references() {
        let mut w = budget();
        // Insert two rows before row 3, in the middle of SUM(B2:B4).
        edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                insert_rows: Some((3, json!([["x", 100], ["y", 200]]))),
                ..EditSheet::default()
            },
        )
        .unwrap();
        let calc = &w.sheets[1];
        assert_eq!(calc.used_rows(), 9);
        assert_eq!(calc.rows[2][0].value, Some(spec::Scalar::Text("x".into())));
        assert_eq!(calc.rows[4][0].value, Some(spec::Scalar::Text("b".into())));
        // The total moved from row 5 to 7 and its range grew to cover the new rows.
        assert_eq!(formula(&w, "Calc", "B7").as_deref(), Some("=SUM(B2:B6)"));
        assert_eq!(formula(&w, "Calc", "B8").as_deref(), Some("=B7*Inputs!B1"));
        assert_eq!(formula(&w, "Calc", "B9").as_deref(), Some("=Inputs!B2+B7"));
        let c = compute(&w).unwrap();
        assert!(c.all_errors().is_empty());
        assert_eq!(shown(&c, "Calc", "B7"), "360");
        assert_eq!(shown(&c, "Calc", "B9"), "1360");
    }

    #[test]
    fn insert_rows_keeps_references_from_other_sheets() {
        let mut w = budget();
        edit_sheet(
            &mut w,
            "Inputs",
            EditSheet {
                insert_rows: Some((1, json!([["Header"]]))),
                ..EditSheet::default()
            },
        )
        .unwrap();
        assert_eq!(formula(&w, "Calc", "B6").as_deref(), Some("=B5*Inputs!B2"));
        let c = compute(&w).unwrap();
        assert_eq!(shown(&c, "Calc", "B6"), "6");
        assert_eq!(shown(&c, "Calc", "B7"), "1060");
    }

    #[test]
    fn insert_rows_at_the_end_and_out_of_range() {
        let mut w = budget();
        edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                insert_rows: Some((8, json!([["end", 1]]))),
                ..EditSheet::default()
            },
        )
        .unwrap();
        assert_eq!(w.sheets[1].used_rows(), 8);
        let e = edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                insert_rows: Some((20, json!([[1]]))),
                ..EditSheet::default()
            },
        )
        .unwrap_err();
        assert!(e.contains("between 1 and 9"), "{e}");
        assert!(edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                insert_rows: Some((0, json!([[1]]))),
                ..EditSheet::default()
            }
        )
        .is_err());
        assert!(edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                insert_rows: Some((2, json!([]))),
                ..EditSheet::default()
            }
        )
        .is_err());
    }

    #[test]
    fn delete_rows_shifts_references_and_marks_dangling_ones() {
        let mut w = budget();
        // Delete row 3 ("b", 20): the total's range shrinks, later rows move up.
        edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                delete_rows: Some((3, 1)),
                ..EditSheet::default()
            },
        )
        .unwrap();
        assert_eq!(w.sheets[1].used_rows(), 6);
        assert_eq!(formula(&w, "Calc", "B4").as_deref(), Some("=SUM(B2:B3)"));
        assert_eq!(formula(&w, "Calc", "B5").as_deref(), Some("=B4*Inputs!B1"));
        assert_eq!(formula(&w, "Calc", "B6").as_deref(), Some("=Inputs!B2+B4"));
        let c = compute(&w).unwrap();
        assert!(c.all_errors().is_empty());
        assert_eq!(shown(&c, "Calc", "B4"), "40");
        assert_eq!(shown(&c, "Calc", "B6"), "1040");

        // Deleting the row a single-cell reference points at gives #REF!.
        let mut w = wb(json!([{ "name": "S", "rows": [[1], [2], [{"formula": "=A2"}]] }]));
        edit_sheet(
            &mut w,
            "S",
            EditSheet {
                delete_rows: Some((2, 1)),
                ..EditSheet::default()
            },
        )
        .unwrap();
        let errors = compute(&w).unwrap().all_errors();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].cell, "A2");
        assert_eq!(errors[0].error, "#REF!");
    }

    #[test]
    fn delete_rows_clamps_and_checks() {
        let mut w = budget();
        edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                delete_rows: Some((6, 50)),
                ..EditSheet::default()
            },
        )
        .unwrap();
        assert_eq!(w.sheets[1].used_rows(), 5);
        let e = edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                delete_rows: Some((9, 1)),
                ..EditSheet::default()
            },
        )
        .unwrap_err();
        assert!(e.contains("nothing to delete"), "{e}");
        assert!(edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                delete_rows: Some((0, 1)),
                ..EditSheet::default()
            }
        )
        .is_err());
        assert!(edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                delete_rows: Some((1, 0)),
                ..EditSheet::default()
            }
        )
        .is_err());
    }

    #[test]
    fn delete_sheet_marks_references_and_protects_the_last_sheet() {
        let mut w = budget();
        edit_sheet(
            &mut w,
            "Inputs",
            EditSheet {
                delete: true,
                ..EditSheet::default()
            },
        )
        .unwrap();
        assert_eq!(w.sheets.len(), 1);
        let errors = compute(&w).unwrap().all_errors();
        assert!(errors.iter().all(|e| e.error == "#REF!"), "{errors:?}");
        assert_eq!(errors.len(), 2);
        let e = edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                delete: true,
                ..EditSheet::default()
            },
        )
        .unwrap_err();
        assert!(e.contains("only sheet"), "{e}");

        let mut w = budget();
        let e = edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                delete: true,
                rename_to: Some("X".into()),
                ..EditSheet::default()
            },
        )
        .unwrap_err();
        assert!(e.contains("can't be combined"), "{e}");
        w.sheets[0].hidden = true;
        let e = edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                delete: true,
                ..EditSheet::default()
            },
        )
        .unwrap_err();
        assert!(e.contains("visible"), "{e}");
    }

    #[test]
    fn delete_sheet_keeps_other_references_pointing_at_the_right_sheet() {
        let mut w = wb(json!([
            { "name": "A", "rows": [[1]] },
            { "name": "B", "rows": [[2]] },
            { "name": "C", "rows": [[{"formula": "=B!A1+10"}]] }
        ]));
        edit_sheet(
            &mut w,
            "A",
            EditSheet {
                delete: true,
                ..EditSheet::default()
            },
        )
        .unwrap();
        assert_eq!(shown(&compute(&w).unwrap(), "C", "A1"), "12");
    }

    #[test]
    fn columns_and_freeze_header() {
        let mut w = budget();
        edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                columns: Some(json!([{"width": 30}, {"width": 14, "format": "currency"}])),
                freeze_header: Some(true),
                ..EditSheet::default()
            },
        )
        .unwrap();
        assert!(w.sheets[1].freeze_header);
        let c = compute(&w).unwrap();
        assert_eq!(c.sheet("Calc").unwrap().column_widths, vec![30.0, 14.0]);
        // The column format reaches cells without their own: B2 = 10.
        assert_eq!(shown(&c, "Calc", "B2"), "$10.00");
        assert_eq!(
            c.sheet("Calc").unwrap().rows[1][1].as_ref().unwrap().kind,
            CellKind::Number
        );
        assert!(edit_sheet(&mut w, "Calc", EditSheet::default())
            .unwrap_err()
            .contains("nothing to change"));
    }

    #[test]
    fn structural_edits_leave_literals_and_styles_alone() {
        let mut w = budget();
        let before = w.sheets[1].rows[0].clone();
        edit_sheet(
            &mut w,
            "Calc",
            EditSheet {
                insert_rows: Some((2, json!([["new", 1]]))),
                ..EditSheet::default()
            },
        )
        .unwrap();
        assert_eq!(w.sheets[1].rows[0], before);
        assert_eq!(w.sheets[1].rows[5][0].style, Some(spec::CellStyle::Total));
        assert_eq!(w.sheets[1].rows[5][1].style, Some(spec::CellStyle::Total));
    }
}
