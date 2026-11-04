'use strict';

/*
 * screen.js: decides whether a scholarship post is worth posting, and where.
 *
 * It only runs for sources marked  screen: true  in sources.js.
 * For each new item it checks, in this order:
 *   1. Is it really a scholarship, fellowship or funded position (and not news, a roundup or an old year)?
 *   2. Is it for Master's or PhD level (not undergraduate only)?
 *   3. Can a computer science student apply: CS or a related field, or open to all fields?
 *      Scholarships that clearly name only another field (nursing, law, MBA...) are dropped.
 *   4. Is it fully funded with a stipend? Those get a [FULLY FUNDED] mark.
 *   5. Was the same scholarship already posted (even from another site)?
 * When the title is not enough, it opens the post's own page and reads the details.
 * If it still cannot tell the field or the level, the post goes out marked [CHECK].
 *
 * Test it on its own:   node screen.js
 */

const YEAR = new Date().getFullYear();
const UA = 'Mozilla/5.0 (compatible; CommunityFeedBot/1.0)';
let pageBudget = Number(process.env.SCREEN_MAX_PAGE_READS || 20); // page reads allowed per run
const KEEP_POSTED = 600;
const POSTED_DAYS = 60;

const join = (list, flags = 'i') => new RegExp(list.join('|'), flags);

// 1. Looks like a scholarship call -----------------------------------------------------------
const FUNDING_TERMS = join([
  'scholarship', 'scholars? program', 'fellowship', 'stipend', 'studentship', 'bursar(y|ies)', 'assistantship',
  '\\bfunded\\b', 'full[- ]ride',
  '\\bph\\.?d\\.?\\s+(positions?|studentships?|vacanc\\w+|openings?|opportunit\\w+)',
  'doctoral\\s+(positions?|candidates?|researchers?|fellowships?|programmes?|programs?)',
  '(positions?|openings?)\\s+for\\s+ph\\.?d',
]);

// Titles that are news, roundups or events, not a call you can apply to.
const NEWS_TERMS = join([
  'winners?', '\\bwins?\\b', '\\bwon\\b', 'congratulat', 'appoint(s|ed)?\\b', '\\bjoins?\\b', 'steps? down',
  'obituar', 'passes away', 'celebrat', 'ceremony', '\\bvisits?\\b', '\\blecture\\b', 'conference',
  '\\brankings?\\b', 'enterprise agreement', 'donat', 'pledge', '\\brecipients?\\b', 'inducted', 'graduation',
  'named (new|as)', 'webinar', 'podcast', 'interview', 'opinion', 'editorial', '\\bbudget\\b', '\\bstrike\\b',
  'protest', 'lawsuit', 'study finds', 'report finds', '\\bsurvey\\b',
  'trending', 'list of', 'round-?up', '\\b(top|best)\\s+\\d+', '\\b\\d+\\s+(best|top)\\b',
  '\\bhow to\\b', 'step[- ]by[- ]step', '\\bguide\\b', '\\btips\\b', 'checklist',
]);

// Internships are not scholarships. A title that mentions one is dropped unless it also names a scholarship, fellowship or degree.
const INTERNSHIP = /\binterns(hips?)?\b/i;
const INTERNSHIP_OK = /scholarship|fellowship|ph\.?d|\bmasters?\b|master'?s/i;

// Words that show a title is a call you can act on. Used when the page cannot be opened (Google News links),
// to tell an open scholarship from a news story that only mentions one.
const CALL_SIGNS = join([
  'fully[- ]funded', '\\bfunded\\b', '\\bapply\\b', 'applications?', '\\bopen(s|ed)?\\b', 'deadline', 'call for',
  'accepting', 'invites?', 'offers?', 'offering', 'announces?', 'launch(es|ed)?', 'available', 'opportunit\\w+',
  'seeking', 'recruit\\w*', 'for\\b.{0,40}\\b(students?|applicants?|candidates?|researchers?|scholars?)\\b',
]);

// Scholarships limited to one other nationality or region ("for Pakistani students", "for Africans").
// They are still posted, but marked [CHECK] so you can read who may apply. Anything that names Bangladesh is left alone.
const NATIONS = [
  'african', 'afghan', 'albanian', 'algerian', 'angolan', 'arab', 'argentin(?:e|ian)', 'armenian', 'azerbaijani', 'brazilian',
  'cambodian', 'cameroonian', 'caribbean', 'chilean', 'chinese', 'colombian', 'congolese', 'egyptian', 'ethiopian', 'filipino',
  'georgian', 'ghanaian', 'indian', 'indonesian', 'iranian', 'iraqi', 'jordanian', 'kazakh', 'kenyan', 'korean', 'kyrgyz',
  'latin american', 'lebanese', 'malawian', 'malaysian', 'maldivian', 'mexican', 'middle eastern', 'mongolian', 'moroccan',
  'mozambican', 'myanmar', 'nepali', 'nepalese', 'nigerian', 'pacific islander', 'pakistani', 'palestinian', 'peruvian',
  'rwandan', 'saudi', 'senegalese', 'sierra leonean', 'somali', 'south african', 'sri lankan', 'sudanese', 'syrian',
  'tajik', 'tanzanian', 'thai', 'tunisian', 'turkish', 'ugandan', 'ukrainian', 'uzbek', 'vietnamese', 'yemeni', 'zambian', 'zimbabwean',
];
const PEOPLE = 'students?|applicants?|citizens|nationals|candidates|scholars|graduates|researchers|professionals|learners|youth';
const NATION_LIMITED = new RegExp(
  `\\bfor\\s+(?:the\\s+)?(?:[\\w-]+\\s+){0,2}?(${NATIONS.join('|')})s?\\b|\\b(${NATIONS.join('|')})\\s+(?:${PEOPLE})\\b`,
  'i',
);

// 2. Level -------------------------------------------------------------------------------------
const UNDER_TITLE = /undergraduate|\bundergrad\b|\bbachelor(s|'s)?\b|\bb\.?sc\.?\b|\bb\.?eng\b|high[- ]school|secondary school|school (students|leavers)|\bdiploma\b/i;
const UNDER_PAGE = /undergraduate|\bundergrad\b|high[- ]school|secondary school|school (students|leavers)|bachelor'?s? (programmes?|programs?|studies|scholarships?|students|courses?)|\bb\.?sc\.? (programmes?|programs?|students)|first[- ]degree/i;
const GRAD_TITLE = /\bmasters?\b|master'?s|\bm\.?sc\.?\b|\bm\.?eng\b|\bm\.?s\.?\b|\bmres\b|\bm\.?phil\b|\bph\.?d|\bdphil\b|doctora(l|te)|post-?graduate|\bgraduate\b|research degree|studentship/i;
const GRAD_PAGE = /\bmasters?\b|master'?s|\bm\.?sc\.?\b|\bm\.?eng\b|\bmres\b|\bm\.?phil\b|\bph\.?d|\bdphil\b|doctora(l|te)|post-?graduate|\bgraduate (school|studies|programmes?|programs?|scholars?|students?|fellows?|degree)|research degree|studentship/i;

// 3. Field -------------------------------------------------------------------------------------
const CS_CORE_LIST = [
  'computer (science|sciences|engineering|architecture|systems|vision|programming|networks?)', '\\bcomputing\\b', '\\bcs\\b',
  'software', '\\bai\\b', 'artificial intelligence', 'machine learning', 'deep learning', '\\bml\\b',
  'data science', 'data analytics', 'big data', 'data mining', 'text mining', 'cyber ?security',
  'information technology', 'information systems', 'informatics', 'robotics', 'autonomous systems',
  'electrical engineering', 'electronics? engineering', '\\bece\\b', 'telecommunication', '\\bict\\b',
  'quantum', 'blockchain', 'fintech', 'computational', 'natural language processing',
];
// Words that often appear on a page for other reasons: they count on a title, but on a page only if nothing else was found
const CS_WEAK_LIST = ['\\bstem\\b(?! cell)', 'mathematic', 'statistic', 'science and technology', 'engineering and technology'];
const CS_FIELDS = join([...CS_CORE_LIST, ...CS_WEAK_LIST]);
const CS_CORE = join(CS_CORE_LIST);
const CS_WEAK = join(CS_WEAK_LIST);
const ALL_FIELDS = join([
  '(all|any|every) (fields?|subjects?|disciplines?|areas?|majors?|programmes?|programs?|courses?)( of study)?',
  'open to (all|any)', 'regardless of (your |the )?(field|subject|discipline|major)',
  'irrespective of (your |the )?(field|subject|discipline|major)', 'in any (field|subject|discipline|programme|program)',
  'across (all|any) (fields|disciplines|subjects)', 'no (restriction|limit)s? on (the )?(field|subject|discipline)',
  'all (postgraduate|master\'?s?) (programmes|programs|courses)',
]);
const OTHER_STRONG_LIST = [
  'nursing', 'midwifery', 'medicine', '\\bmbbs\\b', 'dental', 'dentistry', 'pharmac\\w*', 'veterinar\\w*',
  'public health', '\\blaw\\b', '\\bllm\\b', '\\bmba\\b', 'business administration', 'journalism', 'theolog\\w*',
  'theatre', 'theater', 'fine arts', 'performing arts', 'sociology', 'psycholog\\w*', 'anthropolog\\w*',
  'political science', 'international relations', 'diplomacy', 'public policy', 'public administration',
  'agricultur\\w*', 'forestry', 'fisheries', 'civil engineering', 'chemical engineering', 'mechanical engineering',
  'petroleum', 'geology', 'peace studies', 'gender studies', 'social work', 'teacher training', 'pedagog\\w*',
  'tourism', 'hospitality', 'architecture', 'urban planning', 'nutrition', 'epidemiology', 'physiotherapy',
];
const OTHER_WEAK_LIST = [
  'history', 'literature', 'music', '\\bfilm\\b', 'marketing', 'accounting', '\\bsports?\\b', 'medical',
  'health ?care', 'health sciences', 'humanities', 'philosophy', 'religio\\w*',
];
const OTHER_STRONG = join(OTHER_STRONG_LIST, 'gi');
const OTHER_ANY = join([...OTHER_STRONG_LIST, ...OTHER_WEAK_LIST]);

// 4. Funding -----------------------------------------------------------------------------------
const FULL_WORDS = /fully[- ]funded|full (scholarship|funding|tuition|ride|stipend)|full[- ]ride|all[- ]expenses|100\s?% (tuition|scholarship|funded)/i;
const TUITION_WORDS = /tuition[- ](free|waiver|waived|covered)|tuition fees? (are |is )?(waived|covered|paid)|covers? (the )?(full )?tuition|waiver of tuition/i;
const STIPEND_WORDS = /stipend|monthly (allowance|salary|living)|living (allowance|expenses|costs|stipend|support)|salary|per month|\/ ?month|a month|maintenance (grant|allowance)/i;
const PHD_POSITION = /\b(ph\.?d\.?|doctoral)\s+(position|studentship|candidate)/i;

const hit = (re, text) => {
  const m = re.exec(text);
  return m ? m[0].trim() : '';
};

function levelOf(text, onPage) {
  const g = hit(onPage ? GRAD_PAGE : GRAD_TITLE, text);
  if (g) return { level: 'grad', hit: g };
  const u = hit(onPage ? UNDER_PAGE : UNDER_TITLE, text);
  if (u) return { level: 'under', hit: u };
  return { level: 'unknown', hit: '' };
}

function fieldOf(text, onPage) {
  const cs = hit(onPage ? CS_CORE : CS_FIELDS, text);
  if (cs) return { field: 'cs', hit: cs };
  const all = hit(ALL_FIELDS, text);
  if (all) return { field: 'all', hit: all };
  if (!onPage) {
    // a title or snippet that names another field and no CS field
    const o = hit(OTHER_ANY, text);
    if (o) return { field: 'other', hit: o };
  } else {
    // on a whole page one passing mention means little, so it needs two different fields named
    const found = new Set((text.match(OTHER_STRONG) || []).map((s) => s.toLowerCase()));
    if (found.size >= 2) return { field: 'other', hit: [...found].slice(0, 3).join(', ') };
    const weak = hit(CS_WEAK, text);
    if (weak) return { field: 'cs', hit: weak };
  }
  return { field: 'unknown', hit: '' };
}

function fundingOf(text) {
  const full = hit(FULL_WORDS, text);
  const tuition = TUITION_WORDS.test(text);
  const stipend = hit(STIPEND_WORDS, text);
  const phdJob = PHD_POSITION.test(text);
  if (full) return { kind: 'full', hit: full };
  if (tuition && stipend) return { kind: 'full', hit: 'tuition covered + ' + stipend };
  if (phdJob && (stipend || /\bfunded\b/i.test(text))) return { kind: 'full', hit: 'funded PhD position' };
  if (stipend) return { kind: 'stipend', hit: stipend };
  if (tuition) return { kind: 'tuition', hit: 'tuition covered' };
  return { kind: 'unknown', hit: '' };
}

// Reading the post's own page ------------------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', hellip: '...' };
function decodeEntities(t) {
  return t
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] !== undefined ? ENTITIES[n.toLowerCase()] : m));
}

// Plain text of the main article on a page (menus, sidebars and "related posts" are left out)
function textOf(html) {
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
  const blocks = h.match(/<article\b[\s\S]*?<\/article>/gi) || h.match(/<main\b[\s\S]*?<\/main>/gi);
  if (blocks) h = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');
  let t = decodeEntities(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  // Where the real text ends: links to other posts must not count as part of this one
  const end = t.search(/\b(related (posts|articles|scholarships|opportunities)|you may also like|recommended for you|leave a (reply|comment)|latest (posts|scholarships))\b/i);
  if (end > 250) t = t.slice(0, end);
  // "share this" and newsletter boxes are often at the top too, so those only count late in the page
  const late = t.search(/\b(share this|subscribe to our newsletter)\b/i);
  if (late > 800) t = t.slice(0, late);
  return t.slice(0, 20000);
}

function canRead(url) {
  if (!/^https?:\/\//i.test(url || '')) return false;
  try {
    const host = new URL(url).hostname;
    return !/(^|\.)news\.google\.com$/i.test(host); // Google News links cannot be opened directly
  } catch (_) {
    return false;
  }
}

async function readPage(url) {
  if (!canRead(url) || pageBudget <= 0) return null;
  pageBudget--;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !/html|text/i.test(type)) return null;
    const html = (await res.text()).slice(0, 700000);
    const text = textOf(html);
    return text.length >= 200 ? text : null;
  } catch (_) {
    return null;
  }
}

// Remembering what was posted, so the same scholarship is not posted twice -------------------
const STOP = new Set(
  ('fully funded fund scholarship scholarships fellowship fellowships for in at the to and of a an on with by from ' +
    'applications application apply now open opens call international students student masters master phd phds ' +
    'programme program programs study studies university universities new is are your our you how get can will ' +
    'announces announced launches launched offers offering available').split(' '),
);

function tokens(title) {
  const words = (title || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

function similar(a, b) {
  if (!a.length || !b.length) return false;
  const small = a.length <= b.length ? a : b;
  const big = new Set(a.length <= b.length ? b : a);
  const shared = small.filter((w) => big.has(w)).length;
  if (small.length < 2) return a.length === b.length && shared === small.length;
  return shared >= 2 && shared / small.length >= 0.75;
}

function normUrl(u) {
  try {
    const x = new URL(u);
    return (x.hostname.toLowerCase() + x.pathname.replace(/\/+$/, '') ).toLowerCase();
  } catch (_) {
    return '';
  }
}

function duplicateOf(item, state) {
  const list = (state && state.__posted) || [];
  const t = tokens(item.title);
  const u = normUrl(item.url);
  for (const p of list) {
    if (u && p.u && u === p.u) return p.title;
    if (similar(t, p.k)) return p.title;
  }
  return '';
}

function remember(state, item) {
  const list = (state.__posted = state.__posted || []);
  const cutoff = Date.now() - POSTED_DAYS * 86400000;
  list.push({ k: tokens(item.title), u: normUrl(item.url), title: (item.title || '').slice(0, 120), t: Date.now() });
  state.__posted = list.filter((p) => p.t >= cutoff).slice(-KEEP_POSTED);
}

// The decision ---------------------------------------------------------------------------------
const drop = (reason) => ({ post: false, reason });
const LEVEL_NAME = { grad: "Master's or PhD", under: 'undergraduate', unknown: 'not stated' };
const FIELD_NAME = { cs: 'CS or a related field', all: 'open to all fields', other: 'another field', unknown: 'not stated' };
const FUNDING_NAME = { full: 'fully funded', stipend: 'stipend mentioned', tuition: 'tuition covered', unknown: 'not stated' };

async function screenItem(item, src, state, opts = {}) {
  const title = item.title || '';
  const base = `${title} ${item.summary || ''}`;

  // 1. a real scholarship call
  const news = hit(NEWS_TERMS, title);
  if (news) return drop(`looks like news, not a call ("${news}")`);
  if (!FUNDING_TERMS.test(base)) return drop('not about a scholarship, fellowship or funded position');
  if (INTERNSHIP.test(title) && !INTERNSHIP_OK.test(title)) return drop('internship, not a scholarship');
  const years = (title.match(/\b20\d\d\b/g) || []).map(Number);
  if (years.length && Math.max(...years) < YEAR) return drop(`old (${Math.max(...years)})`);

  // 2 and 3 from the title and snippet
  let lv = levelOf(base, false);
  if (lv.level === 'under') return drop(`undergraduate only ("${lv.hit}")`);
  let fd = fieldOf(base, false);
  if (fd.field === 'other') return drop(`other field only ("${fd.hit}")`);
  let fn = fundingOf(base);

  // not clear yet: read the post's own page
  let pageRead = false;
  if (fd.field === 'unknown' || lv.level === 'unknown' || fn.kind === 'unknown') {
    const reader = opts.readPage || readPage;
    const page = opts.noPage ? null : await reader(item.url);
    if (page) {
      pageRead = true;
      const full = `${base} ${page}`;
      if (lv.level === 'unknown') {
        lv = levelOf(full, true);
        if (lv.level === 'under') return drop(`undergraduate only (page says "${lv.hit}")`);
      }
      if (fd.field === 'unknown') {
        fd = fieldOf(full, true);
        if (fd.field === 'other') return drop(`other field only (page names ${fd.hit})`);
      }
      if (fn.kind === 'unknown') fn = fundingOf(full);
    }
  }
  // The page was read in full and never mentions Master's, PhD or postgraduate study: a programme, event or short course, not a degree
  if (pageRead && lv.level === 'unknown') return drop("page was read and does not mention Master's or PhD");
  if (fd.field === 'unknown' && src && src.defaultField) fd = { field: src.defaultField, hit: 'this source is only about CS and AI' };

  // The page could not be read and the title is vague: without any sign of an open call it is most likely a news story
  if (!pageRead && (fd.field === 'unknown' || lv.level === 'unknown') && !CALL_SIGNS.test(title) && !years.some((y) => y >= YEAR)) {
    return drop('no sign of an open call, and the page could not be read');
  }

  // 5. already posted?
  const dup = duplicateOf(item, state);
  if (dup) return drop(`already posted as "${dup}"`);

  // limited to students of another country? (only looked for in the title and snippet, and not if Bangladesh is named)
  const nm = /bangladesh|bangladeshi/i.test(base) ? null : NATION_LIMITED.exec(base);
  const nation = nm ? (nm.slice(1).find(Boolean) || '').toLowerCase() : '';

  const check = fd.field === 'unknown' || lv.level === 'unknown' || !!nation;
  const tags = [];
  if (fn.kind === 'full') tags.push('FULLY FUNDED');
  if (check) tags.push('CHECK');
  const missing = [fd.field === 'unknown' ? 'field' : '', lv.level === 'unknown' ? 'level' : ''].filter(Boolean).join(' and ');
  const notes = [];
  if (missing) notes.push(`could not confirm the ${missing}${pageRead ? '' : ' (page not readable)'}`);
  if (nation) notes.push(`it may be limited to "${nation}" applicants, so check that Bangladesh is allowed`);
  return {
    post: true,
    channel: lv.level === 'grad' ? 'PHD_MS' : 'SCHOLARSHIP',
    level: lv,
    field: fd,
    funding: fn,
    full: fn.kind === 'full',
    check,
    tags,
    pageRead,
    note: notes.join('; '),
    summary: `level: ${LEVEL_NAME[lv.level]}${lv.hit ? ` ("${lv.hit}")` : ''} | field: ${FIELD_NAME[fd.field]}${fd.hit ? ` ("${fd.hit}")` : ''} | funding: ${FUNDING_NAME[fn.kind]}${fn.hit ? ` ("${fn.hit}")` : ''}`,
  };
}

// Adds the marks and a short facts line to the Discord post
function decorate(embed, v) {
  if (!v || !v.post) return embed;
  const prefix = v.tags.map((t) => `[${t}] `).join('');
  embed.title = (prefix + embed.title).slice(0, 256);
  if (v.full) embed.color = 0xf1c40f; // gold
  const facts = [
    `Level: ${LEVEL_NAME[v.level.level]}`,
    `Field: ${FIELD_NAME[v.field.field]}`,
    `Funding: ${FUNDING_NAME[v.funding.kind]}`,
  ].join('  |  ');
  const lines = [facts];
  if (v.check) lines.push(`**Please check:** ${v.note}. Open the page and read who can apply.`);
  embed.description = (lines.join('\n') + (embed.description ? '\n\n' + embed.description : '')).slice(0, 4000);
  return embed;
}

function setBudget(n) {
  pageBudget = n;
}

module.exports = { screenItem, decorate, remember, duplicateOf, tokens, similar, levelOf, fieldOf, fundingOf, textOf, readPage, setBudget };

// ---------------------------------------------------------------------------------------------
// node screen.js   runs a quick self-test on example titles (no internet needed)
// ---------------------------------------------------------------------------------------------
if (require.main === module) {
  const cases = [
    // [title, summary, should it be posted?]
    ['Former Rector of TU Delft to Chalmers University board', '', false],
    ['Building simpler, fairer and more sustainable Enterprise Agreements', '', false],
    ['Google announces 2025 PhD Fellowship winners: How many Indians are on the prestigious list?', '', false],
    ['Congratulations, Jan Van Den Brand!', '', false],
    ['Red Bull visit University College Cork and host careers lecture for Engineering Students.', '', false],
    ['Top 10 fully funded scholarships in Europe for 2027', '', false],
    ['Fully funded undergraduate scholarship for international students 2027', '', false],
    ['Fully funded nursing scholarship in Ireland for master students', '', false],
    ['Master of Business Administration scholarship at TU Delft 2027', '', false],
    ['Fully funded PhD position in machine learning at TU Munich', '', true],
    ['DAAD EPOS 2027: fully funded master scholarships in Germany', '', true],
    ['Maastricht University High Potential Scholarship 2027 for master students', '', true],
    ['Chevening Scholarships 2027/28: applications now open', '', true],
    ['Doctoral network on AI: 12 funded PhD positions across Europe 2027', '', true],
    // real posts seen in the cloud on Nov 4
    ['Makerere Graduate Loses Polish Scholarship Over Expired Course Listing', '', false],
    ['TechCongress Programs Internship 2027', 'Fellowship for tech people', false],
    ['UK announces fully funded Master’s scholarships for students', '', true],
    ['Simon Fraser University Offers Fully Funded Master’s and PhD Research Opportunities in Canada', '', true],
  ];
  let bad = 0;
  (async () => {
    for (const [title, summary, want] of cases) {
      const v = await screenItem({ title, summary, url: '' }, {}, {}, { noPage: true });
      const ok = v.post === want;
      if (!ok) bad++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${v.post ? 'POST ' + v.tags.map((t) => `[${t}]`).join('') + ' -> ' + v.channel : 'DROP ' + v.reason}\n      ${title}`);
    }
    console.log(bad ? `\n${bad} example(s) failed.` : '\nAll examples behave as expected.');
    process.exit(bad ? 1 : 0);
  })();
}
