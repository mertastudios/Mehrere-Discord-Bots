/**
 * ============================================================================
 *  🛡️ Security Bot (v2) – KI-Moderation über Groq
 *
 *  Ablauf:
 *   - Sammelt Textnachrichten echter Nutzer (Team-Nachrichten nur als Kontext).
 *   - Lokaler Filter → günstige Vorprüfung → Urteil → Maßnahme.
 *   - Antwort im Kanal mit Ping, DM an den Nutzer, Eintrag ins Strafregister,
 *     Meldung ins Log (mit 👍/👎 und „Neuer Auftrag“).
 *   - Alles wird über **einen** Befehl eingerichtet: `/setup` (7 Schritte).
 *
 *  Harte Regeln:
 *   - Ohne Administrator-Rechte macht der Bot NICHTS (mit Begründung).
 *   - `/setup` nur für Owner/Admins.
 *   - Nach abgeschlossenem Setup wird ein zuvor konfigurierter Log-Kanal bei
 *     Löschung wiederhergestellt; gelöschte Rollen/Kanäle werden aus dem
 *     Speicher entfernt; verlässt der Bot den Server, wird alles gelöscht.
 * ============================================================================
 */

const { GatewayIntentBits, ActivityType, Events, REST, PermissionFlagsBits } = require('discord.js');

const { createPresenceUpdater } = require('../../src/safe-presence');
const { createSecurityStore } = require('./src/store');
const { createBudgetSet } = require('./src/budget');
const { registerCommands } = require('./src/register');
const { handleInteraction } = require('./src/interactions');
const { handleIncoming, startPipeline } = require('./src/pipeline');
const { dmGuildOwner, notifyMissingAdmin } = require('./src/notices');
const { ensureLogChannel } = require('./src/logging');
const { botHasAdmin } = require('./src/guard');
const maintenance = require('./src/maintenance');

const REPAIR_INTERVAL_MS = 5 * 60 * 1000;

module.exports = {
  id: 'security-bot',
  name: 'Security Bot',
  tokenEnv: 'SECURITY_BOT_TOKEN',
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],

  /**
   * @param {object} params
   * @param {object} [params.rest] Optionaler REST-Client (Tests); sonst neu.
   */
  async create({ client, token, logger, env, rest = null }) {
    const store = createSecurityStore({ logger, env });
    await store.init();
    store.startBackupInterval(30_000);

    const budget = createBudgetSet(env);
    logger.info(`[security-bot] ${budget.summary()}`);

    const ctx = {
      client,
      token,
      logger,
      env,
      store,
      budget,
      rest: rest || new REST({ version: '10' }).setToken(token),
      pipeline: new Map(),
      orderQueue: new Map(),
      setupDraft: new Map(),
      adminWarnAt: new Map(),
      fetchFn: globalThis.fetch,
      botHighestPosition(guild) {
        return guild?.members?.me?.roles?.highest?.position ?? 0;
      },
    };

    const flushAndLog = async (sig) => {
      logger.info(`[security-bot] ${sig} – speichere Zwischenstand ...`);
      try {
        await store.flush({ force: true });
      } catch (err) {
        logger.error('[security-bot] Speichern vor Shutdown fehlgeschlagen:', err.message);
      }
    };
    process.on('SIGTERM', () => void flushAndLog('SIGTERM'));
    process.on('SIGINT', () => void flushAndLog('SIGINT'));

    const updatePresence = createPresenceUpdater({
      client,
      logger,
      label: 'security-bot',
      build: () => ({
        activities: [
          {
            name: `${client.guilds.cache.size} Server 🛡️ · /setup`,
            type: ActivityType.Watching,
          },
        ],
        status: 'online',
      }),
    });

    let pipelineStop = null;
    let repairTimer = null;
    let commandsRegistered = false;

    async function syncCommands(options = {}) {
      try {
        const result = await registerCommands(ctx, options);
        commandsRegistered = result.failed.length === 0;
        return result;
      } catch (err) {
        commandsRegistered = false;
        logger.error('[security-bot] Command-Registrierung fehlgeschlagen:', err.message);
        return { global: false, guilds: 0, failed: [{ scope: 'all', error: err.message }] };
      }
    }

    // ---------------- Ready ----------------
    client.once(Events.ClientReady, async () => {
      updatePresence();
      pipelineStop = startPipeline(ctx);
      await syncCommands();
      logger.info(`[security-bot] Online: ${client.guilds.cache.size} Server, ${store.getAllGuilds().length} in RAM`);

      // Server mit abgeschlossenem Setup: Log-Kanal prüfen (bzw. neu anlegen)
      for (const guild of client.guilds.cache.values()) {
        const cfg = store.getGuild(guild.id);
        if (!botHasAdmin(guild)) {
          void notifyMissingAdmin(ctx, guild);
          continue;
        }
        if (cfg.setup.done && cfg.logChannelId) await ensureLogChannel(ctx, guild).catch(() => {});
      }

      repairTimer = setInterval(() => {
        void (async () => {
          if (!commandsRegistered) await syncCommands();
          for (const guild of client.guilds.cache.values()) {
            const cfg = store.getGuild(guild.id);
            if (!botHasAdmin(guild)) {
              await notifyMissingAdmin(ctx, guild);
              continue;
            }
            if (cfg.setup.done && cfg.logChannelId) await ensureLogChannel(ctx, guild).catch(() => {});
          }
        })();
      }, REPAIR_INTERVAL_MS);
      repairTimer.unref?.();
    });

    // ---------------- Nachrichten ----------------
    client.on('messageCreate', (message) => {
      void handleIncoming({ ctx, message });
    });

    // ---------------- Interactions ----------------
    client.on('interactionCreate', (interaction) => {
      void handleInteraction(ctx, interaction);
    });

    // ---------------- Server betreten ----------------
    client.on('guildCreate', (guild) => {
      updatePresence();
      void dmGuildOwner(ctx, guild);
      void syncCommands({ onlyGuild: guild.id });
      logger.info(`[security-bot] Server ${guild.name} hinzugefügt – Owner informiert.`);
    });

    // ---------------- Server verlassen / gekickt ----------------
    client.on('guildDelete', (guild) => {
      void maintenance.handleGuildDelete(ctx, guild).then(updatePresence);
    });

    // ---------------- Kanal gelöscht (Log-Kanal selbst heilt sich) ----------------
    client.on('channelDelete', (channel) => {
      void maintenance.handleChannelDelete(ctx, channel);
    });

    // ---------------- Rolle gelöscht (kein Müll im Speicher) ----------------
    client.on('roleDelete', (role) => {
      void maintenance.handleRoleDelete(ctx, role);
    });

    // ---------------- Rechte verloren → sofort melden ----------------
    client.on('guildMemberUpdate', (before, after) => {
      if (after?.user?.id !== client.user?.id) return;
      if (before.permissions?.has?.(PermissionFlagsBits.Administrator) && !botHasAdmin(after.guild)) {
        void notifyMissingAdmin(ctx, after.guild, { force: true });
      }
    });

    // ---------------- Shutdown ----------------
    const originalDestroy = client.destroy.bind(client);
    client.destroy = () => {
      try {
        if (pipelineStop) pipelineStop();
        if (repairTimer) clearInterval(repairTimer);
      } catch {
        /* egal */
      }
      void store.flush({ force: true }).catch(() => {});
      store.stopBackupInterval();
      return originalDestroy();
    };
  },
};
