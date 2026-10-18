// Okapi BM25 (k1=1.2, b=0.75) with a light tokenizer that keeps money, dates and ids ("$11.40", "po-4817").

const STOP = new Set('a an and are as at be by for from has have i in is it of on or our please re that the this to we will with you your'.split(' '));

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/\$?\d+(?:[.,]\d+)*|[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []).filter((t) => !STOP.has(t));
}

export function bm25(docs: string[], query: string, k1 = 1.2, b = 0.75): { index: number; score: number }[] {
  const toks = docs.map(tokenize);
  const avg = toks.reduce((s, t) => s + t.length, 0) / Math.max(1, toks.length);
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const q = [...new Set(tokenize(query))];
  const n = docs.length;
  return toks
    .map((t, index) => {
      const tf = new Map<string, number>();
      for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
      let score = 0;
      for (const w of q) {
        const f = tf.get(w) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + (n - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg)));
      }
      return { index, score };
    })
    .sort((x, y) => y.score - x.score || y.index - x.index);
}
