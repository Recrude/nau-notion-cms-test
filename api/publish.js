// Triggers a rebuild. The deploy hook URL stays in a server-side environment
// variable: putting it in the page would hand every viewer the ability to spend
// the project's build minutes.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  const hook = process.env.DEPLOY_HOOK_URL;
  if (!hook) return res.status(500).json({ error: "DEPLOY_HOOK_URL is not set" });

  try {
    const r = await fetch(hook, { method: "POST" });
    const body = await r.text();
    if (!r.ok) return res.status(502).json({ error: `deploy hook returned ${r.status}`, body: body.slice(0, 300) });
    return res.status(200).json({ ok: true, triggered: new Date().toISOString() });
  } catch (err) {
    return res.status(502).json({ error: String(err) });
  }
}
