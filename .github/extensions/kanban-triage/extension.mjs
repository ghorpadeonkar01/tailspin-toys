import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCanvas, joinSession } from '@github/copilot-sdk/extension';

const execFileAsync = promisify(execFile);
const servers = new Map();

async function getRepository() {
  const { stdout } = await execFileAsync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const repository = stdout.trim();
  if (!repository) throw new Error('Could not determine the current GitHub repository.');
  return repository;
}

async function getIssues() {
  const repository = await getRepository();
  const { stdout } = await execFileAsync('gh', [
    'issue', 'list', '--repo', repository, '--state', 'open', '--limit', '100',
    '--json', 'number,title,body,labels,updatedAt,createdAt,assignees,url',
  ]);
  const now = Date.now();
  return JSON.parse(stdout).map((issue) => {
    const labels = issue.labels.map((label) => label.name.toLowerCase());
    const ageDays = Math.max(0, Math.floor((now - Date.parse(issue.createdAt)) / 86_400_000));
    const recentlyUpdated = now - Date.parse(issue.updatedAt) <= 7 * 86_400_000;
    const urgentLabel = labels.some((label) => /priority|urgent|bug|security|blocking/.test(label));
    const score = (issue.assignees.length ? 0 : 3) + (urgentLabel ? 3 : 0) + (recentlyUpdated ? 2 : 0) + (ageDays >= 14 ? 1 : 0);
    const reasons = [];
    if (!issue.assignees.length) reasons.push('it is unassigned');
    if (urgentLabel) reasons.push('it carries an urgent, bug, security, or blocking label');
    if (recentlyUpdated) reasons.push('it has been updated in the last 7 days');
    if (ageDays >= 14) reasons.push('it has been open for more than two weeks');
    return {
      ...issue,
      labels: labels.map((name) => ({ name })),
      description: issue.body?.trim() || 'No description was provided.',
      justification: reasons.join('; ') || 'it is among the oldest remaining open issues',
      score,
    };
  }).sort((a, b) => b.score - a.score || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.number - b.number);
}

async function addIssueToContext(number, session) {
  const issue = (await getIssues()).find((candidate) => candidate.number === number);
  if (!issue) throw new Error('That issue is no longer open.');
  await session.send({
    prompt: `Add GitHub issue #${issue.number} to the current work context and begin triaging it.\n\nTitle: ${issue.title}\nURL: ${issue.url}\nDescription:\n${issue.description}`,
  });
  return `Issue #${issue.number} was added to the current session context.`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20_000) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function renderHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Issue triage board</title>
<style>
:root{color-scheme:light dark;--surface:color-mix(in srgb,var(--background-color-default,#fff) 94%,var(--text-color-default,#1f2328) 6%);--strong:color-mix(in srgb,var(--background-color-default,#fff) 86%,var(--text-color-default,#1f2328) 14%)}*{box-sizing:border-box}body{margin:0;background:var(--background-color-default,#fff);color:var(--text-color-default,#1f2328);font:var(--text-body-medium,14px)/var(--leading-body-medium,20px) var(--font-sans,system-ui,sans-serif)}main{max-width:980px;margin:auto;padding:24px}header{align-items:end;border-bottom:1px solid var(--border-color-default,#d0d7de);display:flex;justify-content:space-between;margin-bottom:22px;padding-bottom:18px;gap:16px}h1{font-size:28px;line-height:1.15;margin:0}h2{font-size:16px;margin:0 0 10px}h3{font-size:15px;line-height:1.35;margin:0}p{margin:0}.lede,.meta{color:var(--text-color-muted,#59636e)}.lede{margin-top:6px}section+section{margin-top:26px}.cards{display:grid;gap:12px}article{background:var(--surface);border:1px solid var(--border-color-default,#d0d7de);border-radius:10px;padding:15px}article.top{border-left:4px solid var(--true-color-blue,#0969da)}.card-head{align-items:start;display:flex;gap:12px;justify-content:space-between}h3 a{color:inherit;text-decoration:none}h3 a:hover{text-decoration:underline}.meta{font-size:12px;margin-top:8px}.description{margin:10px 0;white-space:pre-line}.why{background:var(--strong);border-radius:7px;color:var(--text-color-muted,#59636e);font-size:12px;margin:10px 0 12px;padding:8px 10px}.why strong{color:var(--text-color-default,#1f2328)}.labels{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}.label{background:var(--true-color-blue-muted,#ddf4ff);border-radius:999px;color:var(--true-color-blue,#0969da);font-size:11px;padding:2px 7px}button{background:var(--true-color-blue,#0969da);border:1px solid var(--true-color-blue,#0969da);border-radius:7px;color:var(--color-white,#fff);cursor:pointer;font:inherit;font-weight:var(--font-weight-semibold,600);min-height:34px;padding:6px 10px;white-space:nowrap}button:hover:not(:disabled){filter:brightness(.9)}button:disabled{cursor:wait;opacity:.65}button:focus-visible{outline:2px solid var(--color-focus-outline,#0969da);outline-offset:2px}#status{color:var(--text-color-muted,#59636e);min-height:20px}.error{color:var(--true-color-red,#cf222e)!important}.empty{border:1px dashed var(--border-color-default,#d0d7de);border-radius:8px;color:var(--text-color-muted,#59636e);padding:16px}@media(max-width:620px){main{padding:16px}header{align-items:start;flex-direction:column}.card-head{flex-direction:column}}
</style></head><body><main><header><div><h1>Issue triage board</h1><p class="lede">Open work ranked by likely urgency and ownership gaps.</p></div><button id="refresh" type="button">Refresh</button></header><p id="status" role="status" aria-live="polite">Loading open issues...</p><section><h2>Needs attention now</h2><div id="top" class="cards"></div></section><section><h2>Remainder of open work</h2><div id="rest" class="cards"></div></section></main>
<script>
const topCards=document.querySelector('#top'),rest=document.querySelector('#rest'),status=document.querySelector('#status'),refresh=document.querySelector('#refresh');const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);const card=(i,t)=>\`<article class="\${t?'top':''}"><div class="card-head"><div><h3><a href="\${esc(i.url)}" target="_blank" rel="noreferrer">#\${i.number} · \${esc(i.title)}</a></h3><p class="meta">Updated \${new Date(i.updatedAt).toLocaleDateString()}</p></div><button type="button" data-issue="\${i.number}">Add to context</button></div><p class="description">\${esc(i.description)}</p>\${t?\`<p class="why"><strong>Why it is here:</strong> \${esc(i.justification)}.</p>\`:''}<div class="labels">\${i.labels.map((l)=>\`<span class="label">\${esc(l.name)}</span>\`).join('')}</div></article>\`;const load=async()=>{refresh.disabled=true;status.className='';status.textContent='Loading open issues...';try{const r=await fetch('/api/issues'),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not load issues.');topCards.innerHTML=d.issues.slice(0,3).map((i)=>card(i,true)).join('')||'<div class="empty">No open issues.</div>';rest.innerHTML=d.issues.slice(3).map((i)=>card(i,false)).join('')||'<div class="empty">All open issues are in the attention section.</div>';status.textContent=d.issues.length+' open issue(s)'}catch(e){topCards.innerHTML=rest.innerHTML='';status.className='error';status.textContent=e.message}finally{refresh.disabled=false}};document.addEventListener('click',async(e)=>{const b=e.target.closest('[data-issue]');if(!b)return;b.disabled=true;b.textContent='Adding...';try{const r=await fetch('/api/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number:Number(b.dataset.issue)})}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not add issue.');b.textContent='Added';status.textContent=d.message}catch(err){b.disabled=false;b.textContent='Add to context';status.className='error';status.textContent=err.message}});refresh.addEventListener('click',load);load();
</script></body></html>`;
}

async function startServer(session) {
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url === '/api/issues' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ issues: await getIssues() }));
        return;
      }
      if (request.url === '/api/add' && request.method === 'POST') {
        const payload = JSON.parse(await readBody(request));
        if (!Number.isInteger(payload.number)) throw new Error('A valid issue number is required.');
        const message = await addIssueToContext(payload.number, session);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ message }));
        return;
      }
      if (request.url === '/' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(renderHtml());
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Not found.' }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
  canvases: [createCanvas({
    id: 'kanban-triage',
    displayName: 'Issue triage board',
    description: 'Interactive board that ranks open repository issues and adds selected issues to the current session context.',
    actions: [{
      name: 'add_issue_to_context',
      description: 'Add an open GitHub issue from the board to the current session context.',
      inputSchema: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'], additionalProperties: false },
      handler: async (ctx) => ({ message: await addIssueToContext(ctx.input.number, session) }),
    }],
    open: async (ctx) => {
      let entry = servers.get(ctx.instanceId);
      if (!entry) {
        entry = await startServer(session);
        servers.set(ctx.instanceId, entry);
      }
      return { title: 'Issue triage board', url: entry.url };
    },
    onClose: async (ctx) => {
      const entry = servers.get(ctx.instanceId);
      if (entry) {
        servers.delete(ctx.instanceId);
        await new Promise((resolve) => entry.server.close(() => resolve()));
      }
    },
  })],
});
