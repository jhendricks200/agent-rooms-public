// Curates the seeded demonstration room required by
// docs/design/promote-provenance.md ("a seeded demonstration room, populated
// before any tester is recruited") and ADR 0003, out of the real chains the
// Stage 0 agent smoke test produced (the validation protocol,
// Stage 0 section: "their best promote, fork, remix, adopt chains are curated
// into the seeded demonstration room, so Stage 0 and the demo room are one
// artifact built once, not two").
//
// This replaces the hand-written Night Market fixture that scripts/seed.ts
// created. The difference that matters: every card in this room is backed by
// a real pull request on a real repository, a real head commit, and, where
// adopted, a real merge commit. Nothing about the provenance is invented.
//
// What IS authored here, and must be understood as authored: the room chat
// and the Q&A exchanges. The Stage 0 agents did not talk to each other, so
// the narration that makes the loop legible to a first-time visitor is
// written fiction placed on a real timeline. That is precisely why the room
// is named "(demo)" and opens with a notice from a non-person contributor
// saying so. A demonstration room that reads as a live team is a lie the
// product cannot afford, since it is the first thing a new participant sees.
//
// Run with: npm run demo:curate
//
// Two follow-up steps touch the running app rather than the database, and
// are opt-in because one of them closes a real pull request on GitHub:
//   npm run demo:curate -- --live-fork   creates a real Fork row via POST /api/fork
//   npm run demo:curate -- --reject      closes a real PR via POST /api/proposals/[id]/reject
// Both require the dev server running with DEV_IDENTITY_FALLBACK=1 and
// STAGE0_IDENTITY_OVERRIDE=1 in the SERVER process environment, the same way
// scripts/stage0.ts does.
//
// Idempotent: re-running the database step is safe. It is authoritative for
// the room, so any proposal sitting in the demo room that is not in the
// curated set below is torn down.

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import {
  rooms,
  contributors,
  proposals,
  proposalVersions,
  forks,
  qaExchanges,
  adoptions,
  messages,
  agentSessions,
  agentMessages,
  agentUsageReservations,
} from '../src/db/schema';
import { STAGE0_IDENTITY_HEADER } from '../src/lib/session';

const DEMO_ROOM_ID = 'night-market';
const DEMO_ROOM_NAME = 'Night Market (demo)';
// The real repository every one of these pull requests was opened against.
// scripts/seed.ts used the placeholder 'nightmarket/app', whose PR links went
// nowhere; a demonstration room whose links 404 teaches the wrong lesson.
const REAL_REPO_REF = 'Agent-Rooms/agent-rooms-nightmarket';

const BASE_URL = process.env.STAGE0_BASE_URL ?? 'http://localhost:3000';

// Nova is the Stage 0 maintainer and performed every adoption in this data,
// so the roster has to include her for the adoption records to be coherent.
// The second entry is the real GitHub-linked operator account, so a signed-in
// human can actually run the room.
const MAINTAINER_PERSONA = 'contributor_p0_nova';
const OPERATOR_CONTRIBUTOR = 'contributor_bf993878-fc45-4034-a227-c7a95e392efa';

// Not a person, and named so a visitor can tell. Authors the notice that the
// room is a demonstration.
const HOST = { id: 'contributor_demo_host', displayName: 'Agent Rooms' };

const P = {
  nova: 'contributor_p0_nova',
  kai: 'contributor_p0_kai',
  rosa: 'contributor_p0_rosa',
  theo: 'contributor_p0_theo',
  yuki: 'contributor_p0_yuki',
} as const;

// ---------------------------------------------------------------------------
// The curated set.
//
// Five complete chains out of the twelve the clean Stage 0 run produced
// (pull requests 67 through 90 on the repo above; app/stage0-results.json is
// the run record). Selection was driven by three constraints:
//
// 1. State coverage. The set has to show adoption WITH lineage (a remix that
//    landed, crediting its origin), adoption WITHOUT lineage (an origin that
//    landed on its own), work still open and forkable, and a rejection. Three
//    chains here landed as the remix, two landed as the origin.
//
// 2. Exactly one "rich" remix note. Stage 0's rich arm emits the same five
//    canned bullets on every proposal ("Kept the existing file layout...").
//    They are generic and say nothing about the specific change. Showing three
//    such cards would teach a visitor that remix notes are filler, so only
//    chain 3 carries one. The notes are NOT rewritten: published versions are
//    frozen by the migration-0007 trigger, and using the escape hatch to
//    improve the text would be fabricating provenance content.
//
// 3. Topic spread. Every Stage 0 proposal is a vendor-display string helper,
//    so chains were picked to be visibly about different things rather than
//    five variations on the same formatter.
// ---------------------------------------------------------------------------
type Chain = {
  label: string;
  origin: { id: string; pr: number; author: string; note: 'rich' | 'thin' | 'none'; state: 'open' | 'adopted' };
  remix: { id: string; pr: number; author: string; state: 'open' | 'adopted' };
};

const CHAINS: Chain[] = [
  {
    label: 'price tiers — origin adopted, remix still open',
    origin: { id: 'proposal_360d0df6-5071-42a4-9ceb-274f6bc5c772', pr: 71, author: P.rosa, note: 'none', state: 'adopted' },
    remix: { id: 'proposal_ddddbfc6-dddf-4d35-b52a-97625c86cbde', pr: 72, author: P.theo, state: 'open' },
  },
  {
    label: 'response time — the hero chain: rich note, remix adopted with lineage',
    origin: { id: 'proposal_7f302551-0fa8-450d-a748-f309c26cd8b9', pr: 73, author: P.theo, note: 'rich', state: 'open' },
    remix: { id: 'proposal_c697ce7d-1b30-4d67-9cc1-1d132941f1f4', pr: 74, author: P.yuki, state: 'adopted' },
  },
  {
    label: 'average rating — origin adopted on a one-line note, remix open and forked live',
    origin: { id: 'proposal_ccd337d5-9011-42ba-a88d-963d6e524ca5', pr: 75, author: P.yuki, note: 'thin', state: 'adopted' },
    remix: { id: 'proposal_1f2c2c2c-2b4f-4a2d-8f42-a49ab8f1d0f2', pr: 76, author: P.nova, state: 'open' },
  },
  {
    label: 'wait time — one-line note, remix adopted with lineage',
    origin: { id: 'proposal_b3b10641-209e-4c45-b59a-b4a4ef9bfe5a', pr: 81, author: P.rosa, note: 'thin', state: 'open' },
    remix: { id: 'proposal_afe85eaa-38bd-442e-b0d4-ef23aadf25a6', pr: 82, author: P.theo, state: 'adopted' },
  },
  {
    label: 'popularity badge — no note anywhere, remix adopted with lineage',
    origin: { id: 'proposal_2822ddec-69ad-4c98-8dfe-e88a98832d09', pr: 89, author: P.kai, note: 'none', state: 'open' },
    remix: { id: 'proposal_a0743116-8327-4518-89d4-bd0aa3e94a65', pr: 90, author: P.rosa, state: 'adopted' },
  },
];

// The rejection. Stage 0 adopted one side of every chain and rejected nothing,
// so a rejected card cannot be curated out of the clean run at all. This is a
// real leftover proposal from an earlier Stage 0 run (pull request 21, still
// open on GitHub), parentless so it drags no out-of-room lineage with it, and
// on a topic none of the five chains covers. It is rejected through the real
// reject route, which closes the pull request for real. Nothing is faked: the
// card says rejected because the proposal is rejected and the PR is closed.
const REJECT_TARGET = {
  id: 'proposal_356f08fe-86b6-47ba-91c0-2b6d488c6c51',
  pr: 21,
  author: P.kai,
};

// The live fork. The room page marks one card "fork live": the newest Fork
// whose proposal is still open. Every existing fork in the Stage 0 data sits
// on an origin whose remix has ALREADY been adopted, so reusing one would
// render "X is forking Y's proposal" for work that finished weeks ago. Instead
// a genuinely new fork is created, through the real API, on an open remix that
// nobody has promoted from. The fork route records a Fork event and returns
// the bundle; it makes no GitHub call, so this is not an outward-facing write.
const LIVE_FORK = {
  proposalId: 'proposal_1f2c2c2c-2b4f-4a2d-8f42-a49ab8f1d0f2', // PR 76, Nova's open remix
  byContributorId: P.theo,
};

const CURATED_PROPOSAL_IDS = [
  ...CHAINS.flatMap((c) => [c.origin.id, c.remix.id]),
  REJECT_TARGET.id,
];

// ---------------------------------------------------------------------------
// Authored narration.
//
// Timestamps are placed against the real publish times of the cards they refer
// to, so the stream reads as a session rather than a block of commentary. The
// events are real; this conversation about them is not, and the opening notice
// says so.
// ---------------------------------------------------------------------------
const at = (hhmmss: string) => new Date(`2026-07-24T${hhmmss}-04:00`);

const CHAT: { id: string; author: string; at: Date; body: string }[] = [
  {
    id: 'demo_msg_00_notice',
    author: HOST.id,
    at: at('19:30:00'),
    body:
      'This is a recorded demonstration room. The five builders in it are seeded personas from the Stage 0 agent smoke test, not people you can reach. Everything underneath them is real: every proposal here opened a pull request on Agent-Rooms/agent-rooms-nightmarket, every adoption merged one with the head commit pinned, and every hash on every card is the hash that was actually recorded. The chat is written narration over those real events.',
  },
  {
    id: 'demo_msg_01',
    author: P.nova,
    at: at('19:37:04'),
    body:
      'Closing Kai’s category formatter without merging it. It re-implements the tag formatter that is already on main, and there is no note saying why a second one is needed. Kai, fork the existing file and reopen it as a remix — the credit chain still carries your name that way.',
  },
  {
    id: 'demo_msg_02',
    author: P.kai,
    at: at('19:37:52'),
    body:
      'Fair. My agent never saw the existing file, so it wrote its own. That is the actual failure, not the code.',
  },
  {
    id: 'demo_msg_03',
    author: P.rosa,
    at: at('19:38:20'),
    body: 'Which is the argument for forking rather than starting clean. You inherit what the last person already decided.',
  },
  {
    id: 'demo_msg_04',
    author: P.rosa,
    at: at('20:16:44'),
    body:
      'Promoted the price-tier formatter with no remix note at all. Nothing about it needed explaining and the diff is the whole story. An empty note is a normal answer here, not a skipped step.',
  },
  {
    id: 'demo_msg_05',
    author: P.theo,
    at: at('20:17:06'),
    body: 'Forked it anyway for the emoji tiers and the hybrid “$–$$” ranges. Mine is still open if someone wants to push it further.',
  },
  {
    id: 'demo_msg_06',
    author: P.theo,
    at: at('20:17:44'),
    body:
      'New one: the response-time helper. This one got a real note, five bullets, because the rounding thresholds are decisions and none of them are visible in the diff.',
  },
  {
    id: 'demo_msg_07',
    author: P.yuki,
    at: at('20:18:08'),
    body:
      'My agent read Theo’s note before it touched the file and quoted the rounding bullet back at me. The prefix option exists because of that note, not because of the code.',
  },
  {
    id: 'demo_msg_08',
    author: P.nova,
    at: at('20:18:18'),
    body:
      'Merged Yuki’s remix rather than Theo’s original. Look at the credit chain on that card: Theo as origin, Yuki as remix, then the room. Theo’s version is still open and still forkable.',
  },
  {
    id: 'demo_msg_09',
    author: P.yuki,
    at: at('20:18:34'),
    body: 'Rating formatter next, one line of note. Sometimes one line is the honest amount.',
  },
  {
    id: 'demo_msg_10',
    author: P.nova,
    at: at('20:18:56'),
    body: 'Forked yours for the locale labels. Still open.',
  },
  {
    id: 'demo_msg_11',
    author: P.rosa,
    at: at('20:21:32'),
    body: 'Wait-time formatter, one-line note.',
  },
  {
    id: 'demo_msg_12',
    author: P.theo,
    at: at('20:22:00'),
    body: 'Remixed the buckets. The 46-to-59 minute case was rounding up to a full hour, which reads as much worse than it is.',
  },
  {
    id: 'demo_msg_13',
    author: P.kai,
    at: at('20:25:02'),
    body: 'Popularity badge. No note on this one either.',
  },
  {
    id: 'demo_msg_14',
    author: P.rosa,
    at: at('20:25:22'),
    body: 'Added the peak-hour icon on top of Kai’s and fixed the zero case. Kai’s name is on the merge through the chain.',
  },
  {
    id: 'demo_msg_15',
    author: P.nova,
    at: at('20:26:10'),
    body:
      'Five chains, five merges, and three of them landed as somebody’s remix rather than the original. Everything still marked open is forkable right now.',
  },
];

const QA: { id: string; proposalId: string; question: string; askedBy: string; answer: string | null; answeredBy: string | null; at: Date }[] = [
  {
    // The room page sources a rejected card's "why this did not land" note from
    // the first answered Q&A row on that proposal. The reject route accepts an
    // optional `note` field but never persists it, so this row IS the reason.
    id: 'demo_qa_reject_1',
    proposalId: REJECT_TARGET.id,
    question: 'Is this a second implementation of the tag formatter that is already on main?',
    askedBy: P.rosa,
    answer:
      'Yes, and that is why it is closed rather than merged. Fork the existing file and reopen it as a remix; the lineage will still credit you for the change.',
    answeredBy: P.nova,
    at: at('19:36:50'),
  },
  {
    id: 'demo_qa_73_1',
    proposalId: CHAINS[1].origin.id,
    question: 'Does the rounding bullet mean I should leave the thresholds alone, or that I should not move them silently?',
    askedBy: P.yuki,
    answer: 'Not silently. Move them if they are wrong, and say which ones in your own note so the next person is not guessing.',
    answeredBy: P.theo,
    at: at('20:17:56'),
  },
  {
    // Deliberately unanswered. A real open question is part of what the room
    // looks like; a demo where every thread is resolved teaches the wrong thing.
    id: 'demo_qa_73_2',
    proposalId: CHAINS[1].origin.id,
    question: 'Any reason this lives in its own file instead of the shared formatter module?',
    askedBy: P.kai,
    answer: null,
    answeredBy: null,
    at: at('20:19:30'),
  },
  {
    id: 'demo_qa_72_1',
    proposalId: CHAINS[0].remix.id,
    question: 'Were the hybrid ranges falling through to the strict lookup before this?',
    askedBy: P.nova,
    answer: 'They were, which is why the range match had to move ahead of it.',
    answeredBy: P.theo,
    at: at('20:17:24'),
  },
];

// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(msg);
}

async function preflight() {
  const rows = await db
    .select({
      proposalId: proposals.id,
      roomId: proposals.roomId,
      state: proposals.state,
      versionId: proposalVersions.versionId,
      status: proposalVersions.status,
      prNumber: proposalVersions.prNumber,
    })
    .from(proposals)
    .innerJoin(proposalVersions, eq(proposalVersions.proposalId, proposals.id))
    .where(inArray(proposals.id, CURATED_PROPOSAL_IDS));

  const byId = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byId.get(r.proposalId) ?? [];
    list.push(r);
    byId.set(r.proposalId, list);
  }

  const problems: string[] = [];
  for (const id of CURATED_PROPOSAL_IDS) {
    const versions = byId.get(id);
    if (!versions || versions.length === 0) {
      problems.push(`${id}: no such proposal, or it has no version rows`);
      continue;
    }
    const published = versions.filter((v) => v.status === 'published');
    if (published.length === 0) {
      problems.push(`${id}: no published version (the proposal page 404s without one)`);
      continue;
    }
    if (published.every((v) => v.prNumber == null)) {
      problems.push(`${id}: published version has no prNumber, so its provenance is not backed by a real PR`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Preflight failed. The curated set does not match the database:\n  ${problems.join('\n  ')}\n` +
        'This script hardcodes the proposal ids of a specific Stage 0 run (pull requests 67-90, ' +
        'recorded in app/stage0-results.json). If that run was cleaned up, the set has to be re-picked.',
    );
  }

  log(`Preflight OK: all ${CURATED_PROPOSAL_IDS.length} curated proposals have a published, PR-backed version.`);
}

async function ensureHostContributor() {
  await db
    .insert(contributors)
    .values({ id: HOST.id, displayName: HOST.displayName, linkedDiscordId: null, linkedGithubId: null })
    .onConflictDoNothing();
}

async function ensureRoom() {
  const [existing] = await db.select().from(rooms).where(eq(rooms.id, DEMO_ROOM_ID)).limit(1);
  const maintainers = [MAINTAINER_PERSONA, OPERATOR_CONTRIBUTOR];

  if (!existing) {
    await db.insert(rooms).values({
      id: DEMO_ROOM_ID,
      name: DEMO_ROOM_NAME,
      discordChannelRef: 'discord:night-market',
      githubRepoRef: REAL_REPO_REF,
      maintainers,
      adoptionAuthority: 'maintainers',
      createdBy: MAINTAINER_PERSONA,
      license: 'MIT',
      tokenBudgetPerUser: 200_000,
      tokenBudgetPerRoom: 2_000_000,
    });
    log(`Created room "${DEMO_ROOM_ID}" pointing at ${REAL_REPO_REF}.`);
    return;
  }

  await db
    .update(rooms)
    .set({ name: DEMO_ROOM_NAME, githubRepoRef: REAL_REPO_REF, maintainers })
    .where(eq(rooms.id, DEMO_ROOM_ID));
  log(`Updated room "${DEMO_ROOM_ID}": name "${DEMO_ROOM_NAME}", repo ${REAL_REPO_REF}, maintainers ${maintainers.join(', ')}.`);
}

// Tears down anything in the demo room that is not part of the curated set.
// This is what removes scripts/seed.ts's six hand-written proposals, and it
// keeps the script authoritative for the room on every re-run. Published
// versions are frozen by the migration-0007 trigger, so the deletes need the
// explicit session-scoped escape the trigger recognizes; only this script,
// scripts/seed.ts, and the test fixtures ever set it.
async function tearDownUncurated() {
  const present = await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.roomId, DEMO_ROOM_ID));
  const stale = present.map((p) => p.id).filter((id) => !CURATED_PROPOSAL_IDS.includes(id));

  if (stale.length === 0) {
    log('No uncurated proposals in the demo room.');
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL "agent_rooms.allow_provenance_mutation" = 'on'`);
    for (const id of stale) {
      await tx.delete(qaExchanges).where(eq(qaExchanges.proposalId, id));
      await tx.delete(forks).where(eq(forks.proposalId, id));
      await tx.delete(adoptions).where(eq(adoptions.proposalId, id));
      await tx.delete(proposalVersions).where(eq(proposalVersions.proposalId, id));
    }
    await tx.delete(proposals).where(inArray(proposals.id, stale));
  });

  log(`Removed ${stale.length} uncurated proposal(s) from the demo room: ${stale.join(', ')}`);
}

// The private agent sidebar is per (contributor, room), and its transcript
// outlives the proposals it discussed. Left alone, a visitor opening the demo
// room finds a sidebar conversation about the previous fixture's repo and
// proposal ids, all of which are now gone. scripts/seed.ts clears these on
// every reseed for the same reason.
async function clearAgentSessions() {
  const sessions = await db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.roomId, DEMO_ROOM_ID));
  for (const s of sessions) {
    await db.delete(agentUsageReservations).where(eq(agentUsageReservations.sessionId, s.id));
    await db.delete(agentMessages).where(eq(agentMessages.sessionId, s.id));
  }
  await db.delete(agentUsageReservations).where(eq(agentUsageReservations.roomId, DEMO_ROOM_ID));
  await db.delete(agentSessions).where(eq(agentSessions.roomId, DEMO_ROOM_ID));
  if (sessions.length > 0) {
    log(`Cleared ${sessions.length} stale private agent session(s) for the demo room.`);
  }
}

// Re-parents the curated proposals into the demo room rather than copying
// them. A copy would mean two proposal_versions rows claiming the same pull
// request and the same head commit, which is exactly the kind of duplicated
// provenance the data model exists to prevent. The Stage 0 run record survives
// in app/stage0-results.json and in the seven remaining chains left behind in
// stage0-lab.
async function moveCuratedChains() {
  const moved = await db
    .update(proposals)
    .set({ roomId: DEMO_ROOM_ID })
    .where(inArray(proposals.id, CURATED_PROPOSAL_IDS))
    .returning({ id: proposals.id });

  // adoptions carry their own roomId, which has to follow the proposal or the
  // room page's adoption lookup (scoped by roomId) will not find them.
  const movedAdoptions = await db
    .update(adoptions)
    .set({ roomId: DEMO_ROOM_ID })
    .where(inArray(adoptions.proposalId, CURATED_PROPOSAL_IDS))
    .returning({ id: adoptions.id });

  log(`Moved ${moved.length} proposals and ${movedAdoptions.length} adoption records into "${DEMO_ROOM_ID}".`);
}

async function writeNarration() {
  await db.delete(messages).where(eq(messages.roomId, DEMO_ROOM_ID));
  await db.insert(messages).values(
    CHAT.map((m) => ({
      id: m.id,
      roomId: DEMO_ROOM_ID,
      authorContributorId: m.author,
      body: m.body,
      createdAt: m.at,
    })),
  );
  log(`Wrote ${CHAT.length} chat messages.`);

  await db.delete(qaExchanges).where(inArray(qaExchanges.id, QA.map((q) => q.id)));
  await db.insert(qaExchanges).values(
    QA.map((q) => ({
      id: q.id,
      proposalId: q.proposalId,
      question: q.question,
      askedBy: q.askedBy,
      answer: q.answer,
      answeredBy: q.answeredBy,
      createdAt: q.at,
    })),
  );
  const unanswered = QA.filter((q) => q.answer == null).length;
  log(`Wrote ${QA.length} Q&A exchanges (${unanswered} deliberately unanswered).`);
}

async function post(path: string, body: unknown, actingContributorId: string) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [STAGE0_IDENTITY_HEADER]: actingContributorId },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, json, text };
}

async function createLiveFork() {
  const existing = await db
    .select({ id: forks.id })
    .from(forks)
    .where(
      and(eq(forks.proposalId, LIVE_FORK.proposalId), eq(forks.byContributorId, LIVE_FORK.byContributorId)),
    );
  if (existing.length > 0) {
    log(`Live fork already exists (${existing[0].id}); skipping.`);
    return;
  }

  const [version] = await db
    .select({ versionId: proposalVersions.versionId })
    .from(proposalVersions)
    .where(eq(proposalVersions.proposalId, LIVE_FORK.proposalId));
  if (!version) throw new Error(`no published version for ${LIVE_FORK.proposalId}`);

  const res = await post(
    '/api/fork',
    { proposalId: LIVE_FORK.proposalId, proposalVersionId: version.versionId },
    LIVE_FORK.byContributorId,
  );

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`fork failed: ${res.status} ${res.text}`);
  }
  log(`Created a real fork on ${LIVE_FORK.proposalId} by ${LIVE_FORK.byContributorId}. This is the "fork live" card.`);
}

async function rejectTarget() {
  const [p] = await db.select().from(proposals).where(eq(proposals.id, REJECT_TARGET.id)).limit(1);
  if (!p) throw new Error(`reject target ${REJECT_TARGET.id} not found`);
  if (p.state === 'rejected') {
    log('Reject target is already rejected; skipping.');
    return;
  }
  if (p.roomId !== DEMO_ROOM_ID) {
    throw new Error('reject target is not in the demo room yet; run the database step first');
  }

  log(`Rejecting ${REJECT_TARGET.id} (pull request #${REJECT_TARGET.pr}). This CLOSES the pull request on ${REAL_REPO_REF}.`);
  const res = await post(
    `/api/proposals/${REJECT_TARGET.id}/reject`,
    { roomId: DEMO_ROOM_ID },
    MAINTAINER_PERSONA,
  );
  if (res.status !== 200) {
    throw new Error(`reject failed: ${res.status} ${res.text}`);
  }
  log('Rejected. The pull request is closed without merge and the card now reads "rejected".');
}

// ---------------------------------------------------------------------------
// Export / import.
//
// The curation step above cannot run against a production database. It
// re-parents rows produced by a Stage 0 run, and Stage 0 identifies its
// personas through a header override that src/lib/session.ts refuses unless
// NODE_ENV=development, so the chains can never be regenerated on a deployed
// server. That is deliberate, and it means the finished room has to move as
// data: --export writes a bundle from this machine, --import loads it into
// whatever DATABASE_URL points at.
//
// Inserting a published proposal_version is allowed without the provenance
// escape hatch, because the migration-0007 freeze trigger fires only on UPDATE
// and DELETE. Nothing here mutates provenance; it copies it verbatim.
// ---------------------------------------------------------------------------

const BUNDLE_VERSION = 1;

async function exportBundle(outPath: string) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, DEMO_ROOM_ID)).limit(1);
  if (!room) throw new Error(`room ${DEMO_ROOM_ID} not found; run the curation step first`);

  const proposalRows = await db.select().from(proposals).where(eq(proposals.roomId, DEMO_ROOM_ID));
  const ids = proposalRows.map((p) => p.id);
  if (ids.length === 0) throw new Error('demo room has no proposals to export');

  const versionRows = await db.select().from(proposalVersions).where(inArray(proposalVersions.proposalId, ids));
  const forkRows = await db.select().from(forks).where(inArray(forks.proposalId, ids));
  const adoptionRows = await db.select().from(adoptions).where(inArray(adoptions.proposalId, ids));
  // Messages and Q&A are exported by the ids this script owns, not by "whatever
  // is in the room". Local development types into the composer, and a stray
  // real message from whoever was signed in must not ride along into a bundle
  // that gets deployed. Anything skipped is reported, never dropped silently.
  const ownedMessageIds = CHAT.map((m) => m.id);
  const ownedQaIds = QA.map((q) => q.id);

  const allQa = await db.select().from(qaExchanges).where(inArray(qaExchanges.proposalId, ids));
  const qaRows = allQa.filter((q) => ownedQaIds.includes(q.id));

  const allMessages = await db.select().from(messages).where(eq(messages.roomId, DEMO_ROOM_ID));
  const messageRows = allMessages.filter((m) => ownedMessageIds.includes(m.id));

  const skippedMessages = allMessages.length - messageRows.length;
  const skippedQa = allQa.length - qaRows.length;
  if (skippedMessages > 0 || skippedQa > 0) {
    log(
      `Excluded ${skippedMessages} chat message(s) and ${skippedQa} Q&A row(s) not authored by this script ` +
        '(left in the local database, kept out of the bundle).',
    );
  }
  if (messageRows.length !== CHAT.length) {
    log(`WARNING: expected ${CHAT.length} authored messages, found ${messageRows.length}. Re-run the curation step.`);
  }

  // Every contributor the bundle references, so the import has no dangling FK.
  // Deliberately excludes the room's maintainer roster: see importBundle.
  const referenced = new Set<string>([
    ...proposalRows.map((p) => p.authorContributorId),
    ...forkRows.map((f) => f.byContributorId),
    ...adoptionRows.map((a) => a.adoptedByContributorId),
    ...messageRows.map((m) => m.authorContributorId),
    MAINTAINER_PERSONA,
    HOST.id,
  ]);
  const contributorRows = (
    await db.select().from(contributors).where(inArray(contributors.id, [...referenced]))
  ).map((c) => ({
    // A seeded persona must never be resolvable by a real GitHub account.
    // linkedGithubUserId is the identity key and NULL never matches a lookup,
    // so these are forced null on the way out rather than trusted to be null.
    ...c,
    linkedGithubUserId: null,
    linkedGithubId: null,
  }));

  const bundle = {
    bundleVersion: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    note:
      'Seeded demonstration room for Agent Rooms. Card provenance (PR numbers, base/head commits, ' +
      'content hashes, merge commits) is real and copied verbatim. Room chat and Q&A are authored ' +
      'narration over those real events; see scripts/curate-demo.ts.',
    room,
    contributors: contributorRows,
    proposals: proposalRows,
    proposalVersions: versionRows,
    forks: forkRows,
    adoptions: adoptionRows,
    qaExchanges: qaRows,
    messages: messageRows,
  };

  writeFileSync(outPath, JSON.stringify(bundle, null, 2));
  log(`Wrote bundle to ${outPath}`);
  log(
    `  ${contributorRows.length} contributors, ${proposalRows.length} proposals, ${versionRows.length} versions, ` +
      `${forkRows.length} forks, ${adoptionRows.length} adoptions, ${qaRows.length} Q&A, ${messageRows.length} messages`,
  );
}

// Rehydrates Date fields, which JSON.stringify flattened to ISO strings.
function withDates<T extends Record<string, unknown>>(row: T, fields: string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    if (typeof out[f] === 'string') out[f] = new Date(out[f] as string);
  }
  return out as T;
}

async function importBundle(inPath: string) {
  const raw = JSON.parse(readFileSync(inPath, 'utf8'));
  if (raw.bundleVersion !== BUNDLE_VERSION) {
    throw new Error(`bundle version ${raw.bundleVersion} does not match expected ${BUNDLE_VERSION}`);
  }

  const target = process.env.DATABASE_URL ?? '(unset)';
  const host = target.replace(/\/\/[^@]*@/, '//');
  log(`Importing into ${host}`);

  // Contributors first: proposals, forks, adoptions and messages all reference
  // them. onConflictDoNothing throughout, so a re-import is a no-op rather
  // than a partial overwrite.
  await db.insert(contributors).values(raw.contributors.map((c: Record<string, unknown>) => withDates(c, ['createdAt']))).onConflictDoNothing();

  // The roster is deliberately reduced to the persona maintainer. The operator's
  // contributor id is keyed to their immutable GitHub account id in the source
  // database only; a first sign-in on the target mints a different id, so an
  // imported roster naming the old one would grant authority to nobody and
  // silently lock the room. Bootstrap the real roster after signing in, with
  // `npm run room:maintainers -- <contributorId> night-market`.
  // tokenBudgetUsed is reset because usage is scoped to the target deployment.
  await db
    .insert(rooms)
    .values(withDates({ ...raw.room, maintainers: [MAINTAINER_PERSONA], tokenBudgetUsed: 0 }, ['createdAt']))
    .onConflictDoNothing();

  await db.insert(proposals).values(raw.proposals.map((r: Record<string, unknown>) => withDates(r, ['createdAt']))).onConflictDoNothing();
  await db.insert(proposalVersions).values(raw.proposalVersions.map((r: Record<string, unknown>) => withDates(r, ['publishedAt']))).onConflictDoNothing();
  await db.insert(forks).values(raw.forks.map((r: Record<string, unknown>) => withDates(r, ['createdAt']))).onConflictDoNothing();
  if (raw.adoptions.length > 0) {
    await db.insert(adoptions).values(raw.adoptions.map((r: Record<string, unknown>) => withDates(r, ['adoptedAt']))).onConflictDoNothing();
  }
  if (raw.qaExchanges.length > 0) {
    await db.insert(qaExchanges).values(raw.qaExchanges.map((r: Record<string, unknown>) => withDates(r, ['createdAt']))).onConflictDoNothing();
  }
  await db.insert(messages).values(raw.messages.map((r: Record<string, unknown>) => withDates(r, ['createdAt']))).onConflictDoNothing();

  log('Imported.');
  log(`Room maintainers set to [${MAINTAINER_PERSONA}] only. After signing in on the deployment, run:`);
  log(`  npm run room:maintainers -- <your-production-contributor-id> ${DEMO_ROOM_ID}`);
}

async function report() {
  const rows = await db
    .select({
      state: proposals.state,
      author: proposals.authorContributorId,
      pr: proposalVersions.prNumber,
      publishedAt: proposalVersions.publishedAt,
      intent: proposalVersions.intentSummary,
    })
    .from(proposals)
    .innerJoin(proposalVersions, eq(proposalVersions.proposalId, proposals.id))
    .where(eq(proposals.roomId, DEMO_ROOM_ID));

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.state] = (acc[r.state] ?? 0) + 1;
    return acc;
  }, {});

  log('');
  log('Demo room contents:');
  for (const [state, n] of Object.entries(counts).sort()) {
    log(`  ${state}: ${n}`);
  }
  log(`  chat messages: ${CHAT.length}`);
  log(`  Q&A exchanges: ${QA.length}`);
  log('');
  log(`Open it at ${BASE_URL}/room/${DEMO_ROOM_ID}`);
}

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${flag} requires a file path`);
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  const doLiveFork = args.includes('--live-fork');
  const doReject = args.includes('--reject');
  const httpOnly = args.includes('--http-only');
  const exportPath = argValue(args, '--export');
  const importPath = argValue(args, '--import');

  // Export and import are terminal modes: neither curates, and --import must
  // never be combined with the curation step, which assumes Stage 0 rows are
  // present locally and would tear down the freshly imported room.
  if (exportPath) {
    await exportBundle(exportPath);
    return;
  }
  if (importPath) {
    await importBundle(importPath);
    await report();
    return;
  }

  if (!httpOnly) {
    await preflight();
    await ensureHostContributor();
    await ensureRoom();
    await tearDownUncurated();
    await clearAgentSessions();
    await moveCuratedChains();
    await writeNarration();
  }

  if (doLiveFork) await createLiveFork();
  if (doReject) await rejectTarget();

  // Report against actual state rather than which flags were passed, so a
  // later database-only run does not tell you to redo work that is done.
  const [liveFork] = await db
    .select({ id: forks.id })
    .from(forks)
    .where(and(eq(forks.proposalId, LIVE_FORK.proposalId), eq(forks.byContributorId, LIVE_FORK.byContributorId)));
  const [rejected] = await db
    .select({ state: proposals.state })
    .from(proposals)
    .where(eq(proposals.id, REJECT_TARGET.id));

  const outstanding: string[] = [];
  if (!liveFork) {
    outstanding.push('  npm run demo:curate -- --http-only --live-fork   (database-only fork event, no GitHub call)');
  }
  if (rejected?.state !== 'rejected') {
    outstanding.push(`  npm run demo:curate -- --http-only --reject       (CLOSES pull request #${REJECT_TARGET.pr} on GitHub)`);
  }

  if (outstanding.length > 0) {
    log('');
    log('Still outstanding. These need the dev server running with DEV_IDENTITY_FALLBACK=1');
    log('and STAGE0_IDENTITY_OVERRIDE=1 in the SERVER process environment:');
    outstanding.forEach(log);
  }

  await report();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
