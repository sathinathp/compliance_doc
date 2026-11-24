'use strict';
// Reading report: shows how Aegis reads an evidence file, without uploading or saving anything.
// For each file it prints what kind of file it is, the text the code took out, the fields the text
// rules found, the fields the AI found, and the final result with the reasons a person would see.
//
//   node scripts/read-evidence.js <file or folder> [--no-ai] [--text]
//
//   --no-ai   text rules only (no AI call, no cost)
//   --text    also print the text the code took out of each file
// Uses the AI keys in .env (main provider first, then the fallback). Nothing is written to the database.
const fs = require('fs'), path = require('path');

const args = process.argv.slice(2), has = (f) => args.includes(f), target = args.find((a) => !a.startsWith('--'));
if (!target) { console.error('Use: node scripts/read-evidence.js <file or folder> [--no-ai] [--text]'); process.exit(2); }
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test'; // in-memory database: nothing is saved
delete process.env.AEGIS_TEST_DATABASE_URL; delete process.env.AEGIS_LLM_BASE_URL;
if (has('--no-ai')) for (const k of ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'AEGIS_LLM_PROVIDER']) delete process.env[k];
const db = require('../server/lib/db');
db.open(':memory:');
const Ev = require('../server/evidence'), docread = require('../server/lib/docread'), llm = require('../server/llm');

const FIELDS = ['doc_type', 'holder_name', 'doc_number', 'issued_on', 'expires_on', 'state'];
const show = (v) => (v === undefined || v === null || v === '' ? '—' : String(v));
const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter((f) => !/\.(md|html)$/i.test(f) && fs.statSync(path.join(target, f)).isFile()).sort().map((f) => path.join(target, f))
  : [target];

async function report(name, buf, mime) {
  const x = await Ev.extract('report', buf, mime, name);
  console.log(`\n■ ${name}   (read as: ${x.kind}${x.text ? `, ${x.text.length} characters of text` : ', no text: picture or scan'})`);
  if (has('--text') && x.text) console.log(x.text.split('\n').map((l) => `   │ ${l}`).join('\n'));
  console.log(`   ${'field'.padEnd(12)} ${'text rules'.padEnd(26)} ${'AI'.padEnd(26)} final (how sure)`);
  for (const k of FIELDS) {
    const final = x.fields[k], conf = x.confidence[k];
    console.log(`   ${k.padEnd(12)} ${show(x.byRules[k]).padEnd(26)} ${show(x.byAI[k]).padEnd(26)} ${show(final)}${final ? ` (${Math.round(conf * 100)}%)` : ''}`);
  }
  const notes = [x.aiNote, x.sourceNote,
    x.aiRead && 'Read by AI from a picture: a person must confirm.',
    x.disagreements.length && `Text rules and AI disagree on: ${x.disagreements.join(', ')}`,
    x.notOnPage.length && `AI gave values not in the text: ${x.notOnPage.join(', ')}`,
    x.scanRead.length && `Read from scanned page ${x.scanPages.join(', ')}: ${x.scanRead.join(', ')}`,
    ...x.ambiguous.map((a) => `${a.field} printed as ${a.printed}: can be read two ways`),
    x.flags.length && 'Contains instruction-like text: held for review'].filter(Boolean);
  for (const n of notes) console.log(`   • ${n}`);
}

(async () => {
  const ai = llm.status('report');
  console.log(ai.configured ? `AI: ${ai.provider_label}${ai.fallback ? `, then ${ai.fallback.provider_label} if it fails` : ''}` : 'AI: off (text rules only)');
  for (const file of files) {
    const buf = fs.readFileSync(file), name = path.basename(file);
    let box = null;
    try { box = await docread.unpack(buf, '', name); } catch (e) { console.log(`\n■ ${name}: cannot open: ${e.message}`); continue; }
    if (!box) { await report(name, buf, ''); continue; }
    console.log(`\n■ ${name}: ${box.from} with ${box.files.length} document(s)${box.skipped.length ? `; left out ${box.skipped.join(', ')}` : ''}`);
    for (const f of box.files) await report(`${name} › ${f.name}`, f.data, f.mime);
  }
  const err = llm.lastError('report');
  if (err) console.log(`\nAI note: ${err.message}`);
  db.close();
})().catch((e) => { console.error(`Could not read: ${e.message}`); process.exit(1); });
