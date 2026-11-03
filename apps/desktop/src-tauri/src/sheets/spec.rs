//! The workbook spec: the JSON a model writes, the types it normalises into,
//! and the validation that rejects what a spreadsheet can't hold.
//!
//! Pure: no database, no IronCalc. Every error names the sheet and, where it
//! applies, the cell (A1), so a model can fix the one thing that is wrong.

use serde_json::{Map, Value};

pub const MAX_SHEETS: usize = 20;
pub const MAX_ROWS: usize = 5_000;
pub const MAX_COLS: usize = 100;
pub const MAX_CELLS: usize = 100_000;
pub const MAX_FORMULA_CHARS: usize = 2_000;
/// Excel's limit for the text in one cell.
pub const MAX_STRING_CHARS: usize = 32_767;
pub const MAX_FORMAT_CHARS: usize = 64;
pub const MAX_SHEET_NAME_CHARS: usize = 31;
pub const MAX_COLUMN_WIDTH: f64 = 255.0;

/// Functions that reach outside the workbook or the machine.
const FORBIDDEN_FUNCTIONS: [&str; 9] = [
    "WEBSERVICE",
    "FILTERXML",
    "HYPERLINK",
    "CALL",
    "REGISTER.ID",
    "REGISTER",
    "RTD",
    "INFO",
    "CELL",
];

/// How far down a header label may sit and still lend its format to the
/// column (`Sheet::effective_format`): a title, a blank row, then headers.
const HEADER_ROWS: usize = 10;

/// The named number formats and the Excel format each stands for.
const NAMED_FORMATS: [(&str, &str); 8] = [
    ("currency", "$#,##0.00"),
    ("currency0", "$#,##0"),
    ("percent", "0%"),
    ("percent1", "0.0%"),
    ("integer", "#,##0"),
    ("decimal", "#,##0.00"),
    ("date", "yyyy-mm-dd"),
    ("text", "@"),
];

/// Currencies a workbook can name (`"currency": "EUR"`), with the formats
/// `currency` and `currency0` stand for in it. Letters are quoted: IronCalc
/// can't read a bare `R$` or `kr`.
const CURRENCIES: [(&str, &str, &str); 16] = [
    ("USD", "$#,##0.00", "$#,##0"),
    ("EUR", "#,##0.00 €", "#,##0 €"),
    ("GBP", "£#,##0.00", "£#,##0"),
    ("JPY", "¥#,##0", "¥#,##0"),
    ("CNY", "¥#,##0.00", "¥#,##0"),
    ("KRW", "₩#,##0", "₩#,##0"),
    ("BRL", "\"R$\" #,##0.00", "\"R$\" #,##0"),
    ("INR", "₹#,##0.00", "₹#,##0"),
    ("CHF", "\"CHF\" #,##0.00", "\"CHF\" #,##0"),
    ("CAD", "$#,##0.00", "$#,##0"),
    ("AUD", "$#,##0.00", "$#,##0"),
    ("MXN", "$#,##0.00", "$#,##0"),
    ("SEK", "#,##0.00 \"kr\"", "#,##0 \"kr\""),
    ("NOK", "#,##0.00 \"kr\"", "#,##0 \"kr\""),
    ("DKK", "#,##0.00 \"kr\"", "#,##0 \"kr\""),
    ("PLN", "#,##0.00 \"zł\"", "#,##0 \"zł\""),
];

/// Symbols that mark a custom format as money, for `Workbook::money_formats`.
const MONEY_SYMBOLS: [&str; 15] = [
    "$", "€", "£", "¥", "₩", "₹", "円", "元", "₽", "₺", "₫", "₱", "฿", "zł", "kr",
];

/// The ISO code for a workbook's `currency`, given as a code or a symbol
/// that names one currency.
fn currency_code(value: &str) -> Result<&'static str, String> {
    let wanted = match value.trim() {
        "€" => "EUR",
        "£" => "GBP",
        "₩" => "KRW",
        "₹" => "INR",
        "R$" => "BRL",
        "円" => "JPY",
        "元" => "CNY",
        other => other,
    }
    .to_uppercase();
    CURRENCIES
        .iter()
        .find(|(code, _, _)| *code == wanted)
        .map(|(code, _, _)| *code)
        .ok_or_else(|| {
            let codes: Vec<&str> = CURRENCIES.iter().map(|(c, _, _)| *c).collect();
            format!(
                "currency '{value}' isn't one this app knows; use an ISO code: {}. For another currency leave it out and use an Excel format such as #,##0.00 \"€\"",
                codes.join(", ")
            )
        })
}

/// The formats `currency` and `currency0` stand for: (two decimals, none).
#[derive(Debug, Clone, PartialEq)]
pub struct MoneyFormats {
    pub currency: String,
    pub currency0: String,
}

impl Default for MoneyFormats {
    fn default() -> Self {
        MoneyFormats {
            currency: NAMED_FORMATS[0].1.to_string(),
            currency0: NAMED_FORMATS[1].1.to_string(),
        }
    }
}

/// The Excel number-format string for a spec format (a named one or a custom
/// string, which passes through), with `currency` in US dollars.
pub fn excel_format(format: &str) -> String {
    excel_format_in(format, &MoneyFormats::default())
}

/// As `excel_format`, with `currency` and `currency0` in a workbook's money.
pub fn excel_format_in(format: &str, money: &MoneyFormats) -> String {
    match format {
        "currency" => quote_symbols(&money.currency),
        "currency0" => quote_symbols(&money.currency0),
        _ => NAMED_FORMATS
            .iter()
            .find(|(name, _)| *name == format)
            .map(|(_, excel)| (*excel).to_string())
            .unwrap_or_else(|| quote_symbols(format)),
    }
}

/// A custom format that shows money: it has a digit placeholder and a
/// currency symbol.
fn is_money_format(format: &str) -> bool {
    !NAMED_FORMATS.iter().any(|(name, _)| *name == format)
        && format.contains(['0', '#'])
        && MONEY_SYMBOLS.iter().any(|s| format.contains(s))
}

/// `#,##0.00 "€"` without its decimals: `#,##0 "€"`.
fn without_decimals(format: &str) -> String {
    let mut out = String::with_capacity(format.len());
    let mut chars = format.chars().peekable();
    let mut quoted = false;
    while let Some(ch) = chars.next() {
        if ch == '"' {
            quoted = !quoted;
        }
        if !quoted && ch == '.' && chars.peek() == Some(&'0') {
            while chars.peek() == Some(&'0') {
                chars.next();
            }
            continue;
        }
        out.push(ch);
    }
    out
}

/// Quotes non-ASCII literals such as ¥ or 円 outside quotes and `[...]`:
/// Excel accepts `¥#,##0` bare, but IronCalc's formatter can't read it and
/// shows #VALUE!. `"¥"#,##0` means the same to both.
///
/// Runs of ASCII letters are literals too (`R$`, `CHF`, `kr`), except date
/// and time codes (`yyyy`, `mm`, `h`), AM/PM, `General` and an exponent `E+`.
fn quote_symbols(format: &str) -> String {
    let chars: Vec<char> = format.chars().collect();
    // Which letters are literal text, decided per run of letters.
    let mut letter_literal = vec![false; chars.len()];
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i].is_ascii_alphabetic() {
            i += 1;
        }
        let run: String = chars[start..i].iter().collect();
        let lower = run.to_ascii_lowercase();
        let code = lower.chars().all(|c| "dmyhs".contains(c))
            || matches!(lower.as_str(), "am" | "pm" | "a" | "p" | "general")
            || (lower == "e" && matches!(chars.get(i), Some('+' | '-')));
        letter_literal[start..i].fill(!code);
    }
    let mut out = String::with_capacity(format.len() + 4);
    let (mut quoted, mut bracket, mut escaped, mut open) = (false, false, false, false);
    for (k, &ch) in chars.iter().enumerate() {
        let literal = (!ch.is_ascii() || letter_literal[k]) && !quoted && !bracket && !escaped;
        if literal != open {
            out.push('"');
            open = literal;
        }
        out.push(ch);
        if escaped {
            escaped = false;
        } else if !open {
            match ch {
                '"' => quoted = !quoted,
                '[' if !quoted => bracket = true,
                ']' if !quoted => bracket = false,
                '\\' if !quoted && !bracket => escaped = true,
                _ => {}
            }
        }
    }
    if open {
        out.push('"');
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub enum Scalar {
    Number(f64),
    Text(String),
    Bool(bool),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellStyle {
    Header,
    Input,
    Total,
    Note,
    Good,
    Bad,
}

impl CellStyle {
    pub const ALL: [CellStyle; 6] = [
        CellStyle::Header,
        CellStyle::Input,
        CellStyle::Total,
        CellStyle::Note,
        CellStyle::Good,
        CellStyle::Bad,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CellStyle::Header => "header",
            CellStyle::Input => "input",
            CellStyle::Total => "total",
            CellStyle::Note => "note",
            CellStyle::Good => "good",
            CellStyle::Bad => "bad",
        }
    }

    pub fn parse(s: &str) -> Option<CellStyle> {
        CellStyle::ALL.into_iter().find(|style| style.as_str() == s)
    }
}

/// One cell, normalised. A blank cell has every field `None`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Cell {
    pub value: Option<Scalar>,
    /// With the leading `=`.
    pub formula: Option<String>,
    /// As written: a named format or an Excel format string.
    pub format: Option<String>,
    pub style: Option<CellStyle>,
}

impl Cell {
    pub fn is_blank(&self) -> bool {
        self.value.is_none()
            && self.formula.is_none()
            && self.format.is_none()
            && self.style.is_none()
    }

    /// Holds a value or a formula (styles and formats alone don't count).
    pub fn has_content(&self) -> bool {
        self.value.is_some() || self.formula.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ColumnSpec {
    /// In characters.
    pub width: Option<f64>,
    pub format: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Sheet {
    pub name: String,
    pub columns: Vec<ColumnSpec>,
    pub freeze_header: bool,
    pub hidden: bool,
    pub rows: Vec<Vec<Cell>>,
}

impl Sheet {
    /// Rows up to the last one that holds anything.
    pub fn used_rows(&self) -> usize {
        self.rows
            .iter()
            .rposition(|row| row.iter().any(|c| !c.is_blank()))
            .map_or(0, |i| i + 1)
    }

    /// Columns up to the last one that holds anything in any row.
    pub fn used_cols(&self) -> usize {
        self.rows
            .iter()
            .filter_map(|row| row.iter().rposition(|c| !c.is_blank()).map(|i| i + 1))
            .max()
            .unwrap_or(0)
    }

    pub fn cell(&self, row0: usize, col0: usize) -> Option<&Cell> {
        self.rows.get(row0).and_then(|r| r.get(col0))
    }

    /// The cell at (row0, col0), growing the sheet to hold it.
    pub fn cell_mut(&mut self, row0: usize, col0: usize) -> &mut Cell {
        if self.rows.len() <= row0 {
            self.rows.resize_with(row0 + 1, Vec::new);
        }
        let row = &mut self.rows[row0];
        if row.len() <= col0 {
            row.resize_with(col0 + 1, Cell::default);
        }
        &mut row[col0]
    }

    /// The format a cell shows with: its own, else its column's, else its
    /// header's. Models often put a column's format on the header label, which
    /// can't show it, meaning the cells below.
    pub fn effective_format(&self, row0: usize, col0: usize) -> Option<&str> {
        self.cell(row0, col0)
            .and_then(|c| c.format.as_deref())
            .or_else(|| self.columns.get(col0).and_then(|c| c.format.as_deref()))
            .or_else(|| self.header_format(row0, col0))
    }

    /// The format on the nearest text label above (row0, col0) within the
    /// first `HEADER_ROWS` rows, unless that format is text.
    fn header_format(&self, row0: usize, col0: usize) -> Option<&str> {
        (0..row0.min(HEADER_ROWS)).rev().find_map(|r| {
            let cell = self.cell(r, col0)?;
            match (&cell.value, cell.format.as_deref()) {
                (Some(Scalar::Text(_)), Some(f)) if !matches!(f, "text" | "@") => Some(f),
                _ => None,
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Workbook {
    pub sheets: Vec<Sheet>,
    /// ISO code of the money `currency` and `currency0` show, if named.
    pub currency: Option<String>,
}

impl Workbook {
    /// What `currency` and `currency0` stand for here: the workbook's own
    /// currency if it names one, else the money format its cells already use
    /// (so a row a model adds in `currency` matches a euro sheet), else US
    /// dollars.
    pub fn money_formats(&self) -> MoneyFormats {
        if let Some((_, two, none)) = self
            .currency
            .as_deref()
            .and_then(|code| CURRENCIES.iter().find(|(c, _, _)| *c == code))
        {
            return MoneyFormats {
                currency: (*two).to_string(),
                currency0: (*none).to_string(),
            };
        }
        let used = self.sheets.iter().find_map(|sheet| {
            sheet
                .columns
                .iter()
                .filter_map(|c| c.format.as_deref())
                .chain(
                    sheet
                        .rows
                        .iter()
                        .flatten()
                        .filter_map(|c| c.format.as_deref()),
                )
                .find(|f| is_money_format(f))
        });
        match used {
            Some(format) => MoneyFormats {
                currency: format.to_string(),
                currency0: without_decimals(format),
            },
            None => MoneyFormats::default(),
        }
    }

    pub fn sheet_index(&self, name: &str) -> Option<usize> {
        let wanted = name.trim().to_lowercase();
        self.sheets
            .iter()
            .position(|s| s.name.to_lowercase() == wanted)
    }

    /// The sheet called `name` (case-insensitive), or an error listing the
    /// sheets that exist.
    pub fn find_sheet(&self, name: &str) -> Result<usize, String> {
        self.sheet_index(name).ok_or_else(|| {
            let names: Vec<&str> = self.sheets.iter().map(|s| s.name.as_str()).collect();
            format!("No sheet called '{name}'. Sheets: {}.", names.join(", "))
        })
    }

    /// Parse the `{"sheets": [...]}` object a model passes, or a stored spec.
    pub fn from_value(value: &Value) -> Result<Workbook, String> {
        let sheets = value
            .get("sheets")
            .and_then(Value::as_array)
            .ok_or("sheets must be an array of sheets, each with a name and rows")?;
        let mut workbook = Workbook::default();
        for (i, sheet) in sheets.iter().enumerate() {
            workbook.sheets.push(parse_sheet(sheet, i)?);
        }
        workbook.currency = match value.get("currency") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.trim().is_empty() => None,
            Some(Value::String(s)) => Some(currency_code(s)?.to_string()),
            Some(_) => return Err("currency must be text, an ISO code such as EUR".to_string()),
        };
        validate(&workbook)?;
        Ok(workbook)
    }

    /// The stored JSON form: bare values where a cell has nothing else.
    pub fn to_value(&self) -> Value {
        let sheets = self.sheets.iter().map(sheet_to_value).collect::<Vec<_>>();
        let mut out = serde_json::json!({ "sheets": sheets });
        if let Some(code) = &self.currency {
            out["currency"] = Value::String(code.clone());
        }
        out
    }
}

// ---------------------------------------------------------------------------
// A1 references
// ---------------------------------------------------------------------------

/// Column letters for a 0-based column index (0 -> "A", 26 -> "AA").
pub fn col_letters(col0: usize) -> String {
    let mut n = col0 + 1;
    let mut out = Vec::new();
    while n > 0 {
        n -= 1;
        out.push(b'A' + (n % 26) as u8);
        n /= 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// A1 text for 0-based (row, col).
pub fn a1(row0: usize, col0: usize) -> String {
    format!("{}{}", col_letters(col0), row0 + 1)
}

/// Parse `B2` (any case, optional `$`) into 0-based (row, col).
pub fn parse_a1(text: &str) -> Option<(usize, usize)> {
    let text = text.trim().replace('$', "");
    let split = text.find(|c: char| c.is_ascii_digit())?;
    let (letters, digits) = text.split_at(split);
    if letters.is_empty() || !letters.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    if !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut col = 0usize;
    for c in letters.chars() {
        col = col
            .checked_mul(26)?
            .checked_add((c.to_ascii_uppercase() as u8 - b'A') as usize + 1)?;
        if col > 20_000 {
            return None;
        }
    }
    let row: usize = digits.parse().ok()?;
    if row == 0 || row > 2_000_000 {
        return None;
    }
    Some((row - 1, col - 1))
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn parse_sheet(value: &Value, index: usize) -> Result<Sheet, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| format!("sheet {} must be an object with a name and rows", index + 1))?;
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("sheet {} needs a name", index + 1))?
        .trim()
        .to_string();
    check_sheet_name(&name)?;
    let columns = match obj.get("columns") {
        None | Some(Value::Null) => Vec::new(),
        Some(v) => parse_columns(v, &name)?,
    };
    let rows = match obj.get("rows") {
        None | Some(Value::Null) => Vec::new(),
        Some(v) => parse_rows(v, &name, 0, 0)?,
    };
    Ok(Sheet {
        name: name.clone(),
        columns,
        freeze_header: optional_bool(obj, "freeze_header", &name)?,
        hidden: optional_bool(obj, "hidden", &name)?,
        rows,
    })
}

fn optional_bool(obj: &Map<String, Value>, key: &str, sheet: &str) -> Result<bool, String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("Sheet '{sheet}': {key} must be true or false")),
    }
}

/// Column settings from column A.
pub fn parse_columns(value: &Value, sheet: &str) -> Result<Vec<ColumnSpec>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| format!("Sheet '{sheet}': columns must be an array"))?;
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let col = col_letters(i);
            match item {
                Value::Null => Ok(ColumnSpec::default()),
                Value::Object(o) => {
                    let width = match o.get("width") {
                        None | Some(Value::Null) => None,
                        Some(w) => {
                            let w = w.as_f64().ok_or_else(|| {
                                format!("Sheet '{sheet}' column {col}: width must be a number")
                            })?;
                            if !(w > 0.0 && w <= MAX_COLUMN_WIDTH) {
                                return Err(format!(
                                    "Sheet '{sheet}' column {col}: width must be between 0 and {MAX_COLUMN_WIDTH} characters"
                                ));
                            }
                            Some(w)
                        }
                    };
                    let format = match o.get("format") {
                        None | Some(Value::Null) => None,
                        Some(f) => Some(check_format(f, &format!("Sheet '{sheet}' column {col}"))?),
                    };
                    Ok(ColumnSpec { width, format })
                }
                _ => Err(format!(
                    "Sheet '{sheet}' column {col}: expected an object like {{\"width\": 12, \"format\": \"currency\"}}"
                )),
            }
        })
        .collect()
}

/// A block of rows. `row0`/`col0` are where the block's first cell lands
/// (0-based), so an error names the cell as it sits in the sheet.
pub fn parse_rows(
    value: &Value,
    sheet: &str,
    row0: usize,
    col0: usize,
) -> Result<Vec<Vec<Cell>>, String> {
    let rows = value
        .as_array()
        .ok_or_else(|| format!("Sheet '{sheet}': rows must be an array of rows"))?;
    // A flat array of cells is one row: a row is always an array, so this
    // can't be read any other way.
    let single;
    let rows = if !rows.is_empty() && rows.iter().all(|r| !r.is_array()) {
        single = [value.clone()];
        &single[..]
    } else {
        &rows[..]
    };
    rows.iter()
        .enumerate()
        .map(|(r, row)| {
            let cells = row.as_array().ok_or_else(|| {
                format!(
                    "Sheet '{sheet}' row {}: expected an array of cells, got {}",
                    row0 + r + 1,
                    type_name(row)
                )
            })?;
            cells
                .iter()
                .enumerate()
                .map(|(c, cell)| parse_cell(cell, sheet, row0 + r, col0 + c))
                .collect()
        })
        .collect()
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

fn scalar(value: &Value, at: &str) -> Result<Option<Scalar>, String> {
    match value {
        Value::Null => Ok(None),
        Value::Bool(b) => Ok(Some(Scalar::Bool(*b))),
        Value::Number(n) => {
            let n = n.as_f64().filter(|n| n.is_finite());
            n.map(|n| Some(Scalar::Number(n)))
                .ok_or_else(|| format!("{at}: number out of range"))
        }
        Value::String(s) => {
            if s.chars().count() > MAX_STRING_CHARS {
                return Err(format!(
                    "{at}: text is longer than {MAX_STRING_CHARS} characters"
                ));
            }
            // Strings are always literal text, whatever they start with. An
            // empty one is an empty cell.
            Ok(if s.is_empty() {
                None
            } else {
                Some(Scalar::Text(s.clone()))
            })
        }
        other => Err(format!(
            "{at}: a value must be a number, text or true/false, got {}",
            type_name(other)
        )),
    }
}

fn check_format(value: &Value, at: &str) -> Result<String, String> {
    let s = value
        .as_str()
        .ok_or_else(|| format!("{at}: format must be text"))?
        .trim();
    if s.is_empty() {
        return Err(format!("{at}: format is empty"));
    }
    if s.chars().count() > MAX_FORMAT_CHARS {
        return Err(format!(
            "{at}: format is longer than {MAX_FORMAT_CHARS} characters"
        ));
    }
    if s.chars().any(|c| (c as u32) < 32) {
        return Err(format!("{at}: format has control characters"));
    }
    Ok(s.to_string())
}

pub fn parse_cell(value: &Value, sheet: &str, row0: usize, col0: usize) -> Result<Cell, String> {
    let at = format!("Sheet '{sheet}' cell {}", a1(row0, col0));
    match value {
        Value::Object(obj) => {
            for key in obj.keys() {
                if !matches!(key.as_str(), "value" | "formula" | "format" | "style") {
                    return Err(format!(
                        "{at}: unknown field '{key}' (a cell object has value or formula, and optionally format and style)"
                    ));
                }
            }
            let formula = match obj.get("formula") {
                None | Some(Value::Null) => None,
                Some(Value::String(f)) => Some(check_formula(f, &at)?),
                Some(_) => return Err(format!("{at}: formula must be text starting with =")),
            };
            // With a formula, a value is the model's guess at its result:
            // the formula wins.
            let value = match obj.get("value") {
                None => None,
                Some(_) if formula.is_some() => None,
                Some(v) => scalar(v, &at)?,
            };
            let format = match obj.get("format") {
                None | Some(Value::Null) => None,
                Some(f) => Some(check_format(f, &at)?),
            };
            let style = match obj.get("style") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(CellStyle::parse(s).ok_or_else(|| {
                    format!(
                        "{at}: unknown style '{s}' (use header, input, total, note, good or bad)"
                    )
                })?),
                Some(_) => return Err(format!("{at}: style must be text")),
            };
            Ok(Cell {
                value,
                formula,
                format,
                style,
            })
        }
        Value::Array(_) => Err(format!(
            "{at}: a cell can't be an array; rows is an array of rows, each an array of cells"
        )),
        other => Ok(Cell {
            value: scalar(other, &at)?,
            ..Cell::default()
        }),
    }
}

/// Normalise and check a formula: it gets its leading `=` if the model left
/// it off, and must be within the length and safety rules.
fn check_formula(formula: &str, at: &str) -> Result<String, String> {
    let trimmed = formula.trim();
    let body = trimmed.strip_prefix('=').unwrap_or(trimmed).trim();
    if body.is_empty() {
        return Err(format!("{at}: formula is empty"));
    }
    let formula = format!("={body}");
    if formula.chars().count() > MAX_FORMULA_CHARS {
        return Err(format!(
            "{at}: formula is longer than {MAX_FORMULA_CHARS} characters"
        ));
    }
    check_formula_safety(&formula).map_err(|why| format!("{at}: {why}"))?;
    Ok(formula)
}

/// Reject functions and references that reach outside the workbook.
pub fn check_formula_safety(formula: &str) -> Result<(), String> {
    let chars: Vec<char> = formula.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            // A string literal: "" is an escaped quote. Anything goes inside
            // (TEXT(A1,"[h]:mm") is fine).
            '"' => {
                i += 1;
                while i < chars.len() {
                    if chars[i] == '"' {
                        if chars.get(i + 1) == Some(&'"') {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            // A quoted sheet name: a path in it means another workbook.
            '\'' => {
                let mut name = String::new();
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\'' {
                        if chars.get(i + 1) == Some(&'\'') {
                            name.push('\'');
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    name.push(chars[i]);
                    i += 1;
                }
                i += 1;
                if name.contains(['\\', '/', ':']) {
                    return Err(format!(
                        "references to other files aren't allowed ('{name}'!)"
                    ));
                }
            }
            '[' => {
                return Err(
                    "external workbook references ([...]) aren't allowed; refer to a sheet in this workbook"
                        .to_string(),
                )
            }
            '|' => return Err("'|' (a DDE reference) isn't allowed in a formula".to_string()),
            c if c.is_alphabetic() || c == '_' => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '.')
                {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                let mut next = i;
                while chars.get(next) == Some(&' ') {
                    next += 1;
                }
                if chars.get(next) == Some(&'(') {
                    let upper = word.to_uppercase();
                    let upper = upper.strip_prefix("_XLFN.").unwrap_or(&upper);
                    if FORBIDDEN_FUNCTIONS.contains(&upper) {
                        return Err(format!(
                            "{upper} isn't allowed (it reaches outside the workbook); calculate it with other functions"
                        ));
                    }
                }
            }
            _ => i += 1,
        }
    }
    Ok(())
}

/// 1–31 characters, none of `[]:*?/\`, no edge apostrophes.
pub fn check_sheet_name(name: &str) -> Result<(), String> {
    let count = name.chars().count();
    if name.trim().is_empty() {
        return Err("a sheet name can't be empty".to_string());
    }
    if count > MAX_SHEET_NAME_CHARS {
        return Err(format!(
            "Sheet name '{name}' is {count} characters; the limit is {MAX_SHEET_NAME_CHARS}"
        ));
    }
    if let Some(bad) = name.chars().find(|c| "[]:*?/\\".contains(*c)) {
        return Err(format!(
            "Sheet name '{name}' has '{bad}'; names can't contain [ ] : * ? / \\"
        ));
    }
    if name.starts_with('\'') || name.ends_with('\'') {
        return Err(format!(
            "Sheet name '{name}' can't start or end with an apostrophe"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// The workbook-level rules: counts, unique names, something visible.
pub fn validate(workbook: &Workbook) -> Result<(), String> {
    if workbook.sheets.is_empty() {
        return Err("A spreadsheet needs at least one sheet".to_string());
    }
    if workbook.sheets.len() > MAX_SHEETS {
        return Err(format!(
            "{} sheets; the limit is {MAX_SHEETS}",
            workbook.sheets.len()
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut cells = 0usize;
    for sheet in &workbook.sheets {
        check_sheet_name(&sheet.name)?;
        if !seen.insert(sheet.name.to_lowercase()) {
            return Err(format!(
                "Sheet name '{}' is used twice (names are compared ignoring case)",
                sheet.name
            ));
        }
        let rows = sheet.used_rows();
        if rows > MAX_ROWS {
            return Err(format!(
                "Sheet '{}' has {rows} rows (A{}); the limit is {MAX_ROWS}",
                sheet.name,
                MAX_ROWS + 1
            ));
        }
        let cols = sheet.used_cols().max(sheet.columns.len());
        if cols > MAX_COLS {
            return Err(format!(
                "Sheet '{}' has {cols} columns ({}1); the limit is {MAX_COLS}",
                sheet.name,
                col_letters(MAX_COLS)
            ));
        }
        cells += sheet
            .rows
            .iter()
            .flatten()
            .filter(|c| c.has_content())
            .count();
    }
    if cells > MAX_CELLS {
        return Err(format!(
            "{cells} filled cells; the limit is {MAX_CELLS} per workbook"
        ));
    }
    if workbook.sheets.iter().all(|s| s.hidden) {
        return Err("At least one sheet must be visible".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

fn number_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

fn scalar_value(s: &Scalar) -> Value {
    match s {
        Scalar::Number(n) => number_value(*n),
        Scalar::Text(t) => Value::String(t.clone()),
        Scalar::Bool(b) => Value::Bool(*b),
    }
}

pub fn cell_to_value(cell: &Cell) -> Value {
    if cell.is_blank() {
        return Value::Null;
    }
    if cell.formula.is_none() && cell.format.is_none() && cell.style.is_none() {
        if let Some(v) = &cell.value {
            return scalar_value(v);
        }
    }
    let mut obj = Map::new();
    if let Some(f) = &cell.formula {
        obj.insert("formula".into(), Value::String(f.clone()));
    }
    if let Some(v) = &cell.value {
        obj.insert("value".into(), scalar_value(v));
    }
    if let Some(f) = &cell.format {
        obj.insert("format".into(), Value::String(f.clone()));
    }
    if let Some(s) = cell.style {
        obj.insert("style".into(), Value::String(s.as_str().to_string()));
    }
    Value::Object(obj)
}

fn sheet_to_value(sheet: &Sheet) -> Value {
    let mut obj = Map::new();
    obj.insert("name".into(), Value::String(sheet.name.clone()));
    if !sheet.columns.is_empty() {
        let cols = sheet
            .columns
            .iter()
            .map(|c| {
                let mut o = Map::new();
                if let Some(w) = c.width {
                    o.insert("width".into(), number_value(w));
                }
                if let Some(f) = &c.format {
                    o.insert("format".into(), Value::String(f.clone()));
                }
                Value::Object(o)
            })
            .collect();
        obj.insert("columns".into(), Value::Array(cols));
    }
    if sheet.freeze_header {
        obj.insert("freeze_header".into(), Value::Bool(true));
    }
    if sheet.hidden {
        obj.insert("hidden".into(), Value::Bool(true));
    }
    let used = sheet.used_rows();
    let rows = sheet.rows[..used]
        .iter()
        .map(|row| {
            let end = row.iter().rposition(|c| !c.is_blank()).map_or(0, |i| i + 1);
            Value::Array(row[..end].iter().map(cell_to_value).collect())
        })
        .collect();
    obj.insert("rows".into(), Value::Array(rows));
    Value::Object(obj)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wb(sheets: Value) -> Result<Workbook, String> {
        Workbook::from_value(&json!({ "sheets": sheets }))
    }

    #[test]
    fn a1_round_trips() {
        assert_eq!(a1(0, 0), "A1");
        assert_eq!(a1(9, 27), "AB10");
        assert_eq!(parse_a1("ab10"), Some((9, 27)));
        assert_eq!(parse_a1("$C$3"), Some((2, 2)));
        assert_eq!(parse_a1("A0"), None);
        assert_eq!(parse_a1("12"), None);
        assert_eq!(parse_a1("A1B"), None);
    }

    #[test]
    fn bare_values_become_cells() {
        let w = wb(json!([{ "name": "S", "rows": [
            ["a", 1, true, null, "", { "value": 2, "format": "currency", "style": "input" },
             { "formula": "SUM(A1:A2)" }]
        ]}]))
        .unwrap();
        let row = &w.sheets[0].rows[0];
        assert_eq!(row[0].value, Some(Scalar::Text("a".into())));
        assert_eq!(row[1].value, Some(Scalar::Number(1.0)));
        assert_eq!(row[2].value, Some(Scalar::Bool(true)));
        assert!(row[3].is_blank());
        assert!(row[4].is_blank());
        assert_eq!(row[5].style, Some(CellStyle::Input));
        assert_eq!(row[5].format.as_deref(), Some("currency"));
        // A formula missing its = gets it.
        assert_eq!(row[6].formula.as_deref(), Some("=SUM(A1:A2)"));
    }

    #[test]
    fn a_flat_array_of_cells_is_one_row() {
        let rows = parse_rows(
            &json!(["Phone", {"value": 90, "format": "currency"}]),
            "S",
            8,
            0,
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0][1].value, Some(Scalar::Number(90.0)));
        // A mix is still an error, naming the row.
        let e = parse_rows(&json!([["a"], "b"]), "S", 8, 0).unwrap_err();
        assert!(e.contains("row 10"), "{e}");
    }

    #[test]
    fn a_formatted_header_formats_its_column() {
        let w = wb(
            json!([{ "name": "S", "columns": [null, {"format": "integer"}], "rows": [
                ["Budget"],
                [{"value": "Planned", "format": "currency"}, {"value": "Qty", "format": "currency"},
                 {"value": "Code", "format": "text"}],
                [1500, 3, 7],
                [{"value": 0.5, "format": "percent"}]
            ]}]),
        )
        .unwrap();
        let s = &w.sheets[0];
        assert_eq!(s.effective_format(2, 0), Some("currency"));
        // Its own and its column's format come first; a text format isn't lent.
        assert_eq!(s.effective_format(3, 0), Some("percent"));
        assert_eq!(s.effective_format(2, 1), Some("integer"));
        assert_eq!(s.effective_format(2, 2), None);
        // Only labels near the top count.
        assert_eq!(s.effective_format(0, 0), None);
        let mut far = s.clone();
        far.cell_mut(40, 0).value = Some(Scalar::Number(1.0));
        assert_eq!(far.effective_format(40, 0), Some("currency"));
        far.rows[1][0].value = None;
        far.cell_mut(12, 0).value = Some(Scalar::Text("Late".into()));
        far.cell_mut(12, 0).format = Some("currency".into());
        assert_eq!(far.effective_format(40, 0), None);
    }

    #[test]
    fn strings_that_look_like_formulas_stay_text() {
        let w =
            wb(json!([{ "name": "S", "rows": [["=1+1", "=HYPERLINK(\"x\")", "@SUM(1)", "+5"]] }]))
                .unwrap();
        for cell in &w.sheets[0].rows[0] {
            assert!(cell.formula.is_none());
            assert!(matches!(cell.value, Some(Scalar::Text(_))));
        }
    }

    #[test]
    fn storing_and_loading_is_lossless() {
        let w = wb(
            json!([{ "name": "S", "columns": [{"width": 12, "format": "currency"}, null],
                "freeze_header": true, "rows": [
                [{"value": "H", "style": "header"}, 2.5],
                [{"formula": "=B1*2", "format": "percent"}, "x", true]
            ]}]),
        )
        .unwrap();
        let again = Workbook::from_value(&w.to_value()).unwrap();
        assert_eq!(w, again);
    }

    #[test]
    fn errors_name_the_sheet_and_cell() {
        let e = wb(json!([{ "name": "BOM", "rows": [[1, 2], [1, {"formula": 3}]] }])).unwrap_err();
        assert!(e.contains("'BOM'") && e.contains("B2"), "{e}");
        let e = wb(json!([{ "name": "BOM", "rows": [[1, [2]]] }])).unwrap_err();
        assert!(e.contains("B1"), "{e}");
        let e = wb(json!([{ "name": "BOM", "rows": [[{"style": "loud"}]] }])).unwrap_err();
        assert!(e.contains("A1") && e.contains("loud"), "{e}");
        let e = wb(json!([{ "name": "BOM", "rows": [[{"bold": true}]] }])).unwrap_err();
        assert!(e.contains("bold"), "{e}");
        let e = wb(json!([{ "name": "BOM", "rows": [["a row"], "not a row"] }])).unwrap_err();
        assert!(e.contains("row 2"), "{e}");
    }

    #[test]
    fn forbidden_functions_are_rejected() {
        for f in [
            "=WEBSERVICE(\"http://x\")",
            "=filterxml(A1,\"//a\")",
            "=HYPERLINK(\"http://x\",\"go\")",
            "=1+CALL(\"a\")",
            "=REGISTER.ID(\"a\",\"b\")",
            "=RTD(\"a\",\"b\")",
            "=INFO(\"os\")",
            "=CELL(\"filename\")",
            "=_xlfn.WEBSERVICE(\"x\")",
            "=SUM(1, CELL (\"row\"))",
        ] {
            let e = wb(json!([{ "name": "S", "rows": [[{"formula": f}]] }])).unwrap_err();
            assert!(e.contains("A1") && e.contains("isn't allowed"), "{f}: {e}");
        }
        // Names that merely contain a forbidden word are fine.
        assert!(wb(json!([{ "name": "S", "rows": [[{"formula": "=SUM(1,2)"}, {"formula": "=\"CELL(\""}]] }])).is_ok());
    }

    #[test]
    fn external_references_are_rejected() {
        for f in [
            "=[Book1.xlsx]Sheet1!A1",
            "='C:\\dir\\[b.xlsx]Sheet1'!A1",
            "='C:\\dir\\Sheet1'!A1",
            "='/tmp/x'!A1",
            "=cmd|'/c calc'!A1",
        ] {
            let e = wb(json!([{ "name": "S", "rows": [[{"formula": f}]] }])).unwrap_err();
            assert!(e.contains("A1") && e.contains("allowed"), "{f}: {e}");
        }
        // Brackets inside a string, and quoted sheet names, are fine.
        assert!(wb(json!([{ "name": "S", "rows": [[{"formula": "=TEXT(1,\"[h]:mm\")"}, {"formula": "='My Sheet'!A1"}]] }])).is_ok());
    }

    #[test]
    fn sheet_names_are_checked() {
        for bad in [
            "",
            "a[b",
            "a:b",
            "a*b",
            "a?b",
            "a/b",
            "a\\b",
            &"x".repeat(32),
            "'a",
        ] {
            assert!(wb(json!([{ "name": bad, "rows": [] }])).is_err(), "{bad:?}");
        }
        assert!(wb(json!([{ "name": "x".repeat(31), "rows": [] }])).is_ok());
        let e = wb(json!([{ "name": "A", "rows": [] }, { "name": "a", "rows": [] }])).unwrap_err();
        assert!(e.contains("twice"), "{e}");
    }

    #[test]
    fn limits_are_enforced() {
        let sheets: Vec<Value> = (0..21)
            .map(|i| json!({"name": format!("S{i}"), "rows": []}))
            .collect();
        assert!(wb(json!(sheets)).unwrap_err().contains("20"));

        let rows: Vec<Value> = (0..5_001).map(|_| json!([1])).collect();
        let e = wb(json!([{ "name": "S", "rows": rows }])).unwrap_err();
        assert!(e.contains("5000") && e.contains("'S'"), "{e}");
        let rows: Vec<Value> = (0..5_000).map(|_| json!([1])).collect();
        assert!(wb(json!([{ "name": "S", "rows": rows }])).is_ok());

        let wide = vec![1; 101];
        let e = wb(json!([{ "name": "S", "rows": [wide] }])).unwrap_err();
        assert!(
            e.contains("100 columns") || e.contains("101 columns"),
            "{e}"
        );

        let long = format!("={}", "1+".repeat(1_000));
        let e = wb(json!([{ "name": "S", "rows": [[{"formula": long}]] }])).unwrap_err();
        assert!(e.contains("A1") && e.contains("2000"), "{e}");

        let text = "x".repeat(32_768);
        let e = wb(json!([{ "name": "S", "rows": [[1, text]] }])).unwrap_err();
        assert!(e.contains("B1") && e.contains("32767"), "{e}");
        assert!(wb(json!([{ "name": "S", "rows": [["x".repeat(32_767)]] }])).is_ok());

        // 100,001 filled cells over 21 sheets' worth of rows is also refused.
        let full: Vec<Value> = (0..20)
            .map(|i| {
                json!({"name": format!("S{i}"),
            "rows": (0..5_000).map(|_| json!([1, 2, 3, 4, 5])).collect::<Vec<_>>()})
            })
            .collect();
        assert!(wb(json!(full)).unwrap_err().contains("100000"));

        let e = wb(json!([{ "name": "S", "hidden": true, "rows": [] }])).unwrap_err();
        assert!(e.contains("visible"), "{e}");
    }

    #[test]
    fn named_formats_map_to_excel() {
        assert_eq!(excel_format("currency"), "$#,##0.00");
        assert_eq!(excel_format("percent1"), "0.0%");
        assert_eq!(excel_format("date"), "yyyy-mm-dd");
        assert_eq!(excel_format("0.00\" kg\""), "0.00\" kg\"");
        // Bare non-ASCII symbols are quoted; quoted ones, [..] codes and
        // escapes are left alone.
        assert_eq!(excel_format("¥#,##0"), "\"¥\"#,##0");
        assert_eq!(excel_format("#,##0円"), "#,##0\"円\"");
        assert_eq!(
            excel_format("[Red]+¥#,##0;-¥#,##0"),
            "[Red]+\"¥\"#,##0;-\"¥\"#,##0"
        );
        assert_eq!(excel_format("#,##0.00 \"€\""), "#,##0.00 \"€\"");
        assert_eq!(excel_format("[$€-407] #,##0"), "[$€-407] #,##0");
        assert_eq!(excel_format("\\€#,##0"), "\\€#,##0");
        let long = "0".repeat(65);
        assert!(wb(json!([{ "name": "S", "rows": [[{"value": 1, "format": long}]] }])).is_err());
    }

    #[test]
    fn letters_in_a_format_are_quoted_unless_they_are_codes() {
        // IronCalc shows #VALUE! for a bare R$, CHF or kr.
        assert_eq!(excel_format("R$ #,##0.00"), "\"R\"$ #,##0.00");
        assert_eq!(excel_format("CHF #,##0"), "\"CHF\" #,##0");
        assert_eq!(excel_format("#,##0.00 kr"), "#,##0.00 \"kr\"");
        assert_eq!(excel_format("\"R$\" #,##0.00"), "\"R$\" #,##0.00");
        for code in [
            "yyyy-mm-dd",
            "dd/mm/yyyy hh:mm",
            "h:mm AM/PM",
            "0.00E+00",
            "General",
        ] {
            assert_eq!(excel_format(code), code);
        }
    }

    #[test]
    fn a_value_beside_a_formula_is_dropped() {
        let w =
            wb(json!([{ "name": "S", "rows": [[1, {"formula": "=A1*2", "value": 2}]] }])).unwrap();
        let cell = w.sheets[0].cell(0, 1).unwrap();
        assert_eq!(cell.formula.as_deref(), Some("=A1*2"));
        assert_eq!(cell.value, None);
    }

    #[test]
    fn currency_follows_the_workbook() {
        let euro = Workbook::from_value(
            &json!({ "currency": "eur", "sheets": [{ "name": "S", "rows": [[1]] }] }),
        )
        .unwrap();
        assert_eq!(euro.currency.as_deref(), Some("EUR"));
        assert_eq!(
            excel_format_in("currency", &euro.money_formats()),
            "#,##0.00 \"€\""
        );
        assert_eq!(
            excel_format_in("currency0", &euro.money_formats()),
            "#,##0 \"€\""
        );
        assert_eq!(Workbook::from_value(&euro.to_value()).unwrap(), euro);
        let symbol = Workbook::from_value(
            &json!({ "currency": "R$", "sheets": [{ "name": "S", "rows": [[1]] }] }),
        );
        assert_eq!(symbol.unwrap().currency.as_deref(), Some("BRL"));
        let e = Workbook::from_value(
            &json!({ "currency": "XYZ", "sheets": [{ "name": "S", "rows": [[1]] }] }),
        )
        .unwrap_err();
        assert!(e.contains("EUR"), "{e}");

        // Unnamed: the money format the sheet already uses.
        let yen = wb(json!([{ "name": "S", "columns": [null, {"format": "¥#,##0.00"}], "rows": [["a", 1]] }])).unwrap();
        let money = yen.money_formats();
        assert_eq!(
            (money.currency.as_str(), money.currency0.as_str()),
            ("¥#,##0.00", "¥#,##0")
        );
        // Nothing to go on: dollars.
        assert_eq!(
            wb(json!([{ "name": "S", "rows": [[{"value": 1, "format": "percent"}]] }]))
                .unwrap()
                .money_formats(),
            MoneyFormats::default()
        );
    }
}
