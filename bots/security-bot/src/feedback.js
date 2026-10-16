/**
 * ============================================================================
 *  Feedback: 👍 / 👎 an jeder Moderations-Meldung
 *
 *  - Die Zähler stehen im Button (`👍 (3)`), die Bewerter-LISTE steckt
 *    unsichtbar in der Nachricht (hidden.js) – keine Datenbank nötig.
 *  - Jedes Teammitglied (Owner/Admin) kann genau EINMAL abstimmen.
 *  - Beim Klick öffnet sich das Formular mit der Frage nach dem Grund (darf
 *    leer bleiben). Ist der Verstoß noch im Strafregister, kommt die Option
 *    „Aus dem Strafregister entfernen“ dazu (Haken standardmäßig aus).
 *  - Der Nutzer bekommt ein Dankeschön – das echte Feedback geht als DM an den
 *    Bot-Owner: Entscheidung, 👍/👎 und der Grund.
 *  - Wird ein Eintrag entfernt, landet das ebenfalls im Log (mit Namen).
 * ============================================================================
 */

const ui = require('./ui');
const { t } = require('./languages');
const { decodeLogState, encodeLogState, stripHidden } = require('./hidden');
const { logNotice, ACCENT } = require('./logging');

/** Alle Texte (TextDisplay-Inhalte) aus einem Nachrichten-Baum holen. */
function collectTexts(components) {
  const texts = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (!node) continue;
      const c = typeof node.toJSON === 'function' ? node.toJSON() : node;
      if (typeof c.content === 'string') texts.push(c.content);
      if (c.components) walk(c.components);
      if (c.accessory) walk([c.accessory]);
    }
  };
  walk(components);
  return texts;
}

function readState(message) {
  return decodeLogState(collectTexts(message?.components).join('\n'));
}

/** Klont die Komponenten und schreibt Zähler + Zustand neu. */
function patchComponents(components, state) {
  const cloned = (components || []).map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c));
  const blob = encodeLogState(state);

  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (!node) continue;
      if (node.type === 10 && typeof node.content === 'string' && !node.__patched) {
        node.content = `${stripHidden(node.content)}${blob}`;
        node.__patched = true;
      }
      if (node.type === 2 && typeof node.custom_id === 'string') {
        if (node.custom_id.startsWith('fb:up:')) node.label = `👍 (${state.up || 0})`;
        if (node.custom_id.startsWith('fb:down:')) node.label = `👎 (${state.down || 0})`;
      }
      if (node.components) walk(node.components);
    }
  };
  walk(cloned);
  for (const node of cloned) delete node.__patched;
  return cloned;
}

// ------------------------------ Buttons ------------------------------

async function handleFeedbackButton(ctx, interaction, vote) {
  const guild = interaction.guild;
  const lang = ctx.store.getGuild(guild.id).lang || 'de';
  const member = interaction.member;
  const { isTeamMember } = require('./guard');

  if (!isTeamMember(member, guild)) {
    return interaction.reply(ui.payload([ui.container([ui.text(t(lang, 'onlyTeam'))], { accentColor: 0xed4245 })], { ephemeral: true }));
  }

  const state = readState(interaction.message);
  if (state.voters?.[member.id]) {
    return interaction.reply(ui.payload([ui.container([ui.text(t(lang, 'fbAlready'))])], { ephemeral: true }));
  }

  // Strafregister-Einträge dieser Meldung, die es noch gibt
  const penalties = (state.penalties || [])
    .map((id) => ctx.store.getPenalty(id))
    .filter(Boolean);

  const question = vote === 'up' ? t(lang, 'fbQuestionUp') : t(lang, 'fbQuestionDown');
  const inputs = [
    ui.textInput({
      id: 'reason',
      label: question,
      style: 2,
      required: false,
      maxLength: 400,
      placeholder: t(lang, 'fbOptional'),
    }),
  ];
  if (vote === 'down' && penalties.length) {
    inputs.push(
      ui.checkboxGroup({
        id: 'remove',
        label: t(lang, 'fbRemoveLabel'),
        description: '',
        required: false,
        options: [{ label: t(lang, 'fbRemoveOption'), value: 'yes', default: false }],
      })
    );
  }

  const modalId = `fb:modal:${vote}`;
  try {
    await interaction.showModal(ui.modal({ id: modalId, title: question, components: inputs }));
  } catch (err) {
    // Ältere Discord-Clients/API: klassisches Modal ohne Häkchen
    ctx.logger?.warn?.('[security-bot] Modernes Feedback-Modal abgelehnt, nutze klassisches:', err.message);
    try {
      await interaction.showModal({
        custom_id: modalId,
        title: ui.clip(question, 45),
        components: [ui.row([{ type: 4, custom_id: 'reason', style: 2, required: false, max_length: 400, label: question, placeholder: t(lang, 'fbOptional') }])],
      });
    } catch (err2) {
      ctx.logger?.warn?.('[security-bot] Feedback-Formular fehlgeschlagen:', err2.message);
    }
  }
}

// ------------------------------ Modal-Antwort ------------------------------

async function handleFeedbackModal(ctx, interaction, vote) {
  const guild = interaction.guild;
  const lang = ctx.store.getGuild(guild.id).lang || 'de';
  const member = interaction.member;
  const { isTeamMember } = require('./guard');

  if (!isTeamMember(member, guild)) {
    return interaction.reply(ui.payload([ui.container([ui.text(t(lang, 'onlyTeam'))])], { ephemeral: true }));
  }

  const reason = String(interaction.fields?.getTextInputValue?.('reason') || '').trim();
  let removeEntry = false;
  try {
    const values = interaction.fields?.getCheckboxGroup?.('remove');
    if (Array.isArray(values) && values.includes('yes')) removeEntry = true;
  } catch {
    /* klassisches Modal ohne Häkchen */
  }

  const message = interaction.message;
  const state = readState(message);
  if (state.voters?.[member.id]) {
    return interaction.reply(ui.payload([ui.container([ui.text(t(lang, 'fbAlready'))])], { ephemeral: true }));
  }

  // 1) Stimme zählen
  state.voters[member.id] = vote === 'up' ? 1 : -1;
  state.up = (state.up || 0) + (vote === 'up' ? 1 : 0);
  state.down = (state.down || 0) + (vote === 'down' ? 1 : 0);

  // 2) Optional: Strafregister-Einträge entfernen
  const removed = [];
  if (removeEntry) {
    for (const id of [...(state.penalties || [])]) {
      const penalty = ctx.store.removePenalty(id);
      if (penalty) removed.push(penalty);
    }
    state.penalties = [];
  }

  // 3) Log-Nachricht aktualisieren (Zähler + kein Häkchen mehr)
  try {
    if (message?.components) {
      await message.edit({ flags: ui.FLAG_V2, components: patchComponents(message.components, state) });
    }
  } catch (err) {
    ctx.logger?.warn?.('[security-bot] Log-Nachricht konnte nicht aktualisiert werden:', err.message);
  }

  // 4) Entfernung des Register-Eintrags ins Log
  if (removed.length) {
    await logNotice(ctx, guild, {
      lang,
      title: t(lang, 'fbRemoveLog', {
        mod: `${member.displayName || member.user?.username || member.id} (<@${member.id}>)`,
        user: removed.map((p) => `${p.userName || p.userId} (<@${p.userId}>)`).join(', '),
      }),
      lines: removed.map((p) => `-# ${p.ruleLabel || p.ruleId || '—'} · ${p.action}${p.duration ? ` (${p.duration})` : ''} · ${new Date(p.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`),
      accentColor: ACCENT.warn,
    });
  }

  // 5) Echtes Feedback an den Bot-Owner
  await sendOwnerFeedback(ctx, {
    guild,
    member,
    message,
    vote,
    reason,
    removed,
  });

  // 6) Danke – aber privat
  return interaction.reply(ui.payload([ui.container([ui.text(t(lang, 'fbThanks'))], { accentColor: ACCENT.ok })], { ephemeral: true }));
}

async function sendOwnerFeedback(ctx, { guild, member, message, vote, reason, removed }) {
  const ownerId = String(
    ctx.env('SECURITY_BOT_OWNER_ID', '') || ctx.env('XP_BOT_OWNER_ID', '') || ctx.env('BIRTHDAY_BOT_OWNER_ID', '') || ''
  )
    .trim()
    .replace(/^<@!?(\d+)>$/, '$1');
  if (!ownerId) return;

  const summary = collectTexts(message?.components)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);

  const lines = [
    `📊 **Feedback zu einer Moderationsentscheidung**`,
    `Server: **${guild.name}** (\`${guild.id}\`)`,
    `Team: **${member.displayName || member.user?.username || member.id}** (<@${member.id}>)`,
    `Bewertung: ${vote === 'up' ? '👍 gut' : '👎 schlecht'}`,
    `Grund: ${reason ? `„${reason}“` : '_(kein Grund angegeben)_'}`,
    removed.length ? `🗑️ Aus dem Strafregister entfernt: ${removed.map((p) => `${p.userName || p.userId} · ${p.ruleLabel || p.ruleId || '—'}`).join(', ')}` : '',
    '',
    `-# Entscheidung: ${summary || '(keine Vorschau)'}`,
  ].filter(Boolean);

  const payload = ui.payload([ui.container([ui.text(lines.join('\n'))], { accentColor: vote === 'up' ? ACCENT.ok : ACCENT.error })]);
  try {
    const user = await ctx.client.users.fetch(ownerId);
    await user.send(payload);
  } catch (err) {
    ctx.logger?.warn?.('[security-bot] Feedback-DM an den Owner fehlgeschlagen:', err.message);
  }
}

module.exports = { handleFeedbackButton, handleFeedbackModal, readState, patchComponents, collectTexts, sendOwnerFeedback };
