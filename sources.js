'use strict';

/*
 * YOUR LIST OF SOURCES. Edit freely.
 *   name, type (rss, page, codeforces, clist, devpost), url, enabled, every (minutes),
 *   requires (settings needed), targets: [{ to, match, exclude, flagFunded }]
 *   to = SCHOLARSHIP, PHD_MS, IELTS, GRE, WEBINAR, CONTESTS or COMPETITIONS
 *   page needs linkPrefix. rss can use stripPublisher. contests can use remindMinutes.
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
  {
    // Confirmed working on your PC. Competitions found here also go to #competition-announcements.
    name: 'Opportunity Desk',
    type: 'rss',
    url: 'https://opportunitydesk.org/feed/',
    every: 15,
    enabled: true,
    targets: [
      { to: 'SCHOLARSHIP', match: /scholarship|fellowship|funded|grant/i, exclude: COMPETITION_WORDS },
      { to: 'PHD_MS', match: PHD_OR_MS },
      { to: 'COMPETITIONS', match: COMPETITION_WORDS, flagFunded: true },
    ],
  },
  {
    // NEW and not confirmed yet. Run --check to see if it works.
    name: 'News: funded MS and PhD',
    type: 'rss',
    url: googleNews(
      '("fully funded" OR "full scholarship") (masters OR "master\'s" OR PhD OR "graduate program") scholarship',
      2,
    ),
    stripPublisher: true,
    every: 30,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP' }, { to: 'PHD_MS', match: PHD_OR_MS }],
  },
  // ------------------------------------------------------------------
  // OFFICIAL SCHOLARSHIP SITES. NEW and not confirmed yet: run the cloud check to see which work.
  // Government and university sites sometimes refuse automated visits, so some may show FAILED.
  // ------------------------------------------------------------------
  {
    // Hungarian government scholarship. News page lists every announcement as /news/new/<id>-<title>.
    name: 'Stipendium Hungaricum',
    type: 'page',
    url: 'https://apply.stipendiumhungaricum.hu/news',
    linkPrefix: 'https://apply.stipendiumhungaricum.hu/news/new/',
    every: 60,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP' }, { to: 'PHD_MS' }],
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
    targets: [
      { to: 'SCHOLARSHIP', match: APPLY_WORDS },
      { to: 'PHD_MS', match: APPLY_WORDS },
    ],
  },
  {
    // UK Commonwealth master's and PhD scholarships. Same idea: only application news.
    name: 'Commonwealth Scholarship Commission',
    type: 'rss',
    url: 'https://cscuk.fcdo.gov.uk/feed/',
    every: 60,
    enabled: true,
    targets: [
      { to: 'SCHOLARSHIP', match: APPLY_WORDS },
      { to: 'PHD_MS', match: APPLY_WORDS },
    ],
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
    targets: [{ to: 'SCHOLARSHIP', match: BD_SCHOLARSHIP, exclude: BD_SKIP }],
  },

  // ------------------------------------------------------------------
  // NEWS ABOUT THE BIG NAMED PROGRAMS (Erasmus Mundus, DAAD, Fulbright, MEXT and more).
  // These sites have no feed of their own, so we watch the news for them instead.
  // ------------------------------------------------------------------
  {
    name: 'News: Europe programs',
    type: 'rss',
    url: googleNews(
      '("Erasmus Mundus" OR DAAD OR "Swedish Institute" OR "Stipendium Hungaricum" OR "Eiffel scholarship") ' +
        '(applications OR "now open" OR deadline OR "call for applications")',
      3,
    ),
    stripPublisher: true,
    every: 30,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP' }, { to: 'PHD_MS', match: PHD_OR_MS }],
  },
  {
    name: 'News: UK and US programs',
    type: 'rss',
    url: googleNews(
      '(Chevening OR "Commonwealth Scholarship" OR Fulbright OR "Gates Cambridge" OR "Rhodes Scholarship" OR "Knight-Hennessy") ' +
        '(applications OR "now open" OR deadline)',
      3,
    ),
    stripPublisher: true,
    every: 30,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP' }, { to: 'PHD_MS', match: PHD_OR_MS }],
  },
  {
    name: 'News: Asian government programs',
    type: 'rss',
    url: googleNews(
      '(MEXT OR "Korean Government Scholarship" OR KGSP OR "Chinese Government Scholarship" OR "Turkiye Burslari" OR "Turkiye Scholarships") ' +
        '(applications OR "now open" OR deadline OR "fully funded")',
      3,
    ),
    stripPublisher: true,
    every: 30,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP' }, { to: 'PHD_MS', match: PHD_OR_MS }],
  },

  {
    // Failed on your PC ("fetch failed"), so it is switched off. Turn it on to retry.
    name: 'Scholarship Positions',
    type: 'rss',
    url: 'https://scholarship-positions.com/feed/',
    enabled: false,
    targets: [{ to: 'SCHOLARSHIP' }, { to: 'PHD_MS', match: PHD_OR_MS }],
  },
  {
    // Refused your PC (HTTP 403). Trying again from GitHub's servers, which are a different address.
    // If your cloud check still says FAILED, change enabled back to false.
    name: 'Scholars4Dev',
    type: 'rss',
    url: 'https://www.scholars4dev.com/feed/',
    every: 30,
    enabled: true,
    targets: [{ to: 'SCHOLARSHIP' }, { to: 'PHD_MS', match: PHD_OR_MS }],
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
    // Not set up yet: we still need the right ETS news page for GRE updates.
    // Send me the address and I will fill this in.
    name: 'GRE news',
    type: 'page',
    url: '',
    linkPrefix: '',
    enabled: false,
    targets: [{ to: 'GRE' }],
  },
];
