import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";

/**
 * A very small .xlsx reader: enough ZIP to get the parts out, and enough
 * SpreadsheetML to turn a sheet into rows of strings.
 *
 * Written by hand so that importing a media list needs no extra dependency —
 * a contributor with a spreadsheet should not have to install a toolchain.
 */

/* ------------------------------------------------------------------ zip -- */

/** Reads a ZIP archive into { filename: Buffer } using the central directory. */
export function unzip(buf) {
  // End of central directory record: signature, then the offset of the CD.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");

  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};

  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // the local header repeats the name and extra field, with its own lengths
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    out[name] = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* -------------------------------------------------------------- xlsx --- */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (n) => ["row", "c", "si", "sheet", "Relationship"].includes(n),
  // numeric character references (&#252;) are valid XML and appear in exports
  htmlEntities: true,
  // spreadsheets are full of legitimate &amp; — the default cap is far too low
  processEntities: {
    enabled: true,
    maxExpansionDepth: 4,
    maxEntityCount: 200,
    maxTotalExpansions: 2000000,
    maxExpandedLength: 80000000,
  },
});

const columnIndex = (ref) => {
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

const textOf = (v) => (v && typeof v === "object" ? (v["#text"] ?? "") : (v ?? ""));

/**
 * @param {string} file path to an .xlsx
 * @returns {Record<string, string[][]>} sheet name → rows → cells
 */
export function readWorkbook(file) {
  const zip = unzip(readFileSync(file));
  const read = (name) => (zip[name] ? zip[name].toString("utf8") : null);

  const sharedXml = read("xl/sharedStrings.xml");
  const shared = sharedXml
    ? (parser.parse(sharedXml).sst?.si || []).map((si) => {
        if (si.t !== undefined) return String(textOf(si.t));
        const runs = Array.isArray(si.r) ? si.r : si.r ? [si.r] : [];
        return runs.map((r) => String(textOf(r.t))).join("");
      })
    : [];

  const wb = parser.parse(read("xl/workbook.xml")).workbook;
  const rels = parser.parse(read("xl/_rels/workbook.xml.rels")).Relationships.Relationship;
  const target = Object.fromEntries(rels.map((r) => [r["@Id"], r["@Target"].replace(/^\/?xl\//, "")]));

  const out = {};
  for (const sheet of wb.sheets.sheet) {
    const xml = read(`xl/${target[sheet["@r:id"]]}`);
    if (!xml) continue;
    const rows = parser.parse(xml).worksheet?.sheetData?.row || [];
    out[sheet["@name"]] = rows.map((r) => {
      const cells = [];
      for (const c of r.c || []) {
        let v = textOf(c.v);
        if (c["@t"] === "s") v = shared[Number(v)] ?? "";
        else if (c["@t"] === "inlineStr") v = textOf(c.is?.t);
        cells[columnIndex(c["@r"])] = v === null || v === undefined ? "" : String(v);
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
      return cells;
    });
  }
  return out;
}

/** Turns a sheet with a header row into objects keyed by column heading. */
export function rowsToObjects(rows) {
  if (!rows?.length) return [];
  const head = rows[0].map((h) => String(h || "").trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] ?? "").trim()])));
}
