// Canonical repo bootstrap: creates a private repo under the GitHub App
// installation's account, seeds it with a minimal Vite web-app template as
// the genesis commit, and links it to the room via rooms.githubRepoRef.
//
// Usage: npm run room:repo -- <roomId> <repoName>
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client';
import { rooms } from '../src/db/schema';
import { createRoomRepo, seedGenesisCommit, getInstallationAccountLogin, credsPresent } from '../src/lib/github';

const VITE_TEMPLATE_FILES = [
  {
    path: 'package.json',
    content: JSON.stringify(
      {
        name: 'room-app',
        private: true,
        version: '0.0.1',
        type: 'module',
        scripts: {
          dev: 'vite',
          build: 'vite build',
          preview: 'vite preview',
        },
        devDependencies: {
          vite: '^6.0.0',
        },
      },
      null,
      2,
    ) + '\n',
  },
  {
    path: 'index.html',
    content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Room App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
  },
  {
    path: 'src/main.js',
    content: `import { renderApp } from './app.js';

renderApp(document.getElementById('app'));
`,
  },
  {
    path: 'src/app.js',
    content: `export function renderApp(root) {
  root.innerHTML = \`
    <main>
      <h1>Room App</h1>
      <p>Genesis commit. Promoted proposals land here as PRs.</p>
    </main>
  \`;
}
`,
  },
  {
    path: 'src/style.css',
    content: `body {
  font-family: system-ui, sans-serif;
  margin: 2rem;
  color: #111;
}
`,
  },
  {
    path: '.gitignore',
    content: `node_modules\ndist\n`,
  },
  {
    path: 'README.md',
    content: `# Room App

Canonical build for this Agent Rooms room. This repo is the only canonical
build and version history; adoption is a SHA-pinned PR merge into \`main\`.
`,
  },
];

async function main() {
  const [roomId, repoName] = process.argv.slice(2);
  if (!roomId || !repoName) {
    console.error('Usage: npm run room:repo -- <roomId> <repoName>');
    process.exit(1);
  }

  if (!credsPresent()) {
    console.error('GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID must be set.');
    process.exit(1);
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) {
    console.error(`room ${roomId} not found`);
    process.exit(1);
  }

  const owner = await getInstallationAccountLogin();
  console.log(`Creating ${owner}/${repoName}...`);
  let created;
  try {
    created = await createRoomRepo(owner, repoName, `Canonical build for Agent Rooms room "${room.name}"`);
    console.log(`Created ${created.url} (default branch: ${created.defaultBranch})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Name already exists on this account')) throw error;
    console.log(`Repo ${owner}/${repoName} already exists; reusing it.`);
    created = { owner, repo: repoName, url: `https://github.com/${owner}/${repoName}`, defaultBranch: 'main' };
  }

  console.log('Seeding genesis commit (minimal Vite web-app template)...');
  const genesisSha = await seedGenesisCommit(
    owner,
    repoName,
    created.defaultBranch,
    VITE_TEMPLATE_FILES,
    'Genesis commit: minimal Vite web-app template',
  );
  console.log(`Genesis commit: ${genesisSha}`);

  const githubRepoRef = `${owner}/${repoName}`;
  await db.update(rooms).set({ githubRepoRef }).where(eq(rooms.id, roomId));
  console.log(`Linked room ${roomId} -> githubRepoRef "${githubRepoRef}"`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
