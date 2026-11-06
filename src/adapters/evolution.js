// Adaptador da Evolution API (WhatsApp via Baileys).
// Outros canais (Meta oficial, Telegram, etc.) terao arquivos parecidos nesta pasta.

const baseUrl = () => (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');
const enc = encodeURIComponent;

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
  const data = await call(`/message/sendText/${enc(instance)}`, { body: { number, text } });
  return { externalId: data?.key?.id || null, raw: data };
}

// Imagem, video ou documento. media = base64 puro.
export async function sendMedia(instance, number, { mediatype, mimetype, fileName, caption, base64 }) {
  const body = { number, mediatype, mimetype, media: base64 };
  if (caption) body.caption = caption;
  // Peculiaridade da Evolution: imagem usa "filename" (minusculo); video e documento usam "fileName".
  if (mediatype === 'image') body.filename = fileName;
  else body.fileName = fileName;
  const data = await call(`/message/sendMedia/${enc(instance)}`, { body });
  return { externalId: data?.key?.id || null, raw: data };
}

// Audio como mensagem de voz. "encoding" converte para o formato do WhatsApp.
export async function sendAudio(instance, number, { mimetype, base64 }) {
  const data = await call(`/message/sendWhatsAppAudio/${enc(instance)}`, {
    body: { number, audio: `data:${mimetype};base64,${base64}`, encoding: true },
  });
  return { externalId: data?.key?.id || null, raw: data };
}

// Baixa a midia de uma mensagem recebida (devolve { base64, mimetype, fileName, ... }).
// 1a tentativa: manda a mensagem completa (nao depende do banco da Evolution e evita um
// erro conhecido com audios); 2a tentativa: so a chave.
export async function getMediaBase64(instance, key, message) {
  const attempts = [];
  if (message) attempts.push({ message: { key, message }, convertToMp4: false });
  attempts.push({ message: { key: { id: key.id } }, convertToMp4: false });

  let lastErr = new Error('Evolution nao devolveu a midia');
  for (const body of attempts) {
    try {
      const r = await call(`/chat/getBase64FromMediaMessage/${enc(instance)}`, { body });
      if (r?.base64) return r;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Confirma quais numeros existem no WhatsApp e devolve o endereco (JID) verdadeiro de cada um:
// [{ exists, jid, number }]
export async function checkNumbers(instance, numbers) {
  const data = await call(`/chat/whatsappNumbers/${enc(instance)}`, { body: { numbers } });
  return Array.isArray(data) ? data : [];
}

export async function connectionState(instance) {
  return call(`/instance/connectionState/${enc(instance)}`, { method: 'GET' });
}
