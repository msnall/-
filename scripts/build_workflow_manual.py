"""Build the workflow manual from the maintained Markdown source."""
from pathlib import Path
import re
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "视频自动剪辑全流程说明.md"
OUTPUT = ROOT / "docs" / "视频自动剪辑全流程说明.docx"
doc = Document()
section = doc.sections[0]
section.page_width, section.page_height = Inches(8.5), Inches(11)
section.top_margin = section.bottom_margin = Inches(0.75)
section.left_margin = section.right_margin = Inches(0.8)
section.footer_distance = Inches(0.3)

def font(style, latin="Calibri", east_asia="Microsoft YaHei", size=11, bold=False):
    style.font.name = latin
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.italic = False
    style.font.color.rgb = RGBColor(0, 0, 0)
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), east_asia)

font(doc.styles["Normal"])
normal = doc.styles["Normal"].paragraph_format
normal.space_after = Pt(6)
normal.line_spacing = 1.18
font(doc.styles["Title"], size=25, bold=True)
doc.styles["Title"].paragraph_format.space_after = Pt(10)
for name, size in [("Heading 1", 17), ("Heading 2", 13)]:
    font(doc.styles[name], size=size, bold=True)
    fmt = doc.styles[name].paragraph_format
    fmt.space_before = Pt(15)
    fmt.space_after = Pt(7)
    fmt.keep_with_next = True
    fmt.keep_together = True
font(doc.styles["Subtitle"], size=12)
doc.styles["Subtitle"].paragraph_format.space_after = Pt(9)
font(doc.styles["List Bullet"], size=11)
font(doc.styles["List Number"], size=11)
code_style = doc.styles.add_style("Workflow Code", 1)
font(code_style, latin="Consolas", size=9)
code_style.paragraph_format.space_before = Pt(3)
code_style.paragraph_format.space_after = Pt(8)
code_style.paragraph_format.line_spacing = 1.08
code_style.paragraph_format.left_indent = Inches(0.1)
code_style.paragraph_format.keep_together = True

def inline(paragraph, text):
    position = 0
    for match in re.finditer(r"\[([^\]]+)\]\(([^)]+)\)", text):
        paragraph.add_run(text[position:match.start()])
        link = OxmlElement("w:hyperlink")
        relation = paragraph.part.relate_to(match.group(2), "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
        link.set(qn("r:id"), relation)
        run = OxmlElement("w:r")
        properties = OxmlElement("w:rPr")
        color = OxmlElement("w:color"); color.set(qn("w:val"), "174A7E"); properties.append(color)
        underline = OxmlElement("w:u"); underline.set(qn("w:val"), "single"); properties.append(underline)
        run.append(properties)
        value = OxmlElement("w:t"); value.text = match.group(1); run.append(value)
        link.append(run); paragraph._p.append(link)
        position = match.end()
    paragraph.add_run(text[position:])

def table(lines):
    rows = [[cell.strip() for cell in line.strip().strip("|").split("|")] for line in lines]
    rows = [row for row in rows if not all(re.fullmatch(r":?-+:?", cell) for cell in row)]
    count = len(rows[0])
    obj = doc.add_table(rows=0, cols=count)
    obj.alignment = WD_TABLE_ALIGNMENT.CENTER
    obj.autofit = False
    if count == 2:
        widths = [4.1, 2.8] if rows[0][0] in ["文件或目录", "工作文件", "检查文件"] else [2.05, 4.85]
    else:
        widths = [1.6, 2.9, 2.4] if rows[0][0] == "模型" else [1.35, 1.7, 3.85]
    for column, width in zip(obj.columns, widths): column.width = Inches(width)
    borders = OxmlElement("w:tblBorders")
    for edge in ["top", "left", "bottom", "right", "insideH", "insideV"]:
        element = OxmlElement("w:" + edge)
        element.set(qn("w:val"), "single"); element.set(qn("w:sz"), "4"); element.set(qn("w:color"), "D9D9D9")
        borders.append(element)
    obj._tbl.tblPr.append(borders)
    for index, values in enumerate(rows):
        row = obj.add_row()
        tr_properties = row._tr.get_or_add_trPr()
        no_split = OxmlElement("w:cantSplit"); tr_properties.append(no_split)
        if index == 0:
            repeat = OxmlElement("w:tblHeader"); tr_properties.append(repeat)
        for col, (cell, value) in enumerate(zip(row.cells, values)):
            cell.width = Inches(widths[col]); cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            cell_properties = cell._tc.get_or_add_tcPr()
            margins = OxmlElement("w:tcMar")
            for edge, amount in [("top", "70"), ("bottom", "70"), ("left", "90"), ("right", "90")]:
                item = OxmlElement("w:" + edge); item.set(qn("w:w"), amount); item.set(qn("w:type"), "dxa"); margins.append(item)
            cell_properties.append(margins)
            if index == 0:
                shading = OxmlElement("w:shd"); shading.set(qn("w:fill"), "DCE6F1"); cell_properties.append(shading)
            paragraph = cell.paragraphs[0]
            paragraph.paragraph_format.space_before = Pt(1)
            paragraph.paragraph_format.space_after = Pt(2)
            paragraph.paragraph_format.line_spacing = 1.1
            if re.fullmatch(r"[\d.,−×/ A-Za-z]+", value) and len(value) < 22:
                paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = paragraph.add_run(value)
            run.font.size = Pt(9.5)
            run.bold = index == 0
    doc.add_paragraph().paragraph_format.space_after = Pt(1)

lines = SOURCE.read_text(encoding="utf-8-sig").splitlines()
index = 0
subtitle_done = False
while index < len(lines):
    line = lines[index]
    if not line.strip(): index += 1; continue
    if line.startswith("```"):
        code = []; index += 1
        while index < len(lines) and not lines[index].startswith("```"):
            code.append(lines[index]); index += 1
        doc.add_paragraph("\n".join(code), "Workflow Code")
    elif line.startswith("|"):
        batch = []
        while index < len(lines) and lines[index].startswith("|"):
            batch.append(lines[index]); index += 1
        table(batch); continue
    elif line.startswith("# "):
        doc.add_paragraph(line[2:], "Title")
    elif line.startswith("## "):
        doc.add_paragraph(line[3:], "Heading 1")
    elif line.startswith("### "):
        doc.add_paragraph(line[4:], "Heading 2")
    elif not subtitle_done:
        doc.add_paragraph(line, "Subtitle"); subtitle_done = True
    else:
        inline(doc.add_paragraph(), line)
    index += 1

footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
run = footer.add_run(); run.font.size = Pt(9)
field = OxmlElement("w:fldSimple"); field.set(qn("w:instr"), "PAGE"); run._r.addnext(field)
doc.core_properties.title = "短视频自动剪辑全流程操作手册"
doc.core_properties.subject = "Windows 环境搭建与 Bloom10 英语口播案例"
doc.core_properties.author = "Leo"
doc.core_properties.keywords = "Remotion HyperFrames whisper.cpp 视频制作"
for root in [doc.styles.element, doc.element]:
    for border in root.xpath(".//w:pBdr"):
        border.getparent().remove(border)
doc.save(OUTPUT)
print(OUTPUT)
