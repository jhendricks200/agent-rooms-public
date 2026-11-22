// Verifies the design-critique fixes end to end through a real browser:
// 1. room opens scrolled to the newest item (no manual scroll needed)
// 2. sending a message auto-scrolls and the message lands in the viewport
// 3. the jump-to-latest pill appears when scrolled up and a message
//    arrives via a direct API post, and clicking it returns to bottom
// 4. in light theme, the room header title and agent-pane user bubble
//    text have non-trivial contrast against their backgrounds
// 5. at several viewport heights, the page itself never scrolls and the
//    composer is always fully on screen without the user scrolling
// Screenshots of both themes are saved to app/screenshots/ for manual
// visual review (gitignored).
//
// Run with: npm run verify:ui
// Requires the dev server already running on http://localhost:3000.

import 'dotenv/config';
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { inArray, eq, gte, and } from 'drizzle-orm';
import { db } from '../src/db/client';
import { messages, agentMessages, agentSessions } from '../src/db/schema';
import { DEV_FALLBACK_CONTRIBUTOR_ID } from '../src/lib/session';

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';
const ROOM_PATH = '/room/night-market';
const ROOM_ID = 'night-market';
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

const postedBodies: string[] = [];
let agentTestStartedAt: Date | null = null;

async function cleanup() {
  if (postedBodies.length > 0) {
    await db.delete(messages).where(inArray(messages.body, postedBodies));
    console.log(`cleaned up ${postedBodies.length} test message(s)`);
  }
  if (agentTestStartedAt) {
    const [session] = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.ownerContributorId, DEV_FALLBACK_CONTRIBUTOR_ID), eq(agentSessions.roomId, ROOM_ID)))
      .limit(1);
    if (session) {
      await db
        .delete(agentMessages)
        .where(and(eq(agentMessages.sessionId, session.id), gte(agentMessages.createdAt, agentTestStartedAt)));
      console.log('cleaned up test agent message(s)');
    }
  }
}

function parseRgb(color: string): [number, number, number] {
  // Chromium reports color-mix()/backdrop-filter-adjacent colors via the
  // modern `color(srgb r g b / a)` syntax (0-1 floats) rather than rgb().
  const colorFn = color.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (colorFn) {
    return [parseFloat(colorFn[1]) * 255, parseFloat(colorFn[2]) * 255, parseFloat(colorFn[3]) * 255];
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return [0, 0, 0];
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map((n) => parseFloat(n));
  return [parts[0], parts[1], parts[2]];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const chan = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [rl, gl, bl] = [chan(r), chan(g), chan(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(parseRgb(fg));
  const l2 = relativeLuminance(parseRgb(bg));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

async function elementContrast(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const style = getComputedStyle(el);
    let bgEl: Element | null = el;
    let bg = 'rgba(0,0,0,0)';
    while (bgEl) {
      const c = getComputedStyle(bgEl).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
        bg = c;
        break;
      }
      bgEl = bgEl.parentElement;
    }
    return { color: style.color, backgroundColor: bg };
  });
}

async function main() {
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch();
  // Force dark regardless of the OS/headless default color scheme, so this
  // run is deterministic; the theme is flipped explicitly for section 4.
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' });

  // ---- 1. Room opens scrolled to the newest item ----
  await page.goto(`${BASE_URL}${ROOM_PATH}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(300); // initial scroll-to-bottom effect

  const initialScroll = await page.locator('.feed-scroll').evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  const initialDistanceFromBottom = initialScroll.scrollHeight - initialScroll.scrollTop - initialScroll.clientHeight;
  if (initialDistanceFromBottom > 40) {
    throw new Error(
      `expected room to open scrolled near bottom, distance from bottom was ${initialDistanceFromBottom}px`,
    );
  }
  console.log(`PASS: room opens scrolled to bottom (distance ${initialDistanceFromBottom}px)`);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'room-dark.png'), fullPage: false });

  // ---- 2. Sending a message auto-scrolls and lands in the viewport ----
  const unique = `verify-ui ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
  postedBodies.push(unique);
  const composerInput = page.locator('.room-composer input[type="text"]');
  await composerInput.click();
  await composerInput.fill(unique);
  await composerInput.press('Enter');

  const sentMessage = page.locator('.chat-msg', { hasText: unique });
  await sentMessage.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(500); // let the smooth-scroll settle

  const isInViewport = await sentMessage.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const scrollEl = document.querySelector('.feed-scroll')!;
    const scrollRect = scrollEl.getBoundingClientRect();
    return rect.top >= scrollRect.top && rect.bottom <= scrollRect.bottom + 4;
  });
  if (!isInViewport) {
    throw new Error('sent message did not land in the visible viewport after auto-scroll');
  }
  console.log(`PASS: sent message auto-scrolled into view: "${unique}"`);

  // ---- 3. Jump-to-latest pill on scroll-up + arriving message ----
  await page.locator('.feed-scroll').evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(100);

  const pillBefore = await page.locator('.jump-latest-pill').count();
  if (pillBefore !== 0) {
    throw new Error('expected no jump-to-latest pill before a new message arrives');
  }

  const apiUnique = `verify-ui-api ${Date.now()}`;
  postedBodies.push(apiUnique);
  const postRes = await page.request.post(`${BASE_URL}/api/rooms/night-market/messages`, {
    data: { body: apiUnique },
  });
  if (!postRes.ok()) {
    throw new Error(`API message post failed: ${postRes.status()}`);
  }

  // The room polls every 3s (see LiveRefresh.tsx); give it two cycles.
  await page.locator('.jump-latest-pill').waitFor({ state: 'visible', timeout: 8_000 });
  console.log('PASS: jump-to-latest pill appeared while scrolled up and a message arrived');

  const scrollTopWhilePillShown = await page.locator('.feed-scroll').evaluate((el) => el.scrollTop);
  if (scrollTopWhilePillShown > 40) {
    throw new Error('expected scroll position to stay put (not be yanked down) while the pill is shown');
  }

  await page.locator('.jump-latest-pill').click();
  await page.locator('.jump-latest-pill').waitFor({ state: 'hidden', timeout: 5_000 });
  await page.waitForTimeout(600); // let the smooth scroll-to-bottom finish
  const afterClick = await page.locator('.feed-scroll').evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  const distanceAfterClick = afterClick.scrollHeight - afterClick.scrollTop - afterClick.clientHeight;
  if (distanceAfterClick > 100) {
    throw new Error(`expected clicking the pill to scroll to bottom, distance from bottom was ${distanceAfterClick}px`);
  }
  console.log('PASS: clicking jump-to-latest pill scrolled to bottom and the pill disappeared');

  // ---- 4. Light theme contrast ----
  // Drive the same toggle button the user clicks, but pin the starting
  // attribute first so the assertion is deterministic regardless of the
  // browser's default color-scheme preference.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.locator('.theme-toggle').click();
  await page.waitForTimeout(500); // let the theme's color/background transition finish
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (theme !== 'light') {
    throw new Error(`expected data-theme="light" after toggling, got ${theme}`);
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'room-light.png'), fullPage: false });

  const headerTitle = await elementContrast(page, '.room-title h1');
  const headerRatio = contrastRatio(headerTitle.color, headerTitle.backgroundColor);
  console.log(`room header title contrast in light theme: ${headerRatio.toFixed(2)}:1`, headerTitle);
  if (headerRatio < 3) {
    throw new Error(`room header title contrast too low in light theme: ${headerRatio.toFixed(2)}:1`);
  }
  console.log('PASS: room header title has non-trivial contrast in light theme');

  // Agent pane chat is live now: seed a user bubble by sending one message
  // into the agent composer before checking its contrast.
  agentTestStartedAt = new Date(Date.now() - 2000);
  const agentUnique = `verify-ui-agent ${Date.now()}`;
  const agentTextarea = page.locator('.agent-composer textarea');
  await agentTextarea.click();
  await agentTextarea.fill(agentUnique);
  await agentTextarea.press('Enter');
  await page.locator('.msg.user', { hasText: agentUnique }).waitFor({ state: 'visible', timeout: 10_000 });

  const userBubble = await elementContrast(page, '.msg.user');
  const bubbleRatio = contrastRatio(userBubble.color, userBubble.backgroundColor);
  console.log(`agent-pane user bubble contrast in light theme: ${bubbleRatio.toFixed(2)}:1`, userBubble);
  if (bubbleRatio < 3) {
    throw new Error(`agent-pane user bubble text contrast too low in light theme: ${bubbleRatio.toFixed(2)}:1`);
  }
  console.log('PASS: agent-pane user bubble text has non-trivial contrast in light theme');

  // Left rail and feed backgrounds should also have flipped, not stayed dark.
  const railBg = await page.locator('.rail').evaluate((el) => getComputedStyle(el).backgroundColor);
  const railLuminance = relativeLuminance(parseRgb(railBg));
  if (railLuminance < 0.5) {
    throw new Error(`expected left rail background to be light in light theme, got ${railBg}`);
  }
  const feedBg = await page.locator('.feed-pane').evaluate((el) => {
    let cur: Element | null = el;
    while (cur) {
      const c = getComputedStyle(cur).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)') return c;
      cur = cur.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  });
  const feedLuminance = relativeLuminance(parseRgb(feedBg));
  if (feedLuminance < 0.5) {
    throw new Error(`expected feed background to be light in light theme, got ${feedBg}`);
  }
  console.log('PASS: left rail and feed backgrounds flip to light theme');

  // ---- 5. Viewport-height lock: no page scroll, composer always visible ----
  // Back to dark for this section; the shell's viewport-lock is
  // theme-independent so one theme is enough here.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

  for (const height of [900, 720, 600]) {
    await page.setViewportSize({ width: 1400, height });
    await page.goto(`${BASE_URL}${ROOM_PATH}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(200);

    const scrollInfo = await page.evaluate(() => {
      const se = document.scrollingElement!;
      return { scrollHeight: se.scrollHeight, clientHeight: se.clientHeight };
    });
    if (scrollInfo.scrollHeight !== scrollInfo.clientHeight) {
      throw new Error(
        `at viewport height ${height}px, the page itself scrolls: scrollHeight=${scrollInfo.scrollHeight} ` +
          `clientHeight=${scrollInfo.clientHeight}`,
      );
    }

    const composerBox = await page.locator('.room-composer input[type="text"]').boundingBox();
    if (!composerBox) throw new Error(`at viewport height ${height}px, composer input has no bounding box`);
    const fullyVisible =
      composerBox.y >= 0 &&
      composerBox.x >= 0 &&
      composerBox.y + composerBox.height <= height &&
      composerBox.x + composerBox.width <= 1400;
    if (!fullyVisible) {
      throw new Error(
        `at viewport height ${height}px, composer is not fully in view: ${JSON.stringify(composerBox)}`,
      );
    }
    console.log(`PASS: viewport ${height}px - no page scroll, composer fully visible on load`);
  }

  console.log('verify:ui PASSED');
  await browser.close();
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error('verify:ui FAILED');
    console.error(err);
    await cleanup().catch(() => {});
    process.exit(1);
  })
  .then(() => process.exit(0));
