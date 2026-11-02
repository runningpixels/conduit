"""Builds tests/fixtures/xlsx/sample.xlsx (run: uv run --with openpyxl python make_xlsx.py OUT).

openpyxl never writes cached formula results, so a second pass injects a
<v> into the formula cell for "Total" (B5) and leaves "Uncached" (B6) without
one.
"""
import datetime
import re
import sys
import zipfile
from openpyxl import Workbook
from openpyxl.styles import PatternFill

out = sys.argv[1]
tmp = out + ".tmp"

wb = Workbook()
ws = wb.active
ws.title = "Budget"
ws.append(["Item", "Amount", "Note", "Date"])
ws.append(["Widgets, large", 1234.5, 'He said "hi"', datetime.date(2024, 3, 5)])
ws.append(["Gadgets", 10, "line one\nline two", datetime.datetime(2024, 3, 6, 14, 30, 0)])
ws.append(["Float noise", 0.30000000000000004, True, None])
ws.append(["Total", "=B2+B3", None, None])
ws.append(["Uncached", "=B2*2", None, None])
# Styled but empty cells far away: the used range must not grow to them.
ws["H20"].fill = PatternFill("solid", fgColor="FFFF00")
ws["C12"].fill = PatternFill("solid", fgColor="FFFF00")

hid = wb.create_sheet("Secret")
hid.append(["code", "value"])
hid.append(["alpha", 1])
hid.sheet_state = "hidden"

wb.create_sheet("Blank")
wb.save(tmp)

with zipfile.ZipFile(tmp) as src, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
    for item in src.infolist():
        data = src.read(item.filename)
        if item.filename == "xl/worksheets/sheet1.xml":
            xml = data.decode("utf-8")
            xml, n = re.subn(r"(<f>B2\+B3</f>)<v\s*/>|(<f>B2\+B3</f>)<v></v>", r"<f>B2+B3</f><v>1244.5</v>", xml)
            assert n == 1, xml
            data = xml.encode("utf-8")
        dst.writestr(item, data)
print("wrote", out)
