// Re-grade saved agent decisions against the eval rubrics. Makes no model calls.
//
//   node eval/grade.ts eval/results/llm-2026-10-17                          # dir of <scenario>.<condition>.json
//   node --env-file=.env eval/grade.ts eval/results/latest-llm-extractor-llm-handoff.json   # an `npm run eval -- --llm` output
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS, grade } from './scenarios.ts';

type Graded = { pass: boolean; fails: string[] };

const target = process.argv[2] ?? 'eval/results/llm-2026-10-17';

const rubricFor = (id: string) => SCENARIOS.find((s) => s.id === id)?.rubric;
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

function report(id: string, condition: string, result: Graded) {
  const verdict = result.pass ? 'PASS' : 'FAIL';
  const why = result.fails.length ? '  — ' + result.fails.join('; ') : '';
  console.log(`${id.padEnd(20)} ${condition.padEnd(11)} ${verdict}${why}`);
}

// A directory holds one decision per file, named <scenario>.<condition>.json.
function gradeDirectory(dir: string) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  for (const file of files) {
    const [id, condition] = file.replace('.json', '').split('.');
    const rubric = rubricFor(id);
    if (rubric) report(id, condition, grade(readJson(join(dir, file)), rubric));
  }
}

// A single file is a full eval run with LLM decisions stored per row and condition.
function gradeRunFile(path: string) {
  const run = readJson(path);
  for (const row of run.rows) {
    const rubric = rubricFor(row.id);
    for (const condition of ['compiled', 'recent', 'transcript']) {
      const decision = row[`llm_${condition}`]?.decision;
      if (rubric && decision) report(row.id, condition, grade(decision, rubric));
    }
  }
}

if (statSync(target).isDirectory()) gradeDirectory(target);
else gradeRunFile(target);
