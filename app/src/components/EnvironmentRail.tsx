'use client';

import { useState } from 'react';
import { avatarClass, initials } from '@/lib/ui';

/**
 * `none` is a room whose repo has nothing merged into it yet. The project
 * reserves green for adoption and passing builds, so a fresh room must not
 * open on a green check asserting a build that has never run.
 */
export type BuildStatus = 'passing' | 'failing' | 'none';

export interface EnvironmentRailProps {
  githubRepoRef: string;
  buildStatus: BuildStatus;
  checksLabel: string;
  workingAgents: { id: string; displayName: string }[];
  lastAdoptedLabel: string | null;
}

// The label carries "<what was adopted> · <when>". The panel draws the
// label column and the value column separately, so the trailing clause
// becomes the right-aligned value and the whole string stays as the
// tooltip. No data is invented here, only split for layout.
function splitAdopted(label: string): { value: string; title: string } {
  const sep = ' · ';
  const at = label.lastIndexOf(sep);
  if (at <= 0) return { value: label, title: label };
  return { value: label.slice(at + sep.length), title: label };
}

export function EnvironmentRail({ githubRepoRef, buildStatus, checksLabel, workingAgents, lastAdoptedLabel }: EnvironmentRailProps) {
  const [collapsed, setCollapsed] = useState(false);
  const working = workingAgents.length > 0;
  const adopted = lastAdoptedLabel ? splitAdopted(lastAdoptedLabel) : null;

  return (
    <div className="env-wrap">
      <section className="env" data-open={collapsed ? 'false' : 'true'}>
        <button
          className="env-head"
          aria-expanded={!collapsed}
          type="button"
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className="h">Environment</span>
          <span className="spacer" />
          {working && <span className="env-live" aria-hidden="true" />}
          <span className="chev" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </span>
        </button>

        <div className="env-rows">
          <div className="env-rows-inner">
            {/* The repo carries no state of its own, so it takes the
                neutral emblem rather than a colored one. */}
            <div className="status-row">
              <span className="emblem e-repo" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                </svg>
              </span>
              <a
                className="label"
                href={`https://github.com/${githubRepoRef}`}
                target="_blank"
                rel="noopener noreferrer"
                title={githubRepoRef}
              >
                {githubRepoRef}
              </a>
            </div>

            {/* Nothing merged means nothing has been built. The row says so
                in the neutral vocabulary rather than claiming a pass. */}
            <div className="status-row">
              {buildStatus === 'passing' && (
                <span className="emblem e-build" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 8.4l3 3 7-7.6" />
                  </svg>
                </span>
              )}
              {buildStatus === 'failing' && (
                <span className="emblem e-fail" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
                    <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />
                  </svg>
                </span>
              )}
              {buildStatus === 'none' && (
                <span className="emblem e-none" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M4.5 8h7" />
                  </svg>
                </span>
              )}
              <span className="label">Build</span>
              {buildStatus === 'none' ? (
                <span className="val" title="Nothing has been merged into this room's repo yet">
                  no builds yet
                </span>
              ) : (
                <span className={`val ${buildStatus === 'passing' ? 'on' : 'bad'}`} title={`${buildStatus} · ${checksLabel}`}>
                  {buildStatus} · {checksLabel}
                </span>
              )}
            </div>

            {/* In flight: cyan. At rest the row carries no state, so it
                takes the neutral emblem and the gray value. */}
            <div className="status-row">
              <span className={`emblem ${working ? 'e-fork' : 'e-none'}`} aria-hidden="true">
                {/* Work in progress as a level meter. The robot head this
                    replaces had an antenna, a face and two eye dots inside a
                    13px circle: at that size the interior collapsed into a
                    smudge. Three bars punch cleanly out of a solid disc and
                    say the same thing, and the rising step reads as activity
                    rather than as a mascot. */}
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
                  <path d="M4.6 9.9v2.2M8 6.6v5.5M11.4 3.9v8.2" />
                </svg>
              </span>
              <span className="label">Agents working</span>
              {working ? (
                <span className="stack" title={workingAgents.map((a) => a.displayName).join(', ')}>
                  {workingAgents.map((a) => (
                    <span key={a.id} className={`avatar ${avatarClass(a.id)}`}>
                      {initials(a.displayName)}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="val">none</span>
              )}
            </div>

            <div className="status-row">
              <span className={`emblem ${adopted ? 'e-lineage' : 'e-none'}`} aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1.9l1.85 3.9 4.05.55-2.95 2.95.75 4.1L8 11.35 4.3 13.4l.75-4.1L2.1 6.35l4.05-.55z" />
                </svg>
              </span>
              <span className="label">Last adopted</span>
              {adopted ? (
                <span className="val" title={adopted.title}>
                  {adopted.value}
                </span>
              ) : (
                <span className="val">nothing yet</span>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
