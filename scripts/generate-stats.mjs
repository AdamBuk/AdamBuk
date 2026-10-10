/**
 * Vygeneruje karty statistik profilu (assets/stats.svg, assets/languages.svg)
 * z GitHub GraphQL API — včetně soukromých repozitářů.
 *
 * Token: proměnná GH_STATS_TOKEN (fine-grained token jen pro čtení:
 * Repository access → All repositories, Permissions → Contents: Read, Metadata: Read).
 * Spouští se automaticky workflowem .github/workflows/stats.yml.
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const token = process.env.GH_STATS_TOKEN;
if (!token) {
  console.log('GH_STATS_TOKEN není nastavený — statistiky se neaktualizují.');
  process.exit(0);
}

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-stats' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map(e => e.message).join('; '));
  return body.data;
}

const { viewer } = await gql(`query {
  viewer {
    login
    createdAt
    repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
      totalCount
      nodes {
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
      }
    }
  }
}`);

// Commity po letech od založení účtu (contributionsCollection pokrývá max. 1 rok)
const startYear = new Date(viewer.createdAt).getUTCFullYear();
const thisYear = new Date().getUTCFullYear();
let commits = 0, prs = 0, lastYear = 0;
for (let y = startYear; y <= thisYear; y++) {
  const from = `${y}-01-01T00:00:00Z`;
  const to = y === thisYear ? new Date().toISOString() : `${y}-12-31T23:59:59Z`;
  const { viewer: v } = await gql(`query($from: DateTime!, $to: DateTime!) {
    viewer { contributionsCollection(from: $from, to: $to) {
      totalCommitContributions restrictedContributionsCount totalPullRequestContributions
    } }
  }`, { from, to });
  const c = v.contributionsCollection;
  commits += c.totalCommitContributions;
  prs += c.totalPullRequestContributions;
  if (y === thisYear) lastYear = c.totalCommitContributions;
}

const repos = viewer.repositories.nodes;
const stars = repos.reduce((s, r) => s + r.stargazerCount, 0);
const langBytes = new Map();
for (const r of repos) for (const e of r.languages.edges) {
  const cur = langBytes.get(e.node.name) ?? { size: 0, color: e.node.color ?? '#8b949e' };
  cur.size += e.size;
  langBytes.set(e.node.name, cur);
}
const totalBytes = [...langBytes.values()].reduce((s, l) => s + l.size, 0) || 1;
const languages = [...langBytes.entries()]
  .map(([name, l]) => ({ name, color: l.color, pct: (l.size / totalBytes) * 100 }))
  .sort((a, b) => b.pct - a.pct)
  .slice(0, 6);

// ── SVG ──────────────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nf = n => n.toLocaleString('cs-CZ').replace(/ /g, ' ');
const W = 420, H = 190;
const style = `
  <style>
    .t { font: 600 16px 'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif; fill: #e6edf3 }
    .l { font: 400 12.5px 'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif; fill: #8b949e }
    .v { font: 700 22px 'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif; fill: #e6edf3 }
    .s { font: 400 12px 'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif; fill: #c9d1d9 }
  </style>`;
const frame = (title, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
${style}
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#11457e"/><stop offset="1" stop-color="#0d1117"/></linearGradient></defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="url(#g)" stroke="#30363d"/>
  <text x="24" y="36" class="t">${esc(title)}</text>
${body}
</svg>
`;

const cells = [
  ['Commity celkem', nf(commits)],
  [`Commity ${thisYear}`, nf(lastYear)],
  ['Repozitáře', nf(viewer.repositories.totalCount)],
  ['Pull requesty', nf(prs)],
];
const statsBody = cells.map(([label, value], i) => {
  const x = 24 + (i % 2) * 196, y = 78 + Math.floor(i / 2) * 58;
  return `  <text x="${x}" y="${y}" class="v">${esc(value)}</text>\n  <text x="${x}" y="${y + 20}" class="l">${esc(label)}</text>`;
}).join('\n') + (stars ? `\n  <text x="${W - 24}" y="36" class="l" text-anchor="end">★ ${nf(stars)}</text>` : '');

let x = 24;
const bar = languages.map(l => {
  const w = Math.max(2, (l.pct / 100) * (W - 48));
  const r = `<rect x="${x.toFixed(1)}" y="56" width="${w.toFixed(1)}" height="10" fill="${l.color}"/>`;
  x += w;
  return r;
}).join('');
const legend = languages.map((l, i) => {
  const lx = 24 + (i % 2) * 196, ly = 94 + Math.floor(i / 2) * 26;
  return `  <circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${l.color}"/>\n  <text x="${lx + 16}" y="${ly}" class="s">${esc(l.name)} <tspan class="l">${l.pct.toFixed(1).replace('.', ',')} %</tspan></text>`;
}).join('\n');
const langBody = `  <clipPath id="c"><rect x="24" y="56" width="${W - 48}" height="10" rx="5"/></clipPath>\n  <g clip-path="url(#c)">${bar}</g>\n${legend}`;

mkdirSync('assets', { recursive: true });
writeFileSync('assets/stats.svg', frame('Statistiky na GitHubu', statsBody));
writeFileSync('assets/languages.svg', frame('Nejpoužívanější jazyky', langBody));
console.log(`Hotovo: ${commits} commitů, ${viewer.repositories.totalCount} repozitářů, jazyky: ${languages.map(l => l.name).join(', ')}`);
