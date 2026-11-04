// Adaptador da Evolution API (WhatsApp via Baileys).
// Outros canais (Meta oficial, Telegram, etc.) terao arquivos parecidos nesta pasta.

const baseUrl = () => (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');

async function call(path, { method = 'POST', body } = {}) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.EVOLUTION_API_KEY || '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Evolution ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// number pode ser telefone (5562999999999) ou JID (5562999999999@s.whatsapp.net)
export async function sendText(instance, number, text) {
  const data = await call(`/message/sendText/${encodeURIComponent(instance)}`, {
    body: { number, text },
  });
  return { externalId: data?.key?.id || null, raw: data };
}

export async function connectionState(instance) {
  return call(`/instance/connectionState/${encodeURIComponent(instance)}`, { method: 'GET' });
}
