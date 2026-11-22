// Seeds the Night Market room from design/direction-c2.html (the blessed
// comp): 5 contributors, chat messages, and 6 proposals covering every
// proposal-card state the v0 UI renders - proposed, fork-live, adopted with
// full ceremony (a remix with lineage), a quiet adopted origin, and
// rejected - so the room demonstrates the promote/fork/adopt loop on first
// load, per docs/design/promote-provenance.md's "seeded demonstration room"
// requirement.
//
// Run with: npm run seed
// Idempotent: deletes any existing 'night-market' room and its rows first.

import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
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

const ROOM_ID = 'night-market';

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000);
const hoursAgo = (h: number) => new Date(now - h * 3_600_000);
const daysAgo = (d: number) => new Date(now - d * 86_400_000);

async function main() {
  console.log(`Seeding room "${ROOM_ID}"...`);

  // Clean slate: delete in FK-safe order if the room already exists.
  // Published proposal_versions are frozen by a database trigger
  // (migration 0007), so tearing down demo data needs the explicit,
  // session-scoped escape the trigger recognizes. No application code
  // ever sets it; only this script and the test fixtures do.
  const existing = await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.roomId, ROOM_ID));
  const existingIds = existing.map((p) => p.id);
  if (existingIds.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL "agent_rooms.allow_provenance_mutation" = 'on'`);
      for (const id of existingIds) {
        await tx.delete(qaExchanges).where(eq(qaExchanges.proposalId, id));
        await tx.delete(forks).where(eq(forks.proposalId, id));
        await tx.delete(adoptions).where(eq(adoptions.proposalId, id));
        await tx.delete(proposalVersions).where(eq(proposalVersions.proposalId, id));
      }
      await tx.delete(proposals).where(eq(proposals.roomId, ROOM_ID));
    });
  }
  await db.delete(messages).where(eq(messages.roomId, ROOM_ID));

  const existingSessions = await db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.roomId, ROOM_ID));
  for (const s of existingSessions) {
    await db.delete(agentUsageReservations).where(eq(agentUsageReservations.sessionId, s.id));
    await db.delete(agentMessages).where(eq(agentMessages.sessionId, s.id));
  }
  await db.delete(agentUsageReservations).where(eq(agentUsageReservations.roomId, ROOM_ID));
  await db.delete(agentSessions).where(eq(agentSessions.roomId, ROOM_ID));

  await db.delete(rooms).where(eq(rooms.id, ROOM_ID));

  const CONTRIBUTOR = {
    priya: 'contributor_priya',
    dele: 'contributor_dele',
    mara: 'contributor_mara',
    tomas: 'contributor_tomas',
    sana: 'contributor_sana',
  };

  for (const c of [
    { id: CONTRIBUTOR.priya, displayName: 'Priya Raman', linkedDiscordId: 'priya#0001', linkedGithubId: 'priyar' },
    { id: CONTRIBUTOR.dele, displayName: 'Dele Okafor', linkedDiscordId: 'dele#0002', linkedGithubId: 'deleo' },
    { id: CONTRIBUTOR.mara, displayName: 'Mara Jensen', linkedDiscordId: 'mara#0003', linkedGithubId: 'jensenm' },
    { id: CONTRIBUTOR.tomas, displayName: 'Tomás Rivera', linkedDiscordId: 'tomas#0004', linkedGithubId: 'triveraq' },
    { id: CONTRIBUTOR.sana, displayName: 'Sana Qureshi', linkedDiscordId: 'sana#0005', linkedGithubId: 'sanaq' },
  ]) {
    await db.insert(contributors).values(c).onConflictDoNothing();
  }

  await db.insert(rooms).values({
    id: ROOM_ID,
    name: 'Night Market',
    discordChannelRef: 'discord:night-market',
    githubRepoRef: 'nightmarket/app',
    maintainers: [CONTRIBUTOR.priya, CONTRIBUTOR.dele],
    adoptionAuthority: 'maintainers',
    createdBy: CONTRIBUTOR.priya,
    license: 'MIT',
    tokenBudgetPerUser: 200_000,
    tokenBudgetPerRoom: 2_000_000,
  });

  // ---- 1. Dele's origin: a quiet adoption, no lineage (adopted, no ceremony) ----
  const deleMapId = 'proposal_dele_map';
  await db.insert(proposals).values({
    id: deleMapId,
    roomId: ROOM_ID,
    authorContributorId: CONTRIBUTOR.dele,
    state: 'adopted',
    parentProposalIds: [],
    createdAt: daysAgo(3),
  });
  await db.insert(proposalVersions).values({
    versionId: 'version_dele_map_1',
    proposalId: deleMapId,
    intentSummary: 'Basic map view with stall pins',
    diffRef:
      '--- /dev/null\n+++ b/src/map/MapView.tsx\n@@ -0,0 +1,18 @@\n+export function MapView({ stalls }: { stalls: Stall[] }) {\n+  return (\n+    <MapCanvas>\n+      {stalls.map((s) => (\n+        <Pin key={s.id} lat={s.lat} lng={s.lng} />\n+      ))}\n+    </MapCanvas>\n+  );\n+}\n',
    baseRef: 'main',
    baseSha: '9b7e310a1c2d3e4f5061728394a5b6c7d8e9f0a1',
    headCommit: 'a3d91be1234567890abcdef1234567890abcdef',
    contentHash: 'a3d91bea3d91bea3d91bea3d91bea3d91bea3d91bea3d91bea3d91bea3d91be',
    status: 'published',
    remixNote: { bullets: [], generatedBy: 'agent-draft', authorEdited: false, lengthCapped: true },
    publishedAt: daysAgo(3),
  });
  await db.insert(adoptions).values({
    id: 'adoption_dele_map',
    proposalId: deleMapId,
    proposalVersionId: 'version_dele_map_1',
    roomId: ROOM_ID,
    adoptedByContributorId: CONTRIBUTOR.priya,
    expectedHeadCommit: 'a3d91be1234567890abcdef1234567890abcdef',
    mergeResult: 'merged',
    status: 'merged',
    adoptionReceiptRef: 'receipt_dele_map',
    adoptedAt: daysAgo(3),
  });

  // ---- 2. Mara's remix: adopted with full ceremony (banner, lineage, credit line) ----
  const maraClusterId = 'proposal_mara_cluster';
  await db.insert(proposals).values({
    id: maraClusterId,
    roomId: ROOM_ID,
    authorContributorId: CONTRIBUTOR.mara,
    state: 'adopted',
    parentProposalIds: [deleMapId],
    createdAt: minutesAgo(20),
  });
  await db.insert(proposalVersions).values({
    versionId: 'version_mara_cluster_1',
    proposalId: maraClusterId,
    intentSummary: 'Stall map with pin clustering',
    diffRef:
      '--- a/src/map/MapView.tsx\n+++ b/src/map/MapView.tsx\n@@ -1,9 +1,14 @@\n-export function MapView({ stalls }: { stalls: Stall[] }) {\n+export function MapView({ stalls }: { stalls: Stall[] }) {\n+  const clusters = useSuperclusterIndex(stalls);\n   return (\n     <MapCanvas>\n-      {stalls.map((s) => (\n-        <Pin key={s.id} lat={s.lat} lng={s.lng} />\n-      ))}\n+      {clusters.map((c) =>\n+        c.isCluster ? (\n+          <ClusterPin key={c.id} count={c.count} lat={c.lat} lng={c.lng} />\n+        ) : (\n+          <Pin key={c.id} lat={c.lat} lng={c.lng} />\n+        ),\n+      )}\n     </MapCanvas>\n   );\n }\n',
    baseRef: 'main',
    baseSha: 'a3d91be1234567890abcdef1234567890abcdef',
    headCommit: '7c02f4d1234567890abcdef1234567890abcdef',
    contentHash: '7c02f4d7c02f4d7c02f4d7c02f4d7c02f4d7c02f4d7c02f4d7c02f4d7c02f4d7',
    status: 'published',
    remixNote: {
      bullets: [
        "Kept Dele's tile layer and stall pin design exactly as shipped.",
        'Replaced the flat pin list with supercluster indexing.',
        'Moved stall fetches from mount-time to viewport intersection.',
        'Cold load dropped from 3.1s to 0.9s on the Taipei dataset.',
      ],
      generatedBy: 'agent-draft',
      authorEdited: true,
      lengthCapped: true,
    },
    publishedAt: minutesAgo(20),
  });
  await db.insert(adoptions).values({
    id: 'adoption_mara_cluster',
    proposalId: maraClusterId,
    proposalVersionId: 'version_mara_cluster_1',
    roomId: ROOM_ID,
    adoptedByContributorId: CONTRIBUTOR.dele,
    expectedHeadCommit: 'e41f8c21234567890abcdef1234567890abcdef',
    mergeResult: 'merged',
    status: 'merged',
    adoptionReceiptRef: 'receipt_mara_cluster',
    adoptedAt: minutesAgo(18),
  });

  // ---- 3. Priya's proposal: open, forked twice (demonstrates fork count + Q&A) ----
  const priyaHoursId = 'proposal_priya_hours';
  await db.insert(proposals).values({
    id: priyaHoursId,
    roomId: ROOM_ID,
    authorContributorId: CONTRIBUTOR.priya,
    state: 'open',
    parentProposalIds: [],
    createdAt: hoursAgo(1),
  });
  await db.insert(proposalVersions).values({
    versionId: 'version_priya_hours_1',
    proposalId: priyaHoursId,
    intentSummary: 'Open-hours model for vendors',
    diffRef:
      '--- /dev/null\n+++ b/src/hours/schedule.ts\n@@ -0,0 +1,12 @@\n+export interface OpenHours {\n+  seasonalWindows: Window[];\n+  weatherClosures: boolean;\n+  looseOpen: string; // "6pm ish"\n+  confidence: number; // "open now, probably"\n+}\n',
    baseRef: 'main',
    baseSha: 'e41f8c21234567890abcdef1234567890abcdef',
    headCommit: 'f5a6b7c1234567890abcdef1234567890abcdef',
    contentHash: 'f5a6b7cf5a6b7cf5a6b7cf5a6b7cf5a6b7cf5a6b7cf5a6b7cf5a6b7cf5a6b7cf',
    status: 'published',
    remixNote: { bullets: [], generatedBy: 'agent-draft', authorEdited: false, lengthCapped: true },
    publishedAt: hoursAgo(1),
  });
  await db.insert(forks).values([
    {
      id: 'fork_tomas_on_hours',
      proposalId: priyaHoursId,
      proposalVersionId: 'version_priya_hours_1',
      byContributorId: CONTRIBUTOR.tomas,
      createdAt: minutesAgo(50),
    },
    {
      id: 'fork_sana_on_hours',
      proposalId: priyaHoursId,
      proposalVersionId: 'version_priya_hours_1',
      byContributorId: CONTRIBUTOR.sana,
      createdAt: minutesAgo(45),
    },
  ]);
  await db.insert(qaExchanges).values([
    {
      id: 'qa_hours_1',
      proposalId: priyaHoursId,
      question: 'does confidence decay overnight or only reset on the next scheduled window?',
      askedBy: CONTRIBUTOR.dele,
      answer: 'decays linearly after the window closes, floors at 0.2 until the next open window starts',
      answeredBy: CONTRIBUTOR.priya,
      createdAt: minutesAgo(55),
    },
    {
      id: 'qa_hours_2',
      proposalId: priyaHoursId,
      question: 'is looseOpen free text or a constrained enum?',
      askedBy: CONTRIBUTOR.mara,
      answer: 'free text for v0, room can add a controlled vocabulary later without a schema change',
      answeredBy: CONTRIBUTOR.priya,
      createdAt: minutesAgo(52),
    },
    {
      id: 'qa_hours_3',
      proposalId: priyaHoursId,
      question: 'can Sana pull this into the filter chips work directly?',
      askedBy: CONTRIBUTOR.sana,
      answer: null,
      answeredBy: null,
      createdAt: minutesAgo(48),
    },
    {
      id: 'qa_hours_4',
      proposalId: priyaHoursId,
      question: 'seasonal windows - are they per-market or per-stall?',
      askedBy: CONTRIBUTOR.tomas,
      answer: 'per-stall, markets just aggregate the union for the market-level badge',
      answeredBy: CONTRIBUTOR.priya,
      createdAt: minutesAgo(46),
    },
    {
      id: 'qa_hours_5',
      proposalId: priyaHoursId,
      question: 'timezone handling for markets that span a boundary?',
      askedBy: CONTRIBUTOR.dele,
      answer: null,
      answeredBy: null,
      createdAt: minutesAgo(44),
    },
  ]);

  // ---- 4. Dele's second proposal: open, simple proposed card ----
  const deleSheetId = 'proposal_dele_sheet';
  await db.insert(proposals).values({
    id: deleSheetId,
    roomId: ROOM_ID,
    authorContributorId: CONTRIBUTOR.dele,
    state: 'open',
    parentProposalIds: [],
    createdAt: hoursAgo(3),
  });
  await db.insert(proposalVersions).values({
    versionId: 'version_dele_sheet_1',
    proposalId: deleSheetId,
    intentSummary: 'Stall detail sheet with photo strip',
    diffRef:
      '--- /dev/null\n+++ b/src/stall/DetailSheet.tsx\n@@ -0,0 +1,10 @@\n+export function DetailSheet({ stall }: { stall: Stall }) {\n+  return (\n+    <BottomSheet>\n+      <PhotoStrip photos={stall.photos} />\n+      <QueueEstimate stallId={stall.id} />\n+    </BottomSheet>\n+  );\n+}\n',
    baseRef: 'main',
    baseSha: 'e41f8c21234567890abcdef1234567890abcdef',
    headCommit: 'b8c9d0e1234567890abcdef1234567890abcdef',
    contentHash: 'b8c9d0eb8c9d0eb8c9d0eb8c9d0eb8c9d0eb8c9d0eb8c9d0eb8c9d0eb8c9d0eb',
    status: 'published',
    remixNote: { bullets: [], generatedBy: 'agent-draft', authorEdited: false, lengthCapped: true },
    publishedAt: hoursAgo(3),
  });
  await db.insert(forks).values({
    id: 'fork_priya_on_sheet',
    proposalId: deleSheetId,
    proposalVersionId: 'version_dele_sheet_1',
    byContributorId: CONTRIBUTOR.priya,
    createdAt: hoursAgo(2),
  });

  // ---- 5. Tomás's proposal: rejected, with a mirrored Q&A answer used as the rejection note ----
  const tomasNotifId = 'proposal_tomas_notif';
  await db.insert(proposals).values({
    id: tomasNotifId,
    roomId: ROOM_ID,
    authorContributorId: CONTRIBUTOR.tomas,
    state: 'rejected',
    parentProposalIds: [],
    createdAt: daysAgo(2),
  });
  await db.insert(proposalVersions).values({
    versionId: 'version_tomas_notif_1',
    proposalId: tomasNotifId,
    intentSummary: 'Push notification opt-in modal',
    diffRef:
      '--- /dev/null\n+++ b/src/onboarding/NotifModal.tsx\n@@ -0,0 +1,9 @@\n+export function NotifModal() {\n+  return (\n+    <FullScreenModal blocking>\n+      <p>Enable notifications to hear about new stalls</p>\n+    </FullScreenModal>\n+  );\n+}\n',
    baseRef: 'main',
    baseSha: '9b7e310a1c2d3e4f5061728394a5b6c7d8e9f0a1',
    headCommit: 'c1d2e3f1234567890abcdef1234567890abcdef',
    contentHash: 'c1d2e3fc1d2e3fc1d2e3fc1d2e3fc1d2e3fc1d2e3fc1d2e3fc1d2e3fc1d2e3fc',
    status: 'published',
    remixNote: { bullets: [], generatedBy: 'agent-draft', authorEdited: false, lengthCapped: true },
    publishedAt: daysAgo(2),
  });
  await db.insert(qaExchanges).values({
    id: 'qa_notif_1',
    proposalId: tomasNotifId,
    question: 'why did this get rejected instead of asked to revise?',
    askedBy: CONTRIBUTOR.tomas,
    answer:
      'Room voted this blocks first paint; asked for a deferred, dismissible prompt instead. Not adopted.',
    answeredBy: CONTRIBUTOR.priya,
    createdAt: daysAgo(2),
  });

  // ---- 6. Sana's proposal: open, the live fork target (must be the most recently created Fork) ----
  const sanaGeoId = 'proposal_sana_geo';
  await db.insert(proposals).values({
    id: sanaGeoId,
    roomId: ROOM_ID,
    authorContributorId: CONTRIBUTOR.sana,
    state: 'open',
    parentProposalIds: [],
    createdAt: minutesAgo(30),
  });
  await db.insert(proposalVersions).values({
    versionId: 'version_sana_geo_1',
    proposalId: sanaGeoId,
    intentSummary: 'Geolocation onboarding flow',
    diffRef:
      '--- /dev/null\n+++ b/src/onboarding/GeoFlow.tsx\n@@ -0,0 +1,11 @@\n+export function GeoFlow() {\n+  const perm = useGeolocationPermission();\n+  if (perm === "denied") {\n+    return <NeighborhoodPicker seedFrom="markets-index" />;\n+  }\n+  return <AutoLocate />;\n+}\n',
    baseRef: 'main',
    baseSha: 'e41f8c21234567890abcdef1234567890abcdef',
    headCommit: 'd4e5f6a1234567890abcdef1234567890abcdef',
    contentHash: 'd4e5f6ad4e5f6ad4e5f6ad4e5f6ad4e5f6ad4e5f6ad4e5f6ad4e5f6ad4e5f6ad',
    status: 'published',
    remixNote: { bullets: [], generatedBy: 'agent-draft', authorEdited: false, lengthCapped: true },
    publishedAt: minutesAgo(30),
  });
  // Most recently created fork in the room - the room page picks the single
  // most recent Fork row targeting a still-open proposal as "fork-live".
  await db.insert(forks).values({
    id: 'fork_tomas_on_geo',
    proposalId: sanaGeoId,
    proposalVersionId: 'version_sana_geo_1',
    byContributorId: CONTRIBUTOR.tomas,
    createdAt: minutesAgo(1),
  });

  // ---- Chat messages interleaved on the timeline ----
  await db.insert(messages).values([
    {
      id: 'message_dele_1',
      roomId: ROOM_ID,
      authorContributorId: CONTRIBUTOR.dele,
      body:
        'watching Tomás fork the geo flow live, the neighborhood picker fallback is the right call. safari deniers are like 30% of my test group',
      createdAt: minutesAgo(2),
    },
    {
      id: 'message_priya_1',
      roomId: ROOM_ID,
      authorContributorId: CONTRIBUTOR.priya,
      body:
        '3.1s to 0.9s on Taipei is wild. @Mara I am wiring my open-hours model into your cluster tooltips right now, should hit the feed tonight',
      createdAt: minutesAgo(15),
    },
    {
      id: 'message_mara_1',
      roomId: ROOM_ID,
      authorContributorId: CONTRIBUTOR.mara,
      body: 'go for it, the cluster index already carries stall ids so the join should be clean',
      createdAt: minutesAgo(14),
    },
  ]);

  console.log('Seed complete.');
  console.log(`Room: /room/${ROOM_ID}`);
  console.log(`Proposals: ${[deleMapId, maraClusterId, priyaHoursId, deleSheetId, tomasNotifId, sanaGeoId].length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
