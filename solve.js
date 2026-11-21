// Fast csv-reader 1.0.0-compatible CSV reader.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. Written from scratch for speed: the reference reads one
// character at a time and builds every field by concatenation; this reader instead
// scans with indexOf (C++ memchr-class work in V8) and slices whole fields out of
// the text, with no intermediate copies — a field is cut straight from the input.
//
// How it works:
// - The text is read once, left to right. A U+FEFF at the very start is dropped.
// - A record is read field by field. A field that opens with a quote is read by the
//   quoted reader below; any other field starts an unquoted stretch, which runs to
//   the next quote, line break or end of the text, and whose fields are cut out of
//   the text with one indexOf(',') per comma — no per-character work, no copy of the
//   stretch, no array of parts. A stretch that ends at a quote either ends at a
//   field boundary (the next field is quoted) or is the start of one unquoted field
//   that holds the quote as a literal, which the unquoted reader then finishes.
//   A CR in a stretch is a stray CR (dropped, error stray_cr), except the CR of a
//   CRLF ending the line.
// - The broken-row policy is csv-reader's own, exactly:
//   * a record ends at LF or CRLF; a line left with no characters is no record;
//   * outside quotes a CR not followed by LF is dropped (error stray_cr);
//   * a field that opens with a quote runs to the next quote that is not doubled
//     ("" inside it is one quote, each CRLF or lone CR inside it is read as LF);
//     what follows its closing quote, up to the next comma or line break, is appended
//     as it stands (quote_junk, when the field ends); a quote that never closes is a
//     literal character and the text after it is read again as unquoted
//     (unterminated_quote); a quote inside an unquoted field is a literal character;
//   * fields stay strings, never trimmed or converted;
//   * columns is the first record when header is true, else null; rows holds the
//     records after it, each padded with "" (short_row, with fields: its field count)
//     or cut (long_row, with extra: the cut fields) to the first record's width;
//   * each error is {code, line, row} in the order met, a record's short_row or
//     long_row when it ends: line the 1-based line its record starts on (every LF,
//     CRLF and lone CR inside quotes counted), row its record's index in rows
//     (null for the header).
// - Every error of a record carries that record's start line and row index, so the
//   readers share the record's line/row in two variables.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.
// No dependencies, no network, no WASM or native addons.

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // The quoted content text[start..end): every CRLF or lone CR inside it becomes one
  // LF, and line counts every LF, CRLF and lone CR it held.
  function quotedContent(start, end) {
    const s = text.slice(start, end);
    if (s.indexOf('\n') === -1 && s.indexOf('\r') === -1) return s;
    // Rare: a quoted field that spans lines. Convert and count in one short pass.
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 13) {
        out += '\n';
        line += 1;
        if (i + 1 < s.length && s.charCodeAt(i + 1) === 10) i++;
      } else {
        if (c === 10) line += 1;
        out += s[i];
      }
    }
    return out;
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR
  // not followed by LF is dropped (stray_cr). Returns [value, ended, added]:
  // ended 0 = comma, 1 = line break, 2 = end of the text; added counts the
  // characters kept (a quote_junk error needs it). Used for quote junk, for a quote
  // that never closes, and for the rare unquoted field that holds a stray CR.
  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      let end = n;
      let kind = 2;
      const ci = text.indexOf(',', pos);
      if (ci !== -1 && ci < end) { end = ci; kind = 0; }
      const ni = text.indexOf('\n', pos);
      if (ni !== -1 && ni < end) { end = ni; kind = 1; }
      const ri = text.indexOf('\r', pos);
      if (ri !== -1 && ri < end) { end = ri; kind = 3; }
      if (kind === 3) {
        if (end + 1 < n && text.charCodeAt(end + 1) === 10) {
          if (end > pos) { value += text.slice(pos, end); added += end - pos; }
          pos = end + 2;
          line += 1;
          return [value, 1, added];
        }
        // A lone CR is dropped (stray_cr) and the field goes on.
        if (end > pos) { value += text.slice(pos, end); added += end - pos; }
        pushError('stray_cr');
        pos = end + 1;
        continue;
      }
      if (end > pos) { value += text.slice(pos, end); added += end - pos; }
      if (kind === 0) { pos = end + 1; return [value, 0, added]; }
      if (kind === 1) { pos = end + 1; line += 1; return [value, 1, added]; }
      pos = n;
      return [value, 2, added];
    }
    return [value, 2, added];
  }

  // Reads a quoted field whose opening quote is at pos.
  // Returns [value, ended, added] with the same ended codes as readUnquoted.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let start = pos;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it
        // is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        return readUnquoted('"');
      }
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one literal quote; the field goes on.
        value += quotedContent(start, q) + '"';
        pos = q + 2;
        start = pos;
        continue;
      }
      value += quotedContent(start, q);
      pos = q + 1;
      break;
    }
    if (pos >= n) return [value, 2, 0];
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; return [value, 0, 0]; }
    if (c === 10) { pos += 1; line += 1; return [value, 1, 0]; }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [value, 1, 0];
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk[2] > 0) pushError('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false; // whether the record's last field was quoted

    while (true) {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const field = readQuoted();
        fields.push(field[0]);
        if (field[1] !== 0) break; // the record ends
        continue;
      }
      // An unquoted stretch: to the next quote, line break or end of the text.
      // The CR of a CRLF ending the line is stripped by a one-character check; any
      // other CR in the stretch is a stray CR, read the slow way below.
      const qi = text.indexOf('"', pos);
      const ni = text.indexOf('\n', pos);
      let bound = n;
      let endKind = 2; // 1 = line break, 2 = end of text, 3 = quote
      if (qi !== -1 && qi < bound) { bound = qi; endKind = 3; }
      if (ni !== -1 && ni < bound) { bound = ni; endKind = 1; }
      let end = bound;
      if (endKind === 1 && bound > pos && text.charCodeAt(bound - 1) === 13) end = bound - 1;
      const ri = text.indexOf('\r', pos);
      if (ri !== -1 && ri < end) {
        // A stray CR: one field the slow way (it drops the CR and goes on).
        quoted = false;
        const field = readUnquoted('');
        fields.push(field[0]);
        if (field[1] !== 0) break;
        continue;
      }
      if (endKind === 1 || endKind === 2) {
        // The stretch is the rest of the record: cut its fields out of the text.
        let fstart = pos;
        while (true) {
          const c = text.indexOf(',', fstart);
          if (c === -1 || c >= end) { fields.push(text.slice(fstart, end)); break; }
          fields.push(text.slice(fstart, c));
          fstart = c + 1;
        }
        pos = endKind === 1 ? bound + 1 : n;
        if (endKind === 1) line += 1;
        quoted = false;
        break;
      }
      // endKind === 3: a quote ahead. The stretch either ends at a field boundary
      // (empty, or its last character a comma) and the next field is quoted, or it
      // is the start of one unquoted field that holds the quote as a literal.
      if (end === pos || text.charCodeAt(end - 1) === 44) {
        let fstart = pos;
        while (fstart < end) {
          const c = text.indexOf(',', fstart);
          if (c === -1 || c >= end) break;
          fields.push(text.slice(fstart, c));
          fstart = c + 1;
        }
        pos = bound; // at the quote: the next field is quoted
        continue;
      }
      let fstart = pos;
      let lastPart = '';
      while (true) {
        const c = text.indexOf(',', fstart);
        if (c === -1 || c >= end) { lastPart = text.slice(fstart, end); break; }
        fields.push(text.slice(fstart, c));
        fstart = c + 1;
      }
      quoted = false;
      pos = bound; // at the quote: it is a literal character of this field
      const field = readUnquoted(lastPart);
      fields.push(field[0]);
      if (field[1] !== 0) break; // the record ends
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
