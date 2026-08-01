export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { from, to, subject, body } = req.body || {};
  if (!from || !to || !body) {
    return res.status(400).json({ error: 'from, to et body sont requis.' });
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: subject?.startsWith('Re:') ? subject : `Re: ${subject || 'Votre message'}`,
        text: body
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('Resend send-reply error:', errText);
      return res.status(502).json({ error: "Échec de l'envoi, réessayez." });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('send-reply error:', err);
    return res.status(500).json({ error: 'Erreur serveur, réessayez.' });
  }
}
