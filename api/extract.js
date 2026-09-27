// Vercel serverless function → /api/extract
import { extract } from '../lib/extract-core.js';
export const config = { maxDuration: 60 };
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  const out = await extract({ body: req.body, headers: req.headers, env: process.env });
  return res.status(out.status).json(out.body);
}
