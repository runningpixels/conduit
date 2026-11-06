//! Native Excel charts for a written .xlsx.
//!
//! IronCalc writes cells, formulas and styles but no charts, so this edits
//! the zip it produced: for each sheet with charts it adds a drawing part
//! (`xl/drawings/drawingN.xml`, one two-cell anchor per chart), a chart part
//! per chart (`xl/charts/chartN.xml`, a DrawingML `c:chartSpace` that refers
//! to the sheet's ranges and caches their computed values), the relationship
//! parts that join them, a `<drawing r:id>` element in the sheet XML and the
//! content-type overrides. A chart whose ranges are gone (`#REF!`) is left out.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use super::{
    charts::{Chart, ChartKind, Range},
    compute::{ComputedChart, ComputedWorkbook},
    spec::{self, Workbook},
};

const NS_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_DRAWING: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const REL_CHART: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const CT_DRAWING: &str = "application/vnd.openxmlformats-officedocument.drawing+xml";
const CT_CHART: &str = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";

/// Series colours, one per series (and per slice of a pie), cycled.
const PALETTE: [&str; 6] = ["4E79A7", "F28E2B", "59A14F", "E15759", "B07AA1", "76B7B2"];
/// A chart covers this many cells from its anchor.
const CHART_COLS: usize = 8;
const CHART_ROWS: usize = 15;

fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            // XML 1.0 has no control characters other than tab, CR, LF.
            c if (c as u32) < 32 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

fn unesc(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// `'Sheet Name'!$B$2:$B$7`: the sheet name always quoted, apostrophes doubled.
pub fn range_ref(sheet: &str, range: &Range) -> String {
    let abs = |r: usize, c: usize| format!("${}${}", spec::col_letters(c), r + 1);
    let quoted = sheet.replace('\'', "''");
    let from = abs(range.row0, range.col0);
    if range.len() == 1 {
        format!("'{quoted}'!{from}")
    } else {
        format!("'{quoted}'!{from}:{}", abs(range.row1, range.col1))
    }
}

fn num(n: f64) -> String {
    format!("{n}")
}

fn series_xml(
    kind: ChartKind,
    i: usize,
    sheet: &str,
    chart: &Chart,
    computed: &ComputedChart,
) -> Option<String> {
    let cat_range = super::charts::stored_range(&chart.categories)?;
    let series = chart.series.get(i)?;
    let val_range = super::charts::stored_range(&series.values)?;
    let data = computed.series.get(i)?;
    let color = PALETTE[i % PALETTE.len()];
    let mut x = String::new();
    x.push_str(&format!(
        "<c:ser><c:idx val=\"{i}\"/><c:order val=\"{i}\"/>"
    ));
    if let Some(name) = &series.name {
        x.push_str(&format!("<c:tx><c:v>{}</c:v></c:tx>", esc(name)));
    }
    match kind {
        ChartKind::Bar => x.push_str(&format!(
            "<c:spPr><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill></c:spPr><c:invertIfNegative val=\"0\"/>"
        )),
        ChartKind::Line => x.push_str(&format!(
            "<c:spPr><a:ln w=\"28575\" cap=\"rnd\"><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill><a:round/></a:ln></c:spPr>\
             <c:marker><c:symbol val=\"circle\"/><c:size val=\"6\"/><c:spPr><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill></c:spPr></c:marker>"
        )),
        ChartKind::Pie => {
            for p in 0..computed.categories.len() {
                let slice = PALETTE[p % PALETTE.len()];
                x.push_str(&format!(
                    "<c:dPt><c:idx val=\"{p}\"/><c:bubble3D val=\"0\"/><c:spPr><a:solidFill><a:srgbClr val=\"{slice}\"/></a:solidFill></c:spPr></c:dPt>"
                ));
            }
        }
    }
    // Labels.
    x.push_str(&format!(
        "<c:cat><c:strRef><c:f>{}</c:f><c:strCache><c:ptCount val=\"{}\"/>",
        esc(&range_ref(sheet, &cat_range)),
        computed.categories.len()
    ));
    for (p, label) in computed.categories.iter().enumerate() {
        x.push_str(&format!(
            "<c:pt idx=\"{p}\"><c:v>{}</c:v></c:pt>",
            esc(label)
        ));
    }
    x.push_str("</c:strCache></c:strRef></c:cat>");
    // Values; a gap has no point.
    x.push_str(&format!(
        "<c:val><c:numRef><c:f>{}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val=\"{}\"/>",
        esc(&range_ref(sheet, &val_range)),
        data.values.len()
    ));
    for (p, value) in data.values.iter().enumerate() {
        if let Some(v) = value {
            x.push_str(&format!("<c:pt idx=\"{p}\"><c:v>{}</c:v></c:pt>", num(*v)));
        }
    }
    x.push_str("</c:numCache></c:numRef></c:val>");
    if kind == ChartKind::Line {
        x.push_str("<c:smooth val=\"0\"/>");
    }
    x.push_str("</c:ser>");
    Some(x)
}

/// The `c:chartSpace` part for one chart, or `None` when it has no real data.
pub fn chart_xml(sheet: &str, chart: &Chart, computed: &ComputedChart) -> Option<String> {
    let mut sers = String::new();
    for i in 0..chart.series.len() {
        sers.push_str(&series_xml(chart.kind, i, sheet, chart, computed)?);
    }
    let mut x = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    x.push_str(&format!(
        "<c:chartSpace xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"{NS_REL}\">"
    ));
    x.push_str("<c:roundedCorners val=\"0\"/><c:chart>");
    if chart.title.is_empty() {
        x.push_str("<c:autoTitleDeleted val=\"1\"/>");
    } else {
        x.push_str(&format!(
            "<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz=\"1400\" b=\"1\"/></a:pPr><a:r><a:rPr lang=\"en-US\" sz=\"1400\" b=\"1\"/><a:t>{}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val=\"0\"/></c:title><c:autoTitleDeleted val=\"0\"/>",
            esc(&chart.title)
        ));
    }
    x.push_str("<c:plotArea><c:layout/>");
    match chart.kind {
        ChartKind::Bar => {
            x.push_str("<c:barChart><c:barDir val=\"col\"/><c:grouping val=\"clustered\"/><c:varyColors val=\"0\"/>");
            x.push_str(&sers);
            x.push_str("<c:gapWidth val=\"150\"/><c:axId val=\"500000001\"/><c:axId val=\"500000002\"/></c:barChart>");
        }
        ChartKind::Line => {
            x.push_str("<c:lineChart><c:grouping val=\"standard\"/><c:varyColors val=\"0\"/>");
            x.push_str(&sers);
            x.push_str("<c:marker val=\"1\"/><c:axId val=\"500000001\"/><c:axId val=\"500000002\"/></c:lineChart>");
        }
        ChartKind::Pie => {
            x.push_str("<c:pieChart><c:varyColors val=\"1\"/>");
            x.push_str(&sers);
            x.push_str("<c:firstSliceAng val=\"0\"/></c:pieChart>");
        }
    }
    if chart.kind != ChartKind::Pie {
        x.push_str(
            "<c:catAx><c:axId val=\"500000001\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"b\"/><c:numFmt formatCode=\"General\" sourceLinked=\"0\"/><c:majorTickMark val=\"out\"/><c:minorTickMark val=\"none\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"500000002\"/><c:crosses val=\"autoZero\"/><c:auto val=\"1\"/><c:lblAlgn val=\"ctr\"/><c:lblOffset val=\"100\"/><c:noMultiLvlLbl val=\"0\"/></c:catAx>\
             <c:valAx><c:axId val=\"500000002\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"l\"/><c:majorGridlines/><c:numFmt formatCode=\"General\" sourceLinked=\"1\"/><c:majorTickMark val=\"out\"/><c:minorTickMark val=\"none\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"500000001\"/><c:crosses val=\"autoZero\"/><c:crossBetween val=\"between\"/></c:valAx>",
        );
    }
    x.push_str("</c:plotArea>");
    if chart.series.len() > 1 || chart.kind == ChartKind::Pie {
        x.push_str("<c:legend><c:legendPos val=\"r\"/><c:overlay val=\"0\"/></c:legend>");
    }
    x.push_str("<c:plotVisOnly val=\"1\"/><c:dispBlanksAs val=\"gap\"/></c:chart></c:chartSpace>");
    Some(x)
}

/// A drawing part with one two-cell anchor per chart; chart `k` is `rId{k+1}`.
fn drawing_xml(charts: &[&Chart]) -> String {
    let mut x = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    x.push_str(&format!(
        "<xdr:wsDr xmlns:xdr=\"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"{NS_REL}\" xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\">"
    ));
    for (k, chart) in charts.iter().enumerate() {
        let (row0, col0) = spec::parse_a1(&chart.anchor).unwrap_or((0, 0));
        x.push_str(&format!(
            "<xdr:twoCellAnchor><xdr:from><xdr:col>{col0}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{row0}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>\
             <xdr:to><xdr:col>{}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>\
             <xdr:graphicFrame macro=\"\"><xdr:nvGraphicFramePr><xdr:cNvPr id=\"{}\" name=\"{}\"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>\
             <xdr:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/></xdr:xfrm>\
             <a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"><c:chart r:id=\"rId{}\"/></a:graphicData></a:graphic>\
             </xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>",
            col0 + CHART_COLS,
            row0 + CHART_ROWS,
            k + 2,
            esc(&format!("Chart {}", k + 1)),
            k + 1,
        ));
    }
    x.push_str("</xdr:wsDr>");
    x
}

fn rels_xml(items: &[(String, &str, String)]) -> String {
    let mut x = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    x.push_str(&format!("<Relationships xmlns=\"{NS_PKG_REL}\">"));
    for (id, kind, target) in items {
        x.push_str(&format!(
            "<Relationship Id=\"{id}\" Type=\"{kind}\" Target=\"{target}\"/>"
        ));
    }
    x.push_str("</Relationships>");
    x
}

/// The value of attribute `name` in an element's start tag text.
fn attr(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let mut from = 0;
    while let Some(at) = tag[from..].find(&needle) {
        let at = from + at;
        let boundary = !tag[..at].chars().last().is_some_and(|c| !c.is_whitespace());
        if boundary {
            let rest = &tag[at + needle.len()..];
            return rest.find('"').map(|end| unesc(&rest[..end]));
        }
        from = at + needle.len();
    }
    None
}

fn start_tags<'a>(xml: &'a str, element: &str) -> Vec<&'a str> {
    let open = format!("<{element} ");
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = xml[from..].find(&open) {
        let at = from + at;
        match xml[at..].find('>') {
            Some(end) => {
                out.push(&xml[at..at + end + 1]);
                from = at + end + 1;
            }
            None => break,
        }
    }
    out
}

/// The zip path of each sheet's part, by sheet name.
fn sheet_parts(files: &HashMap<String, Vec<u8>>) -> Result<HashMap<String, String>, String> {
    let text = |name: &str| -> Result<String, String> {
        files
            .get(name)
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .ok_or_else(|| format!("the .xlsx has no {name}"))
    };
    let workbook = text("xl/workbook.xml")?;
    let rels = text("xl/_rels/workbook.xml.rels")?;
    let targets: HashMap<String, String> = start_tags(&rels, "Relationship")
        .into_iter()
        .filter_map(|tag| Some((attr(tag, "Id")?, attr(tag, "Target")?)))
        .collect();
    let mut out = HashMap::new();
    for tag in start_tags(&workbook, "sheet") {
        let (Some(name), Some(id)) = (attr(tag, "name"), attr(tag, "r:id")) else {
            continue;
        };
        if let Some(target) = targets.get(&id) {
            let path = match target.strip_prefix('/') {
                Some(abs) => abs.to_string(),
                None => format!("xl/{target}"),
            };
            out.insert(name, path);
        }
    }
    Ok(out)
}

/// Insert `<drawing r:id="..."/>` where the schema puts it: after the page
/// setup elements and before legacyDrawing, tableParts and extLst.
fn insert_drawing(sheet_xml: &str, rid: &str) -> Result<String, String> {
    let element = format!("<drawing xmlns:r=\"{NS_REL}\" r:id=\"{rid}\"/>");
    let later = [
        "<legacyDrawing",
        "<legacyDrawingHF",
        "<picture",
        "<oleObjects",
        "<controls",
        "<webPublishItems",
        "<tableParts",
        "<extLst",
        "</worksheet>",
    ];
    let at = later
        .iter()
        .filter_map(|tag| sheet_xml.rfind(tag))
        // `rfind` could land on a nested tag of the same name; the earliest
        // top-level match is what counts, and these are not nested in cells.
        .min()
        .ok_or("the sheet XML has no closing </worksheet>")?;
    let mut out = String::with_capacity(sheet_xml.len() + element.len());
    out.push_str(&sheet_xml[..at]);
    out.push_str(&element);
    out.push_str(&sheet_xml[at..]);
    Ok(out)
}

/// Add the charts of `workbook` to the .xlsx in `xlsx`.
pub fn add_charts(
    xlsx: Vec<u8>,
    workbook: &Workbook,
    computed: &ComputedWorkbook,
) -> Result<Vec<u8>, String> {
    // (sheet name, [(chart, computed)]) for sheets with a drawable chart.
    let mut work: Vec<(&str, Vec<(&Chart, &ComputedChart)>)> = Vec::new();
    for sheet in &workbook.sheets {
        let Some(csheet) = computed.sheet(&sheet.name) else {
            continue;
        };
        let items: Vec<(&Chart, &ComputedChart)> = sheet
            .charts
            .iter()
            .filter_map(|c| {
                let cc = csheet.charts.iter().find(|cc| cc.id == c.id)?;
                (cc.error.is_none() && c.error().is_none()).then_some((c, cc))
            })
            .collect();
        if !items.is_empty() {
            work.push((&sheet.name, items));
        }
    }
    if work.is_empty() {
        return Ok(xlsx);
    }

    let mut archive = zip::ZipArchive::new(Cursor::new(xlsx))
        .map_err(|e| format!("could not read the .xlsx to add charts: {e}"))?;
    let mut order = Vec::new();
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("could not read the .xlsx to add charts: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry
            .name()
            .map_err(|e| format!("could not read the .xlsx to add charts: {e}"))?
            .to_string();
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("could not read the .xlsx to add charts: {e}"))?;
        order.push(name.clone());
        files.insert(name, bytes);
    }

    let parts = sheet_parts(&files)?;
    let mut overrides = String::new();
    let mut chart_no = 0usize;
    for (d, (sheet_name, items)) in work.iter().enumerate() {
        let drawing_no = d + 1;
        let sheet_path = parts
            .get(*sheet_name)
            .ok_or_else(|| format!("the .xlsx has no part for sheet '{sheet_name}'"))?
            .clone();

        let mut drawing_rels = Vec::new();
        for (k, (chart, computed_chart)) in items.iter().enumerate() {
            chart_no += 1;
            let xml = chart_xml(sheet_name, chart, computed_chart)
                .ok_or_else(|| format!("chart '{}' has no data to write", chart.id))?;
            let path = format!("xl/charts/chart{chart_no}.xml");
            files.insert(path.clone(), xml.into_bytes());
            order.push(path);
            overrides.push_str(&format!(
                "<Override PartName=\"/xl/charts/chart{chart_no}.xml\" ContentType=\"{CT_CHART}\"/>"
            ));
            drawing_rels.push((
                format!("rId{}", k + 1),
                REL_CHART,
                format!("../charts/chart{chart_no}.xml"),
            ));
        }
        let only: Vec<&Chart> = items.iter().map(|(c, _)| *c).collect();
        let drawing_path = format!("xl/drawings/drawing{drawing_no}.xml");
        let drawing_rels_path = format!("xl/drawings/_rels/drawing{drawing_no}.xml.rels");
        files.insert(drawing_path.clone(), drawing_xml(&only).into_bytes());
        files.insert(
            drawing_rels_path.clone(),
            rels_xml(&drawing_rels).into_bytes(),
        );
        order.push(drawing_path);
        order.push(drawing_rels_path);
        overrides.push_str(&format!(
            "<Override PartName=\"/xl/drawings/drawing{drawing_no}.xml\" ContentType=\"{CT_DRAWING}\"/>"
        ));

        // The sheet's own relationships: add one, keeping any that exist.
        let (dir, file) = sheet_path
            .rsplit_once('/')
            .ok_or_else(|| format!("odd sheet path {sheet_path}"))?;
        let sheet_rels_path = format!("{dir}/_rels/{file}.rels");
        let target = format!("../drawings/drawing{drawing_no}.xml");
        let rid = match files.get(&sheet_rels_path) {
            Some(existing) => {
                let text = String::from_utf8_lossy(existing).into_owned();
                let used: Vec<usize> = start_tags(&text, "Relationship")
                    .into_iter()
                    .filter_map(|t| attr(t, "Id")?.strip_prefix("rId")?.parse().ok())
                    .collect();
                let rid = format!("rId{}", used.iter().max().map_or(1, |m| m + 1));
                let relationship = format!(
                    "<Relationship Id=\"{rid}\" Type=\"{REL_DRAWING}\" Target=\"{target}\"/>"
                );
                let at = text
                    .rfind("</Relationships>")
                    .ok_or("the sheet relationships part is malformed")?;
                let updated = format!("{}{}{}", &text[..at], relationship, &text[at..]);
                files.insert(sheet_rels_path.clone(), updated.into_bytes());
                rid
            }
            None => {
                files.insert(
                    sheet_rels_path.clone(),
                    rels_xml(&[("rId1".to_string(), REL_DRAWING, target)]).into_bytes(),
                );
                order.push(sheet_rels_path);
                "rId1".to_string()
            }
        };
        let sheet_xml = String::from_utf8_lossy(
            files
                .get(&sheet_path)
                .ok_or_else(|| format!("the .xlsx has no {sheet_path}"))?,
        )
        .into_owned();
        let updated = insert_drawing(&sheet_xml, &rid)?;
        files.insert(sheet_path, updated.into_bytes());
    }

    // Content types.
    let ct = String::from_utf8_lossy(
        files
            .get("[Content_Types].xml")
            .ok_or("the .xlsx has no [Content_Types].xml")?,
    )
    .into_owned();
    let at = ct
        .rfind("</Types>")
        .ok_or("[Content_Types].xml is malformed")?;
    files.insert(
        "[Content_Types].xml".to_string(),
        format!("{}{}{}", &ct[..at], overrides, &ct[at..]).into_bytes(),
    );

    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for name in &order {
        let Some(bytes) = files.get(name) else {
            continue;
        };
        writer
            .start_file(name.as_str(), options)
            .map_err(|e| format!("could not write the .xlsx: {e}"))?;
        writer
            .write_all(bytes)
            .map_err(|e| format!("could not write the .xlsx: {e}"))?;
    }
    let out = writer
        .finish()
        .map_err(|e| format!("could not write the .xlsx: {e}"))?;
    Ok(out.into_inner())
}
