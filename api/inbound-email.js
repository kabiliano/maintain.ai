import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = 'https://cjlizuuaxucbpqykregv.supabase.co';

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function verifySignature(rawBody, headers, secret) {
  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature || !secret) return false;

  const secretBytes = Buffer.from(secret.split('_')[1], 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedSig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  return svixSignature.split(' ').some((entry) => {
    const [, sig] = entry.split(',');
    if (!sig) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'base64'), Buffer.from(expectedSig, 'base64'));
    } catch {
      return false;
    }
  });
}

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...options.headers
    }
  });
  if (!res.ok) throw new Error(`Supabase ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function callClaude(system, userText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: userText }]
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

function decodeHtml(html, htmlFormat) {
  if (htmlFormat === 'data_uri' && html.startsWith('data:')) {
    const base64 = html.split(',')[1];
    return base64 ? Buffer.from(base64, 'base64').toString('utf8') : '';
  }
  return html;
}

function extractBody(content) {
  if (content.text) return content.text.trim();
  if (content.html) {
    const html = decodeHtml(content.html, content.html_format);
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

// Les prompts "Patrimoine" produisent : Urgence / Responsabilité / --- / [email].
// Seul ce qui suit le dernier séparateur "---" doit partir au destinataire —
// le reste est une analyse interne destinée au gestionnaire, pas au client.
function extractEmailBody(agentResponse) {
  const lines = agentResponse.split('\n');
  let lastSepIdx = -1;
  lines.forEach((line, i) => { if (line.trim() === '---') lastSepIdx = i; });
  const raw = lastSepIdx === -1 ? agentResponse : lines.slice(lastSepIdx + 1).join('\n');
  return raw.replace(/\*\*(.*?)\*\*/g, '$1').replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1').trim();
}

function parseFromHeader(from) {
  const match = from.match(/^(.*?)\s*<(.+)>$/);
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() };
  return { name: null, email: from.trim() };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);

  if (!verifySignature(rawBody, req.headers, process.env.RESEND_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(rawBody);
  if (event.type !== 'email.received') return res.status(200).json({ ignored: true });

  try {
    const { email_id, from, to, subject } = event.data;
    const recipient = (to || [])[0] || '';
    const slug = recipient.split('@')[0];

    // Récupère le vrai corps du mail (le webhook ne contient que les métadonnées)
    const contentRes = await fetch(`https://api.resend.com/emails/receiving/${email_id}`, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }
    });
    const content = await contentRes.json();
    console.log('inbound content status:', contentRes.status, 'keys:', Object.keys(content),
      'text_len:', content.text?.length, 'html_len:', content.html?.length, 'html_format:', content.html_format);

    const body = extractBody(content);
    console.log('extracted body length:', body.length, 'preview:', body.slice(0, 200));

    const [org] = await sb(`organizations?slug=eq.${encodeURIComponent(slug)}&select=id,name`);
    if (!org) {
      console.error('No organization found for slug:', slug);
      return res.status(200).json({ ignored: true, reason: 'unknown_org_slug' });
    }

    const agents = await sb(`agents?org_id=eq.${org.id}&select=name,description,prompt`);
    const manager = agents.find((a) => a.name.toLowerCase().includes('manager'));
    const experts = agents.filter((a) => a !== manager);

    const { name: fromName, email: fromEmail } = parseFromHeader(from);
    const emailText = `De : ${fromName || fromEmail} <${fromEmail}>\nObjet : ${subject || '(sans objet)'}\n\n${body}`;

    let targetAgent = experts[0];
    let urgence = null;
    let typeExpediteur = null;

    if (manager) {
      const routingReply = await callClaude(manager.prompt, emailText);
      try {
        const routing = JSON.parse(routingReply.replace(/```json|```/g, '').trim());
        const agentName = routing.agent || routing.agents?.[0];
        const found = experts.find((a) => a.name === agentName);
        if (found) targetAgent = found;
        if (typeof routing.urgence === 'number') urgence = routing.urgence;
        if (routing.type_expediteur) typeExpediteur = routing.type_expediteur;
      } catch (e) {
        console.error('Routing parse failed, falling back to first expert:', e.message);
      }
    }

    let draftReply = '';
    if (targetAgent) {
      const rawReply = await callClaude(
        `${targetAgent.prompt}\n\nOrganisation : ${org.name}`,
        emailText
      );
      draftReply = extractEmailBody(rawReply);
    }

    await sb('inbound_emails', {
      method: 'POST',
      body: JSON.stringify({
        org_id: org.id,
        from_email: fromEmail,
        from_name: fromName,
        subject: subject || '(sans objet)',
        body,
        agent_name: targetAgent?.name || null,
        urgence,
        draft_reply: draftReply,
        status: 'pending'
      })
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('inbound-email error:', err);
    return res.status(500).json({ error: err.message });
  }
}
