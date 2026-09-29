// Generador mínimo de archivos Excel (.xlsx) sin dependencias externas.
// Soporta: varias hojas, texto, números, fechas, porcentajes, soles, encabezados con color,
// fila fija, filtros automáticos y ancho de columnas.
const zlib = require('zlib');

// ---------- ZIP ----------
const TABLA_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zip(archivos) {
  const locales = []; const central = []; let offset = 0;
  for (const [nombre, contenido] of archivos) {
    const datos = Buffer.from(contenido, 'utf8'); const comp = zlib.deflateRawSync(datos); const n = Buffer.from(nombre, 'utf8'); const crc = crc32(datos);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(datos.length, 22); lh.writeUInt16LE(n.length, 26); lh.writeUInt16LE(0, 28);
    locales.push(lh, n, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(datos.length, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42); central.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const fin = Buffer.alloc(22); fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(cd.length, 12); fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, cd, fin]);
}

// ---------- estilos ----------
// índice -> uso
const E = { normal: 0, cab: 1, cabCds: 2, cabPb: 3, entero: 4, pct: 5, soles: 6, fecha: 7, negrita: 8, titulo: 9, hora: 10, gris: 11, total: 12, totalPct: 13, verde: 14, decimal: 15 };
const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="167" formatCode="0.0"/><numFmt numFmtId="164" formatCode="&quot;S/ &quot;#,##0.00"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/><numFmt numFmtId="166" formatCode="0%"/></numFmts>
<fonts count="5"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="14"/><color rgb="FF0B2D63"/><name val="Arial"/></font><font><i/><sz val="10"/><color rgb="FF98A2B3"/><name val="Arial"/></font></fonts>
<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF475467"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF0B2D63"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF8E1B1B"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F7"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE3F1DF"/></patternFill></fill></fills>
<borders count="2"><border/><border><bottom style="thin"><color rgb="FFE4E7EC"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="16">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="3" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="4" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="1" fontId="2" fillId="5" borderId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf numFmtId="166" fontId="2" fillId="5" borderId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="6" borderId="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
function colLetra(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function serialFecha(iso) { const [y, m, d] = iso.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; }

// celda: valor simple o { v, s } (s = nombre de estilo) ; { f: 'fecha', v: '2026-09-27' }
function celdaXml(c, ref) {
  if (c == null || c === '') return '';
  let v = c, s = null;
  if (typeof c === 'object' && !(c instanceof Date)) { v = c.v; s = c.s; }
  if (v == null || v === '') return s ? `<c r="${ref}" s="${E[s]}"/>` : '';
  const st = s != null ? ` s="${E[s]}"` : '';
  if (s === 'fecha' && typeof v === 'string') return `<c r="${ref}"${st}><v>${serialFecha(v)}</v></c>`;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
  return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

// hoja: { nombre, filas: [[celda,...]], anchos: [n,...], filaEncabezado: índice (0-based) para fijar y filtrar }
function hojaXml(h) {
  const filas = h.filas.map((f, i) => `<row r="${i + 1}"${h.altos && h.altos[i] ? ` ht="${h.altos[i]}" customHeight="1"` : ''}>${f.map((c, j) => celdaXml(c, `${colLetra(j)}${i + 1}`)).join('')}</row>`).join('');
  const nCols = Math.max(1, ...h.filas.map((f) => f.length));
  const cols = h.anchos ? `<cols>${h.anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const fe = h.filaEncabezado;
  const vista = fe != null ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${fe + 1}" topLeftCell="A${fe + 2}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const filtro = fe != null && h.filas.length > fe + 1 ? `<autoFilter ref="A${fe + 1}:${colLetra(nCols - 1)}${h.filas.length}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${vista}${cols}<sheetData>${filas}</sheetData>${filtro}</worksheet>`;
}

function crearXlsx(hojas) {
  const archivos = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${hojas.map((h, i) => `<sheet name="${esc(h.nombre.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${hojas.some((h) => h.filaEncabezado != null) ? `<definedNames>${hojas.map((h, i) => (h.filaEncabezado != null && h.filas.length > h.filaEncabezado + 1 ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(h.nombre.slice(0, 31))}'!$A$${h.filaEncabezado + 1}:$${colLetra(Math.max(...h.filas.map((f) => f.length)) - 1)}$${h.filas.length}</definedName>` : '')).join('')}</definedNames>` : ''}</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', ESTILOS],
    ...hojas.map((h, i) => [`xl/worksheets/sheet${i + 1}.xml`, hojaXml(h)]),
  ];
  return zip(archivos);
}

module.exports = { crearXlsx };
