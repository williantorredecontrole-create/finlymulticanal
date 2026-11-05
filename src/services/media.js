import crypto from 'node:crypto';
import { supabase } from '../db.js';
import * as evolution from '../adapters/evolution.js';

export const BUCKET = 'media';
export const MAX_BYTES = 20 * 1024 * 1024; // envio pelo painel
export const MAX_INBOUND_BYTES = 30 * 1024 * 1024; // recebimento

// Tipos de mensagem do WhatsApp que carregam arquivo
export const MEDIA_TYPES = {
  imageMessage: { type: 'image' },
  videoMessage: { type: 'video' },
  audioMessage: { type: 'audio' },
  documentMessage: { type: 'document' },
  stickerMessage: { type: 'sticker' },
};

const EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Nome seguro para o Storage (so ASCII)
export function safeName(name) {
  const s = String(name || 'arquivo')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '');
  return (s || 'arquivo').slice(-80);
}

export function defaultName(type, mime) {
  const ext = EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || 'bin';
  return `${type}-${Date.now()}.${ext}`;
}

// image | video | audio | document (SVG vira documento por seguranca)
export function kindFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/svg+xml') return 'document';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

// Texto curto para a lista de conversas
export function previewFor(type, caption, name) {
  const icon = { image: '📷', video: '🎥', audio: '🎤', document: '📄', sticker: '🏷️' }[type] || '📎';
  if (type === 'document') return `${icon} ${name || 'Documento'}`;
  const label = { image: 'Foto', video: 'Vídeo', audio: 'Áudio', sticker: 'Figurinha' }[type] || 'Arquivo';
  return caption ? `${icon} ${caption}` : `${icon} ${label}`;
}

export function mediaPath(channelId, conversationId, name) {
  return `${channelId}/${conversationId}/${crypto.randomUUID()}-${safeName(name)}`;
}

// ---------- Storage ----------

export async function ensureMediaBucket() {
  const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (error && !/exist|duplicate/i.test(error.message)) throw error;
}

export async function uploadMedia(path, buffer, mime) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType: mime, upsert: false });
  if (error) throw error;
}

export async function downloadMedia(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

// ---------- midia recebida ----------

// Baixa da Evolution e guarda no Storage. Tenta 3 vezes (a Evolution pode demorar a ter o arquivo).
export async function fetchInboundMedia({ channel, messageId, conversationId, type, key, rawMessage }) {
  let lastErr;
  for (const wait of [0, 4000, 12000]) {
    if (wait) await sleep(wait);
    try {
      const { data: row } = await supabase.from('messages').select('id,media_path').eq('id', messageId).maybeSingle();
      if (!row || row.media_path) return; // sumiu, ou ja tem (ex.: enviada pelo painel)

      const r = await evolution.getMediaBase64(channel.instance_name, key, rawMessage);
      const buffer = Buffer.from(String(r.base64).replace(/^data:[^,]*,/, ''), 'base64');
      if (!buffer.length) throw new Error('midia vazia');
      if (buffer.length > MAX_INBOUND_BYTES) throw new Error('midia grande demais');

      const mime = String(r.mimetype || 'application/octet-stream').split(';')[0].trim().toLowerCase();
      const name = r.fileName || defaultName(type, mime);
      const path = mediaPath(channel.id, conversationId, name);
      await uploadMedia(path, buffer, mime);

      const { error } = await supabase
        .from('messages')
        .update({ media_path: path, media_mime: mime, media_name: name, media_size: buffer.length })
        .eq('id', messageId);
      if (error) throw error;
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
