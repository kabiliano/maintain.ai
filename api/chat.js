const SUPABASE_URL = 'https://cjlizuuaxucbpqykregv.supabase.co';
const ALLOWED_MODELS = new Set(['claude-sonnet-4-6']);
const MAX_TOKENS_LIMIT = 8192;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

// Best-effort only: resets whenever the serverless instance is recycled.
const rateLimitBuckets = new Map();

async function getUserFromToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`
    }
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ? user : null;
}

function isRateLimited(userId) {
  const now = Date.now();
  const recent = (rateLimitBuckets.get(userId) || []).filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitBuckets.set(userId, recent);
    return true;
  }
  recent.push(now);
  rateLimitBuckets.set(userId, recent);
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (isRateLimited(user.id)) {
    return res.status(429).json({ error: 'Trop de requêtes, réessaie dans une minute.' });
  }

  const { model, max_tokens, system, messages, tools, tool_choice } = req.body || {};

  if (!ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ error: 'Invalid model' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages is required' });
  }

  const safeBody = {
    model,
    max_tokens: Math.min(Number(max_tokens) || 4096, MAX_TOKENS_LIMIT),
    system,
    messages,
    ...(tools ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {})
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(safeBody)
    });
    const data = await response.json();
    if (data.usage) {
      console.log('[anthropic-usage]', JSON.stringify({
        user_id: user.id,
        model: safeBody.model,
        input_tokens: data.usage.input_tokens,
        cache_creation_input_tokens: data.usage.cache_creation_input_tokens,
        cache_read_input_tokens: data.usage.cache_read_input_tokens,
        output_tokens: data.usage.output_tokens
      }));
    }
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
