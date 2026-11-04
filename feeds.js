'use strict';

/*
 * Community update feeds
 *
 * Watches the sources listed in sources.js and posts new items into your
 * Discord channels through webhooks (private posting links kept in .env).
 *
 * Commands (run in the project folder, in Command Prompt):
 *   node --env-file=.env feeds.js --check             test every source, post nothing
 *   node --env-file=.env feeds.js --test-webhooks     send one test message to each channel
 *   node --env-file=.env feeds.js --preview           show what would be posted or dropped, post nothing
 *   node --env-file=.env feeds.js --latest 3          post the newest 3 items of each source now
 *                                                     (for contests: the next 3 upcoming ones)
 *   node --env-file=.env feeds.js --latest 3 --only Codeforces
 *                                                     same, but only for sources whose name contains "Codeforces"
 *   node --env-file=.env feeds.js --once              check once, post anything new, then stop
 *   node --env-file=.env feeds.js                     keep running; each source is checked on its own
 *                                                     schedule (see "every" in sources.js)
 *
 * The first time a source is checked, its existing items are only remembered
 * (not posted), so your channels do not get flooded with old posts.
 * Contests are the exception to one thing: a "starting soon" reminder is still
 * sent for contests that begin within the reminder window.
 */

const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');
const SOURCES = require('./sources.js');
const screen = require('./screen.js');

const STATE_FILE = path.join(__dirname, 'seen.json');
const USER_AGENT = 'Mozilla/5.0 (compatible; CommunityFeedBot/1.0)';
const MAX_PER_ROUND = 8; // never post more than this many items per source per check
const KEEP_SEEN = 500; // how many past items to remember per source
const PAUSE_BETWEEN_POSTS_MS = Number(process.env.FEED_POST_PAUSE_MS ?? 1500);
const DEFAULT_EVERY_MINUTES = 30; // used when a source has no "every" setting
const TICK_MINUTES = 5; // the running loop wakes up this often and checks which sources are due

const WEBHOOK_KEYS = ['SCHOLARSHIP', 'PHD_MS', 'IELTS', 'GRE', 'WEBINAR', 'CONTESTS', 'COMPETITIONS'];
const CONTEST_TYPES = new Set(['codeforces', 'clist']);

const COLORS = {
  SCHOLARSHIP: 0x3498db,
  PHD_MS: 0x9b59b6,
  IELTS: 0xe74c3c,
  GRE: 0xe67e22,
  WEBINAR: 0x2ecc71,
  CONTESTS: 0x1abc9c,
  COMPETITIONS: 0xe91e63,
};
const FUNDED_COLOR = 0xf1c40f; // gold
const SOON_COLOR = 0xe67e22; // orange

// Words that suggest free travel, accommodation or full funding.
// Used to mark posts with [FUNDED]. It is a text match, so always check the official page.
const FUNDED = new RegExp(
  [
    'fully[- ]funded',
    'all[- ]expenses?[- ](paid|covered)',
    'expenses[- ](paid|covered)',
    '(travel|flights?|airfare|accommodation|lodging|hotel)s?\\W+(?:\\w+\\W+){0,3}(covered|paid|provided|included|sponsored|funded|reimbursed)',
    '(free|sponsored|funded|paid)\\W+(?:\\w+\\W+){0,2}(travel|flights?|airfare|accommodation|lodging|hotel|trip)',
    'travel (grants?|support|stipends?|funding)',
  ].join('|'),
  'i',
);

const parser = new Parser();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const lastRun = {}; // when each source was last checked (kept in memory only)
const warned = new Set(); // so each "skipped" message appears only once

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function codePoint(n) {
  try {
    return String.fromCodePoint(Number(n));
  } catch (_) {
    return ' ';
  }
}

// Turns HTML into plain text and shortens it
function clean(html, max) {
  let text = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => codePoint(n))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (max && text.length > max) text = text.slice(0, max - 1).trimEnd() + '…';
  return text;
}

const stripSlash = (u) => u.replace(/\/+$/, '');

async function fetchText(url, extraHeaders = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, application/json, text/xml, text/html, */*',
        ...extraHeaders,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('timed out after 20 seconds');
    const c = err.cause;
    const why = c && (c.code || c.message);
    throw new Error(`could not connect${why ? ` (${why})` : ''}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  return res.text();
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(`${what} did not return JSON data (the address may be wrong or the site changed)`);
  }
}

// Explains a failure in plain words
function hint(msg) {
  if (/HTTP 40[13]/.test(msg)) return 'The site refuses automated access (or the login details are wrong).';
  if (/HTTP 404/.test(msg)) return 'The address is wrong or has moved.';
  if (/HTTP 429/.test(msg)) return 'Too many requests. Try again later.';
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'This website address was not found. Check the spelling, and your internet.';
  if (/ECONNRESET|ETIMEDOUT|CONNECT_TIMEOUT|timed out|ECONNREFUSED/.test(msg)) {
    return 'The site did not answer. It may be blocked on your network, or just slow.';
  }
  if (/CERT|SSL|TLS/i.test(msg)) return 'A security certificate problem. The site may be blocked or misconfigured.';
  return 'Turn it off in sources.js (enabled: false) or fix the address.';
}

function fmtDuration(sec) {
  if (!sec || sec < 60) return 'not listed';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const PLATFORM_NAMES = {
  'codeforces.com': 'Codeforces',
  'leetcode.com': 'LeetCode',
  'atcoder.jp': 'AtCoder',
  'codechef.com': 'CodeChef',
  'topcoder.com': 'TopCoder',
  'hackerrank.com': 'HackerRank',
  'hackerearth.com': 'HackerEarth',
};
function platformName(host) {
  const h = String(host || '').toLowerCase();
  for (const [k, v] of Object.entries(PLATFORM_NAMES)) if (h.includes(k)) return v;
  return h || 'Contest';
}

// ---------------------------------------------------------------------------
// Reading sources
// ---------------------------------------------------------------------------
async function readRss(src) {
  const xml = await fetchText(src.url);
  const feed = await parser.parseString(xml);
  const items = (feed.items || [])
    .map((i) => {
      let title = clean(i.title, 300) || '(no title)';
      let publisher = '';
      // Google News adds " - Publisher" to every title
      if (src.stripPublisher) {
        // splits at the LAST " - ", so publishers like "Al-Fanar Media" work too
        const m = title.match(/^(.*\S)\s+-\s+(.{2,60})$/);
        if (m) {
          title = m[1];
          publisher = m[2].trim();
        }
      }
      if (title.length > 250) title = title.slice(0, 249).trimEnd() + '…';
      return {
        id: i.guid || i.id || i.link || i.title,
        title,
        publisher,
        url: i.link || '',
        summary: src.stripPublisher ? '' : clean(i.contentSnippet || i.content || i.summary, 350),
        date: i.isoDate || i.pubDate || null,
      };
    })
    .filter((i) => i.id);
  // newest first (keeps the feed's own order when dates are missing)
  return items
    .map((item, index) => ({ item, index, t: Date.parse(item.date) || 0 }))
    .sort((a, b) => b.t - a.t || a.index - b.index)
    .map((x) => x.item);
}

// For sites without a feed: find article links on the page that start with linkPrefix
async function readPage(src) {
  if (!src.linkPrefix) throw new Error('This page source needs a linkPrefix in sources.js');
  const html = await fetchText(src.url);
  const self = stripSlash(src.url);
  const prefix = stripSlash(src.linkPrefix);
  const found = new Map();
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let u;
    try {
      u = new URL(m[1].replace(/&amp;/g, '&'), src.url);
    } catch (_) {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    u.hash = '';
    const url = stripSlash(u.href);
    if (!url.startsWith(prefix) || url === prefix || url === self) continue;
    if (src.exclude && src.exclude.test(url)) continue;
    let title = clean(m[2], 500);
    let date = null;
    // Some sites put labels in front of the title, like "Global News 5 min 07/09/2026 Title".
    // stripFromTitle removes that label, and a day/month/year date inside it becomes the post date.
    if (src.stripFromTitle) {
      const label = title.match(src.stripFromTitle);
      if (label && label.index === 0) {
        const dmy = label[0].match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (dmy) date = new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1])).toISOString();
        title = title.slice(label[0].length).trim();
      }
    }
    if (title.length > 250) title = title.slice(0, 249).trimEnd() + '…';
    if (title.length < 12) continue; // skips "Read more", icons, menu items
    const prev = found.get(url);
    if (!prev || title.length > prev.title.length) {
      found.set(url, { id: url, title, url, summary: '', date });
    }
  }
  return [...found.values()]; // page order, newest first on most news pages
}

// Devpost's public hackathon list (JSON)
async function readDevpost(src) {
  const data = parseJson(await fetchText(src.url), 'Devpost');
  const list = Array.isArray(data.hackathons) ? data.hackathons : [];
  const out = [];
  for (const h of list) {
    const location = clean((h.displayed_location && h.displayed_location.location) || h.location || '', 80);
    const prize = clean(String(h.prize_amount || h.prizeAmount || '').replace(/<[^>]+>/g, ''), 40);
    const prizeNumber = Number(prize.replace(/[^0-9.]/g, '')) || 0;
    if (src.minPrize && prizeNumber < src.minPrize) continue;
    const themes = (h.themes || []).map((t) => t && t.name).filter(Boolean).slice(0, 4).join(', ');
    const dates = clean(h.submission_period_dates || h.submissionPeriodDates || '', 60);
    const org = clean(h.organization_name || h.organizationName || '', 60);
    const lines = [];
    if (location) lines.push(`Location: ${location}`);
    if (dates) lines.push(`Dates: ${dates}`);
    if (prize && prizeNumber > 0) lines.push(`Prizes: ${prize}`);
    if (themes) lines.push(`Themes: ${themes}`);
    if (org) lines.push(`Organizer: ${org}`);
    const url = h.url || '';
    const id = h.id ? `devpost-${h.id}` : url;
    if (!id || !h.title) continue;
    out.push({ id, title: clean(h.title, 250), url, summary: lines.join('\n'), date: null });
  }
  return out; // the address in sources.js asks for the most recently added first
}

// Codeforces official API: upcoming contests
async function readCodeforces(src) {
  const data = parseJson(await fetchText(src.url), 'Codeforces');
  if (data.status && data.status !== 'OK') throw new Error(`Codeforces said: ${data.comment || data.status}`);
  return (data.result || [])
    .filter((c) => c.phase === 'BEFORE' && c.startTimeSeconds)
    .map((c) => ({
      id: `cf-${c.id}`,
      title: clean(c.name, 200),
      url: `https://codeforces.com/contests/${c.id}`,
      start: c.startTimeSeconds,
      duration: c.durationSeconds || 0,
      platform: 'Codeforces',
    }))
    .sort((a, b) => a.start - b.start);
}

// clist.by: contests from many platforms (needs a free account and API key)
async function readClist(src) {
  const u = new URL(src.url);
  u.searchParams.set('username', (process.env.CLIST_USERNAME || '').trim());
  u.searchParams.set('api_key', (process.env.CLIST_API_KEY || '').trim());
  u.searchParams.set('start__gt', new Date().toISOString().slice(0, 19));
  u.searchParams.set('order_by', 'start');
  u.searchParams.set('limit', String(src.limit || 100));
  u.searchParams.set('format', 'json');
  const data = parseJson(await fetchText(u.href), 'clist.by');
  const objects = Array.isArray(data.objects) ? data.objects : [];

  const wanted = (src.platforms || []).map((p) => p.toLowerCase());
  const unwanted = (src.excludePlatforms || ['codeforces.com']).map((p) => p.toLowerCase());
  const hosts = new Set();
  const out = [];
  for (const o of objects) {
    const host = String(
      o.host || (typeof o.resource === 'string' ? o.resource : o.resource && (o.resource.name || o.resource.host)) || '',
    ).toLowerCase();
    if (host) hosts.add(host);
    if (wanted.length && !wanted.some((w) => host.includes(w))) continue;
    if (unwanted.some((w) => host.includes(w))) continue;
    const raw = String(o.start || '');
    const start = Math.floor(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw + 'Z') / 1000);
    if (!start || !o.event) continue;
    out.push({
      id: o.id ? `cl-${o.id}` : `cl-${host}-${o.event}-${start}`,
      title: clean(o.event, 200),
      url: o.href || '',
      start,
      duration: Number(o.duration) || 0,
      platform: platformName(host),
    });
  }
  out.sort((a, b) => a.start - b.start);
  out.hosts = [...hosts].sort();
  return out;
}

function readSource(src) {
  switch (src.type) {
    case 'page': return readPage(src);
    case 'devpost': return readDevpost(src);
    case 'codeforces': return readCodeforces(src);
    case 'clist': return readClist(src);
    default: return readRss(src);
  }
}

// ---------------------------------------------------------------------------
// Remembering what was already posted
// ---------------------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------------------------------------------------------------------------
// Posting to Discord through webhooks
// ---------------------------------------------------------------------------
const webhookFor = (key) => (process.env[`WEBHOOK_${key}`] || '').trim();
const validWebhook = (url) => /\/api\/webhooks\/\d+\/[\w-]+/.test(url);

async function postEmbed(webhook, embed) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed_mentions: { parse: [] }, embeds: [embed] }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      await sleep(Math.ceil((data.retry_after || 2) * 1000) + 250);
      continue;
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Discord answered HTTP ${res.status} ${body}`.trim());
    }
    return;
  }
  throw new Error('Discord is limiting how fast we post. It will be retried next round.');
}

function makeEmbed(item, sourceName, target) {
  const funded = !!target.flagFunded && FUNDED.test(`${item.title} ${item.summary || ''}`);
  const embed = {
    title: ((funded ? '[FUNDED] ' : '') + item.title).slice(0, 256),
    color: funded ? FUNDED_COLOR : COLORS[target.to] || 0x95a5a6,
    footer: { text: item.publisher ? `${sourceName} | ${item.publisher}` : sourceName },
  };
  if (item.url) embed.url = item.url;
  const description =
    (funded ? '**Mentions full funding or paid travel or accommodation.** Check the official page for what exactly is covered.\n\n' : '') +
    (item.summary || '');
  if (description.trim()) embed.description = description.slice(0, 4000);
  const when = item.date ? new Date(item.date) : null;
  if (when && !isNaN(when)) embed.timestamp = when.toISOString();
  return embed;
}

// Discord turns <t:SECONDS:F> and <t:SECONDS:R> into the reader's own time zone
function makeContestEmbed(c, kind, key) {
  const soon = kind === 'soon';
  return {
    title: `${soon ? 'Starting soon' : 'New contest'}: [${c.platform}] ${c.title}`.slice(0, 256),
    url: c.url || undefined,
    color: soon ? SOON_COLOR : COLORS[key] || 0x95a5a6,
    description:
      `Starts: <t:${c.start}:F> (<t:${c.start}:R>)\n` +
      `Duration: ${fmtDuration(c.duration)}\n` +
      'Times are shown in your own time zone.',
    footer: { text: c.platform },
  };
}

function targetsFor(item, src) {
  const text = `${item.title} ${item.summary || ''} ${item.platform || ''}`;
  return (src.targets || []).filter(
    (t) => (!t.match || t.match.test(text)) && (!t.exclude || !t.exclude.test(text)),
  );
}

const isScholarship = (t) => t.to === 'SCHOLARSHIP' || t.to === 'PHD_MS';

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

// ---------------------------------------------------------------------------
// Running one source
// ---------------------------------------------------------------------------
async function runFeedSource(src, state, { latest = 0 } = {}) {
  const seen = new Set(state[src.name] || []);
  const firstRun = !state[src.name];
  const items = await readSource(src);
  let fresh;
  if (latest > 0) {
    fresh = items.slice(0, latest).reverse();
    // remember the rest, so the first real run does not flood the channel
    if (firstRun) items.forEach((i) => seen.add(i.id));
  } else if (firstRun) {
    items.forEach((i) => seen.add(i.id));
    log(`${src.name}: first check, remembered ${items.length} existing item(s). Nothing posted.`);
    fresh = [];
  } else {
    fresh = items.filter((i) => !seen.has(i.id)).reverse(); // oldest first
  }

  if (fresh.length > MAX_PER_ROUND) {
    log(`${src.name}: ${fresh.length} new items, posting only the newest ${MAX_PER_ROUND}`);
    fresh.slice(0, fresh.length - MAX_PER_ROUND).forEach((i) => seen.add(i.id));
    fresh = fresh.slice(-MAX_PER_ROUND);
  }

  let posted = 0;
  try {
    for (const item of fresh) {
      await deliver(item, src, (t) => makeEmbed(item, src.name, t), state);
      seen.add(item.id); // only remembered after it was really delivered
      posted++;
    }
  } finally {
    state[src.name] = [...seen].slice(-KEEP_SEEN);
    saveState(state);
  }
  if (posted) log(`${src.name}: posted ${posted} item(s)`);
}

// Contests: one post when a contest first appears, and a "starting soon" reminder
async function runContestSource(src, state, { latest = 0 } = {}) {
  const all = await readSource(src);
  const nowSec = Date.now() / 1000;
  const upcoming = all.filter((c) => c.start > nowSec);
  const seen = new Set(state[src.name] || []);
  const firstRun = !state[src.name];
  state.__reminded = state.__reminded || {};
  const reminded = state.__reminded;
  const windows = (src.remindMinutes || [60]).slice().sort((a, b) => a - b);

  for (const k of Object.keys(reminded)) if (reminded[k] < nowSec - 2 * 86400) delete reminded[k];

  let announce;
  if (latest > 0) {
    announce = upcoming.slice(0, latest);
    // remember the rest, so the first real run does not flood the channel
    if (firstRun) upcoming.forEach((c) => seen.add(c.id));
  } else if (firstRun) {
    upcoming.forEach((c) => seen.add(c.id));
    log(`${src.name}: first check, remembered ${upcoming.length} upcoming contest(s). Nothing announced.`);
    announce = [];
  } else {
    announce = upcoming.filter((c) => !seen.has(c.id));
  }
  if (announce.length > MAX_PER_ROUND) {
    log(`${src.name}: ${announce.length} new contests, announcing only the ${MAX_PER_ROUND} soonest`);
    announce.slice(MAX_PER_ROUND).forEach((c) => seen.add(c.id));
    announce = announce.slice(0, MAX_PER_ROUND);
  }

  const announcedNow = new Set();
  let announced = 0;
  let reminders = 0;
  try {
    for (const c of announce) {
      await deliver(c, src, (t) => makeContestEmbed(c, 'new', t.to));
      seen.add(c.id);
      announcedNow.add(c.id);
      announced++;
    }
    if (latest === 0) {
      for (const c of upcoming) {
        const minutesLeft = (c.start - nowSec) / 60;
        const dueWindows = windows.filter((w) => minutesLeft <= w);
        if (!dueWindows.length) continue;
        const keys = dueWindows.map((w) => `${src.name}|${c.id}|${w}`);
        if (keys.every((k) => reminded[k])) continue;
        if (!announcedNow.has(c.id)) {
          await deliver(c, src, (t) => makeContestEmbed(c, 'soon', t.to));
          reminders++;
        }
        keys.forEach((k) => (reminded[k] = c.start));
      }
    }
  } finally {
    state[src.name] = [...seen].slice(-KEEP_SEEN);
    saveState(state);
  }
  if (announced || reminders) log(`${src.name}: ${announced} new contest(s), ${reminders} reminder(s)`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function missingEnv(src) {
  return (src.requires || []).filter((k) => !(process.env[k] || '').trim());
}

async function runOnce({ latest = 0, only = '', dueOnly = false } = {}) {
  const state = loadState();
  for (const src of SOURCES.filter((s) => s.enabled !== false)) {
    if (only && !src.name.toLowerCase().includes(only.toLowerCase())) continue;
    const every = (src.every || DEFAULT_EVERY_MINUTES) * 60000;
    if (dueOnly && Date.now() - (lastRun[src.name] || 0) < every - 30000) continue;

    const missing = missingEnv(src);
    if (missing.length) {
      if (!warned.has(src.name)) log(`${src.name}: skipped, ${missing.join(' and ')} not set in .env`);
      warned.add(src.name);
      continue;
    }
    const usable = (src.targets || []).filter((t) => validWebhook(webhookFor(t.to)));
    if (!usable.length) {
      if (!warned.has(src.name)) {
        const names = (src.targets || []).map((t) => `WEBHOOK_${t.to}`).join(' or ');
        log(`${src.name}: skipped, ${names} is not set in .env`);
      }
      warned.add(src.name);
      continue;
    }

    lastRun[src.name] = Date.now();
    try {
      if (CONTEST_TYPES.has(src.type)) await runContestSource(src, state, { latest });
      else await runFeedSource(src, state, { latest });
    } catch (err) {
      log(`${src.name}: PROBLEM, ${err.message}`);
    }
  }
}

async function check() {
  console.log('\nChecking your sources. Nothing is posted to Discord.\n');
  const keys = new Set();
  for (const src of SOURCES) {
    if (src.enabled === false) {
      console.log(`[OFF]  ${src.name}  (disabled in sources.js)`);
      continue;
    }
    (src.targets || []).forEach((t) => keys.add(t.to));
    const missing = missingEnv(src);
    if (missing.length) {
      console.log(`[SKIP] ${src.name}: needs ${missing.join(' and ')} in your .env file`);
      continue;
    }
    try {
      const items = await readSource(src);
      if (CONTEST_TYPES.has(src.type)) {
        if (items.length === 0) {
          console.log(`[OK]   ${src.name}: connected, but there are no upcoming contests right now. That can be normal.`);
        } else {
          console.log(`[OK]   ${src.name}: found ${items.length} upcoming contests. Soonest:`);
          items.slice(0, 6).forEach((c) => {
            console.log(`         - [${c.platform}] ${c.title}`);
            console.log(`           starts ${new Date(c.start * 1000).toLocaleString()}  (${fmtDuration(c.duration)})`);
          });
        }
        if (items.hosts) console.log(`       Platforms seen in the data: ${items.hosts.join(', ') || 'none'}`);
        continue;
      }
      const what = src.type === 'page' ? 'article links' : 'items';
      if (items.length === 0 && src.stripPublisher) {
        console.log(`[OK]   ${src.name}: connected, but no news matched this search right now.`);
        console.log('       That can be normal for a narrow topic. Posts will appear when news does.');
      } else if (items.length === 0) {
        console.log(`[WARN] ${src.name}: reached the address but found 0 ${what}.`);
        console.log('       The site may load its news with JavaScript, or the address/linkPrefix is wrong,');
        console.log('       or your filters (minPrize) removed everything.');
      } else {
        console.log(`[OK]   ${src.name}: found ${items.length} ${what}. Newest:`);
        // page sources show more links, so you can spot menu or category links that should not be there
        const show = src.type === 'page' ? 10 : 3;
        items.slice(0, show).forEach((i) => {
          console.log(`         - ${i.title}${i.publisher ? `  [${i.publisher}]` : ''}\n           ${i.url}`);
          if (src.type === 'devpost' && i.summary) console.log(`           ${i.summary.split('\n').join(' | ')}`);
        });
      }
    } catch (err) {
      console.log(`[FAIL] ${src.name}: ${err.message}`);
      console.log(`       ${hint(err.message)}`);
    }
  }
  console.log('\nWebhooks in your .env:');
  for (const key of WEBHOOK_KEYS) {
    const hook = webhookFor(key);
    const status = !hook ? 'MISSING' : validWebhook(hook) ? 'looks fine' : 'NOT a webhook address';
    const used = keys.has(key) ? '' : '  (not used by any source)';
    console.log(`  WEBHOOK_${key}: ${status}${used}`);
  }
  console.log('');
}

// Shows what the screening would post and drop for the newest items, without posting or saving anything
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

async function testWebhooks() {
  for (const key of WEBHOOK_KEYS) {
    const hook = webhookFor(key);
    if (!validWebhook(hook)) {
      console.log(`WEBHOOK_${key}: missing or invalid, skipped`);
      continue;
    }
    try {
      await postEmbed(hook, {
        title: 'Webhook test',
        description: 'This channel is connected. You can delete this message.',
        color: COLORS[key],
      });
      console.log(`WEBHOOK_${key}: test message sent`);
    } catch (err) {
      console.log(`WEBHOOK_${key}: FAILED, ${err.message}`);
    }
    await sleep(800);
  }
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) return check();
  if (args.includes('--test-webhooks')) return testWebhooks();
  if (args.includes('--preview')) return preview();

  const only = argValue(args, '--only') || '';
  if (args.includes('--latest')) return runOnce({ latest: parseInt(argValue(args, '--latest'), 10) || 1, only });
  if (args.includes('--once')) return runOnce({ only });

  const active = SOURCES.filter((s) => s.enabled !== false).length;
  log(`Watching ${active} source(s). Each one is checked on its own schedule.`);
  log('Leave this window open. Press Ctrl+C to stop.');
  for (;;) {
    try {
      await runOnce({ dueOnly: true, only });
    } catch (err) {
      log(`Problem during this round: ${err.message}. Trying again in ${TICK_MINUTES} minutes.`);
    }
    await sleep(TICK_MINUTES * 60 * 1000);
  }
}

module.exports = { postEmbed, validWebhook, webhookFor, COLORS, clean, FUNDED };

if (require.main === module) {
  main().catch((err) => {
    console.error('Stopped:', err.message);
    process.exit(1);
  });
}
