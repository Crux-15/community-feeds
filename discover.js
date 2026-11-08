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
      { name: 'BrainStation 23', url: 'https://brainstation-23.easy.jobs/' },
    ];

const out = (s) => console.log('DISCOVER|' + String(s).replace(/\s+/g, ' ').slice(0, 900));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch();
  for (const site of SITES) {
    out(`===== ${site.name}  ${site.url}`);
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
    const page = await ctx.newPage();
    const calls = [];
    page.on('response', async (res) => {
      try {
        const req = res.request();
        const type = req.resourceType();
        if (type !== 'xhr' && type !== 'fetch') return;
        const body = (await res.text().catch(() => '')) || '';
        calls.push({
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
    calls.slice(0, 8).forEach((c, i) => {
      out(`--- request ${i + 1}: ${c.method} ${c.url} -> ${c.status} ${c.type} ${c.size} bytes`);
      if (c.headers) out('headers: ' + c.headers);
      if (c.post) out('sent: ' + c.post);
      out('answer starts: ' + c.body);
    });
    await ctx.close();
  }
  await browser.close();
})().catch((err) => {
  out('stopped: ' + err.message);
  process.exit(1);
});
