import { getUserFromToken, getProfile, sbAdmin, validateClientParams } from './_lib/shared.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const profile = await getProfile(user.id);
  if (!profile || (profile.role !== 'admin' && profile.role !== 'superadmin')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { agent_id, action, client_params } = req.body || {};
  if (!agent_id || (action !== 'save_draft' && action !== 'publish')) {
    return res.status(400).json({ error: 'agent_id and a valid action are required' });
  }

  const [agent] = await sbAdmin(`agents?id=eq.${agent_id}&select=*`);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (!agent.org_id || (agent.org_id !== profile.org_id && profile.role !== 'superadmin')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!agent.template_key) {
    return res.status(400).json({ error: 'Cet agent n\'est pas encore migré vers le système de templates.' });
  }

  let template = null;
  if (agent.template_key) {
    const [t] = await sbAdmin(`agent_templates?key=eq.${encodeURIComponent(agent.template_key)}&select=*`);
    template = t || null;
  }

  try {
    if (action === 'save_draft') {
      const validated = validateClientParams(client_params, template);
      await sbAdmin(`agents?id=eq.${agent_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ draft_client_params: validated })
      });
      return res.status(200).json({ success: true, draft_client_params: validated });
    }

    // publish: promote the current draft to live. Re-validates the draft
    // against the template before publishing, in case the template's
    // use_cases changed since the draft was saved.
    if (!agent.draft_client_params) {
      return res.status(400).json({ error: 'Aucun brouillon à publier.' });
    }
    const validated = validateClientParams(agent.draft_client_params, template);
    await sbAdmin(`agents?id=eq.${agent_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ client_params: validated })
    });
    return res.status(200).json({ success: true, client_params: validated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
