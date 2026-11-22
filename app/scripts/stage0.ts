// Stage 0 agent smoke test (the validation protocol's "Stage 0: agent smoke
// test" section; the protocol is kept out of this repository while the
// human test runs). Before any human participates, exercises the full
// promote/fork/remix/adopt loop repeatedly with fictional AI-agent
// personas, driving the app's own HTTP API exactly as a user would.
//
// Purposes, per the protocol:
//   1. end-to-end pipeline verification
//   2. cost and abuse data
//   3. seeding the demonstration room
//
// The protocol's original fourth purpose, a payload-sufficiency probe cycling
// rich / thin / no remix notes, has been dropped as never valid. See the note
// above harnessRemixNote() below, and the Stage 0 section of the protocol.
//
// Identity fidelity caveat (read before trusting these numbers): real
// sign-in is GitHub OAuth, which cannot be scripted for five fictional
// personas in a smoke test. This harness uses the dev fallback plus an
// explicit, documented override (STAGE0_IDENTITY_OVERRIDE=1, see
// src/lib/session.ts): each request carries an `x-stage0-contributor-id`
// header naming which persona is acting, and the server trusts it only
// when NODE_ENV=development AND DEV_IDENTITY_FALLBACK=1 AND
// STAGE0_IDENTITY_OVERRIDE=1 are all set. This exercises every route,
// every validation path, and the real database exactly as a signed-in user
// would, EXCEPT the authentication step itself: nothing here proves a real
// GitHub sign-in reaches the same contributor id. Auth.js's own callback
// wiring (src/auth.ts) is not exercised by this harness.
//
// Run with: npm run stage0 -- [--iterations N] [--cleanup] [--base-url URL]
// Requires: dev server on localhost:3000 (or --base-url), local Postgres,
// OPENROUTER_API_KEY and GITHUB_APP_* creds in .env, DEV_IDENTITY_FALLBACK=1
// and STAGE0_IDENTITY_OVERRIDE=1 in the *server's* environment.

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client';
import { contributors, rooms, proposals, proposalVersions, forks, adoptions, agentSessions, agentMessages, agentUsageReservations } from '../src/db/schema';
import { parseAgentDraft } from '../src/lib/agentDraft';
import { STAGE0_IDENTITY_HEADER } from '../src/lib/session';

const BASE_URL = process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : (process.env.STAGE0_BASE_URL ?? 'http://localhost:3000');

const ROOM_ID = 'stage0-lab';
const REPO_REF = 'Agent-Rooms/agent-rooms-nightmarket';
const CONTRIBUTOR_PREFIX = 'contributor_p0_';

// Slugs must be unique across runs, not just within one: promoted files land
// as real commits on the linked repo's main branch and are never rolled
// back between runs, so a purely iteration+persona slug collides with a
// path a prior run already merged ("add target already exists"). RUN_ID
// scopes every path this run creates to this process invocation.
const RUN_ID = Date.now().toString(36);

// DeepInfra pricing for deepseek/deepseek-v4-flash, the pinned provider
// (src/lib/model.ts PINNED_US_EU_PROVIDER_SLUGS[0]), read live from
// https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints
// on 2026-07-24: prompt $0.00000009/token, completion $0.00000018/token.
const PROMPT_USD_PER_TOKEN = 0.00000009;
const COMPLETION_USD_PER_TOKEN = 0.00000018;

interface Persona {
  id: string;
  displayName: string;
}

const PERSONAS: Persona[] = [
  { id: `${CONTRIBUTOR_PREFIX}nova`, displayName: 'Nova Ibarra' },
  { id: `${CONTRIBUTOR_PREFIX}kai`, displayName: 'Kai Whitfield' },
  { id: `${CONTRIBUTOR_PREFIX}rosa`, displayName: 'Rosa Delgado' },
  { id: `${CONTRIBUTOR_PREFIX}theo`, displayName: 'Theo Marsh' },
  { id: `${CONTRIBUTOR_PREFIX}yuki`, displayName: 'Yuki Tanaka' },
];
const MAINTAINER = PERSONAS[0];

// The payload-sufficiency arm (rich / thin / no remix note, cycled per
// iteration) has been removed. See the validation protocol, Stage 0
// section: it could not produce a result. Every arm scored 4 of 4 because the
// tasks are small enough to complete from the diff alone, and the "rich" arm
// emitted the same canned bullets on every proposal, so it compared a thin
// note against a differently-worded thin note. More fundamentally, a forking
// agent does not experience comprehension cost, which is the thing a remix
// note is meant to reduce, so no version of the arm could measure it. The
// question is left to the human sessions instead.
//
// A single note is still attached to every original promote, so the promote
// route's remix-note validation stays exercised end to end. It is harness
// boilerplate describing the harness's own constraints, not a claim about the
// specific change, and it carries no experimental meaning.
function harnessRemixNote(): { bullets: string[]; generatedBy: 'agent-draft'; authorEdited: boolean } {
  return {
    bullets: [
      'Harness-generated note: scoped to one small, self-contained addition.',
      'No new dependencies, build-config changes, or writes outside src/stage0/.',
    ],
    generatedBy: 'agent-draft',
    authorEdited: false,
  };
}

// ---- metrics -----------------------------------------------------------

interface HttpErrorRecord {
  route: string;
  status: number;
  count: number;
}

interface DeadForkRecord {
  iteration: number;
  cause: 'ingest-failure' | 'model-error';
  detail: string;
}

interface IterationRecord {
  iteration: number;
  author: string;
  forker: string;
  originalPromoted: boolean;
  originalProposalId?: string;
  originalPrUrl?: string;
  forkCreated: boolean;
  remixPromoted: boolean;
  remixProposalId?: string;
  remixPrUrl?: string;
  adopted: boolean;
  adoptedWhich?: 'original' | 'remix';
  tokensIn: number;
  tokensOut: number;
  notes: string[];
}

const metrics = {
  startedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  identityFidelity:
    'dev-fallback + explicit STAGE0_IDENTITY_OVERRIDE header override, not real GitHub OAuth; see file header comment',
  iterationsAttempted: 0,
  iterationsFullyCompleted: 0, // original promoted + fork promoted + adopted
  prsOpened: 0,
  prsMerged: 0,
  forksCreated: 0,
  adoptions: 0,
  deadForks: [] as DeadForkRecord[],
  totalTokensIn: 0,
  totalTokensOut: 0,
  totalCostUsd: 0,
  httpErrors: [] as HttpErrorRecord[],
  iterations: [] as IterationRecord[],
};

function recordHttpError(route: string, status: number) {
  const existing = metrics.httpErrors.find((e) => e.route === route && e.status === status);
  if (existing) existing.count += 1;
  else metrics.httpErrors.push({ route, status, count: 1 });
}

function recordDeadFork(rec: DeadForkRecord) {
  metrics.deadForks.push(rec);
}

// Matches github.ts createBranchAndApplyDiff's DiffApplyError message for an
// add whose target path is already present on the base branch.
const ADD_TARGET_EXISTS_RE = /add target "([^"]+)" already exists/;

// Promotes a proposal, retrying once with changeType flipped from "add" to
// "modify" if the base branch already has that path. RUN_ID-scoped slugs
// (see `slug` below) make same-run collisions unlikely, but a prior run's
// merge to main, or a model that ignores the "add" instruction, can still
// leave a real file at that path; preferring modify over add on that
// specific failure keeps the iteration alive instead of recording it as a
// harness-caused dead fork.
async function promoteProposal(
  contributorId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any; retried: boolean }> {
  const first = await apiCall('/api/proposals', 'POST', contributorId, body);
  if (first.status === 201) return { ...first, retried: false };

  const errMsg = JSON.stringify(first.json);
  const match = errMsg.match(ADD_TARGET_EXISTS_RE);
  if (!match) return { ...first, retried: false };

  let diff: { files: Array<{ path: string; content: string; changeType: string }> };
  try {
    diff = JSON.parse(body.diffRef as string);
  } catch {
    return { ...first, retried: false };
  }

  const collidingPath = match[1];
  let changed = false;
  for (const file of diff.files) {
    if (file.path === collidingPath && file.changeType === 'add') {
      file.changeType = 'modify';
      changed = true;
    }
  }
  if (!changed) return { ...first, retried: false };

  const retryBody = { ...body, diffRef: JSON.stringify(diff) };
  const second = await apiCall('/api/proposals', 'POST', contributorId, retryBody);
  return { ...second, retried: true };
}

// ---- HTTP helpers --------------------------------------------------------

async function apiCall(
  route: string,
  method: string,
  contributorId: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [STAGE0_IDENTITY_HEADER]: contributorId,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) recordHttpError(route, res.status);
  return { status: res.status, json };
}

// The agent-message route streams newline-delimited JSON events
// ({type:'token',delta} ... {type:'done',...}|{type:'error',...}). This
// collects the full text and the final usage/error event.
async function askAgent(
  contributorId: string,
  content: string,
): Promise<{ text: string; tokensIn: number; tokensOut: number; error?: string }> {
  const res = await fetch(`${BASE_URL}/api/agent/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [STAGE0_IDENTITY_HEADER]: contributorId,
    },
    body: JSON.stringify({ roomId: ROOM_ID, content }),
  });

  if (!res.ok) {
    recordHttpError('/api/agent/message', res.status);
    const errJson = await res.json().catch(() => ({}));
    return { text: '', tokensIn: 0, tokensOut: 0, error: errJson?.message ?? errJson?.error ?? `HTTP ${res.status}` };
  }

  const raw = await res.text();
  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let error: string | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: any;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt.type === 'token') text += evt.delta ?? '';
    if (evt.type === 'done') {
      tokensIn = evt.tokensIn ?? 0;
      tokensOut = evt.tokensOut ?? 0;
    }
    if (evt.type === 'error') error = evt.message ?? 'agent stream error';
  }

  return { text, tokensIn, tokensOut, error };
}

// ---- setup (direct DB, one-time fixtures, same pattern as scripts/seed.ts;
// the loop itself below never touches the database directly) --------------

// Fails loudly at startup if the identity override is not actually wired
// up, instead of letting every adopt call in the run silently 403. Adopt
// checks room.maintainers.includes(actingContributorId) before it ever
// looks at proposalId, so a bogus proposalId here still tells us whether
// the acting identity was accepted as maintainer: 403 means the override
// did not take effect (server missing DEV_IDENTITY_FALLBACK=1 or
// STAGE0_IDENTITY_OVERRIDE=1, or the room's maintainer roster is wrong);
// any other status (404 expected, since the proposal does not exist) means
// the maintainer check passed.
async function assertMaintainerIdentity(): Promise<void> {
  const probe = await apiCall('/api/adopt', 'POST', MAINTAINER.id, {
    proposalId: '__stage0_identity_probe__',
    proposalVersionId: '__stage0_identity_probe__',
    roomId: ROOM_ID,
  });
  if (probe.status === 403) {
    throw new Error(
      `Identity assertion failed: adopting as ${MAINTAINER.id} was rejected with 403 ` +
        `(${JSON.stringify(probe.json)}). This means the server did not accept the stage0 ` +
        `identity override as maintainer authority. Check that the dev server process has ` +
        `NODE_ENV=development, DEV_IDENTITY_FALLBACK=1, and STAGE0_IDENTITY_OVERRIDE=1 set, ` +
        `and that room "${ROOM_ID}"'s maintainers array contains "${MAINTAINER.id}".`,
    );
  }
  // Any non-403 (404 not-found is the expected case) proves the maintainer
  // check itself passed for this identity. Undo the httpErrors bookkeeping
  // this preflight call would otherwise leave behind.
  metrics.httpErrors.length = 0;
  console.log(`Identity assertion ok: ${MAINTAINER.id} holds maintainer authority in ${ROOM_ID}.`);
}

async function ensureSetup(): Promise<void> {
  for (const p of PERSONAS) {
    await db
      .insert(contributors)
      .values({ id: p.id, displayName: p.displayName, linkedDiscordId: null, linkedGithubId: null })
      .onConflictDoNothing();
  }

  const [existingRoom] = await db.select().from(rooms).where(eq(rooms.id, ROOM_ID)).limit(1);
  if (!existingRoom) {
    await db.insert(rooms).values({
      id: ROOM_ID,
      name: 'Stage 0 Lab',
      discordChannelRef: 'discord:stage0-lab',
      githubRepoRef: REPO_REF,
      maintainers: [MAINTAINER.id],
      adoptionAuthority: 'maintainers',
      createdBy: MAINTAINER.id,
      license: 'MIT',
      tokenBudgetPerUser: 200_000,
      tokenBudgetPerRoom: 2_000_000,
    });
    console.log(`Created room ${ROOM_ID} -> ${REPO_REF}, maintainer ${MAINTAINER.displayName}`);
  } else if (existingRoom.githubRepoRef !== REPO_REF) {
    await db.update(rooms).set({ githubRepoRef: REPO_REF }).where(eq(rooms.id, ROOM_ID));
    console.log(`Room ${ROOM_ID} already existed; relinked repo to ${REPO_REF}`);
  } else {
    console.log(`Room ${ROOM_ID} already set up, reusing it.`);
  }
}

// ---- draft parsing / classification --------------------------------------

// A 'payload-too-thin' cause used to be reported here whenever a non-rich arm
// failed to parse. That attribution was an artifact of the arm, not evidence:
// the notes did not differ meaningfully, so a parse failure never told us
// anything about the payload. What remains is the honest distinction between
// the model producing nothing usable and the pipeline refusing what it produced.
function classifyForkFailure(parseFailed: boolean): 'ingest-failure' | 'model-error' {
  return parseFailed ? 'model-error' : 'ingest-failure';
}

function slug(iteration: number, persona: Persona): string {
  return `stage0-${RUN_ID}-${iteration}-${persona.id.replace(CONTRIBUTOR_PREFIX, '')}`;
}

// ---- one iteration --------------------------------------------------------

async function runIteration(iteration: number): Promise<void> {
  const author = PERSONAS[iteration % PERSONAS.length];
  const forker = PERSONAS[(iteration + 1) % PERSONAS.length];
  const rec: IterationRecord = {
    iteration,
    author: author.displayName,
    forker: forker.displayName,
    originalPromoted: false,
    forkCreated: false,
    remixPromoted: false,
    adopted: false,
    tokensIn: 0,
    tokensOut: 0,
    notes: [],
  };
  metrics.iterationsAttempted += 1;

  const originalSlug = slug(iteration, author);
  const originalAsk = [
    `Draft one small, concrete improvement to this room's linked repo (${REPO_REF}), a night-market discovery web app.`,
    `Add exactly one new file at path "src/stage0/${originalSlug}.js" (never modify or add any other path,`,
    'never touch .github/, .git/, package.json, package-lock.json, or a root dotfile).',
    'Pick something small and genuinely useful: a formatting helper, a tiny UI microcopy function, a small utility.',
    'Follow the exact draft format from your instructions: an "Intent:" line, a fenced ```json files block, and a "Remix notes:" bullet list.',
  ].join(' ');

  const originalReply = await askAgent(author.id, originalAsk);
  rec.tokensIn += originalReply.tokensIn;
  rec.tokensOut += originalReply.tokensOut;
  if (originalReply.error) {
    rec.notes.push(`original ask failed: ${originalReply.error}`);
    recordDeadFork({ iteration, cause: 'model-error', detail: `original ask: ${originalReply.error}` });
    finish(rec);
    return;
  }

  const originalDraft = parseAgentDraft(originalReply.text);
  if (!originalDraft) {
    rec.notes.push('original ask produced no parseable draft');
    recordDeadFork({ iteration, cause: 'model-error', detail: 'no parseable draft from original ask' });
    finish(rec);
    return;
  }

  const promoteOriginal = await promoteProposal(author.id, {
    roomId: ROOM_ID,
    parentProposalIds: [],
    intentSummary: originalDraft.intentSummary || `Stage 0 iteration ${iteration}: small improvement`,
    diffRef: originalDraft.diffRef,
    baseRef: 'main',
    headCommit: 'stage0-pending',
    remixNote: harnessRemixNote(),
  });

  if (promoteOriginal.status !== 201) {
    const errMsg = JSON.stringify(promoteOriginal.json).slice(0, 300);
    rec.notes.push(`original promote failed (${promoteOriginal.status}): ${errMsg}`);
    // remixNote.ts now allows empty or 1-6 bullets, so a real single-bullet
    // "thin" note (as the validation protocol specifies) is valid input and
    // no longer expected to fail here on bullet count alone. Any promote
    // failure at this point is recorded as an ingest-failure so its actual
    // cause is visible in the results rather than assumed.
    recordDeadFork({ iteration, cause: 'ingest-failure', detail: `original promote: ${errMsg}` });
    finish(rec);
    return;
  }

  rec.originalPromoted = true;
  rec.originalProposalId = promoteOriginal.json.proposal.id;
  rec.originalPrUrl = promoteOriginal.json.version.prUrl ?? undefined;
  if (promoteOriginal.json.version.prNumber != null) metrics.prsOpened += 1;

  const originalProposalId: string = promoteOriginal.json.proposal.id;
  const originalVersionId: string = promoteOriginal.json.version.versionId;
  const originalBranch = `proposal/${originalProposalId}`;

  // ---- fork ----
  const forkResult = await apiCall('/api/fork', 'POST', forker.id, {
    proposalId: originalProposalId,
    proposalVersionId: originalVersionId,
  });

  if (forkResult.status !== 201) {
    const errMsg = JSON.stringify(forkResult.json).slice(0, 300);
    rec.notes.push(`fork failed (${forkResult.status}): ${errMsg}`);
    recordDeadFork({ iteration, cause: 'ingest-failure', detail: `fork: ${errMsg}` });
    finish(rec);
    return;
  }

  rec.forkCreated = true;
  metrics.forksCreated += 1;
  const bundle = forkResult.json.bundle;

  const remixSlug = slug(iteration, forker);
  const remixAsk = [
    'Here is a fork bundle for a proposal you are remixing (the five parts: artifact, base commit, lineage, intent summary, remix note):',
    '```json',
    JSON.stringify(bundle, null, 2),
    '```',
    `Improve on it with one small additional change to the SAME file the bundle's artifact touches (path under src/stage0/${originalSlug}.js).`,
    'Use changeType "modify" with that exact path and produce the complete new file content (not a patch fragment).',
    'Follow the exact draft format from your instructions: an "Intent:" line, a fenced ```json files block, and a "Remix notes:" bullet list.',
    `(Working note for you only, not part of the diff: your own slug is ${remixSlug}.)`,
  ].join('\n');

  const remixReply = await askAgent(forker.id, remixAsk);
  rec.tokensIn += remixReply.tokensIn;
  rec.tokensOut += remixReply.tokensOut;
  if (remixReply.error) {
    rec.notes.push(`remix ask failed: ${remixReply.error}`);
    recordDeadFork({
      iteration,
      cause: classifyForkFailure(true),
      detail: `remix ask: ${remixReply.error}`,
    });
    finish(rec);
    return;
  }

  const remixDraft = parseAgentDraft(remixReply.text);
  if (!remixDraft) {
    rec.notes.push('remix ask produced no parseable draft');
    recordDeadFork({
      iteration,
      cause: classifyForkFailure(true),
      detail: 'no parseable draft from remix ask',
    });
    finish(rec);
    return;
  }

  const promoteRemix = await promoteProposal(forker.id, {
    roomId: ROOM_ID,
    parentProposalIds: [originalProposalId],
    intentSummary: remixDraft.intentSummary || `Stage 0 iteration ${iteration}: remix`,
    diffRef: remixDraft.diffRef,
    baseRef: originalBranch,
    headCommit: 'stage0-pending',
    remixNote: { bullets: [], generatedBy: 'agent-draft', authorEdited: false },
  });

  if (promoteRemix.status !== 201) {
    const errMsg = JSON.stringify(promoteRemix.json).slice(0, 300);
    rec.notes.push(`remix promote failed (${promoteRemix.status}): ${errMsg}`);
    recordDeadFork({
      iteration,
      cause: classifyForkFailure(false),
      detail: `remix promote: ${errMsg}`,
    });
    finish(rec);
    return;
  }

  rec.remixPromoted = true;
  rec.remixProposalId = promoteRemix.json.proposal.id;
  rec.remixPrUrl = promoteRemix.json.version.prUrl ?? undefined;
  if (promoteRemix.json.version.prNumber != null) metrics.prsOpened += 1;

  // ---- adopt: alternate which of the two is adopted so both the plain
  // proposal path and the remix-with-lineage path get exercised. ----
  const adoptOriginal = iteration % 2 === 0;
  const adoptTargetProposalId = adoptOriginal ? originalProposalId : promoteRemix.json.proposal.id;
  const adoptTargetVersionId = adoptOriginal ? originalVersionId : promoteRemix.json.version.versionId;

  const adoptResult = await apiCall('/api/adopt', 'POST', MAINTAINER.id, {
    proposalId: adoptTargetProposalId,
    proposalVersionId: adoptTargetVersionId,
    roomId: ROOM_ID,
  });

  if (adoptResult.status !== 201) {
    const errMsg = JSON.stringify(adoptResult.json).slice(0, 300);
    rec.notes.push(`adopt failed (${adoptResult.status}): ${errMsg}`);
  } else {
    rec.adopted = true;
    rec.adoptedWhich = adoptOriginal ? 'original' : 'remix';
    metrics.adoptions += 1;
    metrics.prsMerged += 1;
  }

  finish(rec);
}

function finish(rec: IterationRecord) {
  metrics.totalTokensIn += rec.tokensIn;
  metrics.totalTokensOut += rec.tokensOut;
  if (rec.originalPromoted && rec.forkCreated && rec.remixPromoted && rec.adopted) {
    metrics.iterationsFullyCompleted += 1;
  }
  metrics.iterations.push(rec);
  const chain = [
    rec.originalPromoted ? 'promote-ok' : 'promote-FAIL',
    rec.forkCreated ? 'fork-ok' : 'fork-skip',
    rec.remixPromoted ? 'remix-ok' : 'remix-skip',
    rec.adopted ? `adopt-ok(${rec.adoptedWhich})` : 'adopt-skip',
  ].join(' -> ');
  console.log(`  iteration ${rec.iteration} ${rec.author} -> ${rec.forker}: ${chain}`);
  for (const n of rec.notes) console.log(`    note: ${n}`);
}

// ---- cleanup ----------------------------------------------------------

async function cleanup(): Promise<void> {
  console.log(`Cleaning up stage0 rows in room ${ROOM_ID}...`);
  const roomProposals = await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.roomId, ROOM_ID));
  for (const p of roomProposals) {
    await db.delete(forks).where(eq(forks.proposalId, p.id));
    await db.delete(adoptions).where(eq(adoptions.proposalId, p.id));
    await db.delete(proposalVersions).where(eq(proposalVersions.proposalId, p.id));
  }
  await db.delete(proposals).where(eq(proposals.roomId, ROOM_ID));

  const sessions = await db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.roomId, ROOM_ID));
  for (const s of sessions) {
    await db.delete(agentUsageReservations).where(eq(agentUsageReservations.sessionId, s.id));
    await db.delete(agentMessages).where(eq(agentMessages.sessionId, s.id));
  }
  await db.delete(agentSessions).where(eq(agentSessions.roomId, ROOM_ID));

  console.log('Note: closing open stage0 PRs on GitHub is not automated here (no PR list was retained');
  console.log('across runs); close any open proposal/* PRs on the linked repo by hand if needed.');
  console.log('Room and contributor rows are left in place by default; delete manually if desired.');
}

// ---- main ---------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const iterFlagIdx = args.indexOf('--iterations');
  const iterations = iterFlagIdx >= 0 ? Number(args[iterFlagIdx + 1]) : 12;
  const doCleanup = args.includes('--cleanup');

  if (doCleanup) {
    await cleanup();
    process.exit(0);
  }

  console.log(`Stage 0 agent smoke test: ${iterations} iteration(s) against ${BASE_URL}`);
  await ensureSetup();
  await assertMaintainerIdentity();

  for (let i = 0; i < iterations; i++) {
    await runIteration(i);
  }

  metrics.totalCostUsd = metrics.totalTokensIn * PROMPT_USD_PER_TOKEN + metrics.totalTokensOut * COMPLETION_USD_PER_TOKEN;

  const outPath = path.resolve(__dirname, '..', 'stage0-results.json');
  writeFileSync(outPath, JSON.stringify(metrics, null, 2));

  console.log('\n=== Stage 0 summary ===');
  console.log(`Iterations attempted: ${metrics.iterationsAttempted}`);
  console.log(`Iterations fully completed (promote+fork+remix+adopt): ${metrics.iterationsFullyCompleted}`);
  console.log(`PRs opened: ${metrics.prsOpened}, merged: ${metrics.prsMerged}`);
  console.log(`Forks created: ${metrics.forksCreated}`);
  console.log(`Adoptions: ${metrics.adoptions}`);
  console.log('Dead forks by cause:');
  const causeCounts: Record<string, number> = {};
  for (const d of metrics.deadForks) causeCounts[d.cause] = (causeCounts[d.cause] ?? 0) + 1;
  for (const [cause, count] of Object.entries(causeCounts)) console.log(`  ${cause}: ${count}`);
  console.log(`Tokens in: ${metrics.totalTokensIn}, out: ${metrics.totalTokensOut}`);
  console.log(`Estimated cost: $${metrics.totalCostUsd.toFixed(4)} total, $${(metrics.totalCostUsd / Math.max(metrics.iterationsAttempted, 1)).toFixed(4)}/iteration`);
  if (metrics.httpErrors.length > 0) {
    console.log('HTTP errors by route/status:');
    for (const e of metrics.httpErrors) console.log(`  ${e.route} ${e.status}: ${e.count}`);
  } else {
    console.log('HTTP errors: none');
  }
  console.log(`\nFull results written to ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
