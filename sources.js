'use strict';

/*
 * YOUR LIST OF SOURCES. Edit this file freely.
 *
 * Each source has:
 *   name      a label shown at the bottom of each post
 *   type      'rss'        a site with an automatic feed (best option)
 *             'page'       no feed, so we watch a news page for new article links
 *             'codeforces' Codeforces contest calendar (official API)
 *             'clist'      contests from many platforms through clist.by (free key needed)
 *             'devpost'    hackathons from Devpost
 *   url       the feed, API or news page address
 *   enabled   set to false to switch a source off
 *   every     how often to check, in minutes (default 30)
 *   requires  names of .env settings the source needs. If one is missing, the source is skipped.
 *   targets   where to post. Each target has:
 *               to:         SCHOLARSHIP, PHD_MS, IELTS, GRE, WEBINAR, CONTESTS or COMPETITIONS
 *                           (these match the WEBHOOK_... lines in your .env)
 *               match:      optional. Only items whose text matches this pattern go to that channel.
 *               exclude:    optional. Items matching this pattern do NOT go to that channel.
 *               flagFunded: optional. true marks posts that mention full funding, free travel or
 *                           accommodation with [FUNDED] and a gold colour.
 *
 * Extra settings for some types:
 *   page:               linkPrefix (required), exclude, stripFromTitle
 *   rss:                stripPublisher (for Google News: removes " - Publisher" from titles)
 *   codeforces / clist: remindMinutes, for example [60] or [1440, 60]. A "starting soon" reminder
 *                       is posted when a contest is that many minutes away. Default [60].
 *   clist:              platforms (only these hosts), excludePlatforms
 *   devpost:            minPrize (skip hackathons with a smaller total cash prize)
 *
 * After any change, test with:  node --env-file=.env feeds.js --check
 *
 * HOW REAL-TIME IS THIS? The script asks each source for news on a schedule (the "every"
 * setting), so a new post shows up in Discord within that many minutes of the source
 * publishing it. It is not instant, and it can only report what these sources publish.
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
  {
    // Failed on your PC ("fetch failed"), so it is switched off. Turn it on to retry.
    name: 'Scholarship Positions',
    type: 'rss',
    url: 'https://scholarship-positions.com/feed/',
    enabled: false,
    targets: [{ to: 'SCHOLARSHIP' }, { to: 'PHD_MS', match: PHD_OR_MS }],
  },
  {
    // This site refused automated access (HTTP 403), so it is switched off.
    name: 'Scholars4Dev',
    type: 'rss',
    url: 'https://www.scholars4dev.com/feed/',
    enabled: false,
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
