const {
  ChannelType, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { componentsV2Payload } = require('./message-payload');
const { smallContainer } = require('./embed-builder');

const PANEL_PREFIX = 'secap_';
const sessions = new Map();

function allowed(ctx, interaction) {
  const dm = interaction.guildId == null && (!interaction.channel || interaction.channel.type === ChannelType.DM);
  return dm && Boolean(ctx.ownerId) && String(interaction.user?.id) === String(ctx.ownerId);
}
function deny(interaction) {
  return interaction.reply(componentsV2Payload([smallContainer(null, '⛔ Dieses Panel ist nur für den Bot-Owner im Bot-Privatchat verfügbar.')], { ephemeral: true }));
}
function serverRows(ctx) {
  return [...ctx.client.guilds.cache.values()].sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));
}
function configSummary(ctx, guild) {
  const cfg = ctx.store.ensureGuild(guild.id);
  return [
    `# 🛡️ ${guild.name}`, '',
    `**Owner:** <@${guild.ownerId}>`, `**Mitglieder:** ${(guild.memberCount || 0).toLocaleString('de-DE')}`,
    `**Gemini-Key:** ${cfg.geminiApiKey ? '✅' : '❌'}`, `**Log-Kanal:** ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '❌'}`,
    `**Anti-Delete:** ${cfg.antiDeleteEnabled ? '✅' : '➖'}`, `**Wartende Nachrichten:** ${ctx.store.countPendingMessages(guild.id)}`,
  ].join('\n');
}
function render(ctx, userId) {
  const guilds = serverRows(ctx);
  const selected = ctx.client.guilds.cache.get(sessions.get(userId));
  const text = selected ? configSummary(ctx, selected) : `# 🛡️ Security Adminpanel\n\nDer Bot ist auf **${guilds.length} Servern** mit insgesamt **${guilds.reduce((n,g)=>n+(g.memberCount||0),0).toLocaleString('de-DE')} Mitgliedern**.\n\nWähle einen Server für Konfiguration, Einladung oder Verlassen.`;
  const box = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  box.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  const shown = guilds.slice(0, 25);
  const select = new StringSelectMenuBuilder().setCustomId(`${PANEL_PREFIX}select`).setPlaceholder('Server auswählen …').setDisabled(!shown.length)
    .addOptions(shown.length ? shown.map(g => ({ label: g.name.slice(0, 100), value: g.id, description: `${g.memberCount || 0} Mitglieder` })) : [{ label: 'Keine Server', value: 'none' }]);
  box.addActionRowComponents(new ActionRowBuilder().addComponents(select));
  if (selected) box.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}invite`).setLabel('Einladung erstellen').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}back`).setLabel('Zurück').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}leave`).setLabel('Server verlassen').setStyle(ButtonStyle.Danger),
  ));
  return componentsV2Payload([box]);
}
async function openPanel(ctx, interaction) {
  if (!allowed(ctx, interaction)) return deny(interaction);
  sessions.delete(interaction.user.id);
  return interaction.reply(render(ctx, interaction.user.id));
}
async function handlePanelInteraction(ctx, interaction) {
  if (!String(interaction.customId || '').startsWith(PANEL_PREFIX)) return false;
  if (!allowed(ctx, interaction)) { await deny(interaction); return true; }
  const uid = interaction.user.id;
  const action = interaction.customId.slice(PANEL_PREFIX.length);
  if (action === 'select') sessions.set(uid, interaction.values?.[0]);
  if (action === 'back') sessions.delete(uid);
  const guild = ctx.client.guilds.cache.get(sessions.get(uid));
  if (action === 'invite' && guild) {
    const channel = guild.channels.cache.find(c => c.isTextBased?.() && c.permissionsFor?.(guild.members.me)?.has?.('CreateInstantInvite'));
    const invite = await channel?.createInvite?.({ maxAge: 3600, maxUses: 1, unique: true, reason: 'Security Adminpanel' }).catch(() => null);
    await interaction.reply({ content: invite ? `🔗 ${invite.url}\nGültig: 1 Stunde, einmal nutzbar.` : '❌ Keine Berechtigung zum Erstellen einer Einladung.', ephemeral: true });
    return true;
  }
  if (action === 'leave' && guild) {
    const name = guild.name; ctx.store.deleteGuild(guild.id); await guild.leave(); sessions.delete(uid);
    await interaction.update(render(ctx, uid));
    await interaction.followUp({ content: `✅ **${name}** wurde verlassen.`, ephemeral: true }).catch(() => {});
    return true;
  }
  await interaction.update(render(ctx, uid));
  return true;
}
module.exports = { PANEL_PREFIX, openPanel, handlePanelInteraction, allowed, render };
