import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { contributors, proposals, proposalVersions } from '@/db/schema';

export interface LineageNode {
  id: string;
  parentProposalIds: string[];
  /** True when this ancestor id is referenced by a descendant but has no
   * row in the database. The node is reported rather than dropped: a chain
   * that silently omits a missing ancestor reads as complete provenance
   * when it is not. */
  missing?: boolean;
}

/**
 * Walks the Proposal DAG from rootProposalId through parentProposalIds
 * (design doc: "Lineage is a DAG rather than a single parent, because real
 * remixes combine more than one source"). Cycle-safe via a visited set,
 * though the schema does not itself forbid cycles.
 *
 * An ancestor id with no corresponding row is returned as an explicit
 * broken-link node (missing: true) instead of being skipped, so callers can
 * surface the gap to a reader.
 */
export async function buildLineageChain(rootProposalId: string): Promise<LineageNode[]> {
  const visited = new Set<string>();
  const chain: LineageNode[] = [];

  let frontier = [rootProposalId];

  while (frontier.length > 0) {
    const unseen = frontier.filter((id) => !visited.has(id));
    if (unseen.length === 0) break;

    const rows = await db
      .select({ id: proposals.id, parentProposalIds: proposals.parentProposalIds })
      .from(proposals)
      .where(inArray(proposals.id, unseen));

    const foundIds = new Set(rows.map((r) => r.id));
    const nextFrontier: string[] = [];
    for (const row of rows) {
      visited.add(row.id);
      chain.push(row);
      for (const parentId of row.parentProposalIds) {
        if (!visited.has(parentId)) nextFrontier.push(parentId);
      }
    }
    for (const id of unseen) {
      if (foundIds.has(id)) continue;
      visited.add(id);
      chain.push({ id, parentProposalIds: [], missing: true });
    }
    frontier = nextFrontier;
  }

  return chain;
}

/**
 * A lineage node with the two things a reader actually needs: who wrote it
 * and what it said. Raw proposal ids are unreadable, and a credit chain
 * rendered as ids is strictly less useful than the same chain on the
 * proposal page, which resolves exactly this data.
 */
export interface LineageDetail {
  id: string;
  /** Absent only for a broken link, where there is no row to name. */
  authorName: string | null;
  intentSummary: string | null;
  headCommit: string | null;
  /** True when the node itself has parents, i.e. it is a remix not an origin. */
  isRemix: boolean;
  missing: boolean;
}

/**
 * Resolves author display names and the published intent summary for each
 * node of a lineage chain, in one query per table rather than per node.
 * Shared by the proposal detail page and the fork receipt so the two render
 * the same chain from the same source.
 */
export async function resolveLineageDetail(chain: LineageNode[]): Promise<LineageDetail[]> {
  const presentIds = chain.filter((n) => !n.missing).map((n) => n.id);
  if (presentIds.length === 0) {
    return chain.map((n) => ({
      id: n.id,
      authorName: null,
      intentSummary: null,
      headCommit: null,
      isRemix: n.parentProposalIds.length > 0,
      missing: true,
    }));
  }

  const proposalRows = await db.select().from(proposals).where(inArray(proposals.id, presentIds));
  const versionRows = await db
    .select()
    .from(proposalVersions)
    .where(
      and(inArray(proposalVersions.proposalId, presentIds), eq(proposalVersions.status, 'published')),
    )
    .orderBy(proposalVersions.publishedAt);

  const authorIds = [...new Set(proposalRows.map((p) => p.authorContributorId))];
  const authorRows = authorIds.length
    ? await db.select().from(contributors).where(inArray(contributors.id, authorIds))
    : [];
  const authorById = new Map(authorRows.map((c) => [c.id, c]));

  const proposalById = new Map(proposalRows.map((p) => [p.id, p]));
  // orderBy publishedAt ascending, so the last write per proposal is the latest.
  const latestVersionByProposal = new Map<string, (typeof versionRows)[number]>();
  for (const v of versionRows) latestVersionByProposal.set(v.proposalId, v);

  return chain.map((node) => {
    const proposal = proposalById.get(node.id);
    const version = latestVersionByProposal.get(node.id);
    return {
      id: node.id,
      authorName: proposal ? authorById.get(proposal.authorContributorId)?.displayName ?? null : null,
      intentSummary: version?.intentSummary ?? null,
      headCommit: version?.headCommit ?? null,
      isRemix: node.parentProposalIds.length > 0,
      missing: node.missing === true || !proposal,
    };
  });
}

/** The broken links in a lineage chain, for surfacing as a visible warning. */
export function brokenLineageLinks(chain: LineageNode[]): LineageNode[] {
  return chain.filter((n) => n.missing === true);
}

export interface ParentValidationResult {
  ok: boolean;
  missingIds: string[];
  cycleIds: string[];
}

/**
 * Validates a new proposal's parentProposalIds before it is created: every
 * id must already exist (missingIds), and adopting them must not create a
 * cycle in the Proposal DAG (cycleIds) (design doc: "Lineage is a DAG").
 * Cross-room parents are allowed by design; nothing here checks roomId.
 *
 * A cycle can only form if newProposalId is reachable by walking
 * parentProposalIds' own ancestry (i.e. one of the requested parents is
 * already, transitively, a descendant of the proposal being created). For a
 * brand-new id this cannot happen unless the caller supplies a
 * parentProposalId chain that loops back to it, which this walk still
 * catches defensively and correctly for any future caller that reuses ids.
 */
export async function validateParents(
  newProposalId: string,
  parentProposalIds: string[],
): Promise<ParentValidationResult> {
  if (parentProposalIds.length === 0) {
    return { ok: true, missingIds: [], cycleIds: [] };
  }

  const rows = await db
    .select({ id: proposals.id, parentProposalIds: proposals.parentProposalIds })
    .from(proposals)
    .where(inArray(proposals.id, parentProposalIds));

  const found = new Map(rows.map((r) => [r.id, r]));
  const missingIds = parentProposalIds.filter((id) => !found.has(id));
  if (missingIds.length > 0) {
    return { ok: false, missingIds, cycleIds: [] };
  }

  const visited = new Set<string>();
  const cycleIds: string[] = [];
  let frontier = [...parentProposalIds];

  while (frontier.length > 0) {
    const unseen = frontier.filter((id) => !visited.has(id));
    if (unseen.length === 0) break;

    const rowsToWalk =
      unseen.every((id) => found.has(id)) && unseen.length === new Set(unseen).size
        ? unseen.map((id) => found.get(id)!)
        : await db
            .select({ id: proposals.id, parentProposalIds: proposals.parentProposalIds })
            .from(proposals)
            .where(inArray(proposals.id, unseen));

    const nextFrontier: string[] = [];
    for (const row of rowsToWalk) {
      visited.add(row.id);
      if (row.id === newProposalId) {
        cycleIds.push(row.id);
        continue;
      }
      for (const parentId of row.parentProposalIds) {
        if (!visited.has(parentId)) nextFrontier.push(parentId);
      }
    }
    frontier = nextFrontier;
  }

  return { ok: cycleIds.length === 0, missingIds: [], cycleIds };
}
