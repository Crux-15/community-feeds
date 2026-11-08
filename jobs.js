'use strict';

/*
 * jobs.js: CS job updates for the JOB UPDATES channels.
 *
 * What it does, for every source in jobsources.js:
 *   1. reads the open jobs (company career sites and job boards, no paid service),
 *   2. keeps only CS related jobs up to mid level (about 3 years of experience),
 *   3. marks beginner jobs (internships, graduate programs, junior and entry level jobs,
 *      "no experience required") with [BEGINNER] and a gold colour,
 *   4. posts every new job once into the right channel.
 *
 * The first time a source is read, its open jobs are posted once as a start (the newest
 * beginner jobs first, a limited number per channel), the rest are only remembered.
 * After that only new jobs are posted. Each source is read about once an hour.
 *
 * The posting links are NOT in this file. They come from the secret JOBS_WEBHOOKS
 * (or the local file jobs-webhooks.json), made by make-job-links.js.
 *
 * Read only look at what a source finds (posts nothing, saves nothing):
 *   node jobs.js --look                 every source
 *   node jobs.js --look --only amazon   sources whose name contains "amazon"
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GOLD = 0xf1c40f;
const BLUE = 0x3498db;
const USER_AGENT = 'Mozilla/5.0 (compatible; CommunityFeedBot/1.0)';
const KEEP_SEEN = Number(process.env.JOBS_KEEP_SEEN || 1500); // remembered jobs per source and channel
const READ_SLOTS = 3; // a known source is read in one of 3 ten-minute slots, so about every 30 minutes
const RETRY_429_MS = Number(process.env.JOBS_RETRY_MS ?? 4000); // wait before asking again when a site says "too many requests"
const READ_PARALLEL = Number(process.env.JOBS_PARALLEL || 6);
const READ_BUDGET_MS = Number(process.env.JOBS_BUDGET_MS || 270000); // stop starting new reads after 4.5 minutes
const PAUSE_BETWEEN_POSTS_MS = Number(process.env.JOBS_POST_PAUSE_MS ?? 1000);
const CAPS = {
  firstGold: Number(process.env.JOBS_FIRST_GOLD || 15), // first start of a channel: beginner jobs
  firstOther: Number(process.env.JOBS_FIRST_OTHER || 5), // first start of a channel: other jobs
  runGold: Number(process.env.JOBS_RUN_GOLD || 10), // normal round: beginner jobs per channel
  runOther: Number(process.env.JOBS_RUN_OTHER || 4), // normal round: other jobs per channel
};

const SOURCES = require('./jobsources.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
// Tests point every site at a fake server through JOBS_TEST_BASE
const base = (real) => process.env.JOBS_TEST_BASE || real;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', bull: '-' };
function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
// Greenhouse sends HTML that is itself escaped, so decode, remove tags, decode again
function htmlToText(s) {
  let t = decode(String(s || ''));
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|ul|ol|tr)>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decode(t).replace(/\s+/g, ' ').trim();
}

async function http(url, { method = 'GET', body, headers = {}, json = true, timeout = 25000 } = {}) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(url, {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: json ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new Error('timed out after ' + Math.round(timeout / 1000) + ' seconds');
      const c = err.cause;
      throw new Error('could not connect' + (c && (c.code || c.message) ? ' (' + (c.code || c.message) + ')' : ''));
    }
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || RETRY_429_MS, 10000);
      await sleep(process.env.JOBS_RETRY_MS ? RETRY_429_MS : wait);
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 403 || res.status === 429 ? ' (the site may block automatic readers)' : ''));
  const text = await res.text();
  if (!json) return text;
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('the answer was not JSON (the site may block automatic readers or changed)');
  }
}

const cut = (s, n) => String(s || '').slice(0, n);
const asTime = (v) => {
  if (!v) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v > 1e9 ? v * 1000 : 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
};
const TITLE_FIX = { i: 'I', ii: 'II', iii: 'III', iv: 'IV', ai: 'AI', ml: 'ML', ui: 'UI', ux: 'UX', qa: 'QA', it: 'IT', sre: 'SRE', swe: 'SWE', sde: 'SDE', ios: 'iOS', devops: 'DevOps' };
const titleCase = (slug) =>
  String(slug)
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => TITLE_FIX[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

function relativePosted(s) {
  // Workday says "Posted Today", "Posted 3 Days Ago", "Posted 30+ Days Ago"
  const t = String(s || '').toLowerCase();
  const day = 86400000;
  if (/today|just posted|hour/.test(t)) return Date.now();
  if (/yesterday/.test(t)) return Date.now() - day;
  const m = t.match(/(\d+)\+?\s*days?/);
  return m ? Date.now() - Number(m[1]) * day : 0;
}

// ---------------------------------------------------------------------------
// Readers: every one returns jobs as { id, title, location, url, team, posted, text, hint, remote }
// hint can be 'beginner', 'junior' or 'senior' when the site itself says so.
// ---------------------------------------------------------------------------
const READERS = {
  // boards-api.greenhouse.io: used by Anthropic, Agoda, Stripe, Cloudflare and many more
  async greenhouse(src) {
    const data = await http(`${base('https://boards-api.greenhouse.io')}/v1/boards/${src.board}/jobs?content=true`);
    return (data.jobs || []).map((j) => ({
      id: String(j.id),
      title: j.title,
      location: (j.location && j.location.name) || '',
      url: j.absolute_url,
      team: ((j.departments || []).map((d) => d.name).filter(Boolean)[0]) || '',
      posted: asTime(j.first_published || j.updated_at),
      text: cut(htmlToText(j.content), 8000),
    }));
  },

  // api.lever.co: used by Spotify, Palantir and others
  async lever(src) {
    const host = src.eu ? 'https://api.eu.lever.co' : 'https://api.lever.co';
    const data = await http(`${base(host)}/v0/postings/${src.company}?mode=json`);
    return (Array.isArray(data) ? data : []).map((j) => ({
      id: String(j.id),
      title: j.text,
      location: (j.categories && j.categories.location) || '',
      url: j.hostedUrl,
      team: (j.categories && (j.categories.team || j.categories.department)) || '',
      posted: asTime(j.createdAt),
      text: cut([j.descriptionPlain, ...(j.lists || []).map((l) => (l.text || '') + ' ' + htmlToText(l.content)), j.additionalPlain].filter(Boolean).join(' '), 8000),
    }));
  },

  // api.ashbyhq.com: used by OpenAI, Notion, Ramp and others
  async ashby(src) {
    const data = await http(`${base('https://api.ashbyhq.com')}/posting-api/job-board/${src.org}`);
    return (data.jobs || [])
      .filter((j) => j.isListed !== false)
      .map((j) => ({
        id: String(j.id),
        title: j.title,
        location: j.location || (j.address && j.address.postalAddress && [j.address.postalAddress.addressLocality, j.address.postalAddress.addressCountry].filter(Boolean).join(', ')) || '',
        url: j.jobUrl || j.applyUrl,
        team: j.team || j.department || '',
        posted: asTime(j.publishedAt),
        text: cut(j.descriptionPlain || htmlToText(j.descriptionHtml), 8000),
        remote: j.isRemote === true ? true : undefined,
      }));
  },

  // api.smartrecruiters.com: used by Bosch and others. It also tells the experience level.
  async smartrecruiters(src) {
    const out = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const data = await http(`${base('https://api.smartrecruiters.com')}/v1/companies/${src.company}/postings?limit=100&offset=${offset}`);
      const rows = data.content || [];
      for (const j of rows) {
        const lv = ((j.experienceLevel && j.experienceLevel.id) || '').toLowerCase();
        const loc = j.location || {};
        out.push({
          id: String(j.id),
          title: j.name,
          location: [loc.city, loc.region, (loc.country || '').toUpperCase()].filter(Boolean).join(', ') + (loc.remote ? ' (remote)' : ''),
          url: `https://jobs.smartrecruiters.com/${src.company}/${j.id}`,
          team: (j.department && (j.department.label || j.department.name)) || '',
          posted: asTime(j.releasedDate),
          text: '',
          hint: /intern|entry/.test(lv) ? 'beginner' : /associate/.test(lv) ? 'junior' : /director|executive|mid_senior/.test(lv) ? 'senior' : '',
        });
      }
      if (rows.length < 100) break;
    }
    return out;
  },

  // Workday career sites: used by NVIDIA, Salesforce, Adobe, Intel and many others
  async workday(src) {
    const origin = `https://${src.tenant}.${src.wd || 'wd5'}.myworkdayjobs.com`;
    const seen = new Map();
    let firstError = null;
    for (const q of src.queries || ['software engineer']) {
      for (let page = 0; page < (src.pages || 3); page++) {
        let data;
        try {
          data = await http(`${base(origin)}/wday/cxs/${src.tenant}/${src.site}/jobs`, {
            method: 'POST',
            body: { appliedFacets: {}, limit: 20, offset: page * 20, searchText: q },
          });
        } catch (err) {
          firstError = firstError || err;
          break;
        }
        const rows = data.jobPostings || [];
        for (const j of rows) {
          const id = j.externalPath || (j.bulletFields || [])[0];
          if (!id || seen.has(id)) continue;
          seen.set(id, {
            id: String(id),
            title: j.title,
            location: j.locationsText || '',
            url: `${origin}/en-US/${src.site}${j.externalPath || ''}`,
            team: '',
            posted: relativePosted(j.postedOn),
            text: '',
          });
        }
        if (rows.length < 20) break;
      }
    }
    if (!seen.size && firstError) throw firstError;
    return [...seen.values()];
  },

  // amazon.jobs search (the same JSON the website uses)
  async amazon(src) {
    const seen = new Map();
    let firstError = null;
    for (const q of src.queries || ['software development engineer']) {
      let data;
      try {
        data = await http(`${base('https://www.amazon.jobs')}/en/search.json?base_query=${encodeURIComponent(q)}&sort=recent&offset=0&result_limit=100`);
      } catch (err) {
        firstError = firstError || err;
        continue;
      }
      for (const j of data.jobs || []) {
        const id = String(j.id_icims || j.id);
        if (seen.has(id)) continue;
        seen.set(id, {
          id,
          title: j.title,
          location: j.normalized_location || j.location || '',
          url: j.job_path ? 'https://www.amazon.jobs' + j.job_path : '',
          team: j.job_category || '',
          posted: asTime(j.posted_date),
          text: cut(htmlToText([j.basic_qualifications, j.preferred_qualifications, j.description_short].filter(Boolean).join(' ')), 8000),
        });
      }
    }
    if (!seen.size && firstError) throw firstError;
    return [...seen.values()];
  },

  // Microsoft careers (Eightfold). The exact answer format can change, so this is read loosely.
  async microsoft(src) {
    const seen = new Map();
    let firstError = null;
    for (const q of src.queries || ['software engineer']) {
      if (seen.size || firstError) await sleep(process.env.JOBS_RETRY_MS ? 0 : 1500); // be gentle, this site limits fast readers
      let data;
      try {
        data = await http(`${base('https://apply.careers.microsoft.com')}/api/pcsx/search?domain=microsoft.com&query=${encodeURIComponent(q)}&start=0&sort_by=timestamp`);
      } catch (err) {
        firstError = firstError || err;
        continue;
      }
      const rows = (data && data.data && data.data.positions) || (data && data.positions) || [];
      for (const p of rows) {
        const id = String(p.id || p.displayJobId || '');
        if (!id || seen.has(id)) continue;
        seen.set(id, {
          id,
          title: p.name || p.title,
          location: Array.isArray(p.locations) ? p.locations.join('; ') : p.location || '',
          url: 'https://apply.careers.microsoft.com' + (p.positionUrl || '/careers/job/' + id),
          team: p.department || '',
          posted: asTime(p.postedTs || p.creationTs),
          text: '',
        });
      }
    }
    if (!seen.size && firstError) throw firstError;
    return [...seen.values()];
  },

  // Goldman Sachs "Higher" career site (GraphQL). Read loosely, may need small fixes.
  async goldman(src) {
    const query =
      'query GetRoles($searchQueryInput: RoleSearchQueryInput!) { roleSearch(searchQueryInput: $searchQueryInput) { totalCount items { roleId jobTitle jobFunction division locations { primary state country city } externalSource { sourceId } } } }';
    const seen = new Map();
    let firstError = null;
    for (const experiences of [['EARLY_CAREER'], ['PROFESSIONAL']]) {
      let data;
      try {
        data = await http(`${base('https://api-higher.gs.com')}/gateway/api/v1/graphql`, {
          method: 'POST',
          body: {
            operationName: 'GetRoles',
            query,
            variables: { searchQueryInput: { page: { pageSize: 100, pageNumber: 0 }, sort: { sortStrategy: 'POSTED_DATE', sortOrder: 'DESC' }, filters: [], experiences, searchTerm: '' } },
          },
        });
      } catch (err) {
        firstError = firstError || err;
        continue;
      }
      for (const j of (data && data.data && data.data.roleSearch && data.data.roleSearch.items) || []) {
        const id = String(j.roleId || (j.externalSource && j.externalSource.sourceId) || '');
        if (!id || seen.has(id)) continue;
        const loc = (j.locations || []).map((l) => [l.city, l.state, l.country].filter(Boolean).join(', ')).filter(Boolean).join('; ');
        seen.set(id, {
          id,
          title: j.jobTitle,
          location: loc,
          url: `https://higher.gs.com/roles/${id}`,
          team: [j.division, j.jobFunction].filter(Boolean).join(' / '),
          posted: 0,
          text: '',
          hint: experiences[0] === 'EARLY_CAREER' ? 'beginner' : '',
        });
      }
    }
    if (!seen.size && firstError) throw firstError;
    return [...seen.values()];
  },

  // jobs.apple.com search page. The result list is inside the page as JSON.
  async apple(src) {
    const seen = new Map();
    let firstError = null;
    for (const q of src.queries || ['software']) {
      let html;
      try {
        html = await http(`${base('https://jobs.apple.com')}/en-us/search?sort=newest&key=${encodeURIComponent(q)}`, { json: false });
      } catch (err) {
        firstError = firstError || err;
        continue;
      }
      let results = [];
      const m = html.match(/__staticRouterHydrationData\s*=\s*JSON\.parse\("((?:[^"\\]|\\.)*)"\)/);
      if (m) {
        try {
          const data = JSON.parse(JSON.parse('"' + m[1] + '"'));
          results = (data.loaderData && data.loaderData.search && data.loaderData.search.searchResults) || [];
        } catch (_) {
          results = [];
        }
      }
      for (const j of results) {
        const id = String(j.positionId || j.id || '');
        if (!id || seen.has(id)) continue;
        seen.set(id, {
          id,
          title: j.postingTitle,
          location: (j.locations || []).map((l) => l.name).filter(Boolean).join('; '),
          url: `https://jobs.apple.com/en-us/details/${id}`,
          team: (j.team && j.team.teamName) || '',
          posted: asTime(j.postDateInGMT || j.postingDate),
          text: cut(j.jobSummary || '', 4000),
        });
      }
    }
    if (!seen.size) throw firstError || new Error('found no jobs (the page format may have changed)');
    return [...seen.values()];
  },

  // google.com/about/careers: the job list is inside the page as data (AF_initDataCallback)
  async google(src) {
    const seen = new Map();
    let firstError = null;
    for (const spec of src.queries || [{ q: 'software engineer' }]) {
      const q = typeof spec === 'string' ? { q: spec } : spec;
      for (let page = 1; page <= 3; page++) {
        let html;
        try {
          html = await http(
            `${base('https://www.google.com')}/about/careers/applications/jobs/results/?q=${encodeURIComponent(q.q || '')}&sort_by=date&hl=en_US&page=${page}` + (q.level ? '&target_level=' + q.level : ''),
            { json: false },
          );
        } catch (err) {
          firstError = firstError || err;
          break;
        }
        const rows = parseGoogleRows(html);
        for (const j of rows) {
          if (seen.has(j.id)) continue;
          j.hint = q.level === 'INTERN_AND_APPRENTICE' ? 'beginner' : q.level === 'EARLY' ? 'junior' : q.level === 'ADVANCED' || q.level === 'DIRECTOR_PLUS' ? 'senior' : '';
          seen.set(j.id, j);
        }
        if (rows.length < 20) break;
      }
    }
    if (!seen.size) throw firstError || new Error('found no jobs (the page format may have changed)');
    return [...seen.values()];
  },

  // bdjobs.com: the exact request is not public, so a few likely shapes are tried and the answer is read loosely
  async bdjobs(src) {
    const out = new Map();
    let firstError = null;
    const url = base('https://api.bdjobs.com') + '/Jobs/api/JobSearch/GetJobSearch';
    for (const q of src.queries || ['software']) {
      let data = null;
      const tries = [
        () => http(`${url}?Keyword=${encodeURIComponent(q)}&pg=1&rpp=50`),
        () => http(`${url}?keyword=${encodeURIComponent(q)}&pageNo=1&pageSize=50`),
        () => http(url, { method: 'POST', body: { Keyword: q, keyword: q, pg: 1, pageNo: 1, rpp: 50, pageSize: 50 } }),
      ];
      for (const t of tries) {
        try {
          data = await t();
          if (findJobRows(data).length) break;
        } catch (err) {
          firstError = firstError || err;
        }
      }
      for (const r of findJobRows(data)) {
        const id = String(r.jobId ?? r.JobId ?? r.jobid ?? r.id ?? r.Id);
        if (!id || out.has(id)) continue;
        const title = r.jobTitle ?? r.JobTitle ?? r.title ?? r.Title ?? r.jobTitleEn;
        out.set(id, {
          id,
          title,
          company: r.companyName ?? r.CompanyName ?? r.company ?? r.CompanyNameEn ?? 'Bangladesh employer',
          location: r.location ?? r.Location ?? r.jobLocation ?? r.JobLocation ?? '',
          url: `https://bdjobs.com/h/details/${id}`,
          team: '',
          posted: asTime(r.postedOn ?? r.PostedOn ?? r.publishDate ?? r.PostDate ?? r.postedDate),
          text: cut(htmlToText([r.experience, r.Experience, r.jobContext, r.education].filter((x) => typeof x === 'string').join(' ')), 3000),
        });
      }
    }
    if (!out.size) throw firstError || new Error('found no jobs (the request format may need a small fix)');
    return [...out.values()];
  },

  // easy.jobs career pages (used by BrainStation 23): <company>.easy.jobs/api/career/home
  async easyjobs(src) {
    const out = new Map();
    for (let page = 1; page <= 3; page++) {
      let data;
      try {
        data = await http(`${base('https://' + src.host)}/api/career/home` + (page > 1 ? `?page=${page}` : ''));
      } catch (err) {
        if (page === 1) throw err;
        break;
      }
      const rows = (data && data.data && data.data.jobs) || [];
      const before = out.size;
      for (const j of rows) {
        const a = j.address || {};
        const loc = [a.city && a.city.name, a.state && a.state.name, a.country && a.country.name].filter(Boolean).join(', ');
        const remote = (j.meta && j.meta.is_remote) || /remote/i.test(String(j.job_type || ''));
        out.set(String(j.id), {
          id: String(j.id),
          title: j.title,
          location: loc + (remote ? ' (remote)' : ''),
          url: `https://${src.host}/${j.slug}`,
          team: '',
          posted: 0,
          text: '',
        });
      }
      if (out.size === before) break;
    }
    return [...out.values()];
  },

  // Feishu Hire career portals (used by Xiaomi): the page gives a csrf cookie, then the search is asked for
  async feishu(src) {
    const origin = base(`https://${src.host}`);
    const portal = src.portal || '/';
    let pageRes;
    try {
      pageRes = await fetch(origin + portal, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    } catch (err) {
      const c = err.cause;
      throw new Error('could not connect' + (c && (c.code || c.message) ? ' (' + (c.code || c.message) + ')' : ''));
    }
    if (!pageRes.ok) throw new Error('HTTP ' + pageRes.status);
    const jar = {};
    for (const c of pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : []) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    const token = jar['atsx-csrf-token'];
    if (!token) throw new Error('the portal gave no csrf cookie (it may need a real browser)');
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const portalType = src.portalType || 6;
    const limit = src.limit || 50;
    const out = new Map();
    for (let offset = 0; offset < (src.max || 300); offset += limit) {
      const qs = `keyword=&limit=${limit}&offset=${offset}&job_category_id_list=&tag_id_list=&location_code_list=&subject_id_list=&recruitment_id_list=&portal_type=${portalType}&job_function_id_list=&storefront_id_list=&portal_entrance=1`;
      const data = await http(`${origin}/api/v1/search/job/posts?${qs}`, {
        method: 'POST',
        body: { keyword: '', limit, offset, job_category_id_list: [], tag_id_list: [], location_code_list: [], subject_id_list: [], recruitment_id_list: [], portal_type: portalType, job_function_id_list: [], storefront_id_list: [], portal_entrance: 1 },
        headers: { 'x-csrf-token': decodeURIComponent(token), Cookie: cookie, Referer: origin + portal, Origin: origin },
      });
      if (data.code !== 0) throw new Error(`the portal answered code ${data.code}${data.message ? ' (' + data.message + ')' : ''}`);
      const list = (data.data && data.data.job_post_list) || [];
      for (const j of list) {
        const city = j.city_info || (Array.isArray(j.city_list) && j.city_list[0]) || j.city || {};
        out.set(String(j.id), {
          id: String(j.id),
          title: j.title,
          location: city.en_name || city.i18n_name || city.name || '',
          url: `https://${src.host}${portal.replace(/\/$/, '')}/position/${j.id}/detail`,
          team: (j.job_category && (j.job_category.en_name || j.job_category.name)) || '',
          posted: asTime(j.publish_time || j.published_at || j.update_time),
          text: cut(htmlToText([j.description, j.requirement].filter(Boolean).join(' ')), 8000),
        });
      }
      if (list.length < limit) break;
    }
    if (!out.size) throw new Error('the portal listed no jobs');
    return [...out.values()];
  },

  // Career pages without an API: read the job links on the page.
  // pages: [{ url, hint }], hrefPattern: text of a regular expression with ONE group (the job id)
  async links(src) {
    const out = new Map();
    let firstError = null;
    const re = new RegExp(src.hrefPattern, 'i');
    for (const pg of src.pages || [{ url: src.url }]) {
      let html;
      try {
        html = await http(pg.url.startsWith('http') ? base(pg.url.replace(/^(https?:\/\/[^/]+).*/, '$1')) + pg.url.replace(/^https?:\/\/[^/]+/, '') : pg.url, { json: false });
      } catch (err) {
        firstError = firstError || err;
        continue;
      }
      const anchors = [...html.matchAll(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
      for (let i = 0; i < anchors.length; i++) {
        const href = decode(anchors[i][1]);
        const m = href.match(re);
        if (!m) continue;
        const id = m[1];
        if (out.has(id)) continue;
        let title = htmlToText(anchors[i][2]);
        if (!title || title.length < 3 || /^(apply|view|details|read more|learn more)/i.test(title)) title = m[2] ? titleCase(m[2]) : '';
        if (!title) continue;
        let location = '';
        if (src.locationRegex) {
          const from = anchors[i].index;
          const to = anchors[i + 1] ? anchors[i + 1].index : from + 600;
          const lm = html.slice(from, Math.min(to, from + 900)).match(new RegExp(src.locationRegex, 'i'));
          if (lm) location = htmlToText(lm[1]);
        }
        const url = href.startsWith('http') ? href : new URL(href, pg.url).toString();
        out.set(id, { id, title, location, url, team: '', posted: 0, text: '', hint: pg.hint || '' });
      }
    }
    if (!out.size) throw firstError || new Error('found no job links (the page may load its jobs with JavaScript, or the page address changed)');
    return [...out.values()];
  },

  // ---- job boards for remote work and Europe ----
  async remotive(src) {
    const out = new Map();
    let firstError = null;
    for (const cat of src.categories || ['software-dev']) {
      let data;
      try {
        data = await http(`${base('https://remotive.com')}/api/remote-jobs?category=${cat}&limit=150`);
      } catch (err) {
        firstError = firstError || err;
        continue;
      }
      for (const j of data.jobs || []) {
        out.set(String(j.id), {
          id: String(j.id),
          title: j.title,
          company: j.company_name,
          location: j.candidate_required_location || '',
          url: j.url,
          team: j.category || '',
          posted: asTime(j.publication_date),
          text: cut(htmlToText(j.description), 8000),
          remote: true,
        });
      }
    }
    if (!out.size && firstError) throw firstError;
    return [...out.values()];
  },

  async remoteok(src) {
    const data = await http(`${base('https://remoteok.com')}/api`);
    return (Array.isArray(data) ? data : [])
      .filter((j) => j && j.id && j.position)
      .map((j) => ({
        id: String(j.id),
        title: j.position,
        company: j.company,
        location: j.location || '',
        url: j.url || (j.slug ? 'https://remoteok.com/remote-jobs/' + j.slug : ''),
        team: (j.tags || []).slice(0, 3).join(', '),
        posted: asTime(j.date || j.epoch),
        text: cut(htmlToText(j.description), 8000),
        remote: true,
      }));
  },

  async weworkremotely(src) {
    const Parser = require('rss-parser');
    const parser = new Parser({ timeout: 25000, headers: { 'User-Agent': USER_AGENT } });
    const out = new Map();
    let firstError = null;
    for (const feedName of src.feeds || ['remote-programming-jobs']) {
      let feed;
      try {
        feed = await parser.parseString(await http(`${base('https://weworkremotely.com')}/categories/${feedName}.rss`, { json: false }));
      } catch (err) {
        firstError = firstError || err;
        continue;
      }
      for (const i of feed.items || []) {
        const m = String(i.title || '').match(/^(.+?):\s+(.+)$/);
        const id = String(i.guid || i.link);
        out.set(id, {
          id,
          title: m ? m[2] : i.title,
          company: m ? m[1] : '',
          location: (i.region || '').toString(),
          url: i.link,
          team: '',
          posted: asTime(i.isoDate || i.pubDate),
          text: cut(htmlToText(i.content || i.contentSnippet || ''), 6000),
          remote: true,
        });
      }
    }
    if (!out.size && firstError) throw firstError;
    return [...out.values()];
  },

  async himalayas(src) {
    const rows = [];
    for (let offset = 0; offset < 100; offset += 20) {
      const data = await http(`${base('https://himalayas.app')}/jobs/api?limit=20&offset=${offset}`);
      const page = data.jobs || [];
      rows.push(...page);
      if (page.length < 20) break;
    }
    const seenIds = new Set();
    return rows.filter((j) => !seenIds.has(j.guid) && seenIds.add(j.guid)).map((j) => {
      const sen = (j.seniority || []).join(' ').toLowerCase();
      return {
        id: String(j.guid || j.applicationLink || j.title + j.companyName),
        title: j.title,
        company: j.companyName,
        location: (j.locationRestrictions || []).join(', ') || 'Worldwide',
        url: j.applicationLink || j.guid,
        team: (j.categories || []).slice(0, 2).join(', '),
        posted: asTime(j.pubDate),
        text: cut(htmlToText(j.description || j.excerpt), 8000),
        remote: true,
        hint: /entry|junior|intern/.test(sen) ? 'beginner' : /senior|manager|lead|director|executive/.test(sen) ? 'senior' : '',
      };
    });
  },

  async jobicy(src) {
    const data = await http(`${base('https://jobicy.com')}/api/v2/remote-jobs?count=50&industry=dev`);
    return (data.jobs || []).map((j) => {
      const lv = String(j.jobLevel || '').toLowerCase();
      return {
        id: String(j.id),
        title: j.jobTitle,
        company: j.companyName,
        location: j.jobGeo || '',
        url: j.url,
        team: [].concat(j.jobIndustry || []).slice(0, 2).join(', '),
        posted: asTime(j.pubDate),
        text: cut(htmlToText(j.jobDescription || j.jobExcerpt), 8000),
        remote: true,
        hint: /entry|junior|intern/.test(lv) ? 'beginner' : /senior|lead|manager/.test(lv) ? 'senior' : '',
      };
    });
  },

  async arbeitnow(src) {
    const data = await http(`${base('https://www.arbeitnow.com')}/api/job-board-api`);
    return (data.data || []).map((j) => ({
      id: String(j.slug),
      title: j.title,
      company: j.company_name,
      location: j.location || '',
      url: j.url,
      team: (j.tags || []).slice(0, 2).join(', '),
      posted: asTime(j.created_at),
      text: cut(htmlToText(j.description), 8000) + ((j.tags || []).join(' ').match(/visa/i) ? ' visa sponsorship' : ''),
      remote: j.remote === true ? true : undefined,
    }));
  },
};


// Google puts its job list in the page as JSON-like data. Rows look like [id, title, url, ...]
function parseGoogleRows(html) {
  const rows = [];
  const re = /AF_initDataCallback\(\{key:\s*'ds:\d+',\s*hash:\s*'[^']*',\s*data:([\s\S]*?),\s*sideChannel:/g;
  let m;
  const deepStrings = (v, depth = 0, out = []) => {
    if (depth > 6 || v == null) return out;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => deepStrings(x, depth + 1, out));
    return out;
  };
  const walk = (a, depth) => {
    if (!Array.isArray(a) || depth > 8) return;
    if ((typeof a[0] === 'string' || typeof a[0] === 'number') && /^\d{6,}$/.test(String(a[0])) && typeof a[1] === 'string' && a[1].length > 3 && typeof a[2] === 'string') {
      const locs = Array.isArray(a[9]) ? a[9].map((l) => (Array.isArray(l) && typeof l[0] === 'string' ? l[0] : '')).filter(Boolean) : [];
      const ts = Array.isArray(a[12]) && typeof a[12][0] === 'number' ? a[12][0] * 1000 : 0;
      rows.push({
        id: String(a[0]),
        title: a[1],
        location: locs.join('; '),
        url: `https://www.google.com/about/careers/applications/jobs/results/${a[0]}`,
        team: '',
        posted: ts,
        text: cut(htmlToText(deepStrings(a.slice(3, 5)).join(' ')), 8000),
      });
      return;
    }
    a.forEach((x) => walk(x, depth + 1));
  };
  while ((m = re.exec(html))) {
    try {
      walk(JSON.parse(m[1]), 0);
    } catch (_) {
      /* a block that is not a job list */
    }
  }
  return rows;
}

// the first list of objects that look like jobs (used for sites with an unknown answer shape)
function findJobRows(data, depth = 0) {
  if (!data || depth > 4) return [];
  if (Array.isArray(data)) {
    const hit = data.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).some((k) => /^(job)?title$/i.test(k) || /^jobtitle/i.test(k)));
    if (hit.length) return hit;
    for (const x of data) {
      const r = findJobRows(x, depth + 1);
      if (r.length) return r;
    }
    return [];
  }
  if (typeof data === 'object') {
    for (const k of Object.keys(data)) {
      const r = findJobRows(data[k], depth + 1);
      if (r.length) return r;
    }
  }
  return [];
}

async function readJobs(src) {
  const reader = READERS[src.reader];
  if (!reader) throw new Error('unknown reader "' + src.reader + '" in jobsources.js');
  const jobs = await reader(src);
  return jobs
    .filter((j) => j && j.id && j.title)
    .map((j) => ({
      ...j,
      title: cut(decode(String(j.title)).replace(/\s+/g, ' ').trim(), 200),
      company: j.company || src.name,
      location: cut(decode(String(j.location || src.defaultLocation || '')).replace(/\s+/g, ' ').trim(), 200),
      text: j.text || '',
    }));
}

// ---------------------------------------------------------------------------
// Deciding: is it a CS job, is it up to mid level, is it for an absolute beginner?
// ---------------------------------------------------------------------------
const CORE_CS =
  /\b(software|developers?|programmers?|swe|sde|sdet|devops|devsecops|sre|site reliability|machine learning|ml|ai|a\.i\.|llm|generative|nlp|computer vision|deep learning|data (?:engineers?|scientists?|engineering|science|analysts?|analytics|platform)|analytics engineers?|back[- ]?end|front[- ]?end|full[- ]?stack|web (?:developers?|engineers?)|mobile (?:developers?|engineers?)|android|ios|firmware|embedded|kernel|compiler|cuda|gpu|security engineers?|cyber ?security|infosec|appsec|penetration|cloud (?:engineers?|architects?|support|infrastructure)|platform engineers?|infrastructure engineers?|systems? (?:engineers?|administrators?|developers?)|network (?:engineers?|administrators?)|database|dba|big data|blockchain|smart contract|robotics|computer (?:science|engineer\w*)|programming|qa|quality assurance|test (?:engineers?|automation)|automation engineers?|verification engineers?|ux|ui|user experience|user interface|graphics|game (?:developers?|engineers?|programmers?)|research (?:engineers?|scientists?)|applied scientists?|algorithm\w*|bioinformatics|quantitative (?:developers?|engineers?))\b/i;
const IT_ROLES =
  /\b(it (?:support|helpdesk|help desk|analyst|administrator|engineer|specialist|technician|operations)|help ?desk|service desk|technical support|support engineers?|desktop support|solutions? (?:engineers?|architects?)|customer engineers?|forward deployed|implementation engineers?|integration engineers?|application support|technical consultant|product (?:managers?|designers?|analysts?)|interaction designers?|technical program\w*|program managers?|technical (?:writers?|product)|developer (?:advocate|relations|experience)|devrel|business intelligence|bi (?:developers?|analysts?)|information (?:technology|systems?|security)|network (?:operations|security)|data entry operator)\b/i;
const NOT_CS =
  /\b(sales|account (?:executive|manager)|marketing|recruit\w*|talent acquisition|people partner|human resources|hr|finance|financial|accountant|accounting|payroll|legal|counsel|attorney|paralegal|auditor|tax|procurement|supply chain|logistics|warehouse|fulfillment|driver|courier|nurse|clinical|pharma\w*|customer (?:service|care|success)|receptionist|executive assistant|facilities|retail|store|cashier|barista|chef|real estate|content (?:writer|creator|strategist)|copywriter|brand|public relations|communications|translator|teacher|tutor|banker|wealth|trader|underwriter|mechanical|civil|chemical|electrician|welder|technician(?! .*(?:it|network|support|software)))\b/i;
const NON_SOFTWARE_ENG = /\b(mechanical|electrical|electronics?|hardware|manufacturing|propulsion|structures?|structural|thermal|avionics|rf|optical|optics|civil|chemical|process|facilities|industrial|aerospace|materials?|photonics?|asic|analog|rtl|silicon|pcb|fpga|vlsi|physical design|layout|packaging|test technician|field (?:engineer|service)|safety|welding|machinist|assembly|production|quality (?:control|technician))\b/i;
const STRICT_CS = /\b(software|developers?|programmers?|swe|sde|sdet|firmware|embedded|machine learning|ml|ai|artificial intelligence|llm|data (?:engineers?|scientists?|analysts?|engineering|science)|devops|devsecops|sre|site reliability|security engineers?|cyber\w*|infosec|cloud|back[- ]?end|front[- ]?end|full[- ]?stack|web|mobile|android|ios|qa|quality assurance|test automation|automation engineers?|network engineers?|platform engineers?|infrastructure engineers?|systems? administrators?|it (?:support|analyst|engineer|specialist)|help ?desk|computer vision|compiler|gpu|cuda|graphics|simulation|autonomy|product designers?|ux|ui)\b/i;
const PHYSICAL_SECURITY = /physical security|security (?:guard|officer)|loss prevention/i;
const WEAK_TITLE = /\b(engineers?|scientists?|researchers?|analysts?|specialists?|interns?|internships?|graduates?|associates?|trainees?|apprentices?|programs?|fellows?|students?)\b/i;
const CS_WORDS = /\b(software|programming|python|java|c\+\+|javascript|typescript|machine learning|algorithms?|data structures|computer science|cloud|aws|azure|sql|linux|devops|api|backend|frontend|cybersecurity|artificial intelligence|deep learning|data science)\b/gi;
const TECH_TITLE = /\b(engineers?|scientists?|researchers?|developers?|programmers?|architects?)\b/i;

const BEGINNER_TITLE =
  /\b(interns?|internships?|co-?ops?|trainees?|apprentic\w*|graduates?|grads?|new[- ]?grad\w*|new college grad\w*|ncg|campus|university (?:grad\w*|hire)|early (?:career|talent|professionals?)|freshers?|fresh grad\w*|juniors?|jr\.?|entry[- ]?level|associate (?:software|engineer|developer|data|analyst|solutions?|cloud|product|program)|students?|werkstudent|working student|summer (?:analyst|associate|engineer|developer)|rotational|(?:engineer|developer|sde|swe|analyst|scientist|programmer|administrator|specialist)\s+(?:i|1)\b|level (?:i|1)\b)\b/i;
const BEGINNER_TEXT =
  /no (?:prior |previous |professional |work )?experience (?:is |was )?(?:required|needed|necessary)|(?:fresh|recent|new) graduates?\b|freshers?\b|0\s*(?:-|to)\s*[12]\s*years?|less than (?:1|2|one|two) years?|entry[- ]level|early[- ]career|final[- ]year students?|graduating in (?:20\d\d|spring|summer|winter|fall)/i;
const SENIOR_TITLE =
  /\b(senior|sr\.?|staff|principal|lead|leads|head|director|vp|svp|evp|vice president|distinguished|technical leadership|chief|president|fellow|iv|vi|vii|level [4-9]|l[6-9]|ic[5-9]|manager of|group manager|engineering manager|managing|(?<!solutions?\s)(?<!solution\s)architect)\b/i;
const MANAGER = /\bmanager\b/i;
const OK_MANAGER = /\b(?:product|program|project|technical program|release|delivery|scrum|it|support|implementation)\s+manager\b/i;

// Lowest "years of experience" the text asks for (null when it says nothing)
function minYears(text) {
  const t = String(text || '').toLowerCase();
  let min = null;
  const re = /(\d{1,2})(?:\s*(?:-|to)\s*(\d{1,2}))?\s*\+?\s*(?:years?|yrs?)\b/g;
  let m;
  while ((m = re.exec(t))) {
    const near = t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 90);
    if (!/experience|exp\b/.test(near)) continue;
    const n = Number(m[1]);
    if (n > 15) continue;
    if (min === null || n < min) min = n;
  }
  return min;
}

function levelLabel(title, text, cls) {
  const t = title.toLowerCase();
  if (/\b(intern|internship|co-?op|student|werkstudent|working student)\b/.test(t)) return 'Internship';
  if (/\b(graduate|grad|new[- ]?grad|campus|university|early (career|talent)|trainee|apprentice|rotational|ncg|fresher|fresh)\b/.test(t)) return 'Graduate or new-grad program';
  if (cls.beginner) return 'Entry level or junior';
  return 'Mid level or not stated';
}

function classify(job, src = {}) {
  const title = job.title || '';
  const text = job.text || '';
  const dept = job.team || '';
  const no = (why) => ({ ok: false, why });

  // 1. CS related?
  let cs = false;
  const hardNo = NOT_CS.test(title) && !/\b(software|developers?|programmers?|data (?:engineers?|scientists?)|machine learning|ml|ai|sdet|devops|security engineers?|backend|frontend|full[- ]?stack|firmware|embedded|help ?desk|service desk|it (?:support|analyst|administrator|engineer|specialist|technician)|desktop support|technical support)\b/i.test(title);
  const recruiter = /recruit|talent acquisition|sales|account (?:executive|manager)/i.test(title);
  if (recruiter || hardNo || PHYSICAL_SECURITY.test(title)) return no('not a CS job');
  if (src.strict && !STRICT_CS.test(title)) return no('not a software job');
  if (NON_SOFTWARE_ENG.test(title) && !/\b(software|firmware|embedded|data|machine learning|ml|ai|devops|cloud|security|qa|test|automation)\b/i.test(title)) return no('not a CS job');
  if (CORE_CS.test(title) || IT_ROLES.test(title)) cs = true;
  else if (src.allTech && TECH_TITLE.test(title)) cs = true;
  else if (WEAK_TITLE.test(title)) {
    // generic title (for example "Graduate Program" or "Research Engineer"): look at the team and the text
    const words = ((dept + ' ' + text).match(CS_WORDS) || []).length;
    if (words >= (BEGINNER_TITLE.test(title) ? 2 : 3) || (words >= 1 && /\b(engineering|technology|technical|software|data|digital|it)\b/i.test(dept))) cs = true;
  }
  if (!cs) return no('not a CS job');

  // 2. Level
  const beginnerTitle = BEGINNER_TITLE.test(title);
  const beginnerText = text ? BEGINNER_TEXT.test(text) : false;
  if (!beginnerTitle && SENIOR_TITLE.test(title)) return no('senior role');
  if (!beginnerTitle && job.hint === 'senior') return no('senior role');
  if (!beginnerTitle && MANAGER.test(title) && !OK_MANAGER.test(title)) return no('management role');
  const years = minYears(text);
  if (!beginnerTitle && years !== null && years >= 4) return no('asks for ' + years + '+ years');

  const beginner = beginnerTitle || job.hint === 'beginner' || (job.hint === 'junior' && years !== null && years <= 2) || (beginnerText && (years === null || years <= 2));
  const cls = { ok: true, beginner, years };
  cls.level = levelLabel(title, text, cls);
  if (job.hint === 'beginner' && cls.level === 'Mid level or not stated') cls.level = 'Entry level or junior';
  return cls;
}

// Remote boards: skip jobs that are only open to people in one region (for example "USA only")
function remoteOpenToUs(loc) {
  const l = String(loc || '').trim();
  if (!l) return true;
  if (/worldwide|anywhere|global|international|asia|apac|south asia|bangladesh|any location|everywhere/i.test(l)) return true;
  if (/\b(usa|u\.s\.|us only|united states|canada|uk|united kingdom|europe|eu only|emea|germany|france|latam|latin america|australia|north america|only)\b/i.test(l)) return false;
  return true;
}

const BD_PLACES = /bangladesh|dhaka|dhanmondi|gulshan|banani|uttara|motijheel|chattogram|chittagong|sylhet|khulna|rajshahi|gazipur|narayanganj|cumilla|bogura|rangpur|barishal/i;

function channelsFor(src, job) {
  const list = [src.channel];
  if (src.channel !== 'BD' && src.alsoBD !== false && BD_PLACES.test((job.location || '') + ' ' + (job.url || ''))) list.push('BD');
  return list;
}

// ---------------------------------------------------------------------------
// Posting links (secret JOBS_WEBHOOKS or the local file jobs-webhooks.json)
// ---------------------------------------------------------------------------
const validHook = (u) => /^https:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/.test(String(u || ''));
function loadHooks() {
  let raw = (process.env.JOBS_WEBHOOKS || '').trim();
  if (!raw) {
    try {
      raw = fs.readFileSync(path.join(__dirname, 'jobs-webhooks.json'), 'utf8');
    } catch (_) {
      return {};
    }
  }
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

function makeEmbed(job, cls, src) {
  const lines = [`**${job.company}**` + (job.location ? '  |  ' + job.location : '')];
  if (job.team) lines.push('Team: ' + cut(job.team, 120));
  lines.push('Level: ' + cls.level + (cls.years !== null && cls.years > 0 && !cls.beginner ? ` (asks for ${cls.years}+ years)` : ''));
  const embed = {
    title: ((cls.beginner ? '[BEGINNER] ' : '') + job.title).slice(0, 256),
    color: cls.beginner ? GOLD : BLUE,
    description: lines.join('\n').slice(0, 4000),
    footer: { text: src.label || src.name },
  };
  if (/^https?:\/\/[^\s]+$/.test(job.url || '') && job.url.length < 1500) embed.url = job.url;
  const when = job.posted ? new Date(job.posted) : null;
  if (when && !isNaN(when) && when.getTime() < Date.now() + 86400000 && when.getFullYear() > 2000) embed.timestamp = when.toISOString();
  return embed;
}

// ---------------------------------------------------------------------------
// Running all sources
// ---------------------------------------------------------------------------
const matches = (src, only) => !only || src.name.toLowerCase().includes(only.toLowerCase()) || src.key.toLowerCase().includes(only.toLowerCase());
const shortId = (id) => crypto.createHash('sha1').update(String(id)).digest('base64url').slice(0, 8);
const spread = (key) => parseInt(crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 6), 16) % READ_SLOTS;

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

/*
 * One round. Nothing about timing is saved: a source that has been read before is read in one
 * of READ_SLOTS ten-minute slots of the hour (so about every 30 minutes, and not all at once).
 * A source never read before is read right away.
 * state.__jobs["source>channel"] is one text of short ids, remembered jobs separated by spaces.
 */
async function run({ state, only = '', save = () => {}, ctx }) {
  const hooks = loadHooks();
  if (!Object.keys(hooks).some((k) => validHook(hooks[k]))) {
    ctx.log('Job feeds: JOBS_WEBHOOKS is not set (or has no valid posting link), skipped');
    return;
  }
  state.__jobs = state.__jobs || {};
  // A list that starts with "!" is a first start that was not finished (posting failed), so it counts as new again
  const isNewList = (lk) => state.__jobs[lk] === undefined || String(state.__jobs[lk]).startsWith('!');
  const lists = new Map();
  const failedChannels = new Set();
  const firstLists = new Set();
  const getList = (lk) => {
    if (!lists.has(lk)) {
      const v = state.__jobs[lk];
      lists.set(lk, typeof v === 'string' ? v.replace(/^!/, '').split(' ').filter(Boolean) : []);
    }
    return lists.get(lk);
  };
  const doneChannels = new Set();
  // final: every first start is finished unless posting failed. Before that: only channels that are done.
  const flush = (final = false) => {
    for (const [lk, arr] of lists) {
      const ch = lk.split('>')[1];
      const unfinished = firstLists.has(lk) && (final ? failedChannels.has(ch) : !doneChannels.has(ch));
      state.__jobs[lk] = (unfinished ? '!' : '') + arr.join(' ');
    }
    save();
  };
  const remember = (lk, id) => {
    const list = getList(lk);
    const sid = shortId(id);
    if (!list.includes(sid)) list.push(sid);
    if (list.length > KEEP_SEEN) list.splice(0, list.length - KEEP_SEEN);
  };

  const started = Date.now();
  const slot = Math.floor(started / 600000) % READ_SLOTS;
  const due = [];
  for (const src of SOURCES) {
    if (src.disabled || !matches(src, only)) continue;
    if (!validHook(hooks[src.channel])) continue;
    const channels = [src.channel, ...(src.channel !== 'BD' && src.alsoBD !== false && validHook(hooks.BD) ? ['BD'] : [])];
    const isNew = channels.some((ch) => isNewList(`${src.key}>${ch}`));
    if (!only && !isNew && spread(src.key) !== slot) continue;
    due.push(src);
  }

  const byChannel = new Map(); // channel key -> candidates
  let skipped = 0;
  await pool(due, READ_PARALLEL, async (src) => {
    if (Date.now() - started > READ_BUDGET_MS) {
      skipped++;
      return;
    }
    let jobs;
    try {
      jobs = await readJobs(src);
    } catch (err) {
      ctx.log(`Jobs: ${src.name}: PROBLEM, ${err.message}`);
      return;
    }
    const channels = [src.channel, ...(src.channel !== 'BD' && src.alsoBD !== false && validHook(hooks.BD) ? ['BD'] : [])];
    for (const ch of channels) {
      const lk = `${src.key}>${ch}`;
      if (isNewList(lk)) firstLists.add(lk);
      getList(lk);
    }
    for (const job of jobs) {
      if (src.remoteOnly && !remoteOpenToUs(job.location)) continue;
      const cls = classify(job, src);
      if (!cls.ok || (src.beginnerOnly && !cls.beginner)) continue;
      for (const ch of channelsFor(src, job)) {
        if (!validHook(hooks[ch])) continue;
        if (!byChannel.has(ch)) byChannel.set(ch, []);
        byChannel.get(ch).push({ src, job, cls, lk: `${src.key}>${ch}` });
      }
    }
  });
  if (skipped) ctx.log(`Jobs: ${skipped} source(s) left for the next round (time budget used)`);

  // every channel posts on its own, one job after the other, so all channels fill at the same time
  await Promise.all(
    [...byChannel].map(async ([ch, cands]) => {
      const first = cands.some((c) => firstLists.has(c.lk));
      const seenOf = new Map();
      const isSeen = (c) => {
        if (!seenOf.has(c.lk)) seenOf.set(c.lk, new Set(getList(c.lk)));
        return seenOf.get(c.lk).has(shortId(c.job.id));
      };
      const fresh = cands.filter((c) => !isSeen(c));
      const byNew = (a, b) => (b.job.posted || 0) - (a.job.posted || 0);
      const gold = fresh.filter((c) => c.cls.beginner).sort(byNew).slice(0, first ? CAPS.firstGold : CAPS.runGold);
      const other = fresh.filter((c) => !c.cls.beginner).sort(byNew).slice(0, first ? CAPS.firstOther : CAPS.runOther);
      const chosen = [...gold, ...other].sort((a, b) => (a.job.posted || 0) - (b.job.posted || 0));
      let posted = 0;
      let failed = false;
      for (const c of chosen) {
        try {
          await ctx.postEmbed(hooks[ch], makeEmbed(c.job, c.cls, c.src));
        } catch (err) {
          ctx.log(`Jobs: #${ch}: PROBLEM, ${err.message}`);
          // Discord refused this one job itself (HTTP 400): skip it for good so it cannot block the channel
          if (/HTTP 400/.test(err.message)) {
            remember(c.lk, c.job.id);
            continue;
          }
          failed = true;
          break;
        }
        remember(c.lk, c.job.id);
        posted++;
        await sleep(PAUSE_BETWEEN_POSTS_MS);
      }
      // a source read for the first time: everything else open now is only remembered (not when posting failed)
      if (failed) failedChannels.add(ch);
      else {
        for (const c of cands) if (firstLists.has(c.lk)) remember(c.lk, c.job.id);
        doneChannels.add(ch);
      }
      flush(); // saved after every channel, so a cut-off run does not lose what it already posted
      if (posted) ctx.log(`Jobs: #${ch}: posted ${posted} job(s)` + (first ? ' (first start of this channel)' : ''));
    }),
  );
  flush(true);
}

// ---------------------------------------------------------------------------
// Check (used by feeds.js --check) and the read only look
// ---------------------------------------------------------------------------
async function summarize(src) {
  const jobs = await readJobs(src);
  const tally = {};
  const good = [];
  for (const job of jobs) {
    if (src.remoteOnly && !remoteOpenToUs(job.location)) {
      tally['open only to one region'] = (tally['open only to one region'] || 0) + 1;
      continue;
    }
    const cls = classify(job, src);
    if (!cls.ok) {
      tally[cls.why] = (tally[cls.why] || 0) + 1;
      continue;
    }
    if (src.beginnerOnly && !cls.beginner) {
      tally['not beginner'] = (tally['not beginner'] || 0) + 1;
      continue;
    }
    good.push({ job, cls });
  }
  return { jobs, good, tally };
}

// reads many sources at once, answers come back in the order of the list
async function summarizeAll(list) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(READ_PARALLEL, list.length) }, async () => {
    while (i < list.length) {
      const n = i++;
      try {
        out[n] = { ok: true, ...(await summarize(list[n])) };
      } catch (err) {
        out[n] = { ok: false, error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function check(log = console.log) {
  log('\nJob sources (nothing is posted):');
  const hooks = loadHooks();
  const keys = [...new Set(SOURCES.map((s) => s.channel).concat('BD'))];
  const active = SOURCES.filter((s) => !s.disabled);
  const results = await summarizeAll(active);
  let n = 0;
  for (const src of SOURCES) {
    if (src.disabled) {
      log(`[OFF]  ${src.name} (${src.channel}): ${typeof src.disabled === 'string' ? src.disabled : 'switched off in jobsources.js'}`);
      continue;
    }
    const r = results[n++];
    const note = src.beta ? '  (site format not confirmed yet)' : '';
    if (!r.ok) {
      log(`[FAIL] ${src.name} (${src.channel}): ${r.error}${note}`);
      continue;
    }
    const { jobs, good, tally } = r;
    const gold = good.filter((g) => g.cls.beginner);
    if (!jobs.length) {
      log(`[WARN] ${src.name} (${src.channel}): reached the site but it listed 0 jobs.${note}`);
      continue;
    }
    log(`[OK]   ${src.name} (${src.channel}): read ${jobs.length} jobs, ${good.length} fit (CS, up to mid level), ${gold.length} beginner.`);
    const why = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${v} ${k}`).join(', ');
    if (why) log(`         left out: ${why}`);
    [...gold.slice(0, 3), ...good.filter((g) => !g.cls.beginner).slice(0, 2)].forEach((g) =>
      log(`         ${g.cls.beginner ? 'BEGINNER ' : 'mid      '}${g.job.title}${g.job.location ? '  [' + cut(g.job.location, 40) + ']' : ''}`),
    );
  }
  const have = Object.keys(hooks).filter((k) => validHook(hooks[k]));
  log(`\nJOBS_WEBHOOKS: ${have.length ? 'set, ' + have.length + ' channel link(s)' : 'NOT SET (job posts are skipped until it is)'}`);
  const missing = keys.filter((k) => !validHook(hooks[k]));
  if (have.length && missing.length) log('  no link for: ' + missing.join(', '));
}

async function look(only) {
  const list = SOURCES.filter((s) => !s.disabled && matches(s, only));
  const results = await summarizeAll(list);
  list.forEach((src, i) => {
    const r = results[i];
    console.log(`\n== ${src.name} (${src.channel})`);
    if (!r.ok) return console.log('FAILED: ' + r.error);
    const { jobs, good, tally } = r;
    console.log(`read ${jobs.length} jobs, ${good.length} fit, ${good.filter((g) => g.cls.beginner).length} beginner`);
    console.log('left out: ' + (Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'));
    good
      .sort((a, b) => Number(b.cls.beginner) - Number(a.cls.beginner) || (b.job.posted || 0) - (a.job.posted || 0))
      .slice(0, 40)
      .forEach((g) => console.log(`  ${g.cls.beginner ? 'BEGINNER' : 'mid     '}  ${g.job.title}  [${cut(g.job.location, 40)}]  ${g.cls.level}`));
  });
  console.log('');
}

module.exports = { run, check, look, classify, readJobs, makeEmbed, minYears, remoteOpenToUs, channelsFor, htmlToText, READERS, CAPS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--only');
  const only = i >= 0 ? args[i + 1] || '' : '';
  if (args.includes('--look')) look(only).catch((e) => console.error('Stopped: ' + e.message));
  else console.log('Use:  node jobs.js --look   (read only)  or run feeds.js, which posts the jobs.');
}
