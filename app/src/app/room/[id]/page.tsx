import { notFound, redirect } from 'next/navigation';
import { and, eq, inArray, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  rooms,
  contributors,
  proposals,
  proposalVersions,
  forks,
  qaExchanges,
  adoptions,
  messages,
} from '@/db/schema';
import { LeftRail } from '@/components/LeftRail';
import { RoomHeader } from '@/components/RoomHeader';
import { ProposalCard, type ProposalCardData, type LineageEntry } from '@/components/ProposalCard';
import { ChatMessageItem } from '@/components/ChatMessageItem';
import { Composer } from '@/components/Composer';
import { AgentPane } from '@/components/AgentPane';
import { FeedScroll } from '@/components/FeedScroll';
import { LiveRefresh } from '@/components/LiveRefresh';
import { DrawerScrim } from '@/components/DrawerScrim';
import { OutboxMessages } from '@/components/OutboxMessages';
import { pluralize, relativeTime, roomChannelName } from '@/lib/ui';
import { getCurrentContributorId } from '@/lib/session';

export const dynamic = 'force-dynamic';

type FeedItem =
  | { kind: 'message'; at: string; data: Parameters<typeof ChatMessageItem>[0] }
  | { kind: 'proposal'; at: string; data: ProposalCardData };

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // A room is not public. An anonymous visitor is sent to sign in rather
  // than shown the whole stream. The development identity fallback in
  // lib/session.ts still applies, so local verify scripts are unaffected.
  const currentContributorId = await getCurrentContributorId();
  if (!currentContributorId) {
    redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(`/room/${id}`)}`);
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
  if (!room) notFound();

  const allRooms = await db.select({ id: rooms.id, name: rooms.name }).from(rooms);
  const allContributors = await db.select().from(contributors);
  const contributorById = new Map(allContributors.map((c) => [c.id, c]));
  const displayName = (contributorId: string) => contributorById.get(contributorId)?.displayName ?? 'Unknown';

  const roomProposals = await db.select().from(proposals).where(eq(proposals.roomId, room.id));
  const proposalIds = roomProposals.map((p) => p.id);

  // Only published versions are ever rendered: a pending row is an
  // in-flight promote whose PR and hashes are still placeholders.
  const versions = proposalIds.length
    ? await db
        .select()
        .from(proposalVersions)
        .where(
          and(inArray(proposalVersions.proposalId, proposalIds), eq(proposalVersions.status, 'published')),
        )
    : [];
  const latestVersionByProposal = new Map<string, (typeof versions)[number]>();
  for (const v of versions) {
    const existing = latestVersionByProposal.get(v.proposalId);
    if (!existing || v.publishedAt > existing.publishedAt) latestVersionByProposal.set(v.proposalId, v);
  }

  const roomForks = proposalIds.length
    ? await db.select().from(forks).where(inArray(forks.proposalId, proposalIds))
    : [];
  const forkCountByProposal = new Map<string, number>();
  for (const f of roomForks) {
    forkCountByProposal.set(f.proposalId, (forkCountByProposal.get(f.proposalId) ?? 0) + 1);
  }

  // Parent candidates for a promote: the forks this reader holds in this
  // room, most recent first. The fork row is the only record that already
  // ties a contributor to a specific proposal version they took, so lineage
  // is read off it rather than off a second piece of state that could
  // disagree with it. A fork whose version is no longer published (an
  // in-flight or rolled-back promote) is not offered, because the server
  // would be crediting against something no reader can see.
  const seenParentProposalIds = new Set<string>();
  const myForkParents = roomForks
    .filter((f) => f.byContributorId === currentContributorId)
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
    .flatMap((f) => {
      // Lineage names a proposal, not a version, so two forks of two
      // versions of the same proposal are one parent. The newest wins.
      if (seenParentProposalIds.has(f.proposalId)) return [];
      const proposal = roomProposals.find((p) => p.id === f.proposalId);
      const version = versions.find((v) => v.versionId === f.proposalVersionId);
      if (!proposal || !version) return [];
      seenParentProposalIds.add(f.proposalId);
      return [
        {
          proposalId: f.proposalId,
          proposalVersionId: f.proposalVersionId,
          intentSummary: version.intentSummary,
          authorName: displayName(proposal.authorContributorId),
          forkedAt: f.createdAt.toISOString(),
          headCommit: version.headCommit,
        },
      ];
    });

  const roomQa = proposalIds.length
    ? await db.select().from(qaExchanges).where(inArray(qaExchanges.proposalId, proposalIds))
    : [];
  const qaCountByProposal = new Map<string, number>();
  const answeredQaByProposal = new Map<string, string>();
  for (const qa of roomQa) {
    qaCountByProposal.set(qa.proposalId, (qaCountByProposal.get(qa.proposalId) ?? 0) + 1);
    if (qa.answer && !answeredQaByProposal.has(qa.proposalId)) {
      answeredQaByProposal.set(qa.proposalId, qa.answer);
    }
  }

  const roomAdoptions = await db
    .select()
    .from(adoptions)
    .where(eq(adoptions.roomId, room.id))
    .orderBy(desc(adoptions.adoptedAt));
  const adoptionByProposal = new Map(roomAdoptions.map((a) => [a.proposalId, a]));

  const roomMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.roomId, room.id))
    .orderBy(messages.createdAt);

  // "fork-live": the single most recently created fork in the room, if its
  // target proposal is still open. Real-data-derived rather than time-of-day
  // based, so the demo reads correctly regardless of when it is viewed.
  const latestFork = [...roomForks].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))[0];
  const liveForkProposalId =
    latestFork && roomProposals.find((p) => p.id === latestFork.proposalId)?.state === 'open'
      ? latestFork.proposalId
      : null;

  function buildLineage(proposal: (typeof roomProposals)[number]): LineageEntry[] | undefined {
    if (proposal.parentProposalIds.length === 0) return undefined;
    const entries: LineageEntry[] = [];
    for (const parentId of proposal.parentProposalIds) {
      const parent = roomProposals.find((p) => p.id === parentId);
      const parentVersion = parent ? latestVersionByProposal.get(parent.id) : undefined;
      if (parent && parentVersion) {
        entries.push({
          proposalId: parent.id,
          contributorId: parent.authorContributorId,
          displayName: displayName(parent.authorContributorId),
          intentSummary: parentVersion.intentSummary,
          hash: parentVersion.headCommit,
          role: 'origin',
        });
      }
    }
    const ownVersion = latestVersionByProposal.get(proposal.id);
    if (ownVersion) {
      entries.push({
        proposalId: proposal.id,
        contributorId: proposal.authorContributorId,
        displayName: displayName(proposal.authorContributorId),
        intentSummary: ownVersion.intentSummary,
        hash: ownVersion.headCommit,
        role: 'remix',
      });
    }
    const adoption = adoptionByProposal.get(proposal.id);
    if (adoption) {
      entries.push({
        contributorId: 'room',
        displayName: 'Room',
        intentSummary: 'adopted to main',
        hash: adoption.expectedHeadCommit,
        role: 'final',
      });
    }
    return entries;
  }

  const proposalCards: ProposalCardData[] = roomProposals.map((proposal) => {
    const version = latestVersionByProposal.get(proposal.id);
    const remixNote = (version?.remixNote as { bullets?: string[] } | undefined)?.bullets ?? [];
    const isLiveFork = proposal.id === liveForkProposalId;

    let variant: ProposalCardData['variant'];
    if (proposal.state === 'adopted') variant = 'adopted';
    else if (proposal.state === 'rejected') variant = 'rejected';
    else if (proposal.state === 'superseded') variant = 'superseded';
    else if (isLiveFork) variant = 'fork-live';
    else variant = 'proposed';

    return {
      id: proposal.id,
      state: proposal.state,
      variant,
      intentSummary: version?.intentSummary ?? '(no published version)',
      remixNoteBullets: remixNote,
      authorId: proposal.authorContributorId,
      authorName: displayName(proposal.authorContributorId),
      createdAt: (version?.publishedAt ?? proposal.createdAt).toISOString(),
      forkCount: forkCountByProposal.get(proposal.id) ?? 0,
      qaCount: qaCountByProposal.get(proposal.id) ?? 0,
      contentHash: version?.contentHash ?? '',
      forkingByName: isLiveFork ? displayName(latestFork.byContributorId) : undefined,
      lineage: proposal.state === 'adopted' ? buildLineage(proposal) : undefined,
      rejectionNote: proposal.state === 'rejected' ? answeredQaByProposal.get(proposal.id) : undefined,
      prNumber: version?.prNumber ?? null,
      prUrl: version?.prUrl ?? null,
      mergeCommitSha: adoptionByProposal.get(proposal.id)?.mergeCommitSha ?? null,
      proposalVersionId: version?.versionId ?? null,
      signedIn: currentContributorId != null,
      baseRef: version?.baseRef ?? null,
      baseSha: version?.baseSha ?? null,
      // The reader's own fork of the version on the card, so the control can
      // offer the fork already on record instead of a duplicate.
      myForkAt:
        (currentContributorId && version
          ? roomForks.find(
              (f) =>
                f.proposalId === proposal.id &&
                f.proposalVersionId === version.versionId &&
                f.byContributorId === currentContributorId,
            )
          : undefined
        )?.createdAt.toISOString() ?? null,
    };
  });

  const feed: FeedItem[] = [
    ...roomMessages.map((m): FeedItem => ({
      kind: 'message',
      at: m.createdAt.toISOString(),
      data: {
        id: m.id,
        authorId: m.authorContributorId,
        authorName: displayName(m.authorContributorId),
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        isOwn: currentContributorId != null && m.authorContributorId === currentContributorId,
      },
    })),
    ...proposalCards.map((card): FeedItem => ({ kind: 'proposal', at: card.createdAt, data: card })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));

  // Consecutive messages from the same author group tightly: the avatar and
  // name render once, and follow-ups drop the header.
  for (let i = 1; i < feed.length; i++) {
    const prev = feed[i - 1];
    const cur = feed[i];
    if (cur.kind === 'message' && prev.kind === 'message' && cur.data.authorId === prev.data.authorId) {
      cur.data.grouped = true;
    }
  }

  // Room membership + a simple, real-data-derived presence signal: the
  // member whose most recent activity in the room is oldest is shown away.
  const lastActivityByContributor = new Map<string, string>();
  const touch = (contributorId: string, at: string) => {
    const existing = lastActivityByContributor.get(contributorId);
    if (!existing || at > existing) lastActivityByContributor.set(contributorId, at);
  };
  for (const p of roomProposals) touch(p.authorContributorId, p.createdAt.toISOString());
  for (const f of roomForks) touch(f.byContributorId, f.createdAt.toISOString());
  for (const m of roomMessages) touch(m.authorContributorId, m.createdAt.toISOString());

  const memberIds = [...lastActivityByContributor.keys()];
  const sortedByActivity = [...memberIds].sort((a, b) =>
    (lastActivityByContributor.get(a) ?? '') < (lastActivityByContributor.get(b) ?? '') ? -1 : 1,
  );
  const awaySet = new Set(sortedByActivity.length > 1 ? [sortedByActivity[0]] : []);

  const members = memberIds.map((cid) => ({
    id: cid,
    displayName: displayName(cid),
    away: awaySet.has(cid),
  }));

  const workingAgentIds = [
    ...new Set(
      roomForks
        .filter((f) => roomProposals.find((p) => p.id === f.proposalId)?.state === 'open')
        .map((f) => f.byContributorId),
    ),
  ];
  const workingAgents = workingAgentIds.map((cid) => ({ id: cid, displayName: displayName(cid) }));

  const lastAdoption = roomAdoptions[0];
  const lastAdoptionVersion = lastAdoption ? latestVersionByProposal.get(lastAdoption.proposalId) : undefined;
  const lastAdoptedLabel = lastAdoption
    ? `${lastAdoptionVersion?.intentSummary ?? 'a proposal'} · ${relativeTime(lastAdoption.adoptedAt)}`
    : null;

  const currentUser = currentContributorId
    ? { id: currentContributorId, displayName: displayName(currentContributorId) }
    : null;

  // A room created without a slug would otherwise render its raw uuid as
  // the channel name and inside the composer placeholder.
  const channelName = roomChannelName(room.id, room.name);

  return (
    <div className="app">
      <LeftRail
        rooms={allRooms}
        activeRoomId={room.id}
        proposalCount={roomProposals.length}
        currentUser={currentUser}
      />

      <RoomHeader
        name={room.name}
        tagline={`a room for ${room.name.toLowerCase()}`}
        members={members}
        onlineCount={members.length - awaySet.size}
      />

      <main className="feed-pane">
        <FeedScroll itemCount={feed.length}>
          <div className="feed-inner">
            <div className="feed-top">
              <h2>#{channelName}</h2>
              <span className="live-tag">
                <span className="dot" />
                {pluralize(workingAgents.length, 'signal')} live
              </span>
              <div className="spacer" />
            </div>
            <p className="feed-sub">
              The room talks here. Promoted work lands in the same stream: fork what interests you, remix what you
              can improve, and the room adopts the winners into the build.
            </p>

            <div className="feed-stream">
              {feed.map((item) =>
                item.kind === 'message' ? (
                  <ChatMessageItem key={`msg-${item.data.id}`} {...item.data} />
                ) : (
                  <ProposalCard key={`proposal-${item.data.id}`} {...item.data} />
                ),
              )}
              {/* Messages the composer has sent but the server has not
                  confirmed yet, at the bottom of the real conversation. */}
              <OutboxMessages
                currentUserId={currentUser?.id ?? null}
                currentUserName={currentUser?.displayName ?? null}
              />
            </div>
          </div>
        </FeedScroll>

        <Composer
          roomId={room.id}
          roomName={channelName}
          signedIn={currentUser != null}
          githubRepoRef={room.githubRepoRef}
          parentOptions={myForkParents}
        />
      </main>
      <LiveRefresh />
      <DrawerScrim />

      <AgentPane
        roomId={room.id}
        githubRepoRef={room.githubRepoRef}
        // Not a live CI integration: the room has either merged something
        // into its repo or it has not. Zero merges is "no builds yet", not
        // a green pass for a repo with no commits.
        buildStatus={roomAdoptions.length > 0 ? 'passing' : 'none'}
        checksLabel={`${roomAdoptions.length} merged to main`}
        workingAgents={workingAgents}
        lastAdoptedLabel={lastAdoptedLabel}
        currentUserDisplayName={currentUser?.displayName ?? 'Signed out'}
        parentOptions={myForkParents}
      />
    </div>
  );
}
