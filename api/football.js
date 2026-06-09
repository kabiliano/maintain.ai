export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const { endpoint, params } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint requis' });

  const url = new URL(`https://v3.football.api-sports.io/${endpoint}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'x-apisports-key': '2052a59717960ab894f10b21c3d480e4'
      }
    });
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
