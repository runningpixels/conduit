//! Write a workbook as .xlsx bytes, with the calculated values cached in each
//! formula cell so any app (and a preview pane) shows numbers.
//!
//! The file holds sheets, cells, formulas, number formats, styles, widths, a
//! frozen header row and hidden sheets. IronCalc writes nothing else: no
//! macros, no external links.

use std::io::Cursor;

use ironcalc::export::save_xlsx_to_writer;

use super::{
    chart_xlsx,
    compute::{compute, evaluated_model},
    spec::Workbook,
};

pub fn write_xlsx(workbook: &Workbook) -> Result<Vec<u8>, String> {
    let model = evaluated_model(workbook)?;
    let cursor = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        save_xlsx_to_writer(&model, Cursor::new(Vec::new()))
    }))
    .map_err(|_| "the spreadsheet engine failed while writing the file".to_string())?
    .map_err(|e| format!("could not write the .xlsx: {e}"))?;
    let bytes = cursor.into_inner();
    if workbook.sheets.iter().all(|s| s.charts.is_empty()) {
        return Ok(bytes);
    }
    // IronCalc writes no charts: add them to the file it wrote.
    chart_xlsx::add_charts(bytes, workbook, &compute(workbook)?)
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

    fn charts_workbook() -> Workbook {
        Workbook::from_value(&json!({ "sheets": [
            { "name": "Q1 'Sales' & more",
              "rows": [
                ["Region", "Units", "Revenue"],
                ["North", 10, {"formula": "=B2*2.5"}],
                ["South", 20, {"formula": "=B3*2.5"}],
                ["East", 30, {"formula": "=B4*2.5"}],
                ["West", 40, "n/a"],
                ["Mid", 50, {"formula": "=B6*2.5"}],
                ["Far", 60, {"formula": "=B7*2.5"}]
              ],
              "charts": [
                { "id": "bars", "type": "bar", "title": "Units <by> region & more",
                  "categories": "A2:A7",
                  "series": [{ "name": "Units", "values": "B2:B7" }, { "name": "Revenue", "values": "C2:C7" }],
                  "anchor": "E2" },
                { "id": "trend", "type": "line", "title": "Revenue", "categories": "A2:A7",
                  "series": [{ "values": "C2:C7" }], "anchor": "E20" },
                { "id": "share", "type": "pie", "title": "Share", "categories": "A2:A7",
                  "series": [{ "name": "Units", "values": "B2:B7" }], "anchor": "N2" }
              ] },
            { "name": "Plain", "rows": [[1, 2]] }
        ]}))
        .unwrap()
    }

    /// Every part parses as XML with balanced tags.
    fn assert_well_formed(bytes: &[u8]) {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).unwrap();
            let name = file.name().unwrap().to_string();
            if !(name.ends_with(".xml") || name.ends_with(".rels")) {
                continue;
            }
            let mut text = String::new();
            file.read_to_string(&mut text).unwrap();
            let mut reader = quick_xml::reader::Reader::from_str(&text);
            let mut depth = 0i32;
            loop {
                match reader.read_event() {
                    Ok(quick_xml::events::Event::Eof) => break,
                    Ok(quick_xml::events::Event::Start(_)) => depth += 1,
                    Ok(quick_xml::events::Event::End(_)) => depth -= 1,
                    Ok(_) => {}
                    Err(e) => panic!("{name} is not well-formed XML: {e}"),
                }
            }
            assert_eq!(depth, 0, "{name} has unbalanced tags");
        }
    }

    #[test]
    fn charts_are_written_as_native_excel_parts() {
        let bytes = write_xlsx(&charts_workbook()).unwrap();
        assert_well_formed(&bytes);
        let all = names(&bytes);
        for part in [
            "xl/charts/chart1.xml",
            "xl/charts/chart2.xml",
            "xl/charts/chart3.xml",
            "xl/drawings/drawing1.xml",
            "xl/drawings/_rels/drawing1.xml.rels",
            "xl/worksheets/_rels/sheet1.xml.rels",
        ] {
            assert!(all.iter().any(|n| n == part), "missing {part} in {all:?}");
        }
        assert!(!all.iter().any(|n| n.contains("drawing2")), "{all:?}");
        assert!(!all.iter().any(|n| n.contains("chart4")), "{all:?}");

        let types = entry(&bytes, "[Content_Types].xml");
        assert!(types.contains("/xl/drawings/drawing1.xml"), "{types}");
        assert!(types.contains("application/vnd.openxmlformats-officedocument.drawing+xml"));
        for n in 1..=3 {
            assert!(
                types.contains(&format!("/xl/charts/chart{n}.xml")),
                "{types}"
            );
        }
        assert!(types.contains("application/vnd.openxmlformats-officedocument.drawingml.chart+xml"));

        // The sheet points at its drawing, in the schema's place: after the
        // data and page setup, before the closing tag.
        let sheet1 = entry(&bytes, "xl/worksheets/sheet1.xml");
        let drawing = sheet1.find("<drawing ").expect(&sheet1);
        assert!(drawing > sheet1.find("</sheetData>").unwrap(), "{sheet1}");
        if let Some(margins) = sheet1.find("<pageMargins") {
            assert!(drawing > margins, "{sheet1}");
        }
        assert!(sheet1[drawing..].contains("r:id=\"rId1\""), "{sheet1}");
        assert!(!entry(&bytes, "xl/worksheets/sheet2.xml").contains("<drawing"));
        let sheet_rels = entry(&bytes, "xl/worksheets/_rels/sheet1.xml.rels");
        assert!(
            sheet_rels.contains("relationships/drawing\""),
            "{sheet_rels}"
        );
        assert!(
            sheet_rels.contains("Target=\"../drawings/drawing1.xml\""),
            "{sheet_rels}"
        );
        assert!(sheet_rels.contains("Id=\"rId1\""), "{sheet_rels}");

        let drawing_rels = entry(&bytes, "xl/drawings/_rels/drawing1.xml.rels");
        for n in 1..=3 {
            assert!(
                drawing_rels.contains(&format!("Target=\"../charts/chart{n}.xml\"")),
                "{drawing_rels}"
            );
            assert!(
                drawing_rels.contains(&format!("Id=\"rId{n}\"")),
                "{drawing_rels}"
            );
        }
        assert!(
            drawing_rels.contains("relationships/chart\""),
            "{drawing_rels}"
        );

        // Two-cell anchors at the chart's anchor cell (0-based col and row).
        let drawing_xml = entry(&bytes, "xl/drawings/drawing1.xml");
        assert_eq!(drawing_xml.matches("<xdr:twoCellAnchor>").count(), 3);
        assert!(
            drawing_xml.contains(
                "<xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row>"
            ),
            "{drawing_xml}"
        );
        assert!(
            drawing_xml.contains(
                "<xdr:from><xdr:col>13</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row>"
            ),
            "{drawing_xml}"
        );
        assert!(
            drawing_xml.contains("<xdr:to><xdr:col>12</xdr:col>"),
            "{drawing_xml}"
        );
        assert!(drawing_xml.contains("r:id=\"rId3\""), "{drawing_xml}");

        // The bar chart: grouped columns, two series, ranges with the sheet
        // name quoted (apostrophes doubled, & escaped), cached values, gaps.
        let bar = entry(&bytes, "xl/charts/chart1.xml");
        assert!(
            bar.contains("<c:barChart>") && bar.contains("<c:grouping val=\"clustered\"/>"),
            "{bar}"
        );
        assert_eq!(bar.matches("<c:ser>").count(), 2);
        assert!(
            bar.contains("<c:f>'Q1 ''Sales'' &amp; more'!$A$2:$A$7</c:f>"),
            "{bar}"
        );
        assert!(
            bar.contains("<c:f>'Q1 ''Sales'' &amp; more'!$B$2:$B$7</c:f>"),
            "{bar}"
        );
        assert!(
            bar.contains("<c:f>'Q1 ''Sales'' &amp; more'!$C$2:$C$7</c:f>"),
            "{bar}"
        );
        assert!(bar.contains("<c:v>North</c:v>"), "{bar}");
        assert!(
            bar.contains("<c:pt idx=\"1\"><c:v>20</c:v></c:pt>"),
            "{bar}"
        );
        // Revenue is 25, 50, 75, a gap (text), 125, 150: five points of six.
        assert!(
            bar.contains("<c:pt idx=\"2\"><c:v>75</c:v></c:pt>"),
            "{bar}"
        );
        assert!(!bar.contains("<c:pt idx=\"3\"><c:v>n/a"), "{bar}");
        assert!(bar.contains("<c:ptCount val=\"6\"/>"), "{bar}");
        assert!(
            bar.contains("<c:v>Units</c:v>") && bar.contains("<c:v>Revenue</c:v>"),
            "{bar}"
        );
        assert!(
            bar.contains("<a:t>Units &lt;by&gt; region &amp; more</a:t>"),
            "{bar}"
        );
        assert!(bar.contains("<c:legend>"), "{bar}");
        assert!(
            bar.contains("<c:catAx>") && bar.contains("<c:valAx>"),
            "{bar}"
        );

        let line = entry(&bytes, "xl/charts/chart2.xml");
        assert!(
            line.contains("<c:lineChart>") && !line.contains("<c:legend>"),
            "{line}"
        );
        let pie = entry(&bytes, "xl/charts/chart3.xml");
        assert!(
            pie.contains("<c:pieChart>") && pie.contains("<c:legend>"),
            "{pie}"
        );
        assert!(!pie.contains("<c:catAx>"), "{pie}");

        // IronCalc still reads the file, and the cells are as before.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.xlsx");
        std::fs::write(&path, &bytes).unwrap();
        let mut model =
            ironcalc::import::load_from_xlsx(path.to_str().unwrap(), "en", "UTC", "en").unwrap();
        model.evaluate();
        assert_eq!(model.get_formatted_cell_value(0, 2, 3).unwrap(), "25");
    }

    #[test]
    fn a_chart_with_deleted_rows_is_left_out_of_the_file() {
        let mut wb = charts_workbook();
        wb.sheets[0].charts[0].categories = "#REF!".to_string();
        let bytes = write_xlsx(&wb).unwrap();
        assert_well_formed(&bytes);
        let all = names(&bytes);
        assert!(all.iter().any(|n| n == "xl/charts/chart2.xml"), "{all:?}");
        assert!(!all.iter().any(|n| n == "xl/charts/chart3.xml"), "{all:?}");
        let mut none = charts_workbook();
        none.sheets[0].charts.clear();
        let plain = names(&write_xlsx(&none).unwrap());
        assert!(!plain
            .iter()
            .any(|n| n.contains("chart") || n.contains("drawing")));
    }

    /// Writes the sample workbook to CHARTS_SAMPLE_OUT, to open in Excel:
    /// CHARTS_SAMPLE_OUT=E:/claude-scratch/charts-sample.xlsx cargo test -p
    /// conduit-desktop --lib write_charts_sample -- --ignored
    #[test]
    #[ignore]
    fn write_charts_sample() {
        let Ok(out) = std::env::var("CHARTS_SAMPLE_OUT") else {
            return;
        };
        std::fs::write(out, write_xlsx(&charts_workbook()).unwrap()).unwrap();
    }
}
