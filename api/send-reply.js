import { getUserFromToken, getProfile, sbAdmin } from './_lib/shared.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const profile = await getProfile(user.id);
  if (!profile || (profile.role !== 'admin' && profile.role !== 'superadmin')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { id, body } = req.body || {};
  if (!id || !body) {
    return res.status(400).json({ error: 'id et body sont requis.' });
  }

  try {
    const [item] = await sbAdmin(`inbound_emails?id=eq.${id}&select=*`);
    if (!item) return res.status(404).json({ error: 'Email introuvable.' });
    if (item.org_id !== profile.org_id && profile.role !== 'superadmin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // from/to/subject are derived server-side from the actual pending
    // record, never trusted from the client — the client only supplies
    // the (possibly edited) reply text.
    const [org] = await sbAdmin(`organizations?id=eq.${item.org_id}&select=slug`);
    const from = `${org?.slug || 'contact'}@send.wrz-digital.com`;
    const subject = item.subject?.startsWith('Re:') ? item.subject : `Re: ${item.subject || 'Votre message'}`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({ from, to: [item.from_email], subject, text: body })
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('Resend send-reply error:', errText);
      return res.status(502).json({ error: "Échec de l'envoi, réessayez." });
    }

    await sbAdmin(`inbound_emails?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'sent', sent_at: new Date().toISOString(), draft_reply: body })
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('send-reply error:', err);
    return res.status(500).json({ error: 'Erreur serveur, réessayez.' });
  }
}
