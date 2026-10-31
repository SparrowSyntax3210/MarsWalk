from pypdf import PdfReader, PdfWriter
from pypdf.generic import ContentStream, DecodedStreamObject, NameObject, FloatObject, NumberObject
src = r'C:\Users\Harsh Goel\Downloads\Assignment-2.pdf'
out = r'C:\Users\Harsh Goel\Downloads\MarsWalk\Assignment-2-edited.pdf'
reader = PdfReader(src)
writer = PdfWriter()
writer.clone_document_from_reader(reader)
remove = {
    "This PDF contains the notebook's code and the corresponding chart outputs. Plotly charts are shown as static",
    'figures for reliable PDF viewing.',
    'Libraries and datasets',
}
for page_index, page in enumerate(writer.pages):
    contents = page.get_contents()
    if contents is None:
        continue
    stream = ContentStream(contents, writer)
    operations = []
    code_font = False
    shifted = False
    for operands, operator in stream.operations:
        if operator == b'Tj' and str(operands[0]) in remove:
            continue
        if operator == b'Tf' and str(operands[0]) == '/F3':
            operands[1] = FloatObject(float(operands[1]) + 2.2)
            code_font = True
        if page_index == 10 and code_font and not shifted and operator in (b'Tj', b'TJ'):
            operations.append(([NumberObject(0), NumberObject(-24)], b'Td'))
            shifted = True
        operations.append((operands, operator))
    stream.operations = operations
    replacement = DecodedStreamObject()
    replacement.set_data(stream.get_data())
    page[NameObject('/Contents')] = writer._add_object(replacement)
with open(out, 'wb') as f:
    writer.write(f)
print(out)
