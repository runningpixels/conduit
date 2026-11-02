//! Write a workbook as .xlsx bytes, with the calculated values cached in each
//! formula cell so any app (and a preview pane) shows numbers.
//!
//! The file holds sheets, cells, formulas, number formats, styles, widths, a
//! frozen header row and hidden sheets. IronCalc writes nothing else: no
//! macros, no external links.

use std::io::Cursor;

use ironcalc::export::save_xlsx_to_writer;

use super::{compute::evaluated_model, spec::Workbook};

pub fn write_xlsx(workbook: &Workbook) -> Result<Vec<u8>, String> {
    let model = evaluated_model(workbook)?;
    let cursor = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        save_xlsx_to_writer(&model, Cursor::new(Vec::new()))
    }))
    .map_err(|_| "the spreadsheet engine failed while writing the file".to_string())?
    .map_err(|e| format!("could not write the .xlsx: {e}"))?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use serde_json::json;

    use super::*;

    fn entry(bytes: &[u8], name: &str) -> String {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut out = String::new();
        zip.by_name(name).unwrap().read_to_string(&mut out).unwrap();
        out
    }

    fn names(bytes: &[u8]) -> Vec<String> {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().unwrap().to_string())
            .collect()
    }

    #[test]
    fn the_file_has_formulas_and_cached_values() {
        let wb = Workbook::from_value(&json!({ "sheets": [
            { "name": "BOM", "freeze_header": true, "columns": [{"width": 20}],
              "rows": [
                [{"value": "Item", "style": "header"}, {"value": "Cost", "style": "header"}],
                ["Display", {"value": 700, "format": "currency", "style": "input"}],
                ["Tax", {"formula": "=B2*0.1", "format": "currency"}],
                ["Evil", "=HYPERLINK(\"x\")"],
                [{"value": "Total", "style": "total"}, {"formula": "=SUM(B2:B3)", "style": "total", "format": "currency"}]
              ]},
            { "name": "Hidden", "hidden": true, "rows": [[1]] }
        ]}))
        .unwrap();
        let bytes = write_xlsx(&wb).unwrap();
        assert_eq!(&bytes[..2], b"PK");

        let sheet1 = entry(&bytes, "xl/worksheets/sheet1.xml");
        assert!(sheet1.contains("<f>B2*0.1</f>"), "{sheet1}");
        // Cached results: 700 * 0.1 = 70, total 770.
        assert!(sheet1.contains("<v>70</v>"), "{sheet1}");
        assert!(sheet1.contains("<v>770</v>"), "{sheet1}");
        assert!(sheet1.contains("pane"), "frozen header: {sheet1}");
        // The injection string is a shared string, not a formula.
        assert!(!sheet1.contains("HYPERLINK"), "{sheet1}");
        let strings = entry(&bytes, "xl/sharedStrings.xml");
        assert!(strings.contains("=HYPERLINK"), "{strings}");

        let workbook = entry(&bytes, "xl/workbook.xml");
        assert!(workbook.contains("state=\"hidden\""), "{workbook}");

        let styles = entry(&bytes, "xl/styles.xml");
        assert!(styles.contains("$#,##0.00"), "{styles}");
        assert!(styles.contains("1F3864"), "{styles}");
        assert!(styles.contains("1F4E9A"), "{styles}");

        for name in names(&bytes) {
            assert!(
                !name.contains("vba") && !name.contains("externalLink"),
                "unexpected part {name}"
            );
        }
    }

    #[test]
    fn the_file_reads_back_with_the_same_values() {
        let wb = Workbook::from_value(&json!({ "sheets": [
            { "name": "A", "rows": [[2, 3, {"formula": "=A1*B1"}]] }
        ]}))
        .unwrap();
        let bytes = write_xlsx(&wb).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.xlsx");
        std::fs::write(&path, &bytes).unwrap();
        let mut model =
            ironcalc::import::load_from_xlsx(path.to_str().unwrap(), "en", "UTC", "en").unwrap();
        model.evaluate();
        assert_eq!(model.get_formatted_cell_value(0, 1, 3).unwrap(), "6");
        assert_eq!(
            model.get_cell_formula(0, 1, 3).unwrap().as_deref(),
            Some("=A1*B1")
        );
    }
}
