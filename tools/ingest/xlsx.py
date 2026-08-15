"""A read-only .xlsx reader with nothing but the standard library.

Written for #123 (the survey of `archive/QLD All Site Inspections.xlsx`) and
meant to be inherited by #124's extractor, which is why it is in `tools/ingest/`
and not inside the survey script.

Why not openpyxl. `tools/README.md` says the ACMA tools are stdlib-only, and
`test/lib/xlsx.mjs` already makes the same argument on the JavaScript side: an
.xlsx is a zip of XML and both halves are in the standard library, so the
dependency buys less than it costs. This one does need a little more than that
file does — the survey has to tell a real date from a number that happens to
look like one, has to see `#VALUE!` as an error rather than as an empty cell,
and has to read the cell comments, none of which a form-fidelity test needs.

What it does **not** do: styles beyond number formats, formulas (the cached
value is what is read, which is what Excel shows), charts, drawings, merges.
"""

from __future__ import annotations

import datetime as _dt
import re
import zipfile
from xml.etree import ElementTree as ET

NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
NS_REL_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS_REL_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
NS_THREAD = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments'


def _q(ns: str, tag: str) -> str:
    return f'{{{ns}}}{tag}'


# ── Cell references ──────────────────────────────────────────────────────────

_REF_RE = re.compile(r'^([A-Z]+)([0-9]+)$')


def col_to_index(letters: str) -> int:
    """`A` -> 1, `Z` -> 26, `AA` -> 27."""
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def index_to_col(index: int) -> str:
    """1 -> `A`. The inverse of :func:`col_to_index`."""
    out = ''
    while index > 0:
        index, rem = divmod(index - 1, 26)
        out = chr(65 + rem) + out
    return out


def split_ref(ref: str) -> tuple[int, int]:
    """`B7` -> (7, 2) — (row, column), both 1-based."""
    m = _REF_RE.match(ref)
    if not m:
        raise ValueError(f'not a cell reference: {ref!r}')
    return int(m.group(2)), col_to_index(m.group(1))


# ── Dates ────────────────────────────────────────────────────────────────────
# Excel's serial day numbers, with the 1900 leap-year bug: serial 60 is the
# 29th of February 1900, a day that did not exist, so everything from 61 on is
# one day ahead of a naive count from the epoch.

_EPOCH_1900 = _dt.datetime(1899, 12, 30)
_EPOCH_1904 = _dt.datetime(1904, 1, 1)

# The built-in number-format ids that are dates or times. 14-22 and 45-47 are
# fixed by the file format; anything else has to be recognised from its code.
_BUILTIN_DATE_IDS = set(range(14, 23)) | set(range(45, 48))

# A custom format is a date format if it uses a date/time placeholder outside
# of a literal. Stripping the literals first is what stops `"m"` (a unit label)
# and `[Red]` from being read as month markers.
_FORMAT_LITERALS_RE = re.compile(r'"[^"]*"|\[[^\]]*\]|\\.')
_DATE_TOKEN_RE = re.compile(r'[ymdhs]', re.IGNORECASE)


def is_date_format(code: str | None) -> bool:
    if not code:
        return False
    stripped = _FORMAT_LITERALS_RE.sub('', code)
    return bool(_DATE_TOKEN_RE.search(stripped))


def serial_to_datetime(serial: float, date1904: bool = False) -> _dt.datetime:
    epoch = _EPOCH_1904 if date1904 else _EPOCH_1900
    days = int(serial)
    if not date1904 and days < 60:
        # Before the phantom leap day, the naive count is right.
        days += 1
    frac = serial - int(serial)
    return epoch + _dt.timedelta(days=days, seconds=round(frac * 86400))


# ── Cell values ──────────────────────────────────────────────────────────────


class Cell:
    """One non-empty cell: where it is, what Excel shows, and what it is.

    `kind` is the survey's vocabulary rather than the file format's:
    `text`, `number`, `date`, `bool`, `error`. `raw` is always the string the
    workbook carries, which is what #122's acceptance means by "the source
    string is retained" — a `>30` fade margin is a `text` cell whose `raw` is
    `>30`, and no reader here is allowed to turn that into 30.
    """

    __slots__ = ('row', 'col', 'ref', 'kind', 'value', 'raw', 'style')

    def __init__(self, row, col, kind, value, raw, style):
        self.row, self.col = row, col
        self.ref = f'{index_to_col(col)}{row}'
        self.kind, self.value, self.raw, self.style = kind, value, raw, style

    @property
    def text(self) -> str:
        """What a person reading the sheet would see, as a string."""
        if self.kind == 'date' and isinstance(self.value, _dt.datetime):
            return self.value.isoformat(sep=' ')
        return '' if self.value is None else str(self.value)

    def __repr__(self):
        return f'<Cell {self.ref} {self.kind} {self.value!r}>'


class Sheet:
    __slots__ = ('name', 'state', 'sheet_id', 'path', 'rows', 'max_row',
                 'max_col', 'declared_dimension', 'comments', 'merges')

    def __init__(self, name, state, sheet_id, path):
        self.name, self.state, self.sheet_id, self.path = name, state, sheet_id, path
        self.rows: dict[int, dict[int, Cell]] = {}
        self.max_row = 0
        self.max_col = 0
        self.declared_dimension = ''
        self.comments: list[dict] = []
        # (row1, col1, row2, col2) per merged range. The group headers are
        # merged cells and their span is the only honest way to know which
        # columns a group label like `Solar` covers.
        self.merges: list[tuple[int, int, int, int]] = []

    def merge_span(self, row: int, col: int) -> tuple[int, int] | None:
        """The (first column, last column) of the merge anchored at this cell."""
        for r1, c1, r2, c2 in self.merges:
            if r1 == row and c1 == col:
                return c1, c2
        return None

    @property
    def hidden(self) -> bool:
        return self.state != 'visible'

    @property
    def used_range(self) -> str:
        """The range that actually holds a value.

        Not the declared one: `Johnstone!` declares 16,382 columns and uses 30.
        """
        if not self.max_row:
            return ''
        return f'A1:{index_to_col(self.max_col)}{self.max_row}'

    def cell(self, row: int, col: int) -> Cell | None:
        return self.rows.get(row, {}).get(col)

    def value(self, row: int, col: int):
        c = self.cell(row, col)
        return None if c is None else c.value

    def text(self, row: int, col: int) -> str:
        c = self.cell(row, col)
        return '' if c is None else c.text

    def row_cells(self, row: int) -> list[Cell]:
        return [c for _, c in sorted(self.rows.get(row, {}).items())]

    def row_is_blank(self, row: int) -> bool:
        return not any(c.text.strip() for c in self.row_cells(row))

    def iter_rows(self):
        for r in range(1, self.max_row + 1):
            yield r, self.row_cells(r)


class Workbook:
    """Every sheet of a workbook, read eagerly.

    7 MB of XML is a few seconds and a few hundred MB of Python objects, which
    is cheaper than the alternative here: the survey walks every sheet several
    times over and a streaming reader would re-parse each time.
    """

    def __init__(self, path: str):
        self.path = path
        self._zip = zipfile.ZipFile(path)
        self._shared: list[str] = []
        self._style_is_date: list[bool] = []
        self.date1904 = False
        self.sheets: list[Sheet] = []
        self._read_styles()
        self._read_shared_strings()
        self._read_sheets()
        self._zip.close()

    # -- package plumbing --

    def _rels(self, part: str) -> dict[str, str]:
        base, _, name = part.rpartition('/')
        rel_path = f'{base}/_rels/{name}.rels' if base else f'_rels/{name}.rels'
        try:
            xml = self._zip.read(rel_path)
        except KeyError:
            return {}
        out = {}
        for rel in ET.fromstring(xml):
            target = rel.get('Target', '')
            if target.startswith('/'):
                resolved = target.lstrip('/')
            elif target.startswith('../'):
                parent = base.rpartition('/')[0]
                resolved = f'{parent}/{target[3:]}' if parent else target[3:]
            else:
                resolved = f'{base}/{target}' if base else target
            out[rel.get('Id')] = resolved
        return out

    def _read_shared_strings(self):
        try:
            xml = self._zip.read('xl/sharedStrings.xml')
        except KeyError:
            return
        for si in ET.fromstring(xml):
            # A string with formatting runs is several <t> under <r>; joining
            # them is what Excel shows.
            self._shared.append(''.join(t.text or '' for t in si.iter(_q(NS_MAIN, 't'))))

    def _read_styles(self):
        try:
            xml = self._zip.read('xl/styles.xml')
        except KeyError:
            return
        root = ET.fromstring(xml)
        custom = {}
        for fmt in root.iter(_q(NS_MAIN, 'numFmt')):
            custom[int(fmt.get('numFmtId'))] = fmt.get('formatCode')
        xfs = root.find(_q(NS_MAIN, 'cellXfs'))
        if xfs is None:
            return
        for xf in xfs:
            fmt_id = int(xf.get('numFmtId', 0))
            if fmt_id in _BUILTIN_DATE_IDS:
                self._style_is_date.append(True)
            elif fmt_id in custom:
                self._style_is_date.append(is_date_format(custom[fmt_id]))
            else:
                self._style_is_date.append(False)

    # -- sheets --

    def _read_sheets(self):
        root = ET.fromstring(self._zip.read('xl/workbook.xml'))
        pr = root.find(_q(NS_MAIN, 'workbookPr'))
        if pr is not None and pr.get('date1904') in ('1', 'true'):
            self.date1904 = True
        rels = self._rels('xl/workbook.xml')
        sheets_el = root.find(_q(NS_MAIN, 'sheets'))
        for el in sheets_el:
            rid = el.get(_q(NS_REL_DOC, 'id'))
            sheet = Sheet(
                name=el.get('name'),
                state=el.get('state', 'visible'),
                sheet_id=int(el.get('sheetId')),
                path=rels.get(rid, ''),
            )
            self._read_sheet(sheet)
            self._read_comments(sheet)
            self.sheets.append(sheet)

    def _read_sheet(self, sheet: Sheet):
        root = ET.fromstring(self._zip.read(sheet.path))
        dim = root.find(_q(NS_MAIN, 'dimension'))
        if dim is not None:
            sheet.declared_dimension = dim.get('ref', '')
        for mc in root.iter(_q(NS_MAIN, 'mergeCell')):
            ref = mc.get('ref', '')
            if ':' not in ref:
                continue
            a, b = ref.split(':')
            (r1, c1), (r2, c2) = split_ref(a), split_ref(b)
            sheet.merges.append((r1, c1, r2, c2))
        data = root.find(_q(NS_MAIN, 'sheetData'))
        if data is None:
            return
        for row_el in data:
            for c_el in row_el:
                cell = self._read_cell(c_el)
                if cell is None:
                    continue
                sheet.rows.setdefault(cell.row, {})[cell.col] = cell
                if cell.row > sheet.max_row:
                    sheet.max_row = cell.row
                if cell.col > sheet.max_col:
                    sheet.max_col = cell.col

    def _read_cell(self, el) -> Cell | None:
        ref = el.get('r')
        if not ref:
            return None
        row, col = split_ref(ref)
        t = el.get('t', 'n')
        style = int(el.get('s', 0))

        if t == 'inlineStr':
            is_el = el.find(_q(NS_MAIN, 'is'))
            text = '' if is_el is None else ''.join(x.text or '' for x in is_el.iter(_q(NS_MAIN, 't')))
            return Cell(row, col, 'text', text, text, style) if text != '' else None

        v_el = el.find(_q(NS_MAIN, 'v'))
        if v_el is None or v_el.text is None:
            return None
        raw = v_el.text

        if t == 's':
            text = self._shared[int(raw)]
            return Cell(row, col, 'text', text, text, style) if text != '' else None
        if t == 'str':
            # A formula's cached string result.
            return Cell(row, col, 'text', raw, raw, style) if raw != '' else None
        if t == 'e':
            # `#VALUE!`, `#REF!` — kept as themselves. #122 counts 707 of them
            # and they are not the same thing as an empty cell.
            return Cell(row, col, 'error', raw, raw, style)
        if t == 'b':
            return Cell(row, col, 'bool', raw == '1', raw, style)

        try:
            num = float(raw)
        except ValueError:
            return Cell(row, col, 'text', raw, raw, style)
        if style < len(self._style_is_date) and self._style_is_date[style] and num > 0:
            return Cell(row, col, 'date', serial_to_datetime(num, self.date1904), raw, style)
        if num == int(num):
            num = int(num)
        return Cell(row, col, 'number', num, raw, style)

    # -- comments --

    def _read_comments(self, sheet: Sheet):
        """Legacy comments and their threaded replacements, per cell.

        Excel writes a modern threaded comment twice: once under
        `xl/threadedComments/` with author ids and timestamps, and once in the
        legacy `xl/comments*.xml` so that older Excels can show it. Reading the
        legacy part is what gets the text of both kinds; the threaded part is
        read on top of it for the reply structure and the dates.
        """
        rels = self._rels(sheet.path)
        threaded: dict[str, list[dict]] = {}
        for target in rels.values():
            if 'threadedComment' not in target:
                continue
            root = ET.fromstring(self._zip.read(target))
            for tc in root:
                ref = tc.get('ref')
                threaded.setdefault(ref, []).append({
                    'ref': ref,
                    'date': tc.get('dT'),
                    'id': tc.get('id'),
                    'parent': tc.get('parentId'),
                    'text': ''.join(x.text or '' for x in tc.iter(_q(NS_THREAD, 'text'))),
                })
        for target in rels.values():
            if not re.search(r'comments\d+\.xml$', target) or 'threadedComments' in target:
                continue
            root = ET.fromstring(self._zip.read(target))
            authors = [a.text or '' for a in root.iter(_q(NS_MAIN, 'author'))]
            for cmt in root.iter(_q(NS_MAIN, 'comment')):
                ref = cmt.get('ref')
                idx = int(cmt.get('authorId', 0))
                text = ''.join(t.text or '' for t in cmt.iter(_q(NS_MAIN, 't')))
                sheet.comments.append({
                    'ref': ref,
                    'author': authors[idx] if idx < len(authors) else '',
                    'text': text,
                    'threaded': threaded.get(ref, []),
                })
        sheet.comments.sort(key=lambda c: split_ref(c['ref']))


def load(path: str) -> Workbook:
    return Workbook(path)
