'use strict';

/*
 * jobsources.js: where the job updates come from.
 *
 * Every line is one company career site (or one job board) and the channel it posts into.
 * channel is the short name of a channel in jobs-webhooks.json / JOBS_WEBHOOKS:
 *   GOOGLE ANTHROPIC MICROSOFT AMAZON GOLDMAN APPLE META SAMSUNG XIAOMI OPENAI AGODA OPTIMIZELY
 *   BRAINSTATION23 RISEUP TESLA   (one per company channel)
 *   REMOTE (#remote-jobs)   INTL (#international-jobs)   BD (#bd-jobs)
 * A job located in Bangladesh is also posted into #bd-jobs, whatever site it came from.
 *
 * To stop one source, add  disabled: true  (or a short reason as text) to its line.
 * To get only beginner jobs from a source, add  beginnerOnly: true.
 *
 * Nothing in this file is secret.
 */

const ENTRY_ROLES = ['software engineer', 'intern', 'new graduate', 'data scientist', 'machine learning', 'security engineer', 'devops cloud', 'support engineer', 'qa test engineer', 'product manager', 'designer'];

const COMPANY = [
  // ---------------------------------------------------------------- one channel per company
  { name: 'Google', channel: 'GOOGLE', reader: 'google', queries: [{ q: '', level: 'INTERN_AND_APPRENTICE' }, { q: '', level: 'EARLY' }, { q: 'software engineer', level: 'MID' }, { q: 'data scientist', level: 'MID' }, { q: 'machine learning', level: 'MID' }, { q: 'security', level: 'MID' }, { q: 'product manager', level: 'MID' }], beta: true },
  { name: 'Google DeepMind', channel: 'GOOGLE', reader: 'greenhouse', board: 'deepmind', allTech: true },
  { name: 'Anthropic', channel: 'ANTHROPIC', reader: 'greenhouse', board: 'anthropic', allTech: true },
  { name: 'OpenAI', channel: 'OPENAI', reader: 'ashby', org: 'openai', allTech: true },
  { name: 'Microsoft', channel: 'MICROSOFT', reader: 'microsoft', queries: ENTRY_ROLES, beta: true },
  { name: 'Amazon', channel: 'AMAZON', reader: 'amazon', queries: ['software development engineer', 'university graduate', 'intern', 'data engineer', 'applied scientist', 'machine learning', 'security engineer', 'systems development engineer', 'cloud support associate', 'quality assurance engineer', 'technical program manager', 'ux designer'] },
  { name: 'Goldman Sachs', channel: 'GOLDMAN', reader: 'goldman', beta: true },
  { name: 'Apple', channel: 'APPLE', reader: 'apple', queries: ['software engineer', 'intern', 'machine learning', 'data', 'security', 'firmware', 'quality assurance', 'program manager'], beta: true },
  { name: 'Meta', channel: 'META', reader: 'none', disabled: 'no way found for a program to read the Meta job list (its site only works in a browser)' },
  { name: 'Samsung Research America', channel: 'SAMSUNG', reader: 'greenhouse', board: 'samsungresearchamerica', allTech: true },
  { name: 'Samsung Semiconductor', channel: 'SAMSUNG', reader: 'greenhouse', board: 'samsungsemiconductor', allTech: true },
  { name: 'Samsung', channel: 'SAMSUNG', reader: 'smartrecruiters', company: 'Samsung1' },
  { name: 'Xiaomi', channel: 'XIAOMI', reader: 'none', disabled: 'no career page found that a program can read' },
  { name: 'Agoda', channel: 'AGODA', reader: 'greenhouse', board: 'agoda', allTech: true },
  {
    name: 'Optimizely',
    channel: 'OPTIMIZELY',
    reader: 'links',
    pages: [0, 25, 50, 75].map((n) => ({ url: `https://careers.optimizely.com/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=${n}` })),
    hrefPattern: '/job/([^/]+/\\d+)',
    locationRegex: 'jobLocation[^>]*>([\\s\\S]*?)<',
    allTech: true,
    beta: true,
  },
  { name: 'BrainStation 23', channel: 'BRAINSTATION23', reader: 'none', disabled: 'needs the address of the BrainStation 23 careers page', defaultLocation: 'Dhaka, Bangladesh' },
  {
    name: 'Riseup Labs',
    channel: 'RISEUP',
    reader: 'links',
    pages: [{ url: 'https://www.careers-page.com/riseup-labs' }],
    hrefPattern: '/riseup-labs/job/([A-Z0-9]+)',
    defaultLocation: 'Dhaka, Bangladesh',
    allTech: true,
    beta: true,
  },
  { name: 'Tesla', channel: 'TESLA', reader: 'none', disabled: 'the Tesla site blocks programs from reading its job list' },

  // ---------------------------------------------------------------- Bangladesh
  { name: 'BDJobs', channel: 'BD', reader: 'bdjobs', queries: ['software', 'developer', 'programmer', 'web', 'android', 'data', 'ai', 'network', 'it support', 'qa', 'intern', 'trainee', 'fresher', 'graphic ui ux'], defaultLocation: 'Bangladesh', beta: true },

  // ---------------------------------------------------------------- remote work (#remote-jobs)
  { name: 'Remotive', channel: 'REMOTE', reader: 'remotive', categories: ['software-dev', 'data', 'devops', 'qa'], allTech: true, remoteOnly: true, alsoBD: false },
  { name: 'Remote OK', channel: 'REMOTE', reader: 'remoteok', allTech: true, remoteOnly: true, alsoBD: false },
  { name: 'We Work Remotely', channel: 'REMOTE', reader: 'weworkremotely', feeds: ['remote-programming-jobs', 'remote-devops-sysadmin-jobs', 'remote-design-jobs'], allTech: true, remoteOnly: true, alsoBD: false },
  { name: 'Himalayas', channel: 'REMOTE', reader: 'himalayas', allTech: true, remoteOnly: true, alsoBD: false },
  { name: 'Jobicy', channel: 'REMOTE', reader: 'jobicy', allTech: true, remoteOnly: true, alsoBD: false },
  { name: 'Arbeitnow', channel: 'REMOTE', reader: 'arbeitnow', allTech: true, remoteOnly: true, alsoBD: false, label: 'Arbeitnow (Europe, many offer visa help)' },
];

// ---------------------------------------------------------------- well-known companies (#international-jobs)
const greenhouse = (name, board) => ({ name, channel: 'INTL', reader: 'greenhouse', board, allTech: true });
const lever = (name, company) => ({ name, channel: 'INTL', reader: 'lever', company, allTech: true });
const ashby = (name, org) => ({ name, channel: 'INTL', reader: 'ashby', org, allTech: true });
const workday = (name, tenant, site, wd = 'wd5') => ({
  name,
  channel: 'INTL',
  reader: 'workday',
  tenant,
  site,
  wd,
  queries: ['software engineer', 'intern', 'new college graduate', 'data scientist', 'machine learning', 'security engineer', 'cloud devops'],
  pages: 2,
});

const INTERNATIONAL = [
  greenhouse('Stripe', 'stripe'),
  greenhouse('Cloudflare', 'cloudflare'),
  greenhouse('Databricks', 'databricks'),
  greenhouse('Airbnb', 'airbnb'),
  greenhouse('Discord', 'discord'),
  greenhouse('Figma', 'figma'),
  greenhouse('Coinbase', 'coinbase'),
  greenhouse('Dropbox', 'dropbox'),
  greenhouse('MongoDB', 'mongodb'),
  greenhouse('Pinterest', 'pinterest'),
  greenhouse('Reddit', 'reddit'),
  greenhouse('Robinhood', 'robinhood'),
  greenhouse('Twilio', 'twilio'),
  greenhouse('Datadog', 'datadog'),
  greenhouse('GitLab', 'gitlab'),
  greenhouse('Lyft', 'lyft'),
  greenhouse('Roblox', 'roblox'),
  greenhouse('Okta', 'okta'),
  greenhouse('Elastic', 'elastic'),
  greenhouse('Scale AI', 'scaleai'),
  { name: 'Anduril', channel: 'INTL', reader: 'greenhouse', board: 'andurilindustries' },
  { name: 'SpaceX', channel: 'INTL', reader: 'greenhouse', board: 'spacex' },
  greenhouse('Epic Games', 'epicgames'),
  greenhouse('Riot Games', 'riotgames'),
  greenhouse('Vercel', 'vercel'),
  greenhouse('Grammarly', 'grammarly'),
  greenhouse('Instacart', 'instacart'),
  greenhouse('Block', 'block'),
  greenhouse('Asana', 'asana'),
  greenhouse('Intercom', 'intercom'),
  greenhouse('Grab', 'grab'),
  greenhouse('Monzo', 'monzo'),
  greenhouse('xAI', 'xai'),
  lever('Spotify', 'spotify'),
  lever('Palantir', 'palantir'),
  lever('Plaid', 'plaid'),
  lever('Mistral AI', 'mistral'),
  ashby('Notion', 'notion'),
  ashby('Ramp', 'ramp'),
  ashby('Perplexity', 'perplexity-ai'),
  ashby('Cohere', 'cohere'),
  ashby('Linear', 'linear'),
  ashby('Deel', 'deel'),
  ashby('Replit', 'replit'),
  ashby('Cursor (Anysphere)', 'anysphere'),
  ashby('Supabase', 'supabase'),
  workday('NVIDIA', 'nvidia', 'NVIDIAExternalCareerSite'),
  workday('Salesforce', 'salesforce', 'External_Career_Site', 'wd12'),
  workday('Adobe', 'adobe', 'external_experienced'),
  workday('Intel', 'intel', 'External', 'wd1'),
  workday('Qualcomm', 'qualcomm', 'External'),
  workday('AMD', 'amd', 'AMD', 'wd1'),
  workday('Dell Technologies', 'dell', 'External', 'wd1'),
  workday('HP', 'hp', 'ExternalCareerSite'),
  workday('Workday', 'workday', 'Workday'),
  workday('Mastercard', 'mastercard', 'CorporateCareers', 'wd1'),
  workday('Walmart Global Tech', 'walmart', 'WalmartExternal'),
  workday('Snowflake', 'snowflake', 'Snowflake', 'wd1'),
  workday('Autodesk', 'autodesk', 'Ext', 'wd1'),
  workday('Red Hat', 'redhat', 'Jobs'),
  { name: 'Bosch', channel: 'INTL', reader: 'smartrecruiters', company: 'BoschGroup' },
  { name: 'Ubisoft', channel: 'INTL', reader: 'smartrecruiters', company: 'Ubisoft2' },
];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

module.exports = [...COMPANY, ...INTERNATIONAL].map((s) => ({ ...s, key: s.key || slug(s.name) }));
