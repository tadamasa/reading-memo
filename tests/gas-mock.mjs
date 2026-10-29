// Apps Script の最小限の模擬。hub/Code.gs を Node で動かして確かめるためのもの。
import fs from 'fs';
import vm from 'vm';

export function loadHub() {
  const sheets = new Map();
  const props = {};
  const makeSheet = name => {
    const sh = { name, rows: [], maxRows: 1000, frozen: 0 };
    const range = (r, c, nr = 1, nc = 1) => {
      if (r + nr - 1 > sh.maxRows) throw new Error(`範囲外 ${r + nr - 1} > ${sh.maxRows}`);
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((sh.rows[r - 1 + i] || [])[c - 1 + j] ?? ''))),
        setValues: v => { v.forEach((row, i) => { sh.rows[r - 1 + i] = sh.rows[r - 1 + i] || []; row.forEach((x, j) => { sh.rows[r - 1 + i][c - 1 + j] = x; }); }); return range(r, c, nr, nc); },
        setNumberFormat: () => range(r, c, nr, nc),
        setFontWeight: () => range(r, c, nr, nc),
      };
    };
    sh.api = {
      getRange: range,
      getLastRow: () => sh.rows.length,
      getMaxRows: () => sh.maxRows,
      insertRowsAfter: (_, n) => { sh.maxRows += n; },
      setFrozenRows: n => { sh.frozen = n; },
    };
    sheets.set(name, sh);
    return sh.api;
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => (sheets.get(n) || {}).api || null, insertSheet: makeSheet }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: s => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Utilities: { getUuid: () => '1234-5678-abcd' },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../hub/Code.gs', import.meta.url), 'utf8'), ctx);
  ctx.setup();
  return {
    token: props.TOKEN,
    sheets,
    post: body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text),
    readingNotesOn: d => ctx.readingNotesOn(d),
  };
}
