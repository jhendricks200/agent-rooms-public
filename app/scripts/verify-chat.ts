// Verifies the room chat stream end to end through a real browser:
// 1. loads /room/night-market and counts rendered chat messages
// 2. types a unique string into the composer, presses Enter
// 3. asserts the string appears rendered in the stream
//
// Run with: npm run verify:chat
// Requires the dev server already running on http://localhost:3000.

import 'dotenv/config';
import { chromium } from 'playwright';
import { inArray } from 'drizzle-orm';
import { db } from '../src/db/client';
import { messages } from '../src/db/schema';

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';
const ROOM_PATH = '/room/night-market';

const postedBodies: string[] = [];

async function cleanup() {
  if (postedBodies.length === 0) return;
  await db.delete(messages).where(inArray(messages.body, postedBodies));
  console.log(`cleaned up ${postedBodies.length} test message(s)`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(`${BASE_URL}${ROOM_PATH}`, { waitUntil: 'networkidle' });

  const before = await page.locator('.chat-msg').count();
  if (before < 1) {
    throw new Error(`expected at least 1 rendered chat message before posting, got ${before}`);
  }
  console.log(`rendered chat messages before post: ${before}`);

  const unique = `verify-chat ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
  postedBodies.push(unique);

  const composerInput = page.locator('.room-composer input[type="text"]');
  await composerInput.click();
  await composerInput.fill(unique);
  await composerInput.press('Enter');

  await page.locator('.chat-msg', { hasText: unique }).waitFor({ state: 'visible', timeout: 10_000 });

  const after = await page.locator('.chat-msg').count();
  console.log(`rendered chat messages after post: ${after}`);

  if (after !== before + 1) {
    throw new Error(`expected chat message count to increase by 1, went from ${before} to ${after}`);
  }

  const composerValueAfter = await composerInput.inputValue();
  if (composerValueAfter !== '') {
    throw new Error(`expected composer to clear after send, still contains: "${composerValueAfter}"`);
  }

  const focused = await composerInput.evaluate((el) => el === document.activeElement);
  if (!focused) {
    throw new Error('expected composer input to keep focus after send');
  }

  console.log(`POSTED STRING FOUND IN STREAM: "${unique}"`);

  // Alignment: the dev user's own message renders right-aligned in an own
  // bubble; a seeded message from another author renders left-aligned.
  const ownMsg = page.locator('.chat-msg.own', { hasText: unique });
  if ((await ownMsg.count()) !== 1) {
    throw new Error('expected the posted message to render with the .own class');
  }
  const streamBox = await page.locator('.feed-stream').boundingBox();
  const ownBox = await ownMsg.boundingBox();
  if (!streamBox || !ownBox) throw new Error('missing bounding boxes for alignment check');
  const streamMid = streamBox.x + streamBox.width / 2;
  if (ownBox.x + ownBox.width / 2 <= streamMid) {
    throw new Error('expected own message to sit in the right half of the stream');
  }
  console.log('PASS: own message renders right-aligned');

  const otherMsg = page.locator('.chat-msg:not(.own)').first();
  if ((await otherMsg.count()) !== 1) {
    throw new Error('expected at least one seeded message from another author');
  }
  const otherBox = await otherMsg.boundingBox();
  if (!otherBox) throw new Error('missing bounding box for other-author message');
  if (otherBox.x + otherBox.width / 2 >= streamMid) {
    throw new Error('expected another author\'s message to sit in the left half of the stream');
  }
  console.log('PASS: other-author message renders left-aligned');

  console.log('verify:chat PASSED');

  await browser.close();
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error('verify:chat FAILED');
    console.error(err);
    await cleanup().catch(() => {});
    process.exit(1);
  })
  .then(() => process.exit(0));
