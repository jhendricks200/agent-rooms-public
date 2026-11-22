// Turns a stored proposal version into a real unified diff.
//
// Why compute on read and cache, rather than compute at promote time and
// store:
//
//   1. Historical rows. Every proposal already in the database holds only
//      whole-file content. A promote-time-only patch would fix new proposals
//      and leave every existing one, including the entire curated demo room,
//      permanently undiffable. On-read computation fixes them all with one
//      code path, and there is no backfill script to run or to forget.
//   2. The patch is derivable, not a fact. baseSha is pinned and immutable,
//      the file content at that SHA is immutable, and diffRef is immutable
//      once published. The patch is therefore a pure function of frozen
//      inputs: exactly the shape of thing that belongs in a regenerable
//      cache and not in the provenance record.
//   3. Promote is the one path that opens a real pull request and has a
//      rollback to get right. Adding two or three more GitHub round trips
//      inside it buys latency on the write path to save latency on a read
//      path that is cached after its first hit.
//
// The cost is that the first view of a proposal pays for a GitHub read per
// modified file. That is one round trip, once, per version, ever.
//
// Failure is honest. If the base content cannot be fetched (no GitHub App
// credentials, a deleted repo, a baseSha that no longer resolves, a binary
// blob), no patch is produced for that file and the renderer says so, rather
// than presenting whole-file content dressed up as a diff.
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { proposalVersionPatches } from '@/db/schema';
import { parseDiffRef } from '@/lib/diff';
import { buildUnifiedPatch } from '@/lib/patch';
import { credsPresent, getFileAtCommit, splitRepoRef } from '@/lib/github';

export interface ProposalPatchResult {
  /**
   * repo-relative path -> unified patch text. Only `modify` entries appear.
   * An empty string means the base was read successfully and the file's
   * content is byte-identical to it: nothing moved. A path that is absent
   * entirely means the base could not be read, which is the honest-degrade
   * case the renderer labels.
   */
  patches: Record<string, string>;
  /** Why some or all modify entries have no patch, for the UI to state plainly. */
  unavailableReason: string | null;
}

const EMPTY: ProposalPatchResult = { patches: {}, unavailableReason: null };

interface VersionLike {
  versionId: string;
  diffRef: string;
  baseSha: string | null;
}

export async function getProposalPatches(
  version: VersionLike,
  githubRepoRef: string | null | undefined,
): Promise<ProposalPatchResult> {
  const parsed = parseDiffRef(version.diffRef);
  if (!parsed.ok || !parsed.diff) return EMPTY;

  const modified = parsed.diff.files.filter((f) => f.changeType === 'modify');
  if (modified.length === 0) return EMPTY;

  const baseSha = version.baseSha ?? '';

  // Cache hit. The version is immutable, so a matching baseSha means the
  // inputs cannot have changed underneath it.
  try {
    const [cached] = await db
      .select()
      .from(proposalVersionPatches)
      .where(eq(proposalVersionPatches.versionId, version.versionId))
      .limit(1);
    if (cached && cached.baseSha === baseSha) {
      const patches = (cached.patches ?? {}) as Record<string, string>;
      const missing = modified.filter((f) => patches[f.path] === undefined).length;
      return {
        patches,
        unavailableReason:
          missing > 0
            ? `the base version of ${missing} file${missing === 1 ? '' : 's'} could not be read from GitHub`
            : null,
      };
    }
  } catch {
    // A cache read failure must never take the page down; fall through and
    // recompute.
  }

  if (!baseSha) {
    return { patches: {}, unavailableReason: 'this version records no base commit SHA' };
  }
  if (!githubRepoRef) {
    return { patches: {}, unavailableReason: 'this room has no linked repository' };
  }
  if (!credsPresent()) {
    return { patches: {}, unavailableReason: 'GitHub App credentials are not configured here' };
  }

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = splitRepoRef(githubRepoRef));
  } catch {
    return { patches: {}, unavailableReason: 'this room has no linked repository' };
  }

  const patches: Record<string, string> = {};
  let failures = 0;

  await Promise.all(
    modified.map(async (file) => {
      try {
        const before = await getFileAtCommit(owner, repo, file.path, baseSha);
        if (before == null) {
          failures++;
          return;
        }
        // An empty patch string records "base read, nothing moved", which is
        // a different fact from "base unreadable" and must not collapse into
        // it.
        patches[file.path] = buildUnifiedPatch(file.path, before, file.content) ?? '';
      } catch {
        failures++;
      }
    }),
  );

  // Only cache a complete result. A partial one would freeze a transient
  // GitHub failure into the record.
  if (failures === 0) {
    try {
      await db
        .insert(proposalVersionPatches)
        .values({ versionId: version.versionId, baseSha, patches })
        .onConflictDoNothing();
    } catch {
      // A cache write failure is not a render failure.
    }
  }

  if (failures > 0) {
    return {
      patches,
      unavailableReason:
        failures === modified.length
          ? 'the base version of this file could not be read from GitHub'
          : `the base version of ${failures} file${failures === 1 ? '' : 's'} could not be read from GitHub`,
    };
  }
  return { patches, unavailableReason: null };
}
