import io
import pdfplumber
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.pdfbase.pdfmetrics import stringWidth
from pypdf import PdfReader, PdfWriter

source = r'C:\Users\Harsh Goel\Downloads\Assignment-2.pdf'
output = r'C:\Users\Harsh Goel\Downloads\MarsWalk\Assignment-2-formatted.pdf'

# Rebuild page 1 so it begins cleanly with the setup code and data preview.
base = PdfReader(source)
page_width = float(base.pages[0].mediabox.width)
page_height = float(base.pages[0].mediabox.height)
first_page_io = io.BytesIO()
c = canvas.Canvas(first_page_io, pagesize=(page_width, page_height))
left, right = 52.0, page_width - 52.0
panel_top = page_height - 40.0
code_lines = [
    'import pandas as pd',
    'import matplotlib.pyplot as plt',
    'import seaborn as sns',
    'import plotly.express as px',
    '',
    'tips = px.data.tips()',
    'iris = px.data.iris()',
    'stocks = px.data.stocks()',
    '',
    'tips.head()',
]
code_font, code_size, leading = 'Courier', 8.0, 11.0
panel_height = 132.0
c.setFillColor(HexColor('#F5F5F5'))
c.setStrokeColor(HexColor('#D5D5D5'))
c.setLineWidth(0.7)
c.roundRect(left, panel_top - panel_height, right-left, panel_height, 2.5, stroke=1, fill=1)
c.setFillColor(HexColor('#202020'))
c.setFont(code_font, 8.0)
text = c.beginText(left + 10, panel_top - 17)
text.setFont(code_font, 8.0)
text.setLeading(leading)
for line in code_lines:
    text.textLine(line)
c.drawText(text)

heading_top = panel_top - panel_height - 22
c.setFillColor(HexColor('#111111'))
c.setFont('Helvetica-Bold', 13)
c.drawString(left, heading_top, 'Dataset preview (first five rows)')
rows = [
    ['total_bill', 'tip', 'sex', 'smoker', 'day', 'time', 'size'],
    ['16.99', '1.01', 'Female', 'No', 'Sun', 'Dinner', '2'],
    ['10.34', '1.66', 'Male', 'No', 'Sun', 'Dinner', '3'],
    ['21.01', '3.5', 'Male', 'No', 'Sun', 'Dinner', '3'],
    ['23.68', '3.31', 'Male', 'No', 'Sun', 'Dinner', '2'],
    ['24.59', '3.61', 'Female', 'No', 'Sun', 'Dinner', '4'],
]
col_widths = [88, 58, 72, 77, 68, 76, 45]
table_x = left
table_top = heading_top - 15
row_h = 22
for ri, row in enumerate(rows):
    y = table_top - (ri + 1) * row_h
    x = table_x
    for ci, value in enumerate(row):
        w = col_widths[ci]
        c.setFillColor(HexColor('#E8EEF5') if ri == 0 else HexColor('#FFFFFF'))
        c.setStrokeColor(HexColor('#B7C4D2'))
        c.setLineWidth(0.45)
        c.rect(x, y, w, row_h, stroke=1, fill=1)
        c.setFillColor(HexColor('#263445') if ri == 0 else HexColor('#222222'))
        c.setFont('Helvetica-Bold' if ri == 0 else 'Helvetica', 8 if ri == 0 else 8.2)
        c.drawString(x + 6, y + 7.2, value)
        x += w

c.setFillColor(HexColor('#888888'))
c.setFont('Helvetica', 8)
c.drawString(50, 20, 'Assignment 2 — Data Visualization')
c.drawRightString(page_width - 50, 20, 'Page 1')
c.save()
first_page_io.seek(0)
first_page = PdfReader(first_page_io).pages[0]

# Add notebook-style code cell panels beneath the existing text on pages 2-11.
code_ranges = {
    2: [(326, 395)], 3: [(326, 387)], 4: [(285, 396)],
    5: [(285, 320), (336, 371)], 6: [(284, 336), (352, 413)],
    7: [(326, 421)], 8: [(406, 492)], 9: [(326, 412)],
    10: [(285, 346), (362, 422)], 11: [(326, 438)],
}
rects = {}
with pdfplumber.open(source) as pdf:
    for page_no, ranges in code_ranges.items():
        pg = pdf.pages[page_no - 1]
        rects[page_no] = []
        for top, bottom in ranges:
            chars = [ch for ch in pg.chars if 'Courier' in ch.get('fontname', '') and top <= ch['top'] <= bottom]
            if not chars:
                raise RuntimeError(f'No code text found on page {page_no}')
            x0, x1 = 52.0, float(pg.width) - 52.0
            y0 = min(ch['top'] for ch in chars) - 3.5
            y1 = max(ch['bottom'] for ch in chars) + 3.5
            rects[page_no].append((x0, float(pg.height) - y1, x1-x0, y1-y0))

reader = PdfReader(source)
writer = PdfWriter()
writer.clone_document_from_reader(reader)
writer.remove_page(0)
writer.insert_page(first_page, 0)
for page_no, page in enumerate(writer.pages[1:], start=2):
    packet = io.BytesIO()
    c = canvas.Canvas(packet, pagesize=(float(page.mediabox.width), float(page.mediabox.height)))
    c.setFillColor(HexColor('#F5F5F5'))
    c.setStrokeColor(HexColor('#D5D5D5'))
    c.setLineWidth(0.7)
    for x, y, w, h in rects[page_no]:
        c.roundRect(x, y, w, h, 2.5, stroke=1, fill=1)
    c.save()
    packet.seek(0)
    page.merge_page(PdfReader(packet).pages[0], over=False)
with open(output, 'wb') as f:
    writer.write(f)
print(output)


