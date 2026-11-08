'use strict';

/*
 * discover.js: opens a few career sites in a real browser (in the cloud) and prints how each one
 * loads its job list, so a small reader can be written for it. It posts nothing and saves nothing.
 * Every output line starts with DISCOVER| so it is easy to pick out of the log.
 */

const { chromium } = require('playwright');

const SITES = process.env.DISCOVER_SITES
  ? JSON.parse(process.env.DISCOVER_SITES)
  : [
      { name: 'Meta', url: 'https://www.metacareers.com/jobsearch/' },
      { name: 'Xiaomi', url: 'https://xiaomi.jobs.f.mioffice.cn/global' },
    ];

const out = (s) => console.log('DISCOVER|' + String(s).replace(/\s+/g, ' ').slice(0, 900));
const NOISY = /^(__dyn|__csr|__hs|__hsi|__s|__rev|__ccg|__a|__user|__req|dpr|av|__comet_req|__spin_r|__spin_b|__spin_t|__aaid|__jssesw)$/;
function formSummary(pd, type) {
  if (!/urlencoded/i.test(type || '')) return '';
  try {
    const parts = [];
    for (const [k, v] of new URLSearchParams(pd)) if (!NOISY.test(k)) parts.push(`${k}=${v.slice(0, 700)}`);
    return parts.join(' & ');
  } catch (_) {
    return '';
  }
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch();
  for (const site of SITES) {
    out(`===== ${site.name}  ${site.url}`);
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
    const page = await ctx.newPage();
    const calls = [];
    const docCookies = [];
    page.on('response', (res) => {
      try {
        if (res.request().resourceType() === 'document') {
          const sc = res.headers()['set-cookie'] || '';
          docCookies.push(...[...sc.matchAll(/(?:^|\n)([^=\n;]+)=/g)].map((m) => m[1]));
        }
      } catch (_) {
        /* ignore */
      }
    });
    page.on('response', async (res) => {
      try {
        const req = res.request();
        const type = req.resourceType();
        if (type !== 'xhr' && type !== 'fetch') return;
        const body = (await res.text().catch(() => '')) || '';
        const fullPost = req.postData() || '';
        calls.push({
          csrf: req.headers()['x-csrf-token'] || '',
          form: formSummary(fullPost, req.headers()['content-type']),
          fullPost,
          method: req.method(),
          url: req.url(),
          status: res.status(),
          type: res.headers()['content-type'] || '',
          size: body.length,
          post: (req.postData() || '').slice(0, 700),
          headers: ['content-type', 'x-csrf-token', 'x-fb-lsd', 'referer', 'origin'].map((h) => (req.headers()[h] ? `${h}: ${req.headers()[h].slice(0, 120)}` : '')).filter(Boolean).join(' ; '),
          body: body.slice(0, 900),
        });
      } catch (_) {
        /* ignore */
      }
    });
    try {
      await page.goto(site.url, { waitUntil: 'networkidle', timeout: 45000 });
    } catch (err) {
      out('page load problem: ' + err.message.split('\n')[0]);
    }
    await page.waitForTimeout(5000);
    out(`final address: ${page.url()}   title: ${await page.title().catch(() => '')}`);
    const cookies = (await ctx.cookies()).map((c) => c.name).join(', ');
    out('cookie names: ' + cookies);
    out('cookies set by the page itself (not by scripts): ' + (docCookies.join(', ') || 'none'));
    const html = await page.content().catch(() => '');
    const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/);
    const dtsg = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]*)"/);
    out(`page html size: ${html.length}; LSD token in page: ${lsd ? lsd[1] : 'not found'}; DTSG token in page: ${dtsg ? dtsg[1].slice(0, 12) + '...' : 'not found'}`);

    // job links as they appear on the finished page
    const anchors = await page
      .$$eval('a[href]', (as) => as.map((a) => ({ t: (a.innerText || '').trim().slice(0, 90), h: a.href })))
      .catch(() => []);
    const jobLike = anchors.filter((a) => a.t && /job|position|detail|career|opening|apply/i.test(a.h) && !/login|signin|privacy|terms|cookie/i.test(a.h));
    out(`links on page: ${anchors.length}, job-like: ${jobLike.length}`);
    jobLike.slice(0, 25).forEach((a) => out(`LINK  ${a.t}  ->  ${a.h}`));

    // text on the page, to see whether the jobs are really displayed
    const text = await page.evaluate(() => document.body.innerText.slice(0, 700)).catch(() => '');
    out('page text: ' + text);

    // background requests: the ones that look like job data first
    const score = (c) => (/job|position|posting|career|search|graphql|vacanc|opening/i.test(c.url + c.post) ? 2 : 0) + (/"title"|"name"|job/i.test(c.body) ? 1 : 0);
    calls.sort((a, b) => score(b) - score(a));
    out(`background requests: ${calls.length}`);
    calls.slice(0, 10).forEach((c, i) => {
      out(`--- request ${i + 1}: ${c.method} ${c.url} -> ${c.status} ${c.type} ${c.size} bytes`);
      if (c.headers) out('headers: ' + c.headers);
      if (c.form) out('form values: ' + c.form);
      else if (c.post) out('sent: ' + c.post);
      out('answer starts: ' + c.body);
    });
    // can the job search be asked again without the _signature in the address?
    const jobCall = calls.find((c) => c.method === 'POST' && /search\/job\/posts/.test(c.url) && c.status === 200);
    if (jobCall) {
      const r = await page
        .evaluate(async ({ url, token, body }) => {
          const u = url.replace(/([?&])_signature=[^&]*&?/, '$1').replace(/[?&]$/, '');
          const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body });
          return res.status + ' ' + (await res.text()).slice(0, 300);
        }, { url: jobCall.url, token: jobCall.csrf, body: jobCall.fullPost })
        .catch((e) => 'replay failed: ' + e.message);
      out('job search asked again WITHOUT _signature: ' + r);
    }
    await ctx.close();
  }
  await browser.close();
})().catch((err) => {
  out('stopped: ' + err.message);
  process.exit(1);
});
