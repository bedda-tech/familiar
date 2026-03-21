/**
 * QA Agent Shared Utilities
 *
 * Shared Playwright helpers for the familiar QA agent fleet.
 * Used by {app}-qa agents running in ~/.familiar/agents/{app}-qa/.
 *
 * Usage in QA agent scripts:
 *   const qa = require('/home/mwhit/familiar/projects/qa/playwright-utils.js');
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────
// Browser lifecycle
// ─────────────────────────────────────────────────────────────

/**
 * Launch a Playwright browser.
 * Returns { browser, context, page } — caller must call browser.close().
 *
 * @param {object} opts
 * @param {boolean} [opts.headless=true]
 * @param {string}  [opts.screenshotDir] - dir to save screenshots on failure
 * @param {object}  [opts.viewport]
 */
async function launchBrowser(opts = {}) {
  const { chromium } = require('playwright');
  const {
    headless = true,
    screenshotDir = null,
    viewport = { width: 1280, height: 900 },
  } = opts;

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  // Attach failure handler — screenshots on uncaught page errors
  if (screenshotDir) {
    page.on('pageerror', async (err) => {
      await screenshotOnFailure(page, screenshotDir, `pageerror-${Date.now()}`);
      console.error('[QA] page error:', err.message);
    });
  }

  return { browser, context, page };
}

/**
 * Save a screenshot with a timestamped name.
 * Returns the path of the saved file.
 */
async function screenshotOnFailure(page, screenshotDir, label) {
  if (!screenshotDir) return null;
  fs.mkdirSync(screenshotDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(screenshotDir, `${label}-${ts}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[QA] screenshot saved: ${file}`);
  } catch (_) {}
  return file;
}

// ─────────────────────────────────────────────────────────────
// Wait helpers
// ─────────────────────────────────────────────────────────────

/** Wait for a network request matching urlPattern (string or regex) to complete. */
async function waitForRequest(page, urlPattern, timeout = 10000) {
  return page.waitForRequest(
    (req) =>
      typeof urlPattern === 'string'
        ? req.url().includes(urlPattern)
        : urlPattern.test(req.url()),
    { timeout }
  );
}

/** Wait for a response matching urlPattern with optional status check. */
async function waitForResponse(page, urlPattern, { timeout = 10000, status } = {}) {
  return page.waitForResponse(
    (res) => {
      const match =
        typeof urlPattern === 'string'
          ? res.url().includes(urlPattern)
          : urlPattern.test(res.url());
      return match && (status == null || res.status() === status);
    },
    { timeout }
  );
}

/** Sleep for ms milliseconds. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────
// Auth flows
// ─────────────────────────────────────────────────────────────

/**
 * Supabase email/password login.
 * Fills email + password fields, submits, and waits for redirect.
 *
 * @param {object} page   - Playwright page
 * @param {string} url    - login page URL
 * @param {string} email
 * @param {string} password
 * @param {object} [opts]
 * @param {string} [opts.emailSelector='input[type="email"]']
 * @param {string} [opts.passwordSelector='input[type="password"]']
 * @param {string} [opts.submitSelector='button[type="submit"]']
 * @param {string} [opts.successUrl]  - partial URL present after successful login
 */
async function loginSupabase(page, url, email, password, opts = {}) {
  const {
    emailSelector = 'input[type="email"]',
    passwordSelector = 'input[type="password"]',
    submitSelector = 'button[type="submit"]',
    successUrl = '/dashboard',
  } = opts;

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.fill(emailSelector, email);
  await page.fill(passwordSelector, password);
  await page.click(submitSelector);
  await page.waitForURL((u) => u.toString().includes(successUrl), { timeout: 15000 });
  return true;
}

/**
 * NextAuth credentials login (standard nextauth /api/auth/callback/credentials flow).
 */
async function loginNextAuth(page, url, email, password, opts = {}) {
  const {
    emailSelector = 'input[name="email"], input[type="email"]',
    passwordSelector = 'input[name="password"], input[type="password"]',
    submitSelector = 'button[type="submit"]',
    successUrl = '/',
  } = opts;

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.fill(emailSelector, email);
  await page.fill(passwordSelector, password);
  await page.click(submitSelector);
  await page.waitForURL((u) => u.toString().includes(successUrl), { timeout: 15000 });
  return true;
}

/**
 * Convex auth login (Clerk-based, typical Convex apps).
 * Opens sign-in modal / page and completes email+password flow.
 */
async function loginConvex(page, url, email, password, opts = {}) {
  const {
    signInSelector = '[data-localization-key="signIn.start.title"], a[href*="sign-in"]',
    emailSelector = 'input[name="identifier"], input[type="email"]',
    continueSelector = 'button[type="submit"]',
    passwordSelector = 'input[type="password"]',
    successUrl = '/',
  } = opts;

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Click sign-in trigger if it exists on the page
  const trigger = page.locator(signInSelector).first();
  if (await trigger.isVisible({ timeout: 3000 }).catch(() => false)) {
    await trigger.click();
  }

  await page.fill(emailSelector, email);
  await page.click(continueSelector);
  await page.fill(passwordSelector, password);
  await page.click(continueSelector);
  await page.waitForURL((u) => u.toString().includes(successUrl), { timeout: 20000 });
  return true;
}

// ─────────────────────────────────────────────────────────────
// State management
// ─────────────────────────────────────────────────────────────

/** Read agent state from state.json (returns {} if missing). */
function readState(stateDir) {
  const file = path.join(stateDir, 'state.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Write agent state to state.json (merges with existing). */
function writeState(stateDir, updates) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'state.json');
  const current = readState(stateDir);
  const next = { ...current, ...updates, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

// ─────────────────────────────────────────────────────────────
// Report generator
// ─────────────────────────────────────────────────────────────

/**
 * Generate a markdown test report.
 *
 * @param {object} opts
 * @param {string} opts.app       - app name e.g. "crowdia"
 * @param {string} opts.url       - base URL tested
 * @param {object[]} opts.results - array of test result objects
 * @param {string} opts.results[].name    - test case name
 * @param {'pass'|'fail'|'skip'} opts.results[].status
 * @param {string} [opts.results[].error]     - error message if fail
 * @param {string} [opts.results[].screenshot] - screenshot path if fail
 * @param {string} [opts.outputPath] - if set, writes report to this file
 * @returns {string} markdown report
 */
function generateReport(opts) {
  const { app, url, results, outputPath } = opts;
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  const total = results.length;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  const runAt = new Date().toISOString();

  const statusEmoji = { pass: '✅', fail: '❌', skip: '⏭️' };

  const rows = results
    .map((r) => {
      const em = statusEmoji[r.status] || '?';
      let row = `| ${em} | ${r.name} | ${r.status}`;
      if (r.error) row += ` | ${r.error.split('\n')[0].slice(0, 80)}`;
      else row += ' |';
      return row + ' |';
    })
    .join('\n');

  const failures = results
    .filter((r) => r.status === 'fail')
    .map((r) => {
      let s = `### ${r.name}\n- **Error**: ${r.error || 'unknown'}\n`;
      if (r.screenshot) s += `- **Screenshot**: \`${r.screenshot}\`\n`;
      if (r.steps) s += `- **Steps**: ${r.steps}\n`;
      return s;
    })
    .join('\n');

  const report = `# QA Report: ${app}

**URL**: ${url}
**Run at**: ${runAt}
**Result**: ${passed}/${total} passed (${pct}%)

| | Test | Status | Notes |
|---|---|---|---|
${rows}

${
  failures
    ? `## Failures\n\n${failures}`
    : '## No failures — all tests passed.'
}
`;

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, report);
  }

  return report;
}

// ─────────────────────────────────────────────────────────────
// Issue creator
// ─────────────────────────────────────────────────────────────

/**
 * Create a GitHub issue for a test failure using the gh CLI.
 *
 * @param {object} opts
 * @param {string} opts.repo   - e.g. "bedda-tech/crowdia-app"
 * @param {string} opts.title  - issue title
 * @param {string} opts.url    - URL where failure occurred
 * @param {string} opts.steps  - reproduction steps
 * @param {string} opts.expected
 * @param {string} opts.actual
 * @param {string} [opts.screenshot] - local path to screenshot
 * @param {string[]} [opts.labels]   - e.g. ["bug", "qa"]
 * @returns {{ number: number, url: string } | null}
 */
function createGitHubIssue(opts) {
  const { repo, title, url, steps, expected, actual, screenshot, labels = ['bug', 'qa'] } = opts;

  const body = `## Bug Report (QA Agent)

**URL**: ${url}

### Steps to Reproduce
${steps}

### Expected
${expected}

### Actual
${actual}

${screenshot ? `### Screenshot\nSee attached: \`${screenshot}\`` : ''}

---
*Created by QA agent on ${new Date().toISOString()}*
`;

  const labelArgs = labels.map((l) => `--label "${l}"`).join(' ');
  const cmd = `gh issue create --repo ${repo} --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} ${labelArgs} --json number,url`;

  try {
    const result = spawnSync('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body', body, '--label', labels.join(','), '--json', 'number,url'], { encoding: 'utf8' });
    if (result.status !== 0) {
      console.error('[QA] gh issue create failed:', result.stderr);
      return null;
    }
    return JSON.parse(result.stdout.trim());
  } catch (err) {
    console.error('[QA] failed to create GitHub issue:', err.message);
    return null;
  }
}

/**
 * Create a Notion task for a test failure.
 * Uses the Notion API directly.
 *
 * @param {object} opts
 * @param {string} opts.token       - Notion API token
 * @param {string} opts.databaseId  - Notion database ID to insert into
 * @param {string} opts.title
 * @param {string} opts.url
 * @param {string} opts.description - full description
 * @param {string} [opts.status='Backlog']
 * @param {string} [opts.priority='High']
 */
async function createNotionIssue(opts) {
  const { token, databaseId, title, url, description, status = 'Backlog', priority = 'High' } = opts;

  const body = {
    parent: { database_id: databaseId },
    properties: {
      Name: { title: [{ text: { content: title } }] },
      Status: { select: { name: status } },
      Priority: { select: { name: priority } },
      URL: { url: url },
    },
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: description } }],
        },
      },
    ],
  };

  const result = spawnSync(
    'curl',
    [
      '-s',
      '-X', 'POST',
      'https://api.notion.com/v1/pages',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Content-Type: application/json',
      '-H', 'Notion-Version: 2022-06-28',
      '-d', JSON.stringify(body),
    ],
    { encoding: 'utf8' }
  );

  try {
    const data = JSON.parse(result.stdout);
    if (data.id) return { id: data.id, url: data.url };
    console.error('[QA] Notion issue create failed:', data.message || result.stdout);
    return null;
  } catch (err) {
    console.error('[QA] Notion response parse error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Test runner helper
// ─────────────────────────────────────────────────────────────

/**
 * Run a Playwright test script at the given path and return structured results.
 * The script must write JSON results to stdout in the format:
 *   [{ name, status, error?, steps?, screenshot? }]
 *
 * @param {string} scriptPath - absolute path to the test script
 * @param {object} [env={}]   - extra env vars for the subprocess
 * @param {number} [timeout=60000]
 * @returns {{ results: object[], raw: string, exitCode: number }}
 */
function runTestScript(scriptPath, env = {}, timeout = 60000) {
  const result = spawnSync('node', [scriptPath], {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
  });

  const raw = result.stdout + result.stderr;
  let results = [];

  // Try to parse JSON from stdout (agent scripts emit JSON results)
  try {
    const jsonMatch = result.stdout.match(/\[[\s\S]*\]/);
    if (jsonMatch) results = JSON.parse(jsonMatch[0]);
  } catch (_) {}

  return {
    results,
    raw,
    exitCode: result.status ?? 1,
  };
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  // Browser
  launchBrowser,
  screenshotOnFailure,
  // Waits
  waitForRequest,
  waitForResponse,
  sleep,
  // Auth
  loginSupabase,
  loginNextAuth,
  loginConvex,
  // State
  readState,
  writeState,
  // Reporting
  generateReport,
  // Issue creation
  createGitHubIssue,
  createNotionIssue,
  // Test runner
  runTestScript,
};
