// MegaNet — xlsx-write.js
//
//   XlsxWrite   a workbook Excel, LibreOffice, Numbers and Google Sheets all
//               open: sheets of cells (text, numbers, a SUM with its answer
//               already in it), a handful of named styles, column widths,
//               merged cells, a frozen header row and landscape printing one
//               page wide. Written by hand as the zip of XML an .xlsx is.
//
// After export.js, whose zipStore() is the container; before level-survey.js
// and two-peg.js, which call it — index.html holds the order. Pure apart from
// that one call, made from inside build(); nothing runs at load.
//
// Why by hand. The app has no build step and loads no spreadsheet library,
// and the part of SpreadsheetML a field sheet needs is small: inline strings
// (no shared-string table to keep in step), numbers with a format, a formula
// with its cached value so a viewer that does not calculate (a phone's
// preview) still shows the answer, and one styles part. Entries are stored,
// not deflated — every reader takes a stored zip, and a survey's workbook is
// tens of kilobytes. `fullCalcOnLoad` asks Excel to work the SUMs again on
// opening, so a reading corrected in the office carries through.
//
//   sheet = { name, rows: [[cell]], cols: [width…], merges: ['A1:M1'],
//             freeze: rowsAbove, landscape, fitWidth }
//   cell  = value | { v, s } | { f, v, s }     s: a name in STYLES

const XlsxWrite = (function () {

  // The styles a sheet may name, in the order their <xf> are written — a
  // cell's s="" is the index. Fonts, fills, borders and number formats are
  // the tables below; each style is [numFmt, font, fill, border, align].
  const NUM_FMTS = { 164: '0.000', 165: '0.0000', 166: '+0.000;-0.000;0.000', 167: '0.0', 168: '+0.0000;-0.0000;0.0000', 169: '0.000000' };
  const FONTS = [
    '<font><sz val="10"/><name val="Calibri"/><family val="2"/></font>',                                   // 0 body
    '<font><b/><sz val="10"/><name val="Calibri"/><family val="2"/></font>',                               // 1 bold
    '<font><b/><sz val="14"/><color rgb="FF0B1F3A"/><name val="Calibri"/><family val="2"/></font>',       // 2 title
    '<font><sz val="10"/><color rgb="FF55606E"/><name val="Calibri"/><family val="2"/></font>',           // 3 sub
    '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>',       // 4 section
    '<font><b/><sz val="9"/><color rgb="FF55606E"/><name val="Calibri"/><family val="2"/></font>',        // 5 label
    '<font><b/><sz val="10"/><color rgb="FF0A7D3B"/><name val="Calibri"/><family val="2"/></font>',       // 6 ok
    '<font><b/><sz val="10"/><color rgb="FFB3261E"/><name val="Calibri"/><family val="2"/></font>',       // 7 bad
    '<font><b/><sz val="10"/><color rgb="FF9A6100"/><name val="Calibri"/><family val="2"/></font>',       // 8 warn
  ];
  const FILLS = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FF0B1F3A"/><bgColor indexed="64"/></patternFill></fill>',   // 2 navy
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F5"/><bgColor indexed="64"/></patternFill></fill>',   // 3 pale
  ];
  const BORDERS = [
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FF9AA5B1"/></bottom><diagonal/></border>',   // 1 under
    '<border><left/><right/><top style="thin"><color rgb="FF55606E"/></top><bottom/><diagonal/></border>',      // 2 over
  ];
  const TOP = '<alignment vertical="top"/>';
  const WRAP = '<alignment vertical="top" wrapText="1"/>';
  const HEAD = '<alignment horizontal="center" vertical="center" wrapText="1"/>';
  const STYLES = {
    default: [0, 0, 0, 0, ''],
    title:   [0, 2, 0, 0, ''],
    sub:     [0, 3, 0, 0, ''],
    section: [0, 4, 2, 0, ''],
    label:   [0, 5, 0, 0, TOP],
    text:    [0, 0, 0, 0, WRAP],
    num3:    [164, 0, 0, 0, TOP],
    num3b:   [164, 1, 3, 2, TOP],
    head:    [0, 1, 3, 1, HEAD],
    ok:      [0, 6, 0, 0, TOP],
    bad:     [0, 7, 0, 0, TOP],
    warn:    [0, 8, 0, 0, TOP],
    int:     [1, 0, 0, 0, TOP],
    sum:     [0, 1, 3, 2, TOP],
    num3s:   [166, 0, 0, 0, TOP],
    num3bad: [166, 7, 0, 0, TOP],
    num1:    [167, 0, 0, 0, TOP],
    num4s:   [168, 0, 0, 0, TOP],
    deg:     [169, 0, 0, 0, TOP],
  };
  const STYLE_NAMES = Object.keys(STYLES);

  // A column letter: 0 → A, 25 → Z, 26 → AA.
  function colName(i) {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  // XML text: the five escapes, and the control characters XML 1.0 cannot
  // carry at all dropped rather than written (a stray one makes Excel call
  // the whole file corrupt).
  function x(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Excel's own rules for a sheet's name: 31 characters, none of []:*?/\ ,
  // not blank, and unique in the book.
  function sheetName(name, used) {
    let base = String(name || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
    let out = base, k = 2;
    while (used.has(out.toLowerCase())) { const tag = ` (${k++})`; out = base.slice(0, 31 - tag.length) + tag; }
    used.add(out.toLowerCase());
    return out;
  }

  function cellXml(ref, c) {
    if (c == null || c === '') return '';
    const o = typeof c === 'object' && !(c instanceof Date) ? c : { v: c };
    const si = STYLE_NAMES.indexOf(o.s || 'default');
    const s = si > 0 ? ` s="${si}"` : '';
    if (o.f) {
      const v = typeof o.v === 'number' && Number.isFinite(o.v) ? `<v>${o.v}</v>` : '';
      return `<c r="${ref}"${s}><f>${x(o.f)}</f>${v}</c>`;
    }
    const v = o.v;
    if (v == null || v === '') return si > 0 ? `<c r="${ref}"${s}/>` : '';
    if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : '';
    if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
  }

  function sheetXml(sh) {
    const rows = sh.rows || [];
    let width = 1;
    for (const r of rows) width = Math.max(width, (r || []).length);
    const dim = `A1:${colName(width - 1)}${Math.max(1, rows.length)}`;
    const freeze = sh.freeze > 0
      ? `<pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/>` : '';
    const cols = (sh.cols || []).map((w, i) => (w ? `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>` : '')).join('');
    const data = rows.map((r, i) => {
      const cells = (r || []).map((c, j) => cellXml(`${colName(j)}${i + 1}`, c)).join('');
      return cells ? `<row r="${i + 1}">${cells}</row>` : '';
    }).join('');
    const merges = (sh.merges || []).length
      ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${x(m)}"/>`).join('')}</mergeCells>` : '';
    const fit = sh.fitWidth ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '';
    const setup = (sh.landscape || sh.fitWidth)
      ? `<pageSetup paperSize="9"${sh.landscape ? ' orientation="landscape"' : ''}${sh.fitWidth ? ' fitToWidth="1" fitToHeight="0"' : ''}/>` : '';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `${fit}<dimension ref="${dim}"/>`
      + `<sheetViews><sheetView workbookViewId="0">${freeze}</sheetView></sheetViews>`
      + '<sheetFormatPr defaultRowHeight="14"/>'
      + (cols ? `<cols>${cols}</cols>` : '')
      + `<sheetData>${data}</sheetData>${merges}`
      + '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
      + `${setup}</worksheet>`;
  }

  function stylesXml() {
    const fmts = Object.entries(NUM_FMTS).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${x(code)}"/>`).join('');
    const xfs = STYLE_NAMES.map(n => {
      const [fmt, font, fill, border, align] = STYLES[n];
      const apply = `${fmt ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}${fill ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}${align ? ' applyAlignment="1"' : ''}`;
      return align
        ? `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"${apply}>${align}</xf>`
        : `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"${apply}/>`;
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + `<numFmts count="${Object.keys(NUM_FMTS).length}">${fmts}</numFmts>`
      + `<fonts count="${FONTS.length}">${FONTS.join('')}</fonts>`
      + `<fills count="${FILLS.length}">${FILLS.join('')}</fills>`
      + `<borders count="${BORDERS.length}">${BORDERS.join('')}</borders>`
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + `<cellXfs count="${STYLE_NAMES.length}">${xfs}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';
  }

  // The parts, in order, as [name, text]. Separate from build() so a check can
  // read the XML without unzipping anything.
  function parts(sheets, meta = {}) {
    const used = new Set();
    const list = (sheets || []).map(s => Object.assign({}, s, { name: sheetName(s.name, used) }));
    if (!list.length) list.push({ name: 'Sheet1', rows: [] });
    const when = (meta.when || new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
    const out = [];
    out.push(['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + list.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + '</Types>']);
    out.push(['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
      + '</Relationships>']);
    out.push(['docProps/core.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
      + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
      + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + `<dc:title>${x(meta.title || '')}</dc:title><dc:creator>Flood-Net</dc:creator>`
      + `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created>`
      + `<dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified>`
      + '</cp:coreProperties>']);
    out.push(['docProps/app.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Flood-Net</Application></Properties>']);
    out.push(['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<bookViews><workbookView/></bookViews><sheets>'
      + list.map((s, i) => `<sheet name="${x(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>']);
    out.push(['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + list.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + '</Relationships>']);
    out.push(['xl/styles.xml', stylesXml()]);
    list.forEach((s, i) => out.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]));
    return out;
  }

  // The workbook's bytes.
  function build(sheets, meta = {}) {
    return zipStore(parts(sheets, meta).map(([name, data]) => ({ name, data })), meta.when || new Date());
  }

  const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  return { build, parts, colName, sheetName, STYLE_NAMES, MIME };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = XlsxWrite;
