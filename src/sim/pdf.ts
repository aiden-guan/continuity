// Tiny single-page PDF writer: Helvetica text in a Flate-compressed content stream.
// Enough to produce believable quote attachments for the local scenario and the tests.
import { deflateSync } from 'node:zlib';
import { WIN_ANSI } from '../ingest/attachments.ts';

const TO_WIN_ANSI = new Map(Object.entries(WIN_ANSI).map(([byte, ch]) => [ch, String.fromCharCode(Number(byte))]));

/** Escape the characters that are special inside a PDF literal string, and encode the text as WinAnsi
 *  (dashes and curly quotes keep their meaning; anything outside the encoding becomes "?"). */
function pdfString(text: string): string {
  const encoded = [...text].map((ch) => TO_WIN_ANSI.get(ch) ?? (ch.charCodeAt(0) <= 0xff ? ch : '?')).join('');
  return encoded.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function makePdf(lines: string[]): Buffer {
  // text operators: font, leading, start position, then one line per Tj (T* moves to the next line)
  const ops = ['BT', '/F1 11 Tf', '14 TL', '56 760 Td'];
  lines.forEach((line, i) => ops.push(`${i > 0 ? 'T* ' : ''}(${pdfString(line)}) Tj`));
  ops.push('ET');
  const compressed = deflateSync(Buffer.from(ops.join('\n'), 'latin1'));

  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.concat([
      Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`),
      compressed,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  ];

  const header = Buffer.from('%PDF-1.4\n');
  const chunks: Buffer[] = [header];
  const offsets: number[] = [];
  let position = header.length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(position);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    position += chunk.length;
  }

  // cross-reference table: entry 0 is the free-list head, then each object's byte offset
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
