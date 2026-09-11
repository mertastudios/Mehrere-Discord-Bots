/**
 * Anti-Delete für den Sicherheitsbot (/set_anti_delete_messages).
 *
 * Wenn der Modus für eine Gilde aktiviert ist und ein ECHTER Nutzer (keine
 * Bots, keine Webhooks, keine Systemnachrichten) seine eigene Nachricht
 * löscht, sendet der Bot sie erneut – per Webhook mit exakter Profil-Kopie
 * (Anzeigename + Avatar des Verfassers, wie vom Nutzer sichtbar).
 *
 * Wichtige Grenzen (bewusst so gewählt):
 * - NUR die jeweils LETZTE Nachricht eines Kanals wird zurückgeholt. Liegt
 *   inzwischen eine neuere Nachricht davor/danach, würde ein erneutes Senden
 *   den Chat-Verlauf nur durcheinanderbringen.
 * - Erwähnungen pingen beim erneuten Senden niemanden (allowedMentions: []) –
 *   sonst wäre Anti-Delete ein perfektes Ghost-Ping-Werkzeug (@everyone senden,
 *   löschen, der Bot pingt erneut).
 * - Es gibt keine Admin-Ausnahme: Das ist kein Moderations-Feature, sondern
 *   eine Chat-Integritäts-Funktion für alle echten Nutzer.
 * - Discord liefert messageDelete im Normalfall nur für gecachte Nachrichten –
 *   genau die frischen "letzten Nachrichten", um die es hier geht. Sehr alte,
 *   nie gecachte Nachrichten kann der Bot ohne Inhalt ohnehin nicht korrekt
 *   erneut senden (Profil-Kopie braucht Verfasser + Text).
 *
 * Webhooks werden pro Kanal wiederverwendet (ein bot-eigener Webhook pro
 * Kanal, bei Threads am Parent-Kanal) und im RAM gecacht. Fehlt dem Bot die
 * "Webhooks verwalten"-Berechtigung, landet eine Warnung im Server-Log –
 * mehrfach wird das Anlegen erst nach 5 Minuten erneut versucht.
 */

const WEBHOOK_NAME = 'Security Anti-Delete';
const WEBHOOK_RETRY_MS = 5 * 60 * 1000;
const MAX_RESEND_CONTENT = 2000; // Nachrichten-Limit auch für Webhooks

// channelHostId -> { webhook|null, checkedAt } (null = Anlegen fehlgeschlagen, gebremst)
const webhookCache = new Map();

/** Cache leeren (z. B. wenn der Bot eine Gilde verlässt). */
function clearWebhookCache() {
  webhookCache.clear();
}

/** Verwirft den Cache-Eintrag für einen Kanal (z. B. nach "Unknown Webhook"). */
function invalidateWebhookForChannel(channel) {
  const host = hostChannelOf(channel);
  if (host) webhookCache.delete(String(host.id));
}

/** Kanal, an dem der Webhook hängen muss (bei Threads: der Parent-Kanal). */
function hostChannelOf(channel) {
  if (!channel) return null;
  const isThread = typeof channel.isThread === 'function' && channel.isThread();
  return isThread ? channel.parent || null : channel;
}

/**
 * Liefert einen bot-eigenen Webhook für den Kanal (lege ihn bei Bedarf an).
 * Rückgabe null, wenn nicht möglich (fehlende Rechte, API-Fehler) – Fehler
 * werden für WEBHOOK_RETRY_MS negativ gecacht, damit nicht jede gelöschte
 * Nachricht einen neuen API-Versuch auslöst.
 */
async function resolveWebhook({ ctx, channel }) {
  const host = hostChannelOf(channel);
  if (!host || typeof host.fetchWebhooks !== 'function') return null;

  const key = String(host.id);
  const cached = webhookCache.get(key);
  if (cached) {
    if (cached.webhook) return cached.webhook;
    if (Date.now() - cached.checkedAt < WEBHOOK_RETRY_MS) return null;
  }

  let webhook = null;
  try {
    const existing = await host.fetchWebhooks();
    // Jeder Webhook, der diesem Bot gehört, eignet sich – Name/Avatar werden
    // beim Senden ohnehin pro Nachricht auf die Profil-Kopie überschrieben.
    webhook = existing?.find
      ? existing.find((w) => w.owner && ctx.client?.user && w.owner.id === ctx.client.user.id) || null
      : null;
    if (!webhook && typeof host.createWebhook === 'function') {
      webhook = await host.createWebhook({
        name: WEBHOOK_NAME,
        reason: 'Anti-Delete: gelöschte letzte Nachrichten mit Profil-Kopie erneut senden',
      });
    }
  } catch (err) {
    ctx.logger?.warn?.(
      `[security-bot] Anti-Delete: Kein Webhook für Kanal ${key} möglich (fehlt „Webhooks verwalten“?):`,
      err?.message || err
    );
    webhook = null;
  }
  webhookCache.set(key, { webhook, checkedAt: Date.now() });
  return webhook;
}

/**
 * War die gelöschte Nachricht die LETZTE Nachricht des Kanals?
 * Nach der Löschung ist die neueste verbleibende Nachricht älter – und
 * Snowflake-IDs sind chronologisch sortierbar. Bei Unklarheit (Fetch-Fehler)
 * lieber nichts erneut senden, statt den Verlauf zu verwürfeln.
 */
async function wasLastChannelMessage(message) {
  const channel = message.channel;
  if (!channel || typeof channel.messages?.fetch !== 'function') return false;
  let recent = null;
  try {
    recent = await channel.messages.fetch({ limit: 1 });
  } catch {
    return false;
  }
  const newest = recent?.first?.() || null;
  if (!newest) return true; // Kanal ist jetzt leer → die gelöschte war die letzte (einzige)
  try {
    return BigInt(message.id) > BigInt(newest.id);
  } catch {
    return String(message.id) > String(newest.id);
  }
}

/**
 * Haupt-Einstieg für jedes messageDelete-Event.
 * Sendet die gelöschte Nachricht ggf. per Webhook mit Profil-Kopie erneut.
 */
async function handleMessageDelete({ ctx, message }) {
  try {
    if (!message?.guild) return; // DMs / partielle Events ohne Gilde
    const guildId = String(message.guild.id);
    if (!ctx.store?.getAntiDeleteEnabled?.(guildId)) return;

    // NUR echte Nutzer: Bots, Webhooks & Systemnachrichten sind ausgenommen.
    if (!message.author || message.author.bot || message.webhookId) return;
    if (message.system) return;
    if (ctx.client?.user && message.author.id === ctx.client.user.id) return;

    const content = String(message.content || '').trim();
    const attachments =
      message.attachments && typeof message.attachments.values === 'function'
        ? [...message.attachments.values()]
        : [];
    // Sticker-/Interact-Nachrichten ohne Text & Anhänge: nichts Sendbares da.
    if (!content && attachments.length === 0) return;

    // Nur zurückholen, wenn es wirklich die letzte Nachricht des Kanals war.
    if (!(await wasLastChannelMessage(message))) return;

    const channel =
      message.channel ||
      (await ctx.client?.channels?.fetch?.(message.channelId).catch(() => null)) ||
      null;
    if (!channel) return;

    const webhook = await resolveWebhook({ ctx, channel });
    if (!webhook || typeof webhook.send !== 'function') {
      ctx.logger?.warn?.(
        `[security-bot] Anti-Delete ist aktiv (Gilde ${guildId}), aber es gibt keinen nutzbaren ` +
          `Webhook in Kanal ${message.channelId}.`
      );
      return;
    }

    // Exakte Profil-Kopie: Anzeigename + Avatar, wie im Server sichtbar.
    const member = message.member || null;
    const username = String(
      member?.displayName ||
        message.author.globalName ||
        message.author.username ||
        'Unbekannter Nutzer'
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Unbekannter Nutzer';
    let avatarURL = null;
    try {
      avatarURL = member?.displayAvatarURL?.() || message.author.displayAvatarURL?.() || null;
    } catch {
      avatarURL = null;
    }

    const files = attachments
      .slice(0, 10)
      .map((a) => a?.url)
      .filter((u) => typeof u === 'string' && u.startsWith('http'));

    const payload = {
      username,
      // Ghost-Ping-Schutz: Beim erneuten Senden pingt nichts und niemand.
      allowedMentions: { parse: [] },
    };
    if (avatarURL) payload.avatarURL = avatarURL;
    if (content) payload.content = content.slice(0, MAX_RESEND_CONTENT);
    if (files.length) payload.files = files;
    if (typeof channel.isThread === 'function' && channel.isThread()) {
      payload.threadId = String(channel.id);
    }

    await webhook.send(payload);
    ctx.logger?.info?.(
      `[security-bot] Anti-Delete: Gelöschte Nachricht von ${message.author.id} in Kanal ` +
        `${message.channelId} per Webhook erneut gesendet (Gilde ${guildId}).`
    );
  } catch (err) {
    // 10015 = Unknown Webhook (wurde zwischenzeitlich gelöscht) → neu anlegen lassen.
    if (err?.code === 10015) invalidateWebhookForChannel(message?.channel);
    ctx.logger?.warn?.(
      '[security-bot] Anti-Delete: Erneutes Senden fehlgeschlagen:',
      err?.message || err
    );
  }
}

module.exports = {
  handleMessageDelete,
  wasLastChannelMessage,
  resolveWebhook,
  clearWebhookCache,
  invalidateWebhookForChannel,
  WEBHOOK_NAME,
};
