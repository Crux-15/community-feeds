'use strict';

/*
 * patch.js: one-time update of feeds.js and the cloud workflow file.
 * Run it once in the community-feeds folder:   node patch.js
 * It changes nothing unless every spot it needs is found exactly as expected.
 */

const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || '.';
const FEEDS = path.join(dir, 'feeds.js');
const FLOW = path.join(dir, '.github', 'workflows', 'feeds.yml');
const SCREEN = path.join(dir, 'screen.js');

function fail(msg) {
  console.log('\nNOT CHANGED. ' + msg + '\n');
  process.exit(1);
}

function load(file) {
  if (!fs.existsSync(file)) fail('Could not find ' + file);
  const raw = fs.readFileSync(file, 'utf8');
  return { raw, crlf: raw.includes('\r\n'), text: raw.replace(/\r\n/g, '\n') };
}

function swap(doc, label, from, to) {
  const parts = doc.text.split(from);
  if (parts.length !== 2) fail('In ' + path.basename(doc.file) + ' the spot "' + label + '" was found ' + (parts.length - 1) + ' times, expected 1. Your file differs from what I expected.');
  doc.text = parts.join(to);
}

function save(doc) {
  fs.writeFileSync(doc.file, doc.crlf ? doc.text.replace(/\n/g, '\r\n') : doc.text);
}

if (!fs.existsSync(SCREEN)) fail('screen.js is missing in this folder. Create it first.');

// ---------------------------------------------------------------------------------------------
// feeds.js
// ---------------------------------------------------------------------------------------------
const feeds = load(FEEDS);
feeds.file = FEEDS;
const feedsDone = feeds.text.includes("require('./screen.js')");

const NEW_DELIVER = String.raw`const isScholarship = (t) => t.to === 'SCHOLARSHIP' || t.to === 'PHD_MS';

// Sources marked screen: true have their scholarship items checked by screen.js first.
// A good item is posted once, in one channel (PHD_MS for Master's/PhD, otherwise SCHOLARSHIP).
async function deliver(item, src, build, state) {
  let targets = targetsFor(item, src);
  let verdict = null;
  if (src.screen && targets.some(isScholarship)) {
    verdict = await screen.screenItem(item, src, state || {});
    targets = targets.filter((t) => !isScholarship(t));
    if (verdict.post) {
      const order = verdict.channel === 'PHD_MS' ? ['PHD_MS', 'SCHOLARSHIP'] : ['SCHOLARSHIP', 'PHD_MS'];
      targets.unshift({ to: order.find((k) => validWebhook(webhookFor(k))) || order[0] });
    } else {
      log('  skipped "' + item.title.slice(0, 90) + '": ' + verdict.reason);
    }
  }
  for (const target of targets) {
    const hook = webhookFor(target.to);
    if (!validWebhook(hook)) {
      log('  ! WEBHOOK_' + target.to + ' is missing or not a webhook address in .env, skipped');
      continue;
    }
    const embed = build(target);
    await postEmbed(hook, verdict && isScholarship(target) ? screen.decorate(embed, verdict) : embed);
    if (state && isScholarship(target)) screen.remember(state, item);
    await sleep(PAUSE_BETWEEN_POSTS_MS);
  }
}

`;

const NEW_PREVIEW = String.raw`// Shows what the screening would post and drop for the newest items, without posting or saving anything
async function preview() {
  console.log('\nPREVIEW: this shows what would be posted and what would be dropped. Nothing is posted or saved.\n');
  screen.setBudget(40);
  const sim = { __posted: JSON.parse(JSON.stringify(loadState().__posted || [])) };
  const short = (s) => (s.length > 110 ? s.slice(0, 109) + '...' : s);
  let would = 0;
  let dropped = 0;
  for (const src of SOURCES.filter((s) => s.enabled !== false && s.screen)) {
    const missing = missingEnv(src);
    if (missing.length) {
      console.log('[SKIP] ' + src.name + ': needs ' + missing.join(' and '));
      continue;
    }
    let items;
    try {
      items = (await readSource(src)).slice(0, 15);
    } catch (err) {
      console.log('[FAIL] ' + src.name + ': ' + err.message);
      continue;
    }
    console.log('== ' + src.name + ' (' + items.length + ' newest items)');
    for (const item of items) {
      if (!targetsFor(item, src).some(isScholarship)) {
        console.log('   SKIP  not for the scholarship channels: ' + short(item.title));
        continue;
      }
      const v = await screen.screenItem(item, src, sim);
      if (v.post) {
        would++;
        screen.remember(sim, item);
        console.log('   POST  ' + v.tags.map((t) => '[' + t + '] ').join('') + '-> ' + v.channel + '  ' + short(item.title));
        console.log('         ' + v.summary + (v.note ? ' | ' + v.note : ''));
      } else {
        dropped++;
        console.log('   DROP  ' + v.reason + ': ' + short(item.title));
      }
    }
  }
  console.log('\nWould post ' + would + ' and drop ' + dropped + ' of the newest items shown above.\n');
}

`;

if (feedsDone) {
  console.log('feeds.js already has the update. Skipping it.');
} else {
  swap(feeds, 'load sources', "const SOURCES = require('./sources.js');", "const SOURCES = require('./sources.js');\nconst screen = require('./screen.js');");

  // replace the old deliver() function
  const startMark = 'async function deliver(item, src, build) {';
  const endMark = '// ---------------------------------------------------------------------------\n// Running one source';
  const a = feeds.text.indexOf(startMark);
  const b = feeds.text.indexOf(endMark);
  if (a === -1 || b === -1 || b < a || feeds.text.indexOf(startMark, a + 1) !== -1) fail('Could not find the posting function in feeds.js.');
  const oldBody = feeds.text.slice(a, b);
  if (!oldBody.includes('for (const target of targetsFor(item, src)) {') || !oldBody.includes('await postEmbed(hook, build(target));')) {
    fail('The posting function in feeds.js is not the version I expected.');
  }
  feeds.text = feeds.text.slice(0, a) + NEW_DELIVER + feeds.text.slice(b);

  swap(feeds, 'feed source posting', 'await deliver(item, src, (t) => makeEmbed(item, src.name, t));', 'await deliver(item, src, (t) => makeEmbed(item, src.name, t), state);');
  swap(feeds, 'preview function', 'async function testWebhooks() {', NEW_PREVIEW + 'async function testWebhooks() {');
  swap(feeds, 'command line', "  if (args.includes('--test-webhooks')) return testWebhooks();", "  if (args.includes('--test-webhooks')) return testWebhooks();\n  if (args.includes('--preview')) return preview();");
  swap(
    feeds,
    'help text',
    ' *   node --env-file=.env feeds.js --test-webhooks     send one test message to each channel',
    ' *   node --env-file=.env feeds.js --test-webhooks     send one test message to each channel\n *   node --env-file=.env feeds.js --preview           show what would be posted or dropped, post nothing',
  );
}

// ---------------------------------------------------------------------------------------------
// the cloud workflow file
// ---------------------------------------------------------------------------------------------
let flow = null;
let flowDone = false;
if (fs.existsSync(FLOW)) {
  flow = load(FLOW);
  flow.file = FLOW;
  flowDone = flow.text.includes('- preview');
  if (!flowDone) {
    swap(flow, 'manual run options', '          - run\n          - check\n', '          - run\n          - check\n          - preview\n');
    swap(
      flow,
      'manual run description',
      "description: 'run = post new items.  check = only test the sources and post nothing.'",
      "description: 'run = post new items.  check = only test the sources.  preview = show what would be posted or dropped, post nothing.'",
    );
    swap(
      flow,
      'run commands',
      '          if [ "$MODE" = "check" ]; then\n            node feeds.js --check\n          else\n',
      '          if [ "$MODE" = "check" ]; then\n            node feeds.js --check\n          elif [ "$MODE" = "preview" ]; then\n            node feeds.js --preview\n          else\n',
    );
  }
} else {
  console.log('Note: ' + FLOW + ' was not found, so the cloud workflow was not updated.');
}

// Everything matched: now write the files
if (!feedsDone) save(feeds);
if (flow && !flowDone) save(flow);
console.log('\nDone. feeds.js ' + (feedsDone ? 'was already updated' : 'updated') + (flow ? ', workflow ' + (flowDone ? 'was already updated' : 'updated') : '') + '.\n');
