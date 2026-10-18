// Text extraction from attachments. Intentionally minimal: plain text, CSV and JSON, plus
// text-based PDFs (FlateDecode or uncompressed content streams drawn with Tj/TJ). Scanned PDFs
// and complex layouts are out of scope — they come back as empty text and get flagged.
import { inflateSync } from 'node:zlib';

export function attachmentText(filename: string, contentType: string, bytes: Buffer): string {
  const type = contentType.toLowerCase();
  const looksTextual = type.startsWith('text/') || /\.(txt|csv|md|json)$/i.test(filename) || type.includes('json');
  if (looksTextual) return bytes.toString('utf8');
  const looksPdf = type.includes('pdf') || /\.pdf$/i.test(filename) || bytes.subarray(0, 5).toString('latin1') === '%PDF-';
  if (looksPdf) return pdfText(bytes);
  return '';
}

export function pdfText(buf: Buffer): string {
  const source = buf.toString('latin1');
  const lines: string[] = [];
  const streamHeader = /<<([^]*?)>>\s*stream\r?\n/g;
  for (let hit = streamHeader.exec(source); hit; hit = streamHeader.exec(source)) {
    const begin = hit.index + hit[0].length;
    const finish = source.indexOf('endstream', begin);
    if (finish < 0) break;
    const dict = hit[1];
    let data = buf.subarray(begin, finish);
    if (/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(data);
      } catch {
        continue;
      }
    } else if (/Filter/.test(dict)) {
      continue; // some other filter we cannot decode
    }
    lines.push(...contentStreamText(data.toString('latin1')).map(fromWinAnsi));
    streamHeader.lastIndex = finish;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** WinAnsiEncoding bytes 0x80–0x9F (where it differs from Latin-1): dashes, curly quotes, ellipsis, euro. */
export const WIN_ANSI: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

/** Simple-font text bytes are WinAnsi (the standard Type 1 encoding for Latin text). */
const fromWinAnsi = (s: string) => s.replace(/[\x80-\x9f]/g, (c) => WIN_ANSI[c.charCodeAt(0)] ?? c);

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

/** Undo PDF literal-string escapes (\n, \(, octal \ddd, ...). */
function decodePdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, code: string) => {
    if (/^[0-7]+$/.test(code)) return String.fromCharCode(parseInt(code, 8));
    return ESCAPES[code];
  });
}

const TEXT_SHOWING = ['Tj', 'TJ', "'", '"'];

/** Walk a content stream's operators and collect the text it draws, one entry per visual line. */
function contentStreamText(cs: string): string[] {
  if (!/\bBT\b/.test(cs)) return [];
  const lines: string[] = [];
  let current = '';
  const endLine = () => {
    if (current.trim()) lines.push(current.trim());
    current = '';
  };
  // tokens: (string), [array], <hex>, operators, numbers
  const token = /\((?:\\.|[^\\)])*\)|\[(?:\((?:\\.|[^\\)])*\)|[^\]])*\]|<[0-9A-Fa-f\s]*>|[A-Za-z*'"]+|-?\d*\.?\d+/g;
  const operands: string[] = [];
  for (let hit = token.exec(cs); hit; hit = token.exec(cs)) {
    const t = hit[0];
    const isOperand = t.startsWith('(') || t.startsWith('[') || t.startsWith('<') || /^-?\d*\.?\d+$/.test(t);
    if (isOperand) {
      operands.push(t);
      continue;
    }
    if (t === 'Tj' || t === "'" || t === '"') {
      if (t !== 'Tj') endLine();
      const str = operands.pop() ?? '';
      current += str.startsWith('(') ? decodePdfString(str.slice(1, -1)) : '';
    } else if (t === 'TJ') {
      const array = operands.pop() ?? '';
      for (const piece of array.matchAll(/\((?:\\.|[^\\)])*\)|-?\d*\.?\d+/g)) {
        if (piece[0].startsWith('(')) current += decodePdfString(piece[0].slice(1, -1));
        else if (Number(piece[0]) < -200) current += ' '; // a large negative kern reads as a word gap
      }
    } else if (t === 'T*' || t === 'Tm' || t === 'ET') {
      endLine();
    } else if (t === 'Td' || t === 'TD') {
      const ty = Number(operands.pop());
      operands.pop();
      if (ty !== 0) endLine();
    }
    if (!TEXT_SHOWING.includes(t)) operands.length = 0;
  }
  endLine();
  return lines;
}
