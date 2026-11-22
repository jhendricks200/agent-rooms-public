// Verifies the sidebar agent end to end through a real browser:
// 1. loads /room/night-market
// 2. sends a message into the agent composer
// 3. asserts streamed assistant text appears in the agent pane
// 4. asserts a worked-for row (elapsed time + token count) renders after
//    the reply completes
//
// Run with: npm run verify:agent
// Requires the dev server already running on http://localhost:3000.
// If OPENROUTER_API_KEY has no credits, set MODEL_BASE_URL to point the
// dev server at a local mock (see scripts/mock-model-server.ts) before
// starting `next dev`, and this script still verifies the full streaming
// + persistence + UI path against that mock.

import 'dotenv/config';
import { chromium } from 'playwright';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/client';
import { agentMessages, agentSessions } from '../src/db/schema';
import { DEV_FALLBACK_CONTRIBUTOR_ID } from '../src/lib/session';

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';
const ROOM_PATH = '/room/night-market';

const postedBodies: string[] = [];

async function cleanup() {
  if (postedBodies.length === 0) return;
  const [session] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.ownerContributorId, DEV_FALLBACK_CONTRIBUTOR_ID));
  if (session) {
    await db.delete(agentMessages).where(inArray(agentMessages.content, postedBodies));
  }
  console.log(`cleaned up ${postedBodies.length} test message(s)`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(`${BASE_URL}${ROOM_PATH}`, { waitUntil: 'networkidle' });

  const unique = `verify-agent ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
  postedBodies.push(unique);

  const composerTextarea = page.locator('.agent-composer textarea');
  await composerTextarea.click();
  await composerTextarea.fill(unique);
  await composerTextarea.press('Enter');

  await page.locator('.msg.user', { hasText: unique }).waitFor({ state: 'visible', timeout: 10_000 });
  console.log(`PASS: user message rendered in agent pane: "${unique}"`);

  // Wait for the streamed assistant reply to produce non-empty text. Poll
  // rather than waitFor on a fixed selector since content streams in.
  const assistantBubble = page.locator('.msg.agent').last();
  await page.waitForFunction(
    () => {
      const bubbles = document.querySelectorAll('.msg.agent');
      const last = bubbles[bubbles.length - 1];
      return !!last && (last.textContent?.trim().length ?? 0) > 0;
    },
    { timeout: 60_000 },
  );
  const streamedText = (await assistantBubble.textContent()) ?? '';
  console.log(`PASS: streamed assistant text appeared (${streamedText.length} chars)`);

  await page.waitForFunction(
    () => {
      const bubbles = document.querySelectorAll('.msg.agent');
      const last = bubbles[bubbles.length - 1];
      const worked = last?.querySelector('.worked');
      return !!worked && /worked .* tokens/.test(worked.textContent ?? '');
    },
    { timeout: 60_000 },
  );
  const workedText = await assistantBubble.locator('.worked').textContent();
  if (!workedText || !/worked .* tokens/.test(workedText)) {
    throw new Error(`expected a worked-for row with elapsed time and token count, got: "${workedText}"`);
  }
  console.log(`PASS: worked-for row rendered: "${workedText.trim()}"`);

  console.log('verify:agent PASSED');
  await browser.close();
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error('verify:agent FAILED');
    console.error(err);
    await cleanup().catch(() => {});
    process.exit(1);
  })
  .then(() => process.exit(0));
