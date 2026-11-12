// github.com:443 is blocked in this environment (api.github.com works), so `git push` fails.
// This pushes the current tree through the Git Data API instead. Usage: node scripts/push-github.mjs [owner/repo]
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = process.argv[2] || '3698688050-pixel/cad-translator';
const TOKEN = execSync('gh auth token', { encoding: 'utf8' }).trim();
const api = async (p, init = {}) => {
  const r = await fetch(`https://api.github.com${p}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${p} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
};

const files = execSync('git ls-files', { encoding: 'utf8', mode: 'buffer' }).toString('utf8').trim().split('\n');
const b64 = (f) => fs.readFileSync(f).toString('base64');
const tree = [];
for (const f of files) {
  const b = await api(`/repos/${REPO}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: b64(f), encoding: 'base64' }) });
  tree.push({ path: f, mode: '100644', type: 'blob', sha: b.sha });
}

let base;
try { base = (await api(`/repos/${REPO}/git/ref/heads/main`)).object.sha; } catch { base = null; }
if (!base) {
  // An empty repo has no refs and its Git Data API refuses blobs; a first Contents commit unlocks it.
  await api(`/repos/${REPO}/contents/${encodeURIComponent(files[0])}`, {
    method: 'PUT', body: JSON.stringify({ message: 'init', content: b64(files[0]) }),
  });
  base = null;
  for (const t of tree) {
    const b = await api(`/repos/${REPO}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: b64(t.path), encoding: 'base64' }) });
    t.sha = b.sha;
  }
}

const newTree = await api(`/repos/${REPO}/git/trees`, { method: 'POST', body: JSON.stringify({ tree, base_tree: base || undefined }) });
const message = execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim() || 'update';
const author = { name: '3698688050-pixel', email: '346747232+3698688050-pixel@users.noreply.github.com' };
const commit = await api(`/repos/${REPO}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: base ? [base] : [], author }) });

if (base) await api(`/repos/${REPO}/git/refs/heads/main`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
else await api(`/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.sha }) });
console.log(`pushed ${files.length} files -> https://github.com/${REPO} (${commit.sha.slice(0, 8)})`);
