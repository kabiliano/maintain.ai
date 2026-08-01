const SUPABASE_URL = 'https://cjlizuuaxucbpqykregv.supabase.co';

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

function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40) + '-' + Date.now().toString(36);
}

const STARTER_AGENT_PROMPT = `Tu es l'assistant IA de cette organisation. Tu aides l'équipe à retrouver des informations dans les documents fournis, répondre à des questions opérationnelles, et rédiger des messages ou des synthèses.

Appuie-toi en priorité sur les documents fournis et cite ta source [Source: nom_fichier]. Si l'information demandée n'est dans aucun document fourni, dis-le clairement plutôt que d'inventer une réponse.

Sois concis : 3 à 8 phrases suffisent pour la plupart des réponses, sauf si on te demande explicitement plus de détail. Si la question fait suite à un échange précédent, appuie-toi sur ce contexte sans le répéter.

Réponds en français, ton clair et professionnel.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, fullName, companyName } = req.body || {};
  if (!email || !fullName || !companyName) {
    return res.status(400).json({ error: 'Nom, email et nom d\'entreprise sont requis.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }

  try {
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const [org] = await sb('organizations', {
      method: 'POST',
      body: JSON.stringify({ name: companyName, slug: slugify(companyName), plan: 'trial', trial_ends_at: trialEndsAt })
    });

    await sb('agents', {
      method: 'POST',
      body: JSON.stringify({
        org_id: org.id,
        name: 'Assistant',
        description: 'Assistant IA polyvalent — à personnaliser selon votre activité',
        icon: '✦',
        color: '#00e0a0',
        prompt: STARTER_AGENT_PROMPT,
        is_default: true
      })
    });

    return res.status(200).json({ orgId: org.id });
  } catch (err) {
    console.error('signup-trial error:', err);
    return res.status(500).json({ error: "Erreur serveur, réessayez." });
  }
}
