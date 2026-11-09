'use strict';
// Read-only links to a code forge (GitLab — also self-hosted — or GitHub) with a personal access token. Used to show, for a
// branch, its merge / pull request and its latest CI pipeline. Nothing here writes to the forge.

// "git@host:group/sub/repo.git", "ssh://git@host:2222/group/repo.git", "https://host/group/repo(.git)" → { host, path }.
function parseRemote(url) {
  const u = String(url || '').trim(); let m;
  if ((m = /^[\w.-]+@([\w.-]+):(?!\d+\/)(.+?)(?:\.git)?\/?$/.exec(u))) return { host: m[1].toLowerCase(), path: m[2] };
  if ((m = /^(?:ssh|git\+ssh|https?):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(u))) return { host: m[1].toLowerCase(), path: m[2] };
  return null;
}
// The link whose address names this host (a link to https://gitlab.example.com serves git@gitlab.example.com:… remotes).
function linkFor(links, remote) {
  const r = parseRemote(remote); if (!r) return null;
  const link = (links || []).find((l) => { try { return new URL(l.url).hostname.toLowerCase() === r.host; } catch { return false; } });
  return link ? { link, path: r.path } : null;
}
function cleanUrl(kind, url) {
  if (kind === 'github') return 'https://api.github.com';
  let u; try { u = new URL(String(url || '').trim()); } catch { return ''; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return '';
  return u.origin;
}
const BRANCH = /^[\w./-]{1,200}$/;

// API requests for one branch; the caller sends them with the token header and passes the JSON answers to summarize().
function requests(link, path, branch) {
  if (!BRANCH.test(branch)) return null;
  if (link.kind === 'github') {
    const [owner, repo] = path.split('/'); if (!owner || !repo) return null;
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return { mr: `${base}/pulls?state=all&per_page=3&head=${encodeURIComponent(owner + ':' + branch)}`, ci: `${base}/commits/${encodeURIComponent(branch)}/check-runs?per_page=50`, web: `https://github.com/${path}` };
  }
  const base = `${link.url}/api/v4/projects/${encodeURIComponent(path)}`;
  return { mr: `${base}/merge_requests?state=all&order_by=updated_at&per_page=3&source_branch=${encodeURIComponent(branch)}`, ci: `${base}/pipelines?per_page=1&ref=${encodeURIComponent(branch)}`, web: `${link.url}/${path}` };
}
function headers(link) {
  return link.kind === 'github' ? { Authorization: `Bearer ${link.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'TERMNEST' } : { 'PRIVATE-TOKEN': link.token };
}
function userUrl(link) { return link.kind === 'github' ? 'https://api.github.com/user' : `${link.url}/api/v4/user`; }

// { mr: { state, title, url, number, draft } | null, ci: { state, url } | null } from the forge's own answers.
function summarize(kind, mrJson, ciJson) {
  let mr = null, ci = null;
  const list = Array.isArray(mrJson) ? mrJson : [];
  const top = list.find((x) => x && (x.state === 'opened' || x.state === 'open')) || list[0];
  if (top) {
    const state = kind === 'github' ? (top.merged_at ? 'merged' : top.state === 'open' ? 'opened' : 'closed') : top.state;
    mr = { state: ['opened', 'merged', 'closed', 'locked'].includes(state) ? state : 'opened', title: String(top.title || '').slice(0, 160), url: String(top.web_url || top.html_url || ''), number: top.iid || top.number || 0, draft: !!(top.draft || top.work_in_progress) };
  }
  if (kind === 'github') {
    const runs = ciJson && Array.isArray(ciJson.check_runs) ? ciJson.check_runs : [];
    if (runs.length) {
      const st = runs.some((r) => r.status !== 'completed') ? 'running' : runs.some((r) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion)) ? 'failed' : 'success';
      ci = { state: st, url: String(runs[0].html_url || '') };
    }
  } else if (Array.isArray(ciJson) && ciJson[0]) {
    const p = ciJson[0], map = { success: 'success', failed: 'failed', running: 'running', pending: 'running', created: 'running', preparing: 'running', waiting_for_resource: 'running', scheduled: 'running', canceled: 'canceled', skipped: 'skipped', manual: 'manual' };
    ci = { state: map[p.status] || 'running', url: String(p.web_url || '') };
  }
  return { mr, ci };
}

module.exports = { parseRemote, linkFor, cleanUrl, requests, headers, userUrl, summarize, BRANCH };
