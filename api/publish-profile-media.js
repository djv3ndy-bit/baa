import { createMediaPublisher } from '../server/moderation/mediaPublication.mjs';

const publish = createMediaPublisher();
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'ugc_method_not_allowed' }); }
  const result = await publish({ authorization: req.headers.authorization, body: req.body });
  return res.status(result.status).json(result.body);
}
