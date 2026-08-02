import { getUserFromToken, getProfile, sbAdmin, isRateLimited, composeAgentSystemPrompt } from './_lib/shared.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_CONTEXT_LEN = 50_000; // sanity cap on docsCtx/footballCtx, not a security boundary

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (isRateLimited(user.id)) {
    return res.status(429).json({ error: 'Trop de requêtes, réessaie dans une minute.' });
  }

  const profile = await getProfile(user.id);
  if (!profile) return res.status(401).json({ error: 'Unauthorized' });

  const { agent_id, messages, docsCtx, footballCtx, tools, preview } = req.body || {};

  if (!agent_id || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'agent_id and messages are required' });
  }

  const [agent] = await sbAdmin(`agents?id=eq.${agent_id}&select=*`);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Global agents (org_id null) are shared across orgs; org-specific agents
  // must belong to the caller's own organization — except superadmins, who
  // can switch orgs client-side (org switcher) and legitimately chat with
  // any org's agents, matching their existing broad access elsewhere in the app.
  if (agent.org_id && agent.org_id !== profile.org_id && profile.role !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const effectiveOrgId = agent.org_id || profile.org_id;

  let template = null;
  if (agent.template_key) {
    const [t] = await sbAdmin(`agent_templates?key=eq.${encodeURIComponent(agent.template_key)}&select=*`);
    template = t || null;
  }

  // Preview mode (sandbox) composes with the draft params so admins can test
  // unpublished changes without affecting real users/emails. Only agents
  // with a role of admin/superadmin may preview drafts belonging to their org.
  const wantsDraft = preview && (profile.role === 'admin' || profile.role === 'superadmin');
  const activeParams = wantsDraft && agent.draft_client_params ? agent.draft_client_params : agent.client_params;

  const { text: systemText, extraBlocks } = composeAgentSystemPrompt({ ...agent, _activeParams: activeParams }, template);

  const systemBlocks = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral', ttl: '1h' } }, ...extraBlocks];

  // The Manager routing call sends no docsCtx (it only needs the routing
  // prompt, same as before this endpoint existed) — skip org/docs context
  // entirely in that case rather than appending an irrelevant block.
  if (typeof docsCtx === 'string' || typeof footballCtx === 'string') {
    let orgName = '';
    if (effectiveOrgId) {
      const [org] = await sbAdmin(`organizations?id=eq.${effectiveOrgId}&select=name`);
      orgName = org?.name || '';
    }
    const safeDocsCtx = typeof docsCtx === 'string' ? docsCtx.slice(0, MAX_CONTEXT_LEN) : '';
    const safeFootballCtx = typeof footballCtx === 'string' ? footballCtx.slice(0, MAX_CONTEXT_LEN) : '';
    systemBlocks.push({ type: 'text', text: `\n\nOrganisation : ${orgName}${safeDocsCtx}`, cache_control: { type: 'ephemeral', ttl: '1h' } });
    if (safeFootballCtx) {
      systemBlocks.push({ type: 'text', text: safeFootballCtx });
    }
  }

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemBlocks,
    messages
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
