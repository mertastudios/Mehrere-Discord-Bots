/**
 * ============================================================================
 *  🛡️ Security Bot – KI-Sicherheitsbot mit Google Gemini
 *
 *  Ablauf:
 *  - Sammelt Textnachrichten echter Nutzer (Admins sind immun), bis das
 *    Token-Budget für eine Gemini-Anfrage erreicht ist – zusätzlich wird der
 *    Verlauf ALLE 2 STUNDEN (Serversprache-Zeitzone, Raster 0/2/4…22 Uhr)
 *    ausgewertet, damit Verwarnungen nicht bis zum nächsten Tag liegen bleiben.
 *  - Sendet System-Prompt + Admin-Prompt (/set_prompt) + sauber formatierten
 *    Chat-Verlauf (IDs ab 1, mentions aufgelöst) an Gemini – standardmäßig an
 *    den von Google gepflegten Alias `gemini-flash-lite-latest` (zeigt immer
 *    auf die aktuell günstigste Flash-Lite-Generation; lehnt Google ein
 *    Modell mit 404 ab, wird automatisch das nächste aus einer Fallback-Kette
 *    versucht – siehe src/gemini.js).
 *  - Gemini entscheidet über Warnungen / Timeouts (1m–1w) mit persönlicher
 *    Nachricht; der Bot antwortet auf die schwerwiegendste Verstoßnachricht.
 *    Ohne Verstoß schreibt der Bot NICHTS in den Chat (kein Small-Talk).
 *  - Fehlgeschlagene Analysen werden NICHT verworfen: Retry-Queue mit Backoff,
 *    meanwhile läuft das Sammeln weiter. Log-Kanal informiert über alles.
 *    /security_check_now stellt alle wartenden Nachrichten sofort fällig –
 *    optional mit einem Nutzer, der dabei zwingend moderiert werden soll.
 *  - Anti-Delete (optional, /set_anti_delete_messages): Löscht ein echter
 *    Nutzer (kein Bot/Webhook) seine eigene letzte Nachricht eines Kanals,
 *    sendet der Bot sie per Webhook mit exakter Profil-Kopie erneut.
 *
 *  Commands (alle nur für Administratoren):
 *  /set_gemini_api_key · /set_prompt · /set_log_channel ·
 *  /set_anti_delete_messages · /set_language · /security_check_now · /help
 * ============================================================================
 */

const { GatewayIntentBits, ActivityType, Events, REST } = require('discord.js');

const { createPresenceUpdater } = require('../../src/safe-presence');
const { createSecurityStore } = require('./src/store');
const {
  registerCommands,
  registerGuildCommands,
  verifyCommandsLive,
  formatDiscordError,
} = require('./src/commands');
const { handleInteraction } = require('./src/interactions');
const { handleIncoming } = require('./src/collector');
const { handleMessageDelete, clearWebhookCache } = require('./src/anti-delete');
const { sendJoinNotice } = require('./src/notices');
const { startScheduler } = require('./src/scheduler');

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

  async create({ client, token, logger, env }) {
    const store = createSecurityStore({ logger, env });
    await store.init();
    store.startBackupInterval(5 * 60 * 1000);

    const flushAndLog = async (sig) => {
      logger.info(`[security-bot] ${sig} – flushe RAM -> DB/File...`);
      try {
        await store.flush({ force: true });
        logger.info('[security-bot] Flush ok vor Shutdown');
      } catch (e) {
        logger.error('[security-bot] Flush fail:', e.message);
      }
    };
    process.on('SIGTERM', () => void flushAndLog('SIGTERM'));
    process.on('SIGINT', () => void flushAndLog('SIGINT'));

    const devGuildId =
      String(env('SECURITY_BOT_GUILD_ID', '')).trim().replace(/^<@!?(\d+)>$/, '$1') || null;

    const ctx = {
      client,
      token,
      logger,
      env,
      ownerId: String(
        env('SECURITY_BOT_OWNER_ID', '') ||
          env('XP_BOT_OWNER_ID', '') ||
          env('BIRTHDAY_BOT_OWNER_ID', '') ||
          ''
      )
        .trim()
        .replace(/^<@!?(\d+)>$/, '$1'),
      devGuildId,
      // Render exposes this automatically. Logging it makes stale deployments
      // distinguishable without ever exposing a token or another secret.
      deployCommit:
        String(env('RENDER_GIT_COMMIT', '') || env('SOURCE_COMMIT', '') || '').trim() || null,
      rest: new REST({ version: '10' }).setToken(token),
      store,
      commandIds: {},
      guildCommandIds: new Map(),
      commandsRegistered: false,
      schedulerState: null,
    };

    let schedulerStop = null;
    let commandRepairTimer = null;
    let commandSyncRunning = false;

    const syncCommands = async (options = {}) => {
      if (commandSyncRunning) return ctx.commandsRegistered;
      commandSyncRunning = true;
      try {
        const registered = await registerCommands(ctx, options);
        // Never let a verification repair bypass the ordered registration
        // transaction (global PUT first, Guild cleanup only afterwards).
        if (!registered) return false;
        // Der Rücklese-Check ist maßgeblich: Er erkennt leere/veraltete Sätze
        // und schreibt fehlende Commands sofort noch einmal zu Discord.
        return await verifyCommandsLive(ctx);
      } catch (err) {
        ctx.commandsRegistered = false;
        logger.error(
          '[security-bot] Command-Synchronisierung fehlgeschlagen:',
          formatDiscordError(err)
        );
        return false;
      } finally {
        commandSyncRunning = false;
      }
    };

    // setPresence() liefert in discord.js v14 synchron ein ClientPresence-Objekt
    // (kein Promise). Ein `.catch()` darauf warf in Produktion einen TypeError und
    // brach den ClientReady-Handler ab, BEVOR registerCommands() lief.
    // Der Helper isoliert jeden Presence-Fehler vollständig.
    const updatePresence = createPresenceUpdater({
      client,
      logger,
      label: 'security-bot',
      build: () => ({
        activities: [
          {
            name: `Moderating ${client.guilds.cache.size} server(s) 🛡️ | /help`,
            type: ActivityType.Watching,
          },
        ],
        status: 'online',
      }),
    });

    client.once(Events.ClientReady, async () => {
      // Presence darf niemals die nachfolgenden Schritte verhindern.
      updatePresence();
      schedulerStop = startScheduler({ ctx });
      logger.info(
        `[security-bot] Bereit auf ${client.guilds.cache.size} Servern, ${store.getAllGuilds().length} Gilden in RAM`
      );

      const commandsLive = await syncCommands();
      if (!commandsLive) {
        logger.error(
          '[security-bot] Commands sind noch nicht vollständig live – automatische Reparatur läuft alle 5 Minuten.'
        );
      }

      // Falls Discord beim Deployment vorübergehend nicht erreichbar war, darf
      // der Bot nicht bis zum nächsten Render-Restart ohne Commands bleiben.
      commandRepairTimer = setInterval(() => {
        if (ctx.commandsRegistered || commandSyncRunning) return;
        void syncCommands({ retryDelays: [0] });
      }, 5 * 60 * 1000);
      commandRepairTimer.unref?.();
    });

    // ---------------- Interactions ----------------
    client.on('interactionCreate', (interaction) => {
      void handleInteraction(ctx, interaction);
    });

    // ---------------- Nachrichten-Sammlung ----------------
    client.on('messageCreate', (msg) => {
      void handleIncoming({ ctx, msg });
    });

    // ---------------- Anti-Delete (messageDelete) ----------------
    client.on('messageDelete', (message) => {
      void handleMessageDelete({ ctx, message });
    });

    // ---------------- Guild Create / Delete ----------------
    client.on('guildCreate', (guild) => {
      void sendJoinNotice(ctx, guild);
      updatePresence();
      // Global commands are authoritative. Only the explicitly configured
      // Guild gets an additional immediate set while global propagation runs.
      if (ctx.devGuildId && String(guild.id) === String(ctx.devGuildId)) {
        void registerGuildCommands(ctx, guild.id).catch((e) => {
          logger.warn(
            '[security-bot] Optionale guildCreate-Sofortregistrierung fehlgeschlagen; ' +
              `globale Commands bleiben aktiv: ${formatDiscordError(e)}`
          );
        });
      }
    });

    client.on('guildDelete', (guild) => {
      store.deleteGuild(guild.id);
      void store.flush();
      clearWebhookCache(); // Anti-Delete-Webhooks der alten Gilde verwerfen
      logger.info(`[security-bot] Server ${guild.name} verlassen – Daten bereinigt`);
      updatePresence();
    });

    // ---------------- Graceful shutdown ----------------
    const originalDestroy = client.destroy.bind(client);
    client.destroy = () => {
      try {
        if (schedulerStop) schedulerStop();
        if (commandRepairTimer) clearInterval(commandRepairTimer);
      } catch {}
      void store.flush({ force: true }).catch(() => {});
      store.stopBackupInterval();
      return originalDestroy();
    };
  },
};
