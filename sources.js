'use strict';

/*
 * YOUR LIST OF SOURCES. Edit freely.
 *   name, type (rss, page, codeforces, clist, devpost), url, enabled, every (minutes),
 *   requires (settings needed), targets: [{ to, match, exclude, flagFunded }]
 *   to = SCHOLARSHIP, PHD_MS, IELTS, GRE, WEBINAR, CONTESTS or COMPETITIONS
 *   page needs linkPrefix. rss can use stripPublisher. contests can use remindMinutes.
 *   screen: true  checks every scholarship item first (real call, Master's/PhD, CS or all fields, no repeats). See screen.js.
 * Test after any change with the cloud check run. New posts appear within "every" minutes.
 */

const PHD_OR_MS = /\b(ph\.?d|doctora\w*|master'?s?|m\.?sc|m\.?s\.?|postgraduate|graduate)\b/i;

// Project competitions: hackathons, datathons, app showcases, Imagine Cup, FinTechathon and similar
const COMPETITION_WORDS = new RegExp(
  [
    'hackathon', 'datathon', 'fintechathon', 'codeathon', 'ideathon', 'buildathon',
    'imagine cup',
    'app (showcase|challenge|competition|contest)',
    'startup (competition|challenge|pitch)',
    'innovation (challenge|competition|contest)',
    'coding (competition|challenge|contest)',
    '(software|ai|data|tech|technology|fintech) (competition|challenge|contest)',
  ].join('|'),
  'i',
);

// Words that mean "something you can act on": applications opening, deadlines, calls.
// Used for official sites whose news is mostly alumni stories, so only the useful posts go through.
const APPLY_WORDS = /applicat|\bapply\b|deadline|now open|\bopens?\b|call for|nominat|intake/i;

// Bangladesh SHED notices are often in Bangla. These match scholarships and fellowships in both languages.
const BD_SCHOLARSHIP = /scholarship|fellowship|MEXT|বৃত্তি|স্কলারশিপ|ফেলোশিপ|উচ্চশিক্ষা|উচ্চ শিক্ষা/i;
// ...but skip the school-level stipends and junior scholarships that also appear there.
const BD_SKIP = /উপবৃত্তি|জুনিয়র|প্রাথমিক|junior|\bstipends?\b|সমাপনী/i;

// Combine several patterns into one.
const anyOf = (...parts) => new RegExp(parts.map((r) => r.source).join('|'), 'i');

// You want scholarships outside Asia and the Middle East. Posts that mention these places
// or programs are left out of the scholarship channels. (Country names like China or India
// are only matched as "in China" and so on, because posts about Germany often say
// "open to students from China, India...".)
const ASIA_ME = new RegExp(
  [
    '\\b(mext|kgsp|gks|burslari|hkpfs|kaust|kfupm|masdar|nazarbayev|tsinghua|fudan|zhejiang|kaist|postech|yonsei|nanyang)\\b',
    '\\b(japan(ese)?|korea(n)?|taiwan(ese)?|hong kong|singapore|malaysia(n)?|thai(land)?|vietnam(ese)?|indonesia(n)?|philippine(s)?|brunei|saudi|qatar(i)?|kuwait(i)?|bahrain|oman|uae|emirates|dubai|abu dhabi|israel(i)?|iran(ian)?|iraq(i)?|jordan|lebanon|turkey|t[uü]rkiye|turkish|kazakhstan|uzbekistan)\\b',
    '\\b(beijing|shanghai|shenzhen|tokyo|kyoto|osaka|seoul|riyadh|doha|kuala lumpur|bangkok)\\b',
    '\\b(in|at|to) (china|india|pakistan|bangladesh|nepal|sri lanka)\\b',
    '\\bchinese (government|university|universities)\\b',
    '\\bpeking university\\b',
    '\\biccr\\b',
  ].join('|'),
  'i',
);
// The same idea for Bangla notices (Japan, China, Korea, Saudi Arabia, Turkey, Malaysia, Singapore, Thailand, India, Gulf)
const BD_ASIA_ME = /(?<![\u0980-\u09FF])(জাপান|চীন|কোরিয়া|সৌদি|তুরস্ক|মালয়েশিয়া|সিঙ্গাপুর|থাইল্যান্ড|ভারত|কাতার|কুয়েত|ইরান|ইরাক|দুবাই|আরব আমিরাত)/;

// Google News search as a feed. Looks at the last "days" days.
const googleNews = (query, days) =>
  'https://news.google.com/rss/search?q=' +
  encodeURIComponent(`${query} when:${days}d`) +
  '&hl=en-US&gl=US&ceid=US:en';

module.exports = [
  // ------------------------------------------------------------------
  // CODING CONTESTS  ->  #contest-announcements
  // ------------------------------------------------------------------
  {
    // Official Codeforces API. No account needed.
    name: 'Codeforces',
    type: 'codeforces',
    url: 'https://codeforces.com/api/contest.list?gym=false',
    every: 10,
    remindMinutes: [60],
    enabled: true,
    targets: [{ to: 'CONTESTS' }],
  },
  {
    // LeetCode, AtCoder, CodeChef and more, through clist.by.
    // Needs a free clist.by account. Put CLIST_USERNAME and CLIST_API_KEY in your .env file.
    // Run --check: it prints "Platforms seen in the data", and you can add more names to platforms.
    name: 'Other platforms (clist.by)',
    type: 'clist',
    url: 'https://clist.by/api/v4/contest/',
    requires: ['CLIST_USERNAME', 'CLIST_API_KEY'],
    platforms: ['leetcode.com', 'atcoder.jp', 'codechef.com', 'topcoder.com', 'hackerrank.com', 'hackerearth.com'],
    // codeforces.com is covered by the source above. lang=ja skips clist's separate Japanese AtCoder listing.
    excludePlatforms: ['codeforces.com', 'lang=ja'],
    every: 10,
    remindMinutes: [60],
    enabled: true,
    targets: [{ to: 'CONTESTS' }],
  },

  // ------------------------------------------------------------------
  // PROJECT COMPETITIONS  ->  #competition-announcements
  // Posts that mention full funding or free travel/accommodation get [FUNDED].
  // ------------------------------------------------------------------
  {
    // Hackathons listed on Devpost, newest first. Only online or worldwide ones are posted.
    // To post only bigger prizes, add:  minPrize: 1000
    name: 'Devpost hackathons',
    type: 'devpost',
    url: 'https://devpost.com/api/hackathons?order_by=recently-added&status[]=upcoming&status[]=open',
    every: 15,
    enabled: true,
    targets: [{ to: 'COMPETITIONS', match: /online|worldwide|global|remote/i, flagFunded: true }],
  },
  {
    name: 'News: funded hackathons',
    type: 'rss',
    url: googleNews(
      '(hackathon OR datathon OR "innovation challenge" OR "student competition") ' +
        '("fully funded" OR "all expenses paid" OR "travel and accommodation" OR "travel grant" OR "flights and accommodation")',
      3,
    ),
    stripPublisher: true,
    every: 10,
    enabled: true,
    targets: [{ to: 'COMPETITIONS', flagFunded: true }],
  },
  {
    name: 'News: Imagine Cup',
    type: 'rss',
    url: googleNews('"Imagine Cup"', 7),
    stripPublisher: true,
    every: 10,
    enabled: true,
    targets: [{ to: 'COMPETITIONS', flagFunded: true }],
  },
  {
    name: 'News: FinTechathon and WeBank',
    type: 'rss',
    url: googleNews('(FinTechathon OR WeBank) (hackathon OR competition OR challenge)', 7),
    stripPublisher: true,
    every: 10,
    enabled: true,
    targets: [{ to: 'COMPETITIONS', flagFunded: true }],
  },

  // ------------------------------------------------------------------
  // SCHOLARSHIPS AND MS/PHD  ->  #scholarship-alerts, #phd-ms-openings
  // ------------------------------------------------------------------
  // OFFICIAL SCHOLARSHIP SITES (not screened, always posted). NEW and not confirmed yet: run the cloud check to see which work.
  // Government and university sites sometimes refuse automated visits, so some may show FAILED.
  // They are listed FIRST on purpose: if a news site reports the same call later, it is dropped as already posted.
  // Each official item is posted once (not in two channels).
  // ------------------------------------------------------------------
  {
    // Hungarian government scholarship. News page lists every announcement as /news/new/<id>-<title>.
    name: 'Stipendium Hungaricum',
    type: 'page',
    url: 'https://apply.stipendiumhungaricum.hu/news',
    linkPrefix: 'https://apply.stipendiumhungaricum.hu/news/new/',
    every: 60,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP' }],
  },
  {
    // UK government one-year master's scholarship. Most of its news is alumni stories,
    // so only posts about applications, deadlines and calls are posted.
    name: 'Chevening news',
    type: 'page',
    url: 'https://www.chevening.org/news/',
    linkPrefix: 'https://www.chevening.org/news/',
    exclude: /\/news\/(page|category|tag)(\/|$)/i,
    every: 60,
    enabled: true,
    targets: [{ to: 'PHD_MS', match: APPLY_WORDS }],
  },
  {
    // UK Commonwealth master's and PhD scholarships. Same idea: only application news.
    name: 'Commonwealth Scholarship Commission',
    type: 'rss',
    url: 'https://cscuk.fcdo.gov.uk/feed/',
    every: 60,
    enabled: true,
    targets: [{ to: 'PHD_MS', match: APPLY_WORDS }],
  },
  {
    // Bangladesh Secondary and Higher Education Division notice board (government nominations
    // for MEXT, Hungary, China, Korea and others). Only scholarship notices are posted.
    // If your check shows FAILED here, the site is probably blocking foreign servers.
    name: 'Bangladesh SHED notices',
    type: 'page',
    url: 'https://shed.gov.bd/site/view/notices',
    linkPrefix: 'https://shed.gov.bd/site/notice',
    every: 60,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP', match: BD_SCHOLARSHIP, exclude: anyOf(BD_SKIP, ASIA_ME, BD_ASIA_ME) }],
  },

  // ------------------------------------------------------------------
  // NEWS SITES AND AGGREGATORS: every item is checked by screen.js before it is posted.
  // ------------------------------------------------------------------
  {
    // Confirmed working on your PC. Competitions found here also go to #competition-announcements.
    name: 'Opportunity Desk',
    screen: true,
    type: 'rss',
    url: 'https://opportunitydesk.org/feed/',
    every: 15,
    enabled: true,
    targets: [
      { to: 'SCHOLARSHIP', match: /scholarship|fellowship|funded|grant/i, exclude: anyOf(COMPETITION_WORDS, ASIA_ME) },
      { to: 'PHD_MS', match: PHD_OR_MS, exclude: anyOf(COMPETITION_WORDS, ASIA_ME) },
      { to: 'COMPETITIONS', match: COMPETITION_WORDS, flagFunded: true },
    ],
  },
  {
    // NEW and not confirmed yet. Run --check to see if it works.
    name: 'News: funded MS and PhD',
    screen: true,
    type: 'rss',
    url: googleNews(
      '("fully funded" OR "full scholarship") (masters OR "master\'s" OR PhD OR "graduate program") scholarship',
      2,
    ),
    stripPublisher: true,
    every: 30,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP', exclude: ASIA_ME }, { to: 'PHD_MS', exclude: ASIA_ME }],
  },
  // ------------------------------------------------------------------
  // SCHOLARSHIP NEWS BY REGION: Europe, North America, Australia and New Zealand.
  // These sites have no feed of their own, so we watch the news about them instead.
  // Each one is checked every 30 minutes. Switch any off with enabled: false.
  // ------------------------------------------------------------------
  ...[
    ['Germany',
      '(DAAD OR "study in Germany" OR "Konrad Adenauer" OR "Friedrich Ebert" OR "Hanns Seidel" OR "Heinrich Böll" OR "Max Planck")'],
    ['Netherlands',
      '("TU Delft" OR "University of Amsterdam" OR "Maastricht University" OR "Eindhoven University of Technology" OR "University of Twente" OR "Leiden University" OR "Utrecht University" OR "University of Groningen" OR "NL Scholarship" OR Nuffic)'],
    ['Ireland',
      '("Government of Ireland" OR "Ireland Fellows" OR "Trinity College Dublin" OR "University College Dublin" OR "University of Galway" OR "University College Cork" OR "Dublin City University" OR "University of Limerick")'],
    ['UK',
      '(Chevening OR "Commonwealth Scholarship" OR "Rhodes Scholarship" OR "Gates Cambridge" OR "Clarendon Scholarship" OR "Reach Oxford" OR "Edinburgh Global" OR "Imperial College London" OR "University of Manchester" OR "University of Glasgow")'],
    ['US and Canada',
      '(Fulbright OR "Knight-Hennessy" OR Vanier OR "Lester B. Pearson" OR "Canada Graduate Scholarship" OR "University of Toronto" OR "University of British Columbia" OR "University of Waterloo" OR "McGill University")'],
    ['Australia and New Zealand',
      '("Australia Awards" OR "Manaaki New Zealand" OR "University of Melbourne" OR "University of Sydney" OR UNSW OR "Monash University" OR "Australian National University" OR "University of Auckland")'],
    ['other Europe',
      '("Erasmus Mundus" OR "Swedish Institute" OR "Eiffel Excellence" OR "Campus France" OR "Swiss Government Excellence" OR "ETH Zurich" OR EPFL OR KTH OR "Aalto University" OR "University of Helsinki" OR OeAD OR "VLIR-UOS" OR NAWA OR "Invest Your Talent" OR "Czech Government" OR "Estonian Government")'],
  ].map(([place, who]) => ({
    name: `News: ${place}`,
    screen: true,
    type: 'rss',
    url: googleNews(who + ' (scholarship OR fellowship OR stipend OR "fully funded")', 3),
    stripPublisher: true,
    every: 30,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP', exclude: ASIA_ME }, { to: 'PHD_MS', exclude: ASIA_ME }],
  })),
  {
    // Computer science and AI: funded PhD positions, doctoral networks and fellowships, in any country
    // outside Asia and the Middle East.
    name: 'News: funded CS and AI PhD or MS',
    screen: true,
    defaultField: 'cs', // this search is already about CS and AI, so the field counts as CS
    type: 'rss',
    url: googleNews(
      '("computer science" OR "artificial intelligence" OR "machine learning" OR "data science" OR "software engineering") ' +
        '("fully funded" OR "funded PhD" OR "PhD position" OR "PhD fellowship" OR "doctoral network" OR "Marie Curie" OR "ELLIS PhD")',
      3,
    ),
    stripPublisher: true,
    every: 30,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP', exclude: ASIA_ME }, { to: 'PHD_MS', exclude: ASIA_ME }],
  },

  {
    // Failed on your PC ("fetch failed"), so it is switched off. Turn it on to retry.
    name: 'Scholarship Positions',
    screen: true,
    type: 'rss',
    url: 'https://scholarship-positions.com/feed/',
    enabled: false,
    targets: [{ to: 'SCHOLARSHIP', exclude: ASIA_ME }, { to: 'PHD_MS', exclude: ASIA_ME }],
  },
  {
    // Refused your PC (HTTP 403). Trying again from GitHub's servers, which are a different address.
    // If your cloud check still says FAILED, change enabled back to false.
    name: 'Scholars4Dev',
    screen: true,
    type: 'rss',
    url: 'https://www.scholars4dev.com/feed/',
    every: 30,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP', exclude: ASIA_ME }, { to: 'PHD_MS', exclude: ASIA_ME }],
  },

  // ------------------------------------------------------------------
  // IELTS AND GRE
  // ------------------------------------------------------------------
  {
    // Confirmed working on your PC. Titles come with a label like
    // "Global News 5 min 07/09/2026 ...", which stripFromTitle removes.
    name: 'IELTS news',
    type: 'page',
    url: 'https://ielts.org/news-and-insights',
    linkPrefix: 'https://ielts.org/news-and-insights/',
    stripFromTitle: /^.*?\d+\s*min\s+\d{1,2}\/\d{1,2}\/\d{4}\s+/,
    every: 60,
    enabled: true,
    targets: [{ to: 'IELTS' }],
  },
  {
    // ETS has no news list that a program can read, so GRE news comes from a Google News search
    // (last 14 days): test changes, fees, test dates, score reporting, and universities that
    // drop or require the GRE. Only titles that contain GRE and a change or announcement word are
    // posted, and the usual coaching, tips and how-to articles are left out.
    name: 'News: GRE updates',
    type: 'rss',
    url: googleNews(
      'GRE (ETS OR "GRE General Test" OR "GRE test" OR "GRE requirement" OR "GRE scores" OR "GRE exam") ' +
        '(changes OR change OR announces OR announced OR update OR updated OR fee OR "test dates" OR "score reporting" ' +
        'OR "test format" OR "no longer require" OR "no longer requires" OR waives OR waived OR "test-optional" OR "test optional" OR reinstates)',
      14,
    ),
    stripPublisher: true,
    // Google News returns old explainers (some from 2017) when nothing recent matches, so anything
    // older than this many days is ignored.
    maxAgeDays: 21,
    every: 60,
    enabled: true,
    targets: [
      {
        to: 'GRE',
        // The title must contain GRE and a word that signals a change or an announcement
        // (changes, announces, no longer, waives, drops, fee rise ...). This keeps out the
        // many "How to book a GRE slot" and "How hard is the GRE" explainers.
        match: new RegExp(
          '^(?=.*\\bGRE\\b)(?=.*\\b(?:chang\\w*|announc\\w*|no longer|waiv\\w*|drops?|dropp\\w*|eliminat\\w*|scrap\\w*|abolish\\w*|' +
            'reinstat\\w*|introduc\\w*|launch\\w*|revis\\w*|replac\\w*|discontinu\\w*|cancel\\w*|suspend\\w*|shorter|shorten\\w*|faster|' +
            'rise|rises|rising|increase\\w*|hike\\w*|raise\\w*|adds|added|expand\\w*|optional|now (?:accept\\w*|offer\\w*|available))\\b)',
          'i',
        ),
        exclude:
          /\b(tips?|how to|how hard|how difficult|what to expect|study plan|prep(?:aration)?|courses?|coaching|crack|vocabulary|syllabus|pattern|sample|practice|mock|books?|cheat sheet|strategy|strategies|guide|explained|faqs?|need to know|eligibility|registration|slot|login|worth it|vs\.?|versus|score calculator)\b/i,
      },
    ],
  },
];
