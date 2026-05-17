"use strict";
/* eslint-disable no-console */
// =============================================================================
// Audit: enumerate the distinct Jira statuses that came in during the import,
// show how the current mapStatus rule classifies them, and highlight any that
// fell into "Todo" via the default branch.
//
// Read-only. After reviewing the output, edit the mapStatus rule in
// scripts/import-from-jira.ts (or duplicate it into a remap script) and re-run
// the remap against the DB.
//
// Run:
//   pnpm --filter @nockta/api tsx scripts/audit-jira-statuses.ts
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
require("../src/bootstrap-env");
const client_1 = require("@prisma/client");
const JIRA_DOMAIN = requireEnv('JIRA_DOMAIN');
const JIRA_EMAIL = requireEnv('JIRA_EMAIL');
const JIRA_API_TOKEN = requireEnv('JIRA_API_TOKEN');
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`Missing ${name}`);
        process.exit(1);
    }
    return v;
}
async function jira(path, params = {}) {
    const url = new URL(`https://${JIRA_DOMAIN}${path}`);
    for (const [k, v] of Object.entries(params))
        url.searchParams.set(k, v);
    await new Promise((r) => setTimeout(r, 125)); // ~8 req/sec
    const res = await fetch(url, { headers: { Authorization: AUTH, Accept: 'application/json' } });
    if (!res.ok)
        throw new Error(`Jira ${path} → ${res.status} ${res.statusText}`);
    return res.json();
}
// Copy of the mapStatus rule from import-from-jira.ts. Kept here so we can
// also see the "would map to" column for any rule changes we're considering.
function mapStatus(jiraStatus, preset) {
    const lower = jiraStatus.toLowerCase();
    const done = ['done', 'closed', 'resolved', 'completed', 'cancelled', 'canceled', "won't do", 'wont do'];
    if (preset === 'generic') {
        if (done.some((k) => lower.includes(k)))
            return { status: 'Done', viaDefault: false };
        if (lower.includes('progress') || lower.includes('doing') || lower.includes('development') || lower.includes('selected'))
            return { status: 'In Progress', viaDefault: false };
        return { status: 'Todo', viaDefault: true };
    }
    if (preset === 'design') {
        if (done.some((k) => lower.includes(k)))
            return { status: 'Done', viaDefault: false };
        if (lower.includes('approv'))
            return { status: 'Approved', viaDefault: false };
        if (lower.includes('review'))
            return { status: 'In Review', viaDefault: false };
        if (lower.includes('progress') || lower.includes('doing'))
            return { status: 'In Progress', viaDefault: false };
        return { status: 'Todo', viaDefault: true };
    }
    if (done.some((k) => lower.includes(k)))
        return { status: 'Done', viaDefault: false };
    if (lower.includes('test') || lower.includes('qa') || lower.includes('uat'))
        return { status: 'Testing', viaDefault: false };
    if (lower.includes('review'))
        return { status: 'In Review', viaDefault: false };
    if (lower.includes('progress') || lower.includes('doing') || lower.includes('development') || lower.includes('selected'))
        return { status: 'In Progress', viaDefault: false };
    return { status: 'Todo', viaDefault: true };
}
function inferPreset(name, projectTypeKey) {
    if (projectTypeKey === 'software')
        return 'engineering';
    const lc = name.toLowerCase();
    if (lc.includes('design') || lc.includes('creative') || lc.includes('marketing'))
        return 'design';
    return 'generic';
}
async function main() {
    const prisma = new client_1.PrismaClient();
    // Project list comes from Jira so we can apply the preset rule consistently.
    const jiraProjects = await jira('/rest/api/3/project');
    // Histogram keyed by `${jiraStatus} | ${preset}` so the same name under two
    // different presets is shown separately (their target bucket differs).
    const hist = new Map();
    for (const jp of jiraProjects) {
        const preset = inferPreset(jp.name, jp.projectTypeKey);
        let nextPageToken;
        let projectIssueCount = 0;
        while (true) {
            const params = {
                jql: `project = "${jp.key}"`,
                fields: 'status',
                maxResults: '100',
            };
            if (nextPageToken)
                params['nextPageToken'] = nextPageToken;
            const resp = await jira('/rest/api/3/search/jql', params);
            for (const i of resp.issues) {
                const name = i.fields.status?.name ?? 'Unknown';
                const { status: mapped, viaDefault } = mapStatus(name, preset);
                const k = `${name}__${preset}`;
                const entry = hist.get(k);
                if (entry) {
                    entry.count++;
                    entry.sampleProjects.add(jp.key);
                }
                else {
                    hist.set(k, {
                        jiraStatus: name,
                        preset,
                        count: 1,
                        mapped,
                        viaDefault,
                        sampleProjects: new Set([jp.key]),
                    });
                }
                projectIssueCount++;
            }
            if (resp.isLast || !resp.nextPageToken)
                break;
            nextPageToken = resp.nextPageToken;
        }
        process.stdout.write(`  ${jp.key} (${preset}): ${projectIssueCount} issues\n`);
    }
    await prisma.$disconnect();
    const rows = Array.from(hist.values()).sort((a, b) => b.count - a.count);
    console.log('\n=== All Jira statuses (sorted by count) ===\n');
    console.log('count  preset       jira status            →  nockta status     default?  sample projects');
    console.log('-----  -----------  ---------------------  -----------------    --------  ---------------');
    for (const r of rows) {
        const flag = r.viaDefault ? '  YES   ' : '   no   ';
        const sample = Array.from(r.sampleProjects).slice(0, 3).join(',')
            + (r.sampleProjects.size > 3 ? `…+${r.sampleProjects.size - 3}` : '');
        console.log(`${String(r.count).padStart(5)}  ${r.preset.padEnd(11)}  ${r.jiraStatus.padEnd(21)}  →  ${r.mapped.padEnd(17)}  ${flag}  ${sample}`);
    }
    const suspect = rows.filter((r) => r.viaDefault);
    console.log(`\n=== Suspect: ${suspect.length} status name(s) fell through to "Todo" by default ===\n`);
    for (const r of suspect) {
        console.log(`  "${r.jiraStatus}" (${r.preset}) — ${r.count} issue(s)`);
    }
    console.log('\nIf any of these should map to a different bucket (e.g. Done), tell me which');
    console.log('and I\'ll write a one-shot remap script that updates only the affected tasks.');
}
main().catch((e) => { console.error(e); process.exit(1); });
//# sourceMappingURL=audit-jira-statuses.js.map