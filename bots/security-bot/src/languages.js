/**
 * ============================================================================
 *  🛡️ Security Bot – Sprachdatei (10 Sprachen)
 *
 *  Unterstützte Sprachen:
 *  - de (Deutsch)      - en (English)     - fr (Français)
 *  - es (Español)      - pt (Português)   - ru (Русский)
 *  - ja (日本語)        - ko (한국어)       - zh (中文)   - it (Italiano)
 *
 *  Die Sprache steuert:
 *  - Alle Bot-Antworten & Log-Hinweise
 *  - Den Standardtext für /set_prompt (Formular-Vorbelegung)
 *  - Die Zeitzone für die 2-stündliche Auswertung des Chat-Verlaufs
 * ============================================================================
 */

const LANGS = {
  de: {
    name: 'Deutsch',
    names: { de: 'Deutsch', en: 'German', fr: 'Allemand', es: 'Alemán', pt: 'Alemão', ru: 'Немецкий', ja: 'ドイツ語', ko: '독일어', zh: '德语', it: 'Tedesco' },
    flag: '🇩🇪',
    locale: 'de-DE',
    tz: 'Europe/Berlin',
  },
  en: {
    name: 'English',
    names: { de: 'Englisch', en: 'English', fr: 'Anglais', es: 'Inglés', pt: 'Inglês', ru: 'Английский', ja: '英語', ko: '영어', zh: '英语', it: 'Inglese' },
    flag: '🇬🇧',
    locale: 'en-US',
    tz: 'America/New_York',
  },
  fr: {
    name: 'Français',
    names: { de: 'Französisch', en: 'French', fr: 'Français', es: 'Francés', pt: 'Francês', ru: 'Французский', ja: 'フランス語', ko: '프랑스어', zh: '法语', it: 'Francese' },
    flag: '🇫🇷',
    locale: 'fr-FR',
    tz: 'Europe/Paris',
  },
  es: {
    name: 'Español',
    names: { de: 'Spanisch', en: 'Spanish', fr: 'Espagnol', es: 'Español', pt: 'Espanhol', ru: 'Испанский', ja: 'スペイン語', ko: '스페인어', zh: '西班牙语', it: 'Spagnolo' },
    flag: '🇪🇸',
    locale: 'es-ES',
    tz: 'Europe/Madrid',
  },
  pt: {
    name: 'Português',
    names: { de: 'Portugiesisch', en: 'Portuguese', fr: 'Portugais', es: 'Portugués', pt: 'Português', ru: 'Португальский', ja: 'ポルトガル語', ko: '포르투갈어', zh: '葡萄牙语', it: 'Portoghese' },
    flag: '🇧🇷',
    locale: 'pt-BR',
    tz: 'America/Sao_Paulo',
  },
  ru: {
    name: 'Русский',
    names: { de: 'Russisch', en: 'Russian', fr: 'Russe', es: 'Ruso', pt: 'Russo', ru: 'Русский', ja: 'ロシア語', ko: '러시아어', zh: '俄语', it: 'Russo' },
    flag: '🇷🇺',
    locale: 'ru-RU',
    tz: 'Europe/Moscow',
  },
  ja: {
    name: '日本語',
    names: { de: 'Japanisch', en: 'Japanese', fr: 'Japonais', es: 'Japonés', pt: 'Japonês', ru: 'Японский', ja: '日本語', ko: '일본어', zh: '日语', it: 'Giapponese' },
    flag: '🇯🇵',
    locale: 'ja-JP',
    tz: 'Asia/Tokyo',
  },
  ko: {
    name: '한국어',
    names: { de: 'Koreanisch', en: 'Korean', fr: 'Coréen', es: 'Coreano', pt: 'Coreano', ru: 'Корейский', ja: '韓国語', ko: '한국어', zh: '韩语', it: 'Coreano' },
    flag: '🇰🇷',
    locale: 'ko-KR',
    tz: 'Asia/Seoul',
  },
  zh: {
    name: '中文',
    names: { de: 'Chinesisch', en: 'Chinese', fr: 'Chinois', es: 'Chino', pt: 'Chinês', ru: 'Китайский', ja: '中国語', ko: '중국어', zh: '中文', it: 'Cinese' },
    flag: '🇨🇳',
    locale: 'zh-CN',
    tz: 'Asia/Shanghai',
  },
  it: {
    name: 'Italiano',
    names: { de: 'Italienisch', en: 'Italian', fr: 'Italien', es: 'Italiano', pt: 'Italiano', ru: 'Итальянский', ja: 'イタリア語', ko: '이탈리아어', zh: '意大利语', it: 'Italiano' },
    flag: '🇮🇹',
    locale: 'it-IT',
    tz: 'Europe/Rome',
  },
};

const DEFAULT_LANG = 'de';


const STRINGS = {

  de: {
    errGuildOnly: '🔒 Dieser Befehl funktioniert nur in einem Server.',
    errNoPermission: '🔒 Nur Server-Administratoren können diesen Befehl nutzen.',

    apiKeySet: '✅ **Gemini API-Key gespeichert** ({key}).\nDie KI-Überwachung ist ab jetzt aktiv – gesammelte Nachrichten werden analysiert, sobald das Token-Limit erreicht ist, spätestens aber alle 2 Stunden.',
    apiKeyInvalid: '❌ **Google hat den API-Key abgelehnt** ({error}). Der Key wurde **nicht** gespeichert. Erstelle einen Schlüssel auf [aistudio.google.com](https://aistudio.google.com/apikey).',
    apiKeyKept: 'ℹ️ Der bestehende API-Key wurde unverändert beibehalten.',
    apiKeyRemoved: '🗑️ **Gemini API-Key gelöscht.** Es werden keine Nachrichten mehr gesammelt oder analysiert.',
    apiKeyUnverified: '⚠️ **API-Key gespeichert** ({key}), aber die Prüfung bei Google schlug fehl ({error}). Der Key wird trotzdem verwendet.',

    promptModalTitle: '🛡️ KI-Anweisungen (Prompt)',
    promptModalLabel: 'Regeln, Strenge & Maßnahmen für Gemini',
    promptSaved: '✅ **KI-Anweisungen gespeichert** ({chars} Zeichen).\nSie gelten für die nächste Chat-Analyse.',
    promptReset: '♻️ **KI-Anweisungen auf den Standardtext zurückgesetzt.**',

    logChannelSet: '✅ **Log-Kanal gesetzt:** {channel}\nDorthin sendet der Bot Moderations-Hinweise, API-Fehler und sonstige Meldungen.',
    logChannelRemoved: '🗑️ **Log-Kanal entfernt.** Es werden keine Hinweise mehr versendet.',
    antiDeleteEnabled: '✅ **Anti-Delete aktiviert.** Löscht jemand (kein Bot/Webhook) seine eigene letzte Nachricht eines Kanals, sendet der Bot sie per Webhook mit exakter Profil-Kopie (Anzeigename & Avatar) erneut. Erwähnungen pingen dabei niemanden.',
    antiDeleteDisabled: '⛔ **Anti-Delete deaktiviert.** Gelöschte Nachrichten werden nicht mehr erneut gesendet.',

    langChanged: '✅ Sprache geändert: {name}',

    descApiKey: 'Google Gemini API-Key für diesen Server hinterlegen',
    descPrompt: 'KI-Anweisungen per Formular festlegen (Regeln, Strenge, Maßnahmen)',
    descLogChannel: 'Log-Kanal für Moderations-Hinweise & API-Fehler setzen',
    descLanguage: 'Sprache des Bots dauerhaft ändern',
    descHelp: 'Zeigt alle Befehle und Funktionen',
    descCheckNow: 'Startet sofort eine KI-Prüfung der gesammelten Nachrichten (nur Admins)',
    descCheckNowUser: 'Nutzer, der bei dieser Prüfung zwangsmoderiert werden soll (optional)',
    descAntiDelete: 'Anti-Delete: gelöschte letzte Nachrichten per Webhook erneut senden',
    descAntiDeleteOption: 'true = Anti-Delete einschalten, false = ausschalten',

    helpTitle: '🛡️ Security Bot – KI-Moderation mit Gemini',
    helpDesc: 'Dieser Bot sammelt **Textnachrichten echter Nutzer** (Admins sind immun), bis das Token-Limit für eine Gemini-Analyse voll ist – zusätzlich wird der Verlauf **alle 2 Stunden** ausgewertet. Gemini erhält den System-Prompt, eure Server-Regeln und den sauber formatierten Chat-Verlauf und entscheidet über Warnungen & Timeouts. Bei API-Fehlern geht **nichts verloren**: Es wird so lange wiederholt, bis es klappt.',
    helpApiKey: 'Hinterlegt den Google Gemini API-Key für diesen Server. Muss vor der Überwachung einmal gesetzt werden.',
    helpPrompt: 'Öffnet ein Formular mit euren KI-Anweisungen: Server-Regeln, wie streng moderiert wird und welche Maßnahmen Gemini wie einsetzt. Der letzte gespeicherte Text ist bereits eingetragen.',
    helpLogChannel: 'Setzt den Log-Kanal für Moderations-Hinweise, API-Fehler und Meldungen. Ohne Kanal-Angabe wird der Log-Kanal entfernt.',
    helpLanguage: 'Ändert die Sprache des Bots dauerhaft (steuert auch die Zeitzone der 2-Stunden-Auswertung & die Standardsprache der KI).',
    helpHelp: 'Zeigt diese Übersicht.',
    helpCheckNow: 'Wertet die bisher gesammelten Nachrichten sofort aus, ohne auf das Token-Limit oder die nächste 2-Stunden-Auswertung zu warten. Mit der Option `user` lässt sich ein Nutzer wählen, der bei dieser Prüfung zwingend moderiert werden soll.',
    helpAntiDelete: 'Schaltet Anti-Delete ein oder aus: Löscht jemand (kein Bot/Webhook) seine eigene letzte Nachricht eines Kanals, sendet der Bot sie per Webhook mit exakter Profil-Kopie (Name & Avatar) erneut. Erwähnungen pingen dabei niemanden.',

    logModTitle: '🛡️ KI-Moderation',
    logFieldUser: 'Nutzer',
    logFieldAction: 'Maßnahme',
    logFieldReason: 'Begründung von Gemini',
    logFieldMessage: 'Nachricht',
    logActionWarn: '⚠️ Warnung',
    logActionTimeout: '⏱️ Timeout',
    logPrimary: '💥 Hauptverstoß (darauf hat der Bot geantwortet)',
    logNormal: 'Verstoß',
    logImmune: '🛡️ **Übersprungen:** Gemini wollte {user} moderieren, aber Administratoren bleiben immer verschont.',
    logBatchSize: 'Verlauf: {count} Nachrichten',

    logApiTitle: '⚠️ Gemini API-Fehler',
    logApiDesc: 'Die Analyse von **{count} gesammelten Nachrichten** ist fehlgeschlagen.\nFehler: `{error}`\n\n🔁 Versuch {attempt} – nächste Wiederholung: **{retry}**.\n💾 Die Nachrichten bleiben vollständig erhalten und werden **nicht verworfen** – neue Nachrichten sammeln sich derweil ganz normal weiter.',
    logNoKeyTitle: '🔑 Kein Gemini API-Key hinterlegt',
    logNoKeyDesc: '{count} gesammelte Nachrichten warten auf Analyse. Ein Administrator muss erst `/set_gemini_api_key` ausführen.',
    logDropTitle: '🗑️ Veralteter Chat-Verlauf verworfen',
    logDropDesc: '{count} Nachrichten konnten über 30 Tage lang nicht analysiert werden (dauerhafter API-Fehler) und wurden zur Datenhygiene gelöscht.',
    checkNowNoKey: '🔑 Kein Gemini API-Key hinterlegt. Führe zuerst `/set_gemini_api_key` aus.',
    checkNowEmpty: 'ℹ️ Aktuell liegen keine gesammelten Nachrichten vor – nichts zu prüfen.',
    checkNowDone: '✅ **Sofort-Prüfung abgeschlossen** ({count} Nachrichten analysiert). Ergebnisse siehe Log-Kanal.',
    checkNowPartial: '⚠️ **Sofort-Prüfung gestartet** ({count} Nachrichten), aber {remaining} davon konnten nicht abgeschlossen werden (API-Fehler) – Details im Log-Kanal, es wird automatisch weiter versucht.',
    checkNowForcedActive: '🎯 Zwangsmoderation angefordert: {user} wird bei dieser Prüfung zwingend moderiert – Details siehe Log-Kanal.',
    checkNowForcedNoMsgs: '⚠️ {user} kommt in den gesammelten Nachrichten nicht vor – es gab keine Nachricht, die moderiert werden könnte.',
    checkNowForcedInvalid: '⚠️ {user} ist ein Bot oder Administrator und kann nicht moderiert werden. Wähle ein reguläres Mitglied.',

    joinTitle: '👋 Security Bot ist beigelegt!',
    joinDesc: 'Danke fürs Einladen! So startest du:\n\n1️⃣ `/set_gemini_api_key` – Google Gemini Key hinterlegen ([kostenlos erstellen](https://aistudio.google.com/apikey))\n2️⃣ `/set_prompt` – Regeln & Strenge der KI festlegen (Standardtext ist vorbelegt)\n3️⃣ `/set_log_channel` – Log-Kanal für Moderations-Hinweise wählen\n\nAb dann überwacht die KI automatisch alle Textnachrichten. **Alle Commands sind nur für Administratoren sichtbar.**',

    defaultPrompt: `Moderiere diesen Server als faires, freundliches, aber konsequentes OP-Team.

=== REGELN ===
- Keine Beleidigungen, Hass, Diskriminierung oder extreme Toxizität
- Keine sexistischen, rassistischen, homophoben oder transphoben Aussagen
- Kein Spam, keine Werbung, kein Account-/Nitro-Handel, keine verdächtigen Links
- Respektvoller Umgang – auch bei Meinungsverschiedenheiten
- Keine gefährlichen oder illegalen Inhalte

=== STRENGE (weder zu lasch noch zu streng) ===
- Freundschaftliche Frotzeleien, Sarkasmus unter Freunden und Selbstironie NIEMALS bestrafen
- Nur über andere zu sprechen (z. B. Streamer oder Gegner) ist KEIN Verstoß
- Eine frühere Strafe allein ist KEIN Grund für eine neue Strafe
- Erst bei echten, klaren, eindeutigen Verstößen eingreifen
- Im Zweifel: lieber eine Warnung als ein Timeout

=== ESKALATION (Warnungen zuerst) ===
- Erster Verstoß: immer Warnung (warn), kein Timeout
- Timeout erst nach wiederholten Warnungen (Strafenregister) oder bei schweren Verstößen
- Pro Person höchstens EIN Timeout pro Analyse – weitere Verstöße derselben Person als warn
- Der schwerwiegendste Verstoß ist primary=true und bekommt die längste (oder gleichlängste) Dauer

=== MASSNAHMEN ===
- Leichte Verstöße: warn mit freundlichem Hinweis
- Klare Beleidigung oder Provokation: warn, bei Wiederholung timeout 5m–10m
- Wiederholter Verstoß trotz Warnung: timeout 10m–1h
- Diskriminierung, Hate Speech, Drohungen: timeout 1d–1w
- Gefährliche Inhalte, Phishing-/Betrugs-Links: timeout 1w
- Spam/Werbung: erstes Mal warn, Wiederholung timeout 1h
- Kein Verstoß: niemanden moderieren und NICHTS in den Chat schreiben – der Bot bleibt still
- Niemals Grüße, Small-Talk, Entwarnungen oder Statusmeldungen posten`,
  },

  en: {
    errGuildOnly: '🔒 This command only works inside a server.',
    errNoPermission: '🔒 Only server administrators can use this command.',

    apiKeySet: '✅ **Gemini API key saved** ({key}).\nAI moderation is now active – collected messages are analyzed once the token limit is reached, and at the latest every 2 hours.',
    apiKeyInvalid: '❌ **Google rejected the API key** ({error}). The key was **not** saved. Create one at [aistudio.google.com](https://aistudio.google.com/apikey).',
    apiKeyKept: 'ℹ️ The existing API key was kept unchanged.',
    apiKeyRemoved: '🗑️ **Gemini API key removed.** Messages are no longer collected or analyzed.',
    apiKeyUnverified: '⚠️ **API key saved** ({key}), but verification with Google failed ({error}). The key will be used anyway.',

    promptModalTitle: '🛡️ AI Instructions (Prompt)',
    promptModalLabel: 'Rules, strictness & measures for Gemini',
    promptSaved: '✅ **AI instructions saved** ({chars} characters).\nThey apply from the next chat analysis onward.',
    promptReset: '♻️ **AI instructions reset to the default text.**',

    logChannelSet: '✅ **Log channel set:** {channel}\nThe bot will post moderation notices, API errors and other reports there.',
    logChannelRemoved: '🗑️ **Log channel removed.** No more notices will be sent.',
    antiDeleteEnabled: '✅ **Anti-delete enabled.** When someone (not a bot/webhook) deletes their own last message of a channel, the bot resends it via webhook with an exact profile copy (display name & avatar). Mentions never ping anyone.',
    antiDeleteDisabled: '⛔ **Anti-delete disabled.** Deleted messages are no longer resent.',

    langChanged: '✅ Language changed: {name}',

    descApiKey: 'Set the Google Gemini API key for this server',
    descPrompt: 'Set AI instructions via form (rules, strictness, measures)',
    descLogChannel: 'Set the log channel for moderation notices & API errors',
    descLanguage: 'Change the bot language permanently',
    descHelp: 'Shows all commands and features',
    descCheckNow: 'Immediately runs an AI check on the collected messages (admins only)',
    descCheckNowUser: 'User who must definitely be moderated in this check (optional)',
    descAntiDelete: 'Anti-delete: resend users\' deleted last messages via webhook',
    descAntiDeleteOption: 'true = turn anti-delete on, false = turn it off',

    helpTitle: '🛡️ Security Bot – AI Moderation with Gemini',
    helpDesc: 'This bot collects **text messages from real users** (admins are immune) until the token limit for one Gemini analysis is full – in addition, the history is analyzed **every 2 hours**. Gemini receives the system prompt, your server rules and a cleanly formatted chat history, then decides on warnings & timeouts. If the API fails, **nothing is lost**: retries continue until it succeeds.',
    helpApiKey: 'Stores the Google Gemini API key for this server. Must be set once before monitoring starts.',
    helpPrompt: 'Opens a form with your AI instructions: server rules, how strictly to moderate and which measures Gemini should use. Your last saved text is already filled in.',
    helpLogChannel: 'Sets the log channel for moderation notices, API errors and reports. Calling it without a channel removes the log channel.',
    helpLanguage: 'Permanently changes the bot language (also controls the timezone of the 2-hour analysis and the AI default language).',
    helpHelp: 'Shows this overview.',
    helpCheckNow: 'Analyzes the currently collected messages right away, without waiting for the token limit or the next 2-hour run. The `user` option lets you pick a user who must be moderated during this check.',
    helpAntiDelete: 'Turns anti-delete on or off: if someone (not a bot/webhook) deletes their own last message of a channel, the bot resends it via webhook with an exact profile copy (name & avatar). Mentions never ping anyone.',

    logModTitle: '🛡️ AI Moderation',
    logFieldUser: 'User',
    logFieldAction: 'Measure',
    logFieldReason: 'Reason from Gemini',
    logFieldMessage: 'Message',
    logActionWarn: '⚠️ Warning',
    logActionTimeout: '⏱️ Timeout',
    logPrimary: '💥 Primary violation (the bot replied to this message)',
    logNormal: 'Violation',
    logImmune: '🛡️ **Skipped:** Gemini wanted to moderate {user}, but administrators are always immune.',
    logBatchSize: 'History: {count} messages',

    logApiTitle: '⚠️ Gemini API error',
    logApiDesc: 'The analysis of **{count} collected messages** failed.\nError: `{error}`\n\n🔁 Attempt {attempt} – next retry: **{retry}**.\n💾 The messages are fully preserved and **not discarded** – new messages keep collecting normally in the meantime.',
    logNoKeyTitle: '🔑 No Gemini API key configured',
    logNoKeyDesc: '{count} collected messages are waiting for analysis. An administrator needs to run `/set_gemini_api_key` first.',
    logDropTitle: '🗑️ Stale chat history discarded',
    logDropDesc: '{count} messages could not be analyzed for over 30 days (persistent API failure) and were deleted for data hygiene.',
    checkNowNoKey: '🔑 No Gemini API key configured. Run `/set_gemini_api_key` first.',
    checkNowEmpty: 'ℹ️ There are currently no collected messages – nothing to check.',
    checkNowDone: '✅ **Instant check complete** ({count} messages analyzed). See the log channel for results.',
    checkNowPartial: '⚠️ **Instant check started** ({count} messages), but {remaining} of them could not be completed (API error) – see the log channel for details, retries continue automatically.',
    checkNowForcedActive: '🎯 Forced moderation requested: {user} will definitely be moderated in this check – see the log channel for details.',
    checkNowForcedNoMsgs: '⚠️ {user} does not appear in the collected messages – there was no message to moderate.',
    checkNowForcedInvalid: '⚠️ {user} is a bot or an administrator and cannot be moderated. Please pick a regular member.',

    joinTitle: '👋 Security Bot has arrived!',
    joinDesc: 'Thanks for inviting me! Getting started:\n\n1️⃣ `/set_gemini_api_key` – add a Google Gemini key ([create one free](https://aistudio.google.com/apikey))\n2️⃣ `/set_prompt` – define the AI rules & strictness (a default text is pre-filled)\n3️⃣ `/set_log_channel` – pick a log channel for moderation notices\n\nAfter that the AI automatically monitors all text messages. **All commands are visible to administrators only.**',

    defaultPrompt: `Moderate this server like a fair, friendly but firm OP team.

=== RULES ===
- No insults, hate, discrimination or extreme toxicity
- No sexist, racist, homophobic or transphobic statements
- No spam, no advertising, no account/Nitro trading, no suspicious links
- Treat each other with respect – even when disagreeing
- No dangerous or illegal content

=== STRICTNESS (neither too lenient nor too strict) ===
- NEVER punish friendly banter, sarcasm among friends or self-deprecating jokes
- Merely talking ABOUT others (e.g. streamers or opponents) is NOT a violation
- A previous penalty alone is NOT a reason for a new penalty
- Only step in on real, clear, unambiguous violations
- When in doubt: prefer a warning over a timeout

=== ESCALATION (warnings first) ===
- First violation: always a warning (warn), no timeout
- Timeout only after repeated warnings (penalty register) or for severe violations
- At most ONE timeout per person per analysis – further violations of the same person as warn
- The most severe violation is primary=true and gets the longest (or equal) duration

=== MEASURES ===
- Minor violations: warn with a friendly hint
- Clear insult or provocation: warn, on repetition timeout 5m–10m
- Repeated violation despite warning: timeout 10m–1h
- Discrimination, hate speech, threats: timeout 1d–1w
- Dangerous content, phishing/scam links: timeout 1w
- Spam/advertising: first time warn, repetition timeout 1h
- No violation: moderate nobody and write NOTHING into the chat – the bot stays silent
- Never post greetings, small talk, all-clear notes or status updates`,
  },

  fr: {
    errGuildOnly: '🔒 Cette commande ne fonctionne que dans un serveur.',
    errNoPermission: '🔒 Seuls les administrateurs du serveur peuvent utiliser cette commande.',
    apiKeySet: '✅ **Clé API Gemini enregistrée** ({key}).\nLa modération IA est désormais active – les messages collectés sont analysés dès que la limite de tokens est atteinte, et au plus tard toutes les 2 heures.',
    apiKeyInvalid: '❌ **Google a refusé la clé API** ({error}). La clé n’a **pas** été enregistrée. Créez-en une sur [aistudio.google.com](https://aistudio.google.com/apikey).',
    apiKeyKept: 'ℹ️ La clé API existante a été conservée.',
    apiKeyRemoved: '🗑️ **Clé API Gemini supprimée.** Les messages ne sont plus collectés ni analysés.',
    apiKeyUnverified: '⚠️ **Clé API enregistrée** ({key}), mais la vérification auprès de Google a échoué ({error}). La clé sera quand même utilisée.',
    promptModalTitle: '🛡️ Instructions IA (Prompt)',
    promptModalLabel: 'Règles, strictesse et mesures pour Gemini',
    promptSaved: '✅ **Instructions IA enregistrées** ({chars} caractères).\nElles s’appliquent à partir de la prochaine analyse.',
    promptReset: '♻️ **Instructions IA réinitialisées au texte par défaut.**',
    logChannelSet: '✅ **Salon de journal défini :** {channel}\nLe bot y publiera les avis de modération, les erreurs API et autres rapports.',
    logChannelRemoved: '🗑️ **Salon de journal supprimé.** Plus aucun avis ne sera envoyé.',
    antiDeleteEnabled: '✅ **Anti-suppression activée.** Si quelqu’un (ni bot ni webhook) supprime son propre dernier message d’un salon, le bot le renvoie via webhook avec une copie exacte du profil (nom d’affichage et avatar). Les mentions ne pingent personne.',
    antiDeleteDisabled: '⛔ **Anti-suppression désactivée.** Les messages supprimés ne sont plus renvoyés.',
    langChanged: '✅ Langue modifiée : {name}',

    descApiKey: 'Définir la clé API Google Gemini pour ce serveur',
    descPrompt: 'Définir les instructions IA (règles, sévérité, mesures)',
    descLogChannel: 'Définir le salon de journal (avis de modération, erreurs API)',
    descLanguage: 'Changer définitivement la langue du bot',
    descHelp: 'Affiche toutes les commandes et fonctions',
    descCheckNow: 'Lance immédiatement une analyse IA des messages collectés (admins uniquement)',
    descCheckNowUser: 'Utilisateur à modérer obligatoirement lors de ce contrôle (optionnel)',
    descAntiDelete: 'Anti-suppression : renvoyer les derniers messages supprimés via webhook',
    descAntiDeleteOption: 'true = activer l’anti-suppression, false = désactiver',

    helpTitle: '🛡️ Security Bot – Modération IA avec Gemini',
    helpDesc: 'Ce bot collecte les **messages texte des vrais utilisateurs** (les admins sont immunisés) jusqu’à la limite de tokens pour une analyse Gemini – en plus, l’historique est analysé **toutes les 2 heures**. Gemini reçoit le prompt système, vos règles et un historique bien formaté, puis décide des avertissements et timeouts. En cas d’erreur API, **rien n’est perdu** : les tentatives continuent jusqu’au succès.',
    helpApiKey: 'Enregistre la clé API Google Gemini pour ce serveur. À définir une fois avant de démarrer la surveillance.',
    helpPrompt: 'Ouvre un formulaire avec vos instructions IA : règles du serveur, strictesse de modération et mesures à employer. Votre dernier texte est déjà prérempli.',
    helpLogChannel: 'Définit le salon de journal pour les avis de modération et erreurs API. Sans salon, le journal est supprimé.',
    helpLanguage: 'Change définitivement la langue du bot (contrôle aussi le fuseau horaire de l’analyse toutes les 2 heures et la langue par défaut de l’IA).',
    helpHelp: 'Affiche cet aperçu.',
    helpCheckNow: 'Analyse immédiatement les messages déjà collectés, sans attendre la limite de tokens ni la prochaine analyse bihoraire. L’option `user` permet de choisir un utilisateur qui sera obligatoirement modéré lors de ce contrôle.',
    helpAntiDelete: 'Active ou désactive l’anti-suppression : si quelqu’un (ni bot ni webhook) supprime son propre dernier message d’un salon, le bot le renvoie via webhook avec une copie exacte du profil (nom et avatar). Les mentions ne pingent personne.',
    logModTitle: '🛡️ Modération IA',
    logFieldUser: 'Utilisateur',
    logFieldAction: 'Mesure',
    logFieldReason: 'Raison de Gemini',
    logFieldMessage: 'Message',
    logActionWarn: '⚠️ Avertissement',
    logActionTimeout: '⏱️ Timeout',
    logPrimary: '💥 Violation principale (le bot a répondu à ce message)',
    logNormal: 'Violation',
    logImmune: '🛡️ **Ignoré :** Gemini voulait modérer {user}, mais les administrateurs sont toujours épargnés.',
    logBatchSize: 'Historique : {count} messages',
    logApiTitle: '⚠️ Erreur de l’API Gemini',
    logApiDesc: 'L’analyse de **{count} messages collectés** a échoué.\nErreur : `{error}`\n\n🔁 Tentative {attempt} – prochaine répétition : **{retry}**.\n💾 Les messages sont conservés et **pas supprimés** – la collecte continue normalement.',
    logNoKeyTitle: '🔑 Aucune clé API Gemini configurée',
    logNoKeyDesc: '{count} messages collectés attendent une analyse. Un administrateur doit d’abord exécuter `/set_gemini_api_key`.',
    logDropTitle: '🗑️ Historique périmé supprimé',
    logDropDesc: '{count} messages n’ont pas pu être analysés pendant plus de 30 jours (échec API persistant) et ont été supprimés par hygiène des données.',
    checkNowNoKey: '🔑 Aucune clé API Gemini configurée. Exécutez d’abord `/set_gemini_api_key`.',
    checkNowEmpty: 'ℹ️ Aucun message collecté pour le moment – rien à analyser.',
    checkNowDone: '✅ **Analyse immédiate terminée** ({count} messages analysés). Voir le salon de journal pour les résultats.',
    checkNowPartial: '⚠️ **Analyse immédiate lancée** ({count} messages), mais {remaining} d’entre eux n’ont pas pu être terminés (erreur API) – détails dans le salon de journal, nouvelles tentatives automatiques.',
    checkNowForcedActive: '🎯 Modération forcée demandée : {user} sera obligatoirement modéré lors de ce contrôle – détails dans le salon de journal.',
    checkNowForcedNoMsgs: '⚠️ {user} n’apparaît pas dans les messages collectés – aucun message à modérer.',
    checkNowForcedInvalid: '⚠️ {user} est un bot ou un administrateur et ne peut pas être modéré. Choisissez un membre régulier.',
    joinTitle: '👋 Security Bot est arrivé !',
    joinDesc: 'Merci pour l’invitation ! Pour commencer :\n\n1️⃣ `/set_gemini_api_key` – ajoutez une clé Google Gemini ([création gratuite](https://aistudio.google.com/apikey))\n2️⃣ `/set_prompt` – définissez les règles et la strictesse de l’IA (texte par défaut prérempli)\n3️⃣ `/set_log_channel` – choisissez un salon de journal\n\nEnsuite, l’IA surveille automatiquement tous les messages texte. **Toutes les commandes sont réservées aux administrateurs.**',
    defaultPrompt: `Modère ce serveur comme une équipe d’OP juste, aimable mais ferme.

=== RÈGLES ===
- Pas d’insultes, de haine, de discrimination ni de toxicité extrême
- Pas de propos sexistes, racistes, homophobes ou transphobes
- Pas de spam, de publicité, de revente de comptes/Nitro, pas de liens suspects
- Respect mutuel, même en cas de désaccord
- Aucun contenu dangereux ou illégal

=== SÉVÉRITÉ (ni trop laxiste ni trop stricte) ===
- Ne JAMAIS punir les taquineries amicales, le sarcasme entre amis ou l’autodérision
- Parler D’autres (p. ex. streamers ou adversaires) n’est PAS une infraction
- Une sanction passée ne justifie PAS à elle seule une nouvelle sanction
- N’intervenir qu’en cas de violations réelles, claires et sans ambiguïté
- En cas de doute : préférer un avertissement à un timeout

=== ESCALADE (avertissements d’abord) ===
- Première infraction : toujours un avertissement (warn), pas de timeout
- Timeout seulement après avertissements répétés (registre) ou pour violations graves
- Au plus UN timeout par personne et par analyse – les autres infractions de la même personne en warn
- L’infraction la plus grave est primary=true et reçoit la durée la plus longue (ou égale)

=== MESURES ===
- Infractions légères : warn avec un conseil amical
- Insulte ou provocation claire : warn, en cas de répétition timeout 5m–10m
- Infraction répétée malgré avertissement : timeout 10m–1h
- Discrimination, discours de haine, menaces : timeout 1d–1w
- Contenus dangereux, liens de phishing/arnaque : timeout 1w
- Spam/publicité : première fois warn, répétition timeout 1h
- Aucune infraction : ne modérer personne et n’écrire RIEN dans le chat – le bot reste silencieux
- Ne jamais publier de salutations, de bavardages, de messages rassurants ou d’états`,
  },

  es: {
    errGuildOnly: '🔒 Este comando solo funciona dentro de un servidor.',
    errNoPermission: '🔒 Solo los administradores del servidor pueden usar este comando.',
    apiKeySet: '✅ **Clave API de Gemini guardada** ({key}).\nLa moderación IA ya está activa: los mensajes recopilados se analizan al llegar al límite de tokens y, como máximo, cada 2 horas.',
    apiKeyInvalid: '❌ **Google rechazó la clave API** ({error}). La clave **no** se guardó. Crea una en [aistudio.google.com](https://aistudio.google.com/apikey).',
    apiKeyKept: 'ℹ️ La clave API existente se mantuvo sin cambios.',
    apiKeyRemoved: '🗑️ **Clave API de Gemini eliminada.** Ya no se recopilan ni analizan mensajes.',
    apiKeyUnverified: '⚠️ **Clave API guardada** ({key}), pero la verificación con Google falló ({error}). Se usará de todos modos.',
    promptModalTitle: '🛡️ Instrucciones de IA (Prompt)',
    promptModalLabel: 'Reglas, rigor y medidas para Gemini',
    promptSaved: '✅ **Instrucciones de IA guardadas** ({chars} caracteres).\nSe aplicarán a partir del próximo análisis del chat.',
    promptReset: '♻️ **Instrucciones de IA restablecidas al texto predeterminado.**',
    logChannelSet: '✅ **Canal de registro establecido:** {channel}\nEl bot publicará allí avisos de moderación, errores de API y otros informes.',
    logChannelRemoved: '🗑️ **Canal de registro eliminado.** Ya no se enviarán avisos.',
    antiDeleteEnabled: '✅ **Anti-borrado activado.** Si alguien (ni bot ni webhook) elimina su propio último mensaje de un canal, el bot lo reenvía vía webhook con una copia exacta del perfil (nombre visible y avatar). Las menciones no notifican a nadie.',
    antiDeleteDisabled: '⛔ **Anti-borrado desactivado.** Los mensajes eliminados ya no se reenvían.',
    langChanged: '✅ Idioma cambiado: {name}',

    descApiKey: 'Configura la clave API de Google Gemini para este servidor',
    descPrompt: 'Define las instrucciones de IA (reglas, rigor, medidas)',
    descLogChannel: 'Configura el canal de registro para avisos y errores de API',
    descLanguage: 'Cambia el idioma del bot de forma permanente',
    descHelp: 'Muestra todos los comandos y funciones',
    descCheckNow: 'Ejecuta de inmediato un análisis de IA de los mensajes recopilados (solo admins)',
    descCheckNowUser: 'Usuario que debe ser moderado obligatoriamente en esta revisión (opcional)',
    descAntiDelete: 'Anti-borrado: reenviar los últimos mensajes eliminados vía webhook',
    descAntiDeleteOption: 'true = activar anti-borrado, false = desactivar',

    helpTitle: '🛡️ Security Bot – Moderación IA con Gemini',
    helpDesc: 'Este bot recopila **mensajes de texto de usuarios reales** (los admins son inmunes) hasta llenar el límite de tokens para un análisis de Gemini; además, el historial se analiza **cada 2 horas**. Gemini recibe el prompt del sistema, las reglas del servidor y un historial bien formateado, y decide advertencias y timeouts. Si la API falla, **no se pierde nada**: se reintenta hasta lograrlo.',
    helpApiKey: 'Guarda la clave API de Google Gemini para este servidor. Debe configurarse una vez antes de empezar la vigilancia.',
    helpPrompt: 'Abre un formulario con tus instrucciones de IA: reglas del servidor, rigor de moderación y medidas que debe usar Gemini. Tu último texto ya está rellenado.',
    helpLogChannel: 'Establece el canal de registro para avisos de moderación y errores de API. Sin canal, se elimina el registro.',
    helpLanguage: 'Cambia el idioma del bot de forma permanente (también controla la zona horaria del análisis cada 2 horas y el idioma predeterminado de la IA).',
    helpHelp: 'Muestra este resumen.',
    helpCheckNow: 'Analiza de inmediato los mensajes ya recopilados, sin esperar el límite de tokens ni el próximo análisis bihorario. La opción `user` permite elegir un usuario que será moderado obligatoriamente en esta revisión.',
    helpAntiDelete: 'Activa o desactiva el anti-borrado: si alguien (ni bot ni webhook) elimina su propio último mensaje de un canal, el bot lo reenvía vía webhook con una copia exacta del perfil (nombre y avatar). Las menciones no notifican a nadie.',
    logModTitle: '🛡️ Moderación IA',
    logFieldUser: 'Usuario',
    logFieldAction: 'Medida',
    logFieldReason: 'Razón de Gemini',
    logFieldMessage: 'Mensaje',
    logActionWarn: '⚠️ Advertencia',
    logActionTimeout: '⏱️ Timeout',
    logPrimary: '💥 Infracción principal (el bot respondió a este mensaje)',
    logNormal: 'Infracción',
    logImmune: '🛡️ **Omitido:** Gemini quiso moderar a {user}, pero los administradores siempre están inmunes.',
    logBatchSize: 'Historial: {count} mensajes',
    logApiTitle: '⚠️ Error de la API de Gemini',
    logApiDesc: 'El análisis de **{count} mensajes recopilados** falló.\nError: `{error}`\n\n🔁 Intento {attempt} – próximo reintento: **{retry}**.\n💾 Los mensajes se conservan y **no se descartan** – la recopilación sigue con normalidad.',
    logNoKeyTitle: '🔑 Sin clave API de Gemini configurada',
    logNoKeyDesc: '{count} mensajes recopilados esperan análisis. Un administrador debe ejecutar primero `/set_gemini_api_key`.',
    logDropTitle: '🗑️ Historial obsoleto descartado',
    logDropDesc: '{count} mensajes no pudieron analizarse durante más de 30 días (fallo persistente de la API) y se borraron por higiene de datos.',
    checkNowNoKey: '🔑 No hay clave API de Gemini configurada. Ejecuta primero `/set_gemini_api_key`.',
    checkNowEmpty: 'ℹ️ Actualmente no hay mensajes recopilados – nada que analizar.',
    checkNowDone: '✅ **Análisis inmediato completado** ({count} mensajes analizados). Consulta el canal de registro para ver los resultados.',
    checkNowPartial: '⚠️ **Análisis inmediato iniciado** ({count} mensajes), pero {remaining} de ellos no se pudieron completar (error de API) – detalles en el canal de registro, los reintentos continúan automáticamente.',
    checkNowForcedActive: '🎯 Moderación forzada solicitada: {user} será moderado obligatoriamente en esta revisión – detalles en el canal de registro.',
    checkNowForcedNoMsgs: '⚠️ {user} no aparece en los mensajes recopilados – no hubo ningún mensaje que moderar.',
    checkNowForcedInvalid: '⚠️ {user} es un bot o un administrador y no puede ser moderado. Elige un miembro normal.',
    joinTitle: '👋 ¡Security Bot ha llegado!',
    joinDesc: '¡Gracias por invitarme! Para empezar:\n\n1️⃣ `/set_gemini_api_key` – añade una clave de Google Gemini ([crea una gratis](https://aistudio.google.com/apikey))\n2️⃣ `/set_prompt` – define las reglas y el rigor de la IA (texto predeterminado rellenado)\n3️⃣ `/set_log_channel` – elige un canal de registro\n\nDespués la IA vigila automáticamente todos los mensajes de texto. **Todos los comandos son solo para administradores.**',
    defaultPrompt: `Modera este servidor como un equipo de OP justo, amable pero firme.

=== REGLAS ===
- Sin insultos, odio, discriminación ni toxicidad extrema
- Sin comentarios sexistas, racistas, homófobos ni tránsfobos
- Sin spam, publicidad, venta de cuentas/Nitro ni enlaces sospechosos
- Respeto mutuo, incluso en desacuerdos
- Nada de contenido peligroso o ilegal

=== RIGOR (ni laxo ni estricto en exceso) ===
- NUNCA castigar bromas amistosas, sarcasmo entre amigos ni autocrítica
- Hablar SOBRE otros (p. ej. streamers o rivales) NO es una infracción
- Una sanción previa por sí sola NO justifica una nueva sanción
- Intervenir solo ante infracciones reales, claras e inequívocas
- En caso de duda: preferir una advertencia a un timeout

=== ESCALADA (advertencias primero) ===
- Primera infracción: siempre una advertencia (warn), sin timeout
- Timeout solo tras advertencias repetidas (registro) o en infracciones graves
- Como máximo UN timeout por persona y análisis – el resto de infracciones de esa persona como warn
- La infracción más grave es primary=true y recibe la duración más larga (o igual)

=== MEDIDAS ===
- Infracciones leves: warn con un consejo amable
- Insulto o provocación clara: warn, en repetición timeout 5m–10m
- Infracción repetida pese a la advertencia: timeout 10m–1h
- Discriminación, discurso de odio, amenazas: timeout 1d–1w
- Contenido peligroso, enlaces de phishing/estafa: timeout 1w
- Spam/publicidad: primera vez warn, repetición timeout 1h
- Sin infracción: no moderar a nadie y NO escribir nada en el chat – el bot permanece en silencio
- Nunca publicar saludos, charla trivial, avisos de «todo en orden» ni mensajes de estado`,
  },

  pt: {
    errGuildOnly: '🔒 Este comando só funciona dentro de um servidor.',
    errNoPermission: '🔒 Apenas administradores do servidor podem usar este comando.',
    apiKeySet: '✅ **Chave de API do Gemini salva** ({key}).\nA moderação por IA já está ativa – as mensagens coletadas são analisadas ao atingir o limite de tokens e, no máximo, a cada 2 horas.',
    apiKeyInvalid: '❌ **O Google rejeitou a chave de API** ({error}). A chave **não** foi salva. Crie uma em [aistudio.google.com](https://aistudio.google.com/apikey).',
    apiKeyKept: 'ℹ️ A chave de API existente foi mantida.',
    apiKeyRemoved: '🗑️ **Chave de API do Gemini removida.** As mensagens não são mais coletadas nem analisadas.',
    apiKeyUnverified: '⚠️ **Chave de API salva** ({key}), mas a verificação com o Google falhou ({error}). Ela será usada mesmo assim.',
    promptModalTitle: '🛡️ Instruções da IA (Prompt)',
    promptModalLabel: 'Regras, rigor e medidas para o Gemini',
    promptSaved: '✅ **Instruções da IA salvas** ({chars} caracteres).\nVale a partir da próxima análise do chat.',
    promptReset: '♻️ **Instruções da IA redefinidas para o texto padrão.**',
    logChannelSet: '✅ **Canal de registro definido:** {channel}\nO bot publicará lá avisos de moderação, erros de API e outros relatórios.',
    logChannelRemoved: '🗑️ **Canal de registro removido.** Nenhum aviso será mais enviado.',
    antiDeleteEnabled: '✅ **Anti-exclusão ativada.** Se alguém (não bot/webhook) apagar a própria última mensagem de um canal, o bot a reenvia via webhook com uma cópia exata do perfil (nome de exibição e avatar). Menções nunca notificam ninguém.',
    antiDeleteDisabled: '⛔ **Anti-exclusão desativada.** Mensagens apagadas não são mais reenviadas.',
    langChanged: '✅ Idioma alterado: {name}',

    descApiKey: 'Define a chave de API do Google Gemini para este servidor',
    descPrompt: 'Define as instruções da IA (regras, rigor, medidas)',
    descLogChannel: 'Define o canal de registro para avisos e erros de API',
    descLanguage: 'Muda o idioma do bot permanentemente',
    descHelp: 'Mostra todos os comandos e funções',
    descCheckNow: 'Executa imediatamente uma verificação de IA das mensagens coletadas (somente admins)',
    descCheckNowUser: 'Usuário que deve ser moderado obrigatoriamente nesta verificação (opcional)',
    descAntiDelete: 'Anti-exclusão: reenviar últimas mensagens apagadas via webhook',
    descAntiDeleteOption: 'true = ativar anti-exclusão, false = desativar',

    helpTitle: '🛡️ Security Bot – Moderação por IA com Gemini',
    helpDesc: 'Este bot coleta **mensagens de texto de usuários reais** (admins são imunes) até encher o limite de tokens para uma análise do Gemini – além disso, o histórico é analisado **a cada 2 horas**. O Gemini recebe o prompt do sistema, as regras do servidor e um histórico bem formatado e decide avisos e timeouts. Se a API falhar, **nada se perde**: as tentativas continuam até dar certo.',
    helpApiKey: 'Salva a chave de API do Google Gemini para este servidor. Precisa ser definida uma vez antes do monitoramento começar.',
    helpPrompt: 'Abre um formulário com suas instruções para a IA: regras do servidor, rigor da moderação e medidas que o Gemini deve usar. Seu último texto já vem preenchido.',
    helpLogChannel: 'Define o canal de registro para avisos de moderação e erros de API. Sem canal, o registro é removido.',
    helpLanguage: 'Muda o idioma do bot permanentemente (também controla o fuso horário da análise a cada 2 horas e o idioma padrão da IA).',
    helpHelp: 'Mostra este resumo.',
    helpCheckNow: 'Analisa imediatamente as mensagens já coletadas, sem esperar o limite de tokens ou a próxima análise de 2 em 2 horas. A opção `user` permite escolher um usuário que será moderado obrigatoriamente nesta verificação.',
    helpAntiDelete: 'Ativa ou desativa o anti-exclusão: se alguém (não bot/webhook) apagar a própria última mensagem de um canal, o bot a reenvia via webhook com uma cópia exata do perfil (nome e avatar). Menções nunca notificam ninguém.',
    logModTitle: '🛡️ Moderação por IA',
    logFieldUser: 'Usuário',
    logFieldAction: 'Medida',
    logFieldReason: 'Motivo do Gemini',
    logFieldMessage: 'Mensagem',
    logActionWarn: '⚠️ Aviso',
    logActionTimeout: '⏱️ Timeout',
    logPrimary: '💥 Violação principal (o bot respondeu a esta mensagem)',
    logNormal: 'Violação',
    logImmune: '🛡️ **Pulado:** o Gemini quis moderar {user}, mas administradores são sempre imunes.',
    logBatchSize: 'Histórico: {count} mensagens',
    logApiTitle: '⚠️ Erro da API do Gemini',
    logApiDesc: 'A análise de **{count} mensagens coletadas** falhou.\nErro: `{error}`\n\n🔁 Tentativa {attempt} – próxima repetição: **{retry}**.\n💾 As mensagens permanecem guardadas e **não são descartadas** – a coleta continua normalmente.',
    logNoKeyTitle: '🔑 Nenhuma chave de API do Gemini configurada',
    logNoKeyDesc: '{count} mensagens coletadas aguardam análise. Um administrador precisa executar `/set_gemini_api_key` primeiro.',
    logDropTitle: '🗑️ Histórico antigo descartado',
    logDropDesc: '{count} mensagens não puderam ser analisadas por mais de 30 dias (falha persistente da API) e foram apagadas por higiene de dados.',
    checkNowNoKey: '🔑 Nenhuma chave de API do Gemini configurada. Execute `/set_gemini_api_key` primeiro.',
    checkNowEmpty: 'ℹ️ No momento não há mensagens coletadas – nada para analisar.',
    checkNowDone: '✅ **Verificação imediata concluída** ({count} mensagens analisadas). Veja o canal de registro para os resultados.',
    checkNowPartial: '⚠️ **Verificação imediata iniciada** ({count} mensagens), mas {remaining} delas não puderam ser concluídas (erro de API) – detalhes no canal de registro, as novas tentativas continuam automaticamente.',
    checkNowForcedActive: '🎯 Moderação forçada solicitada: {user} será obrigatoriamente moderado nesta verificação – detalhes no canal de registro.',
    checkNowForcedNoMsgs: '⚠️ {user} não aparece nas mensagens coletadas – não houve mensagem para moderar.',
    checkNowForcedInvalid: '⚠️ {user} é um bot ou administrador e não pode ser moderado. Escolha um membro comum.',
    joinTitle: '👋 O Security Bot chegou!',
    joinDesc: 'Obrigado por me convidar! Para começar:\n\n1️⃣ `/set_gemini_api_key` – adicione uma chave do Google Gemini ([crie grátis](https://aistudio.google.com/apikey))\n2️⃣ `/set_prompt` – defina as regras e o rigor da IA (texto padrão já preenchido)\n3️⃣ `/set_log_channel` – escolha um canal de registro\n\nDepois disso a IA monitora automaticamente todas as mensagens de texto. **Todos os comandos são só para administradores.**',
    defaultPrompt: `Modere este servidor como uma equipe de OP justa, simpática, mas firme.

=== REGRAS ===
- Sem insultos, ódio, discriminação ou toxicidade extrema
- Sem declarações sexistas, racistas, homofóbicas ou transfóbicas
- Sem spam, publicidade, venda de contas/Nitro ou links suspeitos
- Respeito mútuo, mesmo em divergências
- Nada de conteúdo perigoso ou ilegal

=== RIGOR (nem frouxo nem rígido demais) ===
- NUNCA punir brincadeiras amigáveis, sarcasmo entre amigos ou autodepreciação
- Falar SOBRE outros (ex.: streamers ou adversários) NÃO é infração
- Uma punição anterior por si só NÃO justifica uma nova punição
- Intervir apenas em infrações reais, claras e inequívocas
- Na dúvida: prefira um aviso a um timeout

=== ESCALADA (avisos primeiro) ===
- Primeira infração: sempre um aviso (warn), sem timeout
- Timeout só após avisos repetidos (registro) ou em infrações graves
- No máximo UM timeout por pessoa por análise – demais infrações da mesma pessoa como warn
- A infração mais grave é primary=true e recebe a maior duração (ou igual)

=== MEDIDAS ===
- Infrações leves: warn com uma dica amigável
- Insulto ou provocação clara: warn, em repetição timeout 5m–10m
- Infração repetida apesar do aviso: timeout 10m–1h
- Discriminação, discurso de ódio, ameaças: timeout 1d–1w
- Conteúdo perigoso, links de phishing/golpe: timeout 1w
- Spam/publicidade: primeira vez warn, repetição timeout 1h
- Sem infração: não moderar ninguém e NÃO escrever nada no chat – o bot fica em silêncio
- Nunca publicar saudações, conversa fiada, avisos de «está tudo bem» ou mensagens de status`,
  },

  ru: {
    errGuildOnly: '🔒 Эта команда работает только на сервере.',
    errNoPermission: '🔒 Эту команду могут использовать только администраторы сервера.',
    apiKeySet: '✅ **API-ключ Gemini сохранён** ({key}).\nИИ-модерация активна – собранные сообщения анализируются по достижении лимита токенов и не реже одного раза в 2 часа.',
    apiKeyInvalid: '❌ **Google отклонил API-ключ** ({error}). Ключ **не** сохранён. Создайте его на [aistudio.google.com](https://aistudio.google.com/apikey).',
    apiKeyKept: 'ℹ️ Существующий API-ключ оставлен без изменений.',
    apiKeyRemoved: '🗑️ **API-ключ Gemini удалён.** Сообщения больше не собираются и не анализируются.',
    apiKeyUnverified: '⚠️ **API-ключ сохранён** ({key}), но проверка у Google не удалась ({error}). Ключ всё равно будет использоваться.',
    promptModalTitle: '🛡️ Инструкции для ИИ (Промпт)',
    promptModalLabel: 'Правила, строгость и меры для Gemini',
    promptSaved: '✅ **Инструкции для ИИ сохранены** ({chars} символов).\nОни вступят в силу со следующего анализа чата.',
    promptReset: '♻️ **Инструкции для ИИ сброшены к стандартному тексту.**',
    logChannelSet: '✅ **Канал журнала установлен:** {channel}\nТам бот будет публиковать уведомления о модерации, ошибки API и другие отчёты.',
    logChannelRemoved: '🗑️ **Канал журнала удалён.** Уведомления больше не отправляются.',
    antiDeleteEnabled: '✅ **Анти-удаление включено.** Если кто-то (не бот и не вебхук) удалит своё последнее сообщение в канале, бот отправит его заново вебхуком с точной копией профиля (отображаемое имя и аватар). Упоминания никого не уведомляют.',
    antiDeleteDisabled: '⛔ **Анти-удаление выключено.** Удалённые сообщения больше не отправляются заново.',
    langChanged: '✅ Язык изменён: {name}',

    descApiKey: 'Задать API-ключ Google Gemini для этого сервера',
    descPrompt: 'Задать инструкции для ИИ (правила, строгость, меры)',
    descLogChannel: 'Задать канал журнала для уведомлений и ошибок API',
    descLanguage: 'Навсегда изменить язык бота',
    descHelp: 'Показывает все команды и функции',
    descCheckNow: 'Немедленно запускает ИИ-проверку собранных сообщений (только админы)',
    descCheckNowUser: 'Пользователь, которого нужно обязательно модерировать при этой проверке',
    descAntiDelete: 'Анти-удаление: повторно отправлять удалённые последние сообщения вебхуком',
    descAntiDeleteOption: 'true = включить анти-удаление, false = выключить',

    helpTitle: '🛡️ Security Bot – ИИ-модерация с Gemini',
    helpDesc: 'Бот собирает **текстовые сообщения реальных пользователей** (админы неприкосновенны), пока не заполнится лимит токенов для анализа Gemini – кроме того, история анализируется **каждые 2 часа**. Gemini получает системный промпт, правила сервера и аккуратно оформленную историю чата, после чего решает, кого предупредить или выдать тайм-аут. При сбое API **ничего не теряется**: попытки повторяются до успеха.',
    helpApiKey: 'Сохраняет API-ключ Google Gemini для этого сервера. Должен быть задан один раз перед началом наблюдения.',
    helpPrompt: 'Открывает форму с вашими инструкциями для ИИ: правила сервера, строгость модерации и меры, которые применяет Gemini. Ваш последний текст уже вставлен.',
    helpLogChannel: 'Задаёт канал журнала для уведомлений о модерации и ошибок API. Без канала журнал удаляется.',
    helpLanguage: 'Навсегда меняет язык бота (также задаёт часовой пояс анализа каждые 2 часа и язык ИИ по умолчанию).',
    helpHelp: 'Показывает этот обзор.',
    helpCheckNow: 'Немедленно анализирует уже собранные сообщения, не дожидаясь лимита токенов или следующего запуска раз в 2 часа. Опция `user` позволяет выбрать пользователя, который будет обязательно модерирован при этой проверке.',
    helpAntiDelete: 'Включает или выключает анти-удаление: если кто-то (не бот и не вебхук) удалит своё последнее сообщение в канале, бот отправит его заново вебхуком с точной копией профиля (имя и аватар). Упоминания никого не уведомляют.',
    logModTitle: '🛡️ ИИ-модерация',
    logFieldUser: 'Пользователь',
    logFieldAction: 'Мера',
    logFieldReason: 'Причина от Gemini',
    logFieldMessage: 'Сообщение',
    logActionWarn: '⚠️ Предупреждение',
    logActionTimeout: '⏱️ Тайм-аут',
    logPrimary: '💥 Главное нарушение (бот ответил на это сообщение)',
    logNormal: 'Нарушение',
    logImmune: '🛡️ **Пропущено:** Gemini хотел наказать {user}, но администраторы всегда неприкосновенны.',
    logBatchSize: 'История: {count} сообщений',
    logApiTitle: '⚠️ Ошибка API Gemini',
    logApiDesc: 'Анализ **{count} собранных сообщений** не удался.\nОшибка: `{error}`\n\n🔁 Попытка {attempt} – следующая: **{retry}**.\n💾 Сообщения полностью сохранены и **не удаляются** – новые продолжают собираться как обычно.',
    logNoKeyTitle: '🔑 API-ключ Gemini не настроен',
    logNoKeyDesc: '{count} собранных сообщений ждут анализа. Администратор должен сначала выполнить `/set_gemini_api_key`.',
    logDropTitle: '🗑️ Устаревшая история чата удалена',
    logDropDesc: '{count} сообщений не удалось проанализировать более 30 дней (постоянный сбой API) – они удалены для гигиены данных.',
    checkNowNoKey: '🔑 API-ключ Gemini не настроен. Сначала выполните `/set_gemini_api_key`.',
    checkNowEmpty: 'ℹ️ Сейчас нет собранных сообщений – проверять нечего.',
    checkNowDone: '✅ **Мгновенная проверка завершена** ({count} сообщений проанализировано). Результаты смотрите в канале журнала.',
    checkNowPartial: '⚠️ **Мгновенная проверка запущена** ({count} сообщений), но {remaining} из них не удалось завершить (ошибка API) – подробности в канале журнала, повторные попытки продолжаются автоматически.',
    checkNowForcedActive: '🎯 Запрошена принудительная модерация: {user} будет обязательно модерирован при этой проверке – подробности в канале журнала.',
    checkNowForcedNoMsgs: '⚠️ {user} не встречается в собранных сообщениях – сообщений для модерации не было.',
    checkNowForcedInvalid: '⚠️ {user} — бот или администратор и не может быть модерирован. Выберите обычного участника.',
    joinTitle: '👋 Security Bot на сервере!',
    joinDesc: 'Спасибо за приглашение! Как начать:\n\n1️⃣ `/set_gemini_api_key` – добавьте ключ Google Gemini ([создать бесплатно](https://aistudio.google.com/apikey))\n2️⃣ `/set_prompt` – задайте правила и строгость ИИ (стандартный текст уже вставлен)\n3️⃣ `/set_log_channel` – выберите канал журнала\n\nПосле этого ИИ автоматически следит за всеми текстовыми сообщениями. **Все команды видны только администраторам.**',
    defaultPrompt: `Модерируй этот сервер как справедливая, дружелюбная, но твёрдая команда ОП.

=== ПРАВИЛА ===
- Никаких оскорблений, ненависти, дискриминации или крайней токсичности
- Никаких сексистских, расистских, гомофобных или трансфобных высказываний
- Никакого спама, рекламы, продажи аккаунтов/Nitro и подозрительных ссылок
- Взаимное уважение – даже в спорах
- Никакого опасного или незаконного контента

=== СТРОГОСТЬ (не слишком мягко и не слишком строго) ===
- НИКОГДА не наказывай дружеские подколы, сарказм между друзьями и самоиронию
- Говорить О других (например, о стримерах или соперниках) – НЕ нарушение
- Прежнее наказание само по себе НЕ повод для нового наказания
- Вмешивайся только при настоящих, ясных, однозначных нарушениях
- Сомневаешься – лучше предупреждение, чем тайм-аут

=== ЭСКАЛАЦИЯ (сначала предупреждения) ===
- Первое нарушение: всегда предупреждение (warn), без тайм-аута
- Тайм-аут только после повторных предупреждений (реестр) или при тяжёлых нарушениях
- Не более ОДНОГО тайм-аута на человека за анализ – остальные нарушения того же человека как warn
- Самое тяжёлое нарушение – primary=true и получает самую длинную (или равную) длительность

=== МЕРЫ ===
- Лёгкие нарушения: warn с дружелюбным советом
- Явное оскорбление или провокация: warn, при повторе timeout 5m–10m
- Повторное нарушение несмотря на предупреждение: timeout 10m–1h
- Дискриминация, язык вражды, угрозы: timeout 1d–1w
- Опасный контент, фишинг/мошеннические ссылки: timeout 1w
- Спам/реклама: первый раз warn, повтор timeout 1h
- Нет нарушений: никого не наказывать и НИЧЕГО не писать в чат – бот молчит
- Никогда не публиковать приветствия, болтовню, сообщения «всё спокойно» или статусы`,
  },

  ja: {
    errGuildOnly: '🔒 このコマンドはサーバー内でのみ使用できます。',
    errNoPermission: '🔒 このコマンドを使用できるのはサーバー管理者のみです。',
    apiKeySet: '✅ **Gemini APIキーを保存しました**（{key}）。\nAIモデレーションが有効になりました。収集したメッセージはトークン上限に達し次第、遅くとも2時間ごとに分析されます。',
    apiKeyInvalid: '❌ **GoogleにAPIキーを拒否されました**（{error}）。キーは保存されて**いません**。[aistudio.google.com](https://aistudio.google.com/apikey) で作成してください。',
    apiKeyKept: 'ℹ️ 既存のAPIキーはそのまま維持されました。',
    apiKeyRemoved: '🗑️ **Gemini APIキーを削除しました。** メッセージの収集と分析を停止します。',
    apiKeyUnverified: '⚠️ **APIキーを保存しました**（{key}）が、Googleでの確認に失敗しました（{error}）。それでもこのキーを使用します。',
    promptModalTitle: '🛡️ AIへの指示（プロンプト）',
    promptModalLabel: 'Geminiへのルール・厳しさ・措置',
    promptSaved: '✅ **AIへの指示を保存しました**（{chars}文字）。\n次のチャット分析から適用されます。',
    promptReset: '♻️ **AIへの指示をデフォルトのテキストに戻しました。**',
    logChannelSet: '✅ **ログチャンネルを設定しました：** {channel}\nモデレーションのお知らせやAPIエラーなどはここに送られます。',
    logChannelRemoved: '🗑️ **ログチャンネルを削除しました。** お知らせは送信されなくなります。',
    antiDeleteEnabled: '✅ **アンチ削除を有効化しました。** 誰かが（ボット・Webhook以外）自分の最後のメッセージを削除した場合、ボットが正確なプロフィール（表示名とアバター）でWebhook経由で再送信します。メンションは通知されません。',
    antiDeleteDisabled: '⛔ **アンチ削除を無効化しました。** 削除されたメッセージは再送信されません。',
    langChanged: '✅ 言語を変更しました：{name}',

    descApiKey: 'このサーバーのGoogle Gemini APIキーを設定',
    descPrompt: 'フォームでAIの指示を設定（ルール・厳しさ・措置）',
    descLogChannel: 'モデレーション通知のログチャンネルを設定',
    descLanguage: 'ボットの言語を永久に変更',
    descHelp: 'すべてのコマンドと機能を表示',
    descCheckNow: '収集済みメッセージのAIチェックを今すぐ実行します（管理者のみ）',
    descCheckNowUser: 'このチェックで必ずモデレートするユーザー（任意）',
    descAntiDelete: 'アンチ削除：削除された最後のメッセージをWebhookで再送信',
    descAntiDeleteOption: 'true = アンチ削除を有効化、false = 無効化',

    helpTitle: '🛡️ Security Bot – GeminiによるAIモデレーション',
    helpDesc: 'このボットは、Geminiで分析するためのトークン上限に達するまで**実際のユーザーのテキストメッセージ**を収集します（管理者は対象外）。さらに、履歴は**2時間ごと**にも分析されます。Geminiはシステムプロンプト・サーバーのルール・整形されたチャット履歴を受け取り、警告やタイムアウトを決定します。APIエラー時も**何も失われません**：成功するまで再試行を続けます。',
    helpApiKey: 'このサーバーのGoogle Gemini APIキーを保存します。監視開始前に一度設定してください。',
    helpPrompt: 'AIへの指示フォームを開きます：サーバーのルール、モデレーションの厳しさ、Geminiが使う措置。最後に保存したテキストが入力済みです。',
    helpLogChannel: 'モデレーションのお知らせやAPIエラー用のログチャンネルを設定します。チャンネルを指定しない場合は削除されます。',
    helpLanguage: 'ボットの言語を永久に変更します（2時間ごとの分析のタイムゾーンとAIのデフォルト言語にも影響します）。',
    helpHelp: 'この概要を表示します。',
    helpCheckNow: 'トークン上限や次の2時間ごとの分析を待たずに、これまでに収集したメッセージを今すぐ分析します。`user` オプションで必ずモデレートするユーザーを指定できます。',
    helpAntiDelete: 'アンチ削除のオン／オフ：誰かが（ボット・Webhook以外）自分の最後のメッセージを削除した場合、ボットが正確なプロフィール（名前とアバター）でWebhook経由で再送信します。メンションは通知されません。',
    logModTitle: '🛡️ AIモデレーション',
    logFieldUser: 'ユーザー',
    logFieldAction: '措置',
    logFieldReason: 'Geminiの理由',
    logFieldMessage: 'メッセージ',
    logActionWarn: '⚠️ 警告',
    logActionTimeout: '⏱️ タイムアウト',
    logPrimary: '💥 主な違反（ボットはこのメッセージに返信しました）',
    logNormal: '違反',
    logImmune: '🛡️ **スキップ：** Geminiは{user}をモデレートしようとしましたが、管理者は常に保護されています。',
    logBatchSize: '履歴：{count}件のメッセージ',
    logApiTitle: '⚠️ Gemini APIエラー',
    logApiDesc: '**{count}件の収集メッセージ**の分析に失敗しました。\nエラー：`{error}`\n\n🔁 試行{attempt}回目 – 次回：**{retry}**。\n💾 メッセージは完全に保持され、**破棄されません** – 新しいメッセージも通常どおり収集されます。',
    logNoKeyTitle: '🔑 Gemini APIキーが未設定です',
    logNoKeyDesc: '{count}件の収集メッセージが分析待ちです。管理者が先に `/set_gemini_api_key` を実行する必要があります。',
    logDropTitle: '🗑️ 古いチャット履歴を破棄しました',
    logDropDesc: '{count}件のメッセージは30日以上分析できず（APIの永続的な障害）、データ衛生のため削除されました。',
    checkNowNoKey: '🔑 Gemini APIキーが設定されていません。先に `/set_gemini_api_key` を実行してください。',
    checkNowEmpty: 'ℹ️ 現在収集されたメッセージはありません – チェックする内容がありません。',
    checkNowDone: '✅ **即時チェックが完了しました**（{count}件のメッセージを分析）。結果はログチャンネルをご覧ください。',
    checkNowPartial: '⚠️ **即時チェックを開始しました**（{count}件）が、うち{remaining}件は完了できませんでした（APIエラー）。詳細はログチャンネルを確認してください。自動的に再試行が続きます。',
    checkNowForcedActive: '🎯 強制モデレーションが指定されました：{user} はこのチェックで必ずモデレートされます。詳細はログチャンネルへ。',
    checkNowForcedNoMsgs: '⚠️ {user} は収集されたメッセージに存在しません。モデレートするメッセージがありませんでした。',
    checkNowForcedInvalid: '⚠️ {user} はボットまたは管理者のためモデレートできません。通常のメンバーを選んでください。',
    joinTitle: '👋 Security Botが到着しました！',
    joinDesc: '招待ありがとうございます！始め方：\n\n1️⃣ `/set_gemini_api_key` – Google Geminiキーを設定（[無料で作成](https://aistudio.google.com/apikey)）\n2️⃣ `/set_prompt` – AIのルールと厳しさを設定（デフォルト文を入力済み）\n3️⃣ `/set_log_channel` – ログチャンネルを選択\n\nその後、AIがすべてのテキストメッセージを自動監視します。**すべてのコマンドは管理者のみ表示されます。**',
    defaultPrompt: `このサーバーを、公正で親しみやすいけれど毅然としたOPチームとしてモデレートしてください。

=== ルール ===
- 侮辱、ヘイト、差別、極端な毒性は禁止
- 性差別的・人種差別的・同性愛嫌悪的・トランス嫌悪的な発言は禁止
- スパム、宣伝、アカウント/Nitroの売買、不審なリンクは禁止
- 意見が違っても互いに尊重する
- 危険または違法なコンテンツは禁止

=== 厳しさ（甘すぎず厳しすぎず） ===
- 友人間の冗談、皮肉、自虐ネタは決して罰しない
- 他人について語るだけ（例：配信者や対戦相手）は違反ではない
- 過去の処罰だけでは新しい処罰の理由にならない
- 明確で疑いのない実際の違反にのみ介入する
- 迷ったらタイムアウトより警告を選ぶ

=== エスカレーション（まず警告） ===
- 初回の違反：必ず警告（warn）、タイムアウトなし
- タイムアウトは繰り返しの警告後（記録）または重大な違反のみ
- 1人につき1分析で最大1回のタイムアウト。同じ人の他の違反はwarn
- 最も重大な違反をprimary=trueとし、最長（または同等）の時間を与える

=== 措置 ===
- 軽微な違反：親しみやすい注意つきのwarn
- 明確な侮辱や挑発：warn、繰り返しならtimeout 5m〜10m
- 警告にもかかわらず繰り返す違反：timeout 10m〜1h
- 差別、ヘイトスピーチ、脅迫：timeout 1d〜1w
- 危険なコンテンツ、フィッシング/詐欺リンク：timeout 1w
- スパム/宣伝：初回はwarn、繰り返しならtimeout 1h
- 違反なし：誰も罰せず、チャットには何も書かない – ボットは沈黙する
- 挨拶、雑談、「異常なし」の報告、状況アナウンスは絶対に投稿しない`,
  },

  ko: {
    errGuildOnly: '🔒 이 명령어는 서버 안에서만 사용할 수 있습니다.',
    errNoPermission: '🔒 서버 관리자만 이 명령어를 사용할 수 있습니다.',
    apiKeySet: '✅ **Gemini API 키가 저장되었습니다** ({key}).\nAI 검열이 활성화되었습니다. 수집된 메시지는 토큰 한도에 도달하면, 늦어도 2시간마다 분석됩니다.',
    apiKeyInvalid: '❌ **Google이 API 키를 거부했습니다** ({error}). 키는 저장되지 **않았습니다**. [aistudio.google.com](https://aistudio.google.com/apikey)에서 만들어 주세요.',
    apiKeyKept: 'ℹ️ 기존 API 키가 그대로 유지되었습니다.',
    apiKeyRemoved: '🗑️ **Gemini API 키가 삭제되었습니다.** 더 이상 메시지를 수집하거나 분석하지 않습니다.',
    apiKeyUnverified: '⚠️ **API 키가 저장되었습니다** ({key})만 Google 확인에 실패했습니다 ({error}). 그래도 이 키를 사용합니다.',
    promptModalTitle: '🛡️ AI 지시사항 (프롬프트)',
    promptModalLabel: 'Gemini를 위한 규칙·엄격함·조치',
    promptSaved: '✅ **AI 지시사항이 저장되었습니다** ({chars}자).\n다음 채팅 분석부터 적용됩니다.',
    promptReset: '♻️ **AI 지시사항이 기본 텍스트로 초기화되었습니다.**',
    logChannelSet: '✅ **로그 채널이 설정되었습니다:** {channel}\n검열 알림, API 오류 등이 이곳에 전송됩니다.',
    logChannelRemoved: '🗑️ **로그 채널이 제거되었습니다.** 더 이상 알림을 보내지 않습니다.',
    antiDeleteEnabled: '✅ **안티 삭제가 활성화되었습니다.** 누군가(봇/웹훅 제외) 자신의 마지막 메시지를 삭제하면 봇이 정확한 프로필(표시 이름과 아바타)로 웹훅을 통해 다시 본냅니다. 멘션은 알림을 본내지 않습니다.',
    antiDeleteDisabled: '⛔ **안티 삭제가 비활성화되었습니다.** 삭제된 메시지는 더 이상 다시 본내지 않습니다.',
    langChanged: '✅ 언어가 변경되었습니다: {name}',

    descApiKey: '이 서버의 Google Gemini API 키 설정',
    descPrompt: '양식으로 AI 지시사항 설정 (규칙·엄격함·조치)',
    descLogChannel: '검열 알림의 로그 채널 설정',
    descLanguage: '봇 언어를 영구적으로 변경',
    descHelp: '모든 명령어와 기능 표시',
    descCheckNow: '수집된 메시지에 대한 AI 검사를 즉시 시작합니다 (관리자 전용)',
    descCheckNowUser: '이 점검에서 반드시 모더레이션할 사용자 (선택 사항)',
    descAntiDelete: '안티 삭제: 삭제된 마지막 메시지를 웹훅으로 다시 본내기',
    descAntiDeleteOption: 'true = 안티 삭제 켜기, false = 끄기',

    helpTitle: '🛡️ Security Bot – Gemini AI 검열',
    helpDesc: '이 봇은 Gemini 분석 토큰 한도가 채워질 때까지 **실제 사용자의 텍스트 메시지**를 수집합니다(관리자는 면역). 또한 2시간마다 기록을 분석합니다. Gemini는 시스템 프롬프트, 서버 규칙, 정리된 채팅 기록을 받아 경고와 타임아웃을 결정합니다. API 오류가 발생해도 **아무것도 사라지지 않습니다**: 성공할 때까지 재시도합니다.',
    helpApiKey: '이 서버의 Google Gemini API 키를 저장합니다. 모니터링 시작 전 한 번 설정해야 합니다.',
    helpPrompt: 'AI 지시사항 양식을 엽니다: 서버 규칙, 검열 엄격함, Gemini가 사용할 조치. 마지막으로 저장한 텍스트가 미리 채워져 있습니다.',
    helpLogChannel: '검열 알림과 API 오류를 위한 로그 채널을 설정합니다. 채널 없이 호출하면 제거됩니다.',
    helpLanguage: '봇 언어를 영구적으로 변경합니다 (2시간 주기 분석의 시간대와 AI 기본 언어에도 영향).',
    helpHelp: '이 개요를 표시합니다.',
    helpCheckNow: '토큰 한도나 다음 2시간 주기 분석을 기다리지 않고 지금까지 수집된 메시지를 즉시 분석합니다. `user` 옵션으로 반드시 모더레이션할 사용자를 지정할 수 있습니다.',
    helpAntiDelete: '안티 삭제 켜기/끄기: 누군가(봇/웹훅 제외) 자신의 마지막 메시지를 삭제하면 봇이 정확한 프로필(이름과 아바타)로 웹훅을 통해 다시 본냅니다. 멘션은 알림을 본내지 않습니다.',
    logModTitle: '🛡️ AI 검열',
    logFieldUser: '사용자',
    logFieldAction: '조치',
    logFieldReason: 'Gemini의 이유',
    logFieldMessage: '메시지',
    logActionWarn: '⚠️ 경고',
    logActionTimeout: '⏱️ 타임아웃',
    logPrimary: '💥 주요 위반 (봇이 이 메시지에 답장했습니다)',
    logNormal: '위반',
    logImmune: '🛡️ **건너뜀:** Gemini가 {user}님을 검열하려 했지만 관리자는 항상 면역입니다.',
    logBatchSize: '기록: {count}개 메시지',
    logApiTitle: '⚠️ Gemini API 오류',
    logApiDesc: '**수집된 {count}개 메시지**의 분석이 실패했습니다.\n오류: `{error}`\n\n🔁 {attempt}번째 시도 – 다음 재시도: **{retry}**.\n💾 메시지는 그대로 보존되며 **폐기되지 않습니다** – 새 메시지도 평소처럼 수집됩니다.',
    logNoKeyTitle: '🔑 Gemini API 키가 설정되지 않았습니다',
    logNoKeyDesc: '수집된 {count}개 메시지가 분석을 기다립니다. 관리자가 먼저 `/set_gemini_api_key`를 실행해야 합니다.',
    logDropTitle: '🗑️ 오래된 채팅 기록 폐기',
    logDropDesc: '{count}개 메시지는 30일 넘게 분석하지 못했고(API 지속 장애) 데이터 위생을 위해 삭제되었습니다.',
    checkNowNoKey: '🔑 Gemini API 키가 설정되지 않았습니다. 먼저 `/set_gemini_api_key`를 실행하세요.',
    checkNowEmpty: 'ℹ️ 현재 수집된 메시지가 없습니다 – 검사할 내용이 없습니다.',
    checkNowDone: '✅ **즉시 검사 완료** ({count}개 메시지 분석됨). 결과는 로그 채널을 확인하세요.',
    checkNowPartial: '⚠️ **즉시 검사 시작됨** ({count}개), 그러나 {remaining}개는 완료되지 못했습니다(API 오류) – 자세한 내용은 로그 채널에서 확인하세요. 재시도가 자동으로 계속됩니다.',
    checkNowForcedActive: '🎯 강제 모더레이션이 요청되었습니다: {user} 님은 이번 점검에서 반드시 모더레이션됩니다. 자세한 내용은 로그 채널을 확인하세요.',
    checkNowForcedNoMsgs: '⚠️ 수집된 메시지에 {user} 님이 없습니다 – 모더레이션할 메시지가 없었습니다.',
    checkNowForcedInvalid: '⚠️ {user} 님은 봇이거나 관리자이므로 모더레이션할 수 없습니다. 일반 멤버를 선택하세요.',
    joinTitle: '👋 Security Bot이 도착했습니다!',
    joinDesc: '초대해 주셔서 감사합니다! 시작 방법:\n\n1️⃣ `/set_gemini_api_key` – Google Gemini 키 추가([무료 생성](https://aistudio.google.com/apikey))\n2️⃣ `/set_prompt` – AI 규칙과 엄격함 설정(기본 텍스트 미리 입력됨)\n3️⃣ `/set_log_channel` – 로그 채널 선택\n\n이후 AI가 모든 텍스트 메시지를 자동 감시합니다. **모든 명령어는 관리자에게만 보입니다.**',
    defaultPrompt: `이 서버를 공정하고 친절하지만 단호한 운영팀처럼 검열하세요.

=== 규칙 ===
- 모욕, 혐오, 차별, 극단적 독성 금지
- 성차별·인종차별·동성애 혐오·트랜스젠더 혐오 발언 금지
- 스팸, 광고, 계정/Nitro 거래, 수상한 링크 금지
- 의견이 달라도 서로 존중하기
- 위험하거나 불법적인 콘텐츠 금지

=== 엄격함 (너무 느슨하지도, 너무 엄하지도 않게) ===
- 친구 사이의 장난, 농담, 자조적인 말은 절대 처벌하지 않기
- 다른 사람에 대해 말하는 것(예: 스트리머나 상대)은 위반이 아님
- 과거 처벌만으로는 새로운 처벌의 이유가 되지 않음
- 실제로 명확하고 분명한 위반에만 개입하기
- 애매하면 타임아웃보다 경고를 선택하기

=== 에스컬레이션 (경고 우선) ===
- 첫 위반: 항상 경고(warn), 타임아웃 없음
- 타임아웃은 반복된 경고 후(기록) 또는 중대한 위반일 때만
- 1인당 분석당 최대 1회 타임아웃. 같은 사람의 다른 위반은 warn
- 가장 중대한 위반을 primary=true로 하고 가장 긴(또는 동일한) 시간을 부여

=== 조치 ===
- 가벼운 위반: 친절한 안내와 함께 warn
- 명백한 모욕이나 도발: warn, 반복 시 timeout 5m~10m
- 경고에도 반복된 위반: timeout 10m~1h
- 차별, 혐오 발언, 위협: timeout 1d~1w
- 위험한 콘텐츠, 피싱/사기 링크: timeout 1w
- 스팸/광고: 처음엔 warn, 반복 시 timeout 1h
- 위반 없음: 누구도 처벌하지 말고 채팅에 아무것도 쓰지 않기 – 봇은 침묵합니다
- 인사, 잡담, 「이상 없음」 안내, 상태 알림은 절대 게시하지 않기`,
  },

  zh: {
    errGuildOnly: '🔒 此命令只能在服务器内使用。',
    errNoPermission: '🔒 只有服务器管理员才能使用此命令。',
    apiKeySet: '✅ **Gemini API 密钥已保存**（{key}）。\nAI 审核已启用——收集的消息将在达到令牌上限时分析，最迟每 2 小时分析一次。',
    apiKeyInvalid: '❌ **Google 拒绝了该 API 密钥**（{error}）。密钥**未**保存。请在 [aistudio.google.com](https://aistudio.google.com/apikey) 创建。',
    apiKeyKept: 'ℹ️ 现有 API 密钥保持不变。',
    apiKeyRemoved: '🗑️ **Gemini API 密钥已删除。** 不再收集或分析消息。',
    apiKeyUnverified: '⚠️ **API 密钥已保存**（{key}），但在 Google 验证失败（{error}）。仍将使用该密钥。',
    promptModalTitle: '🛡️ AI 指令（提示词）',
    promptModalLabel: '给 Gemini 的规则、严格程度与措施',
    promptSaved: '✅ **AI 指令已保存**（{chars} 个字符）。\n将从下一次聊天分析开始生效。',
    promptReset: '♻️ **AI 指令已重置为默认文本。**',
    logChannelSet: '✅ **日志频道已设置：** {channel}\n机器人将在此发布审核通知、API 错误等报告。',
    logChannelRemoved: '🗑️ **日志频道已移除。** 不再发送通知。',
    antiDeleteEnabled: '✅ **反删除已开启。** 当有人（非机器人/Webhook）删除自己在频道中的最后一条消息时，机器人会通过 Webhook 以完全相同的个人资料（显示名称和头像）重新发送。提及不会通知任何人。',
    antiDeleteDisabled: '⛔ **反删除已关闭。** 被删除的消息将不再重新发送。',
    langChanged: '✅ 语言已更改：{name}',

    descApiKey: '设置此服务器的 Google Gemini API 密钥',
    descPrompt: '通过表单设置 AI 指令（规则、严格度、措施）',
    descLogChannel: '设置审核通知的日志频道',
    descLanguage: '永久更改机器人语言',
    descHelp: '显示所有命令与功能',
    descCheckNow: '立即对已收集的消息运行 AI 检查（仅限管理员）',
    descCheckNowUser: '本次检查中必须被审核的用户（可选）',
    descAntiDelete: '反删除：通过 Webhook 重新发送被删除的最后一条消息',
    descAntiDeleteOption: 'true = 开启反删除，false = 关闭',

    helpTitle: '🛡️ Security Bot – Gemini AI 审核',
    helpDesc: '此机器人收集**真实用户的文本消息**（管理员免疫），直到达到一次 Gemini 分析的令牌上限——此外，**每 2 小时**也会分析历史记录。Gemini 会收到系统提示词、服务器规则和格式良好的聊天记录，然后决定警告与禁言。API 出错时**不会丢失任何内容**：会不断重试直到成功。',
    helpApiKey: '保存此服务器的 Google Gemini API 密钥。开始监控前必须设置一次。',
    helpPrompt: '打开 AI 指令表单：服务器规则、审核严格程度以及 Gemini 应采取的措施。已预填您上次保存的文本。',
    helpLogChannel: '设置用于审核通知和 API 错误的日志频道。不带频道调用则移除日志频道。',
    helpLanguage: '永久更改机器人语言（同时控制每 2 小时分析的时区和 AI 默认语言）。',
    helpHelp: '显示此概览。',
    helpCheckNow: '无需等待令牌上限或下一次每 2 小时的分析，立即分析目前已收集的消息。可通过 `user` 选项指定一位必须被审核的用户。',
    helpAntiDelete: '开启或关闭反删除：当有人（非机器人/Webhook）删除自己在频道中的最后一条消息时，机器人会通过 Webhook 以完全相同的个人资料（名称和头像）重新发送。提及不会通知任何人。',
    logModTitle: '🛡️ AI 审核',
    logFieldUser: '用户',
    logFieldAction: '措施',
    logFieldReason: 'Gemini 的理由',
    logFieldMessage: '消息',
    logActionWarn: '⚠️ 警告',
    logActionTimeout: '⏱️ 禁言',
    logPrimary: '💥 主要违规（机器人回复了此消息）',
    logNormal: '违规',
    logImmune: '🛡️ **已跳过：** Gemini 想处罚 {user}，但管理员始终免疫。',
    logBatchSize: '记录：{count} 条消息',
    logApiTitle: '⚠️ Gemini API 错误',
    logApiDesc: '**{count} 条已收集消息**的分析失败。\n错误：`{error}`\n\n🔁 第 {attempt} 次尝试 – 下次重试：**{retry}**。\n💾 消息被完整保留并**不会丢弃**——新消息继续正常收集。',
    logNoKeyTitle: '🔑 未设置 Gemini API 密钥',
    logNoKeyDesc: '{count} 条收集的消息正在等待分析。管理员需要先执行 `/set_gemini_api_key`。',
    logDropTitle: '🗑️ 过期聊天记录已丢弃',
    logDropDesc: '{count} 条消息超过 30 天无法分析（API 持续故障），已出于数据卫生被删除。',
    checkNowNoKey: '🔑 尚未配置 Gemini API 密钥。请先执行 `/set_gemini_api_key`。',
    checkNowEmpty: 'ℹ️ 目前没有已收集的消息——无需检查。',
    checkNowDone: '✅ **即时检查已完成**（已分析 {count} 条消息）。结果请查看日志频道。',
    checkNowPartial: '⚠️ **即时检查已开始**（{count} 条消息），但其中 {remaining} 条未能完成（API 错误)——详情见日志频道，系统会自动继续重试。',
    checkNowForcedActive: '🎯 已请求强制审核：{user} 将在本次检查中被强制审核——详情见日志频道。',
    checkNowForcedNoMsgs: '⚠️ 收集的消息中没有 {user}——没有可审核的消息。',
    checkNowForcedInvalid: '⚠️ {user} 是机器人或管理员，无法被审核。请选择普通成员。',
    joinTitle: '👋 Security Bot 已加入！',
    joinDesc: '感谢邀请！开始步骤：\n\n1️⃣ `/set_gemini_api_key` – 配置 Google Gemini 密钥（[免费创建](https://aistudio.google.com/apikey)）\n2️⃣ `/set_prompt` – 设置 AI 规则与严格度（已预填默认文本）\n3️⃣ `/set_log_channel` – 选择日志频道\n\n之后 AI 将自动监控所有文本消息。**所有命令仅管理员可见。**',
    defaultPrompt: `像一支公正、友善但坚定的管理团队一样审核这个服务器。

=== 规则 ===
- 禁止侮辱、仇恨、歧视或极端恶毒言论
- 禁止性别歧视、种族歧视、恐同或跨性别歧视言论
- 禁止刷屏、广告、账号/Nitro 交易和可疑链接
- 即使意见不合也要互相尊重
- 禁止危险或非法内容

=== 严格程度（既不过松也不过严） ===
- 绝不处罚朋友间的玩笑、讽刺和自嘲
- 只是谈论他人（例如主播或对手）并不违规
- 过往处罚本身不构成新的处罚理由
- 只在真实、明确、无歧义的违规时介入
- 有疑问时：宁选警告，不选禁言

=== 升级规则（警告优先） ===
- 首次违规：一律警告（warn），不禁言
- 只有在多次警告之后（记录）或严重违规时才禁言
- 每人每次分析最多一次禁言；同一人的其他违规改为 warn
- 最严重的违规标记为 primary=true，并给予最长（或相同）的时长

=== 措施 ===
- 轻微违规：友好提示的 warn
- 明确的侮辱或挑衅：warn，重复时 timeout 5m–10m
- 警告后仍重复违规：timeout 10m–1h
- 歧视、仇恨言论、威胁：timeout 1d–1w
- 危险内容、钓鱼/诈骗链接：timeout 1w
- 刷屏/广告：首次 warn，重复时 timeout 1h
- 没有违规：不处罚任何人，也不要在聊天中写任何内容——机器人保持沉默
- 绝不发布问候、闲聊、「一切正常」的通报或状态消息`,
  },

  it: {
    errGuildOnly: '🔒 Questo comando funziona solo dentro un server.',
    errNoPermission: '🔒 Solo gli amministratori del server possono usare questo comando.',
    apiKeySet: '✅ **Chiave API Gemini salvata** ({key}).\nLa moderazione IA è ora attiva – i messaggi raccolti vengono analizzati al raggiungimento del limite di token e comunque ogni 2 ore.',
    apiKeyInvalid: '❌ **Google ha rifiutato la chiave API** ({error}). La chiave **non** è stata salvata. Creane una su [aistudio.google.com](https://aistudio.google.com/apikey).',
    apiKeyKept: 'ℹ️ La chiave API esistente è stata mantenuta.',
    apiKeyRemoved: '🗑️ **Chiave API Gemini rimossa.** I messaggi non vengono più raccolti né analizzati.',
    apiKeyUnverified: '⚠️ **Chiave API salvata** ({key}), ma la verifica con Google non è riuscita ({error}). Verrà usata comunque.',
    promptModalTitle: '🛡️ Istruzioni per l’IA (Prompt)',
    promptModalLabel: 'Regole, severità e misure per Gemini',
    promptSaved: '✅ **Istruzioni per l’IA salvate** ({chars} caratteri).\nValgono dalla prossima analisi della chat.',
    promptReset: '♻️ **Istruzioni per l’IA ripristinate al testo predefinito.**',
    logChannelSet: '✅ **Canale di log impostato:** {channel}\nIl bot pubblicherà lì avvisi di moderazione, errori API e altri rapporti.',
    logChannelRemoved: '🗑️ **Canale di log rimosso.** Non verranno più inviati avvisi.',
    antiDeleteEnabled: '✅ **Anti-eliminazione attivata.** Se qualcuno (non bot/webhook) elimina il proprio ultimo messaggio di un canale, il bot lo reinvia via webhook con una copia esatta del profilo (nome visualizzato e avatar). Le menzioni non notificano nessuno.',
    antiDeleteDisabled: '⛔ **Anti-eliminazione disattivata.** I messaggi eliminati non vengono più reinviati.',
    langChanged: '✅ Lingua cambiata: {name}',

    descApiKey: 'Imposta la chiave API Google Gemini per questo server',
    descPrompt: 'Imposta le istruzioni IA (regole, severità, misure)',
    descLogChannel: 'Imposta il canale di log per avvisi ed errori API',
    descLanguage: 'Cambia permanentemente la lingua del bot',
    descHelp: 'Mostra tutti i comandi e le funzioni',
    descCheckNow: 'Avvia subito un controllo IA dei messaggi raccolti (solo admin)',
    descCheckNowUser: 'Utente da moderare obbligatoriamente in questo controllo (opzionale)',
    descAntiDelete: 'Anti-eliminazione: reinvia gli ultimi messaggi eliminati via webhook',
    descAntiDeleteOption: 'true = attiva anti-eliminazione, false = disattiva',

    helpTitle: '🛡️ Security Bot – Moderazione IA con Gemini',
    helpDesc: 'Questo bot raccoglie i **messaggi di testo degli utenti reali** (gli admin sono immuni) fino al limite di token per un’analisi Gemini – in aggiunta, la cronologia viene analizzata **ogni 2 ore**. Gemini riceve il prompt di sistema, le regole del server e una cronologia ben formattata, poi decide avvisi e timeout. Se l’API fallisce, **non si perde nulla**: i tentativi continuano finché non riesce.',
    helpApiKey: 'Salva la chiave API Google Gemini per questo server. Va impostata una volta prima di avviare il controllo.',
    helpPrompt: 'Apre un modulo con le tue istruzioni per l’IA: regole del server, severità della moderazione e misure da usare. L’ultimo testo salvato è già compilato.',
    helpLogChannel: 'Imposta il canale di log per avvisi di moderazione ed errori API. Senza canale, il log viene rimosso.',
    helpLanguage: 'Cambia permanentemente la lingua del bot (controlla anche il fuso orario dell’analisi ogni 2 ore e la lingua predefinita dell’IA).',
    helpHelp: 'Mostra questa panoramica.',
    helpCheckNow: 'Analizza subito i messaggi già raccolti, senza attendere il limite di token o la prossima analisi ogni 2 ore. L’opzione `user` permette di scegliere un utente che sarà moderato obbligatoriamente in questo controllo.',
    helpAntiDelete: 'Attiva o disattiva l’anti-eliminazione: se qualcuno (non bot/webhook) elimina il proprio ultimo messaggio di un canale, il bot lo reinvia via webhook con una copia esatta del profilo (nome e avatar). Le menzioni non notificano nessuno.',
    logModTitle: '🛡️ Moderazione IA',
    logFieldUser: 'Utente',
    logFieldAction: 'Misura',
    logFieldReason: 'Motivo di Gemini',
    logFieldMessage: 'Messaggio',
    logActionWarn: '⚠️ Avviso',
    logActionTimeout: '⏱️ Timeout',
    logPrimary: '💥 Violazione principale (il bot ha risposto a questo messaggio)',
    logNormal: 'Violazione',
    logImmune: '🛡️ **Saltato:** Gemini voleva moderare {user}, ma gli amministratori sono sempre immuni.',
    logBatchSize: 'Cronologia: {count} messaggi',
    logApiTitle: '⚠️ Errore API Gemini',
    logApiDesc: 'L’analisi di **{count} messaggi raccolti** non è riuscita.\nErrore: `{error}`\n\n🔁 Tentativo {attempt} – prossimo retry: **{retry}**.\n💾 I messaggi restano conservati e **non vengono scartati** – la raccolta continua normalmente.',
    logNoKeyTitle: '🔑 Nessuna chiave API Gemini configurata',
    logNoKeyDesc: '{count} messaggi raccolti attendono l’analisi. Un amministratore deve prima eseguire `/set_gemini_api_key`.',
    logDropTitle: '🗑️ Cronologia obsoleta scartata',
    logDropDesc: '{count} messaggi non sono potuti essere analizzati per oltre 30 giorni (guasto API persistente) e sono stati eliminati per igiene dei dati.',
    checkNowNoKey: '🔑 Nessuna chiave API Gemini configurata. Esegui prima `/set_gemini_api_key`.',
    checkNowEmpty: 'ℹ️ Al momento non ci sono messaggi raccolti – niente da controllare.',
    checkNowDone: '✅ **Controllo immediato completato** ({count} messaggi analizzati). Vedi il canale di log per i risultati.',
    checkNowPartial: '⚠️ **Controllo immediato avviato** ({count} messaggi), ma {remaining} di essi non sono stati completati (errore API) – dettagli nel canale di log, i tentativi continuano automaticamente.',
    checkNowForcedActive: '🎯 Moderazione forzata richiesta: {user} sarà obbligatoriamente moderato in questo controllo – dettagli nel canale di log.',
    checkNowForcedNoMsgs: '⚠️ {user} non compare nei messaggi raccolti – nessun messaggio da moderare.',
    checkNowForcedInvalid: '⚠️ {user} è un bot o un amministratore e non può essere moderato. Scegli un membro normale.',
    joinTitle: '👋 Security Bot è arrivato!',
    joinDesc: 'Grazie per l’invito! Per iniziare:\n\n1️⃣ `/set_gemini_api_key` – aggiungi una chiave Google Gemini ([creala gratis](https://aistudio.google.com/apikey))\n2️⃣ `/set_prompt` – definisci regole e severità dell’IA (testo predefinito già compilato)\n3️⃣ `/set_log_channel` – scegli un canale di log\n\nDa quel momento l’IA monitora automaticamente tutti i messaggi di testo. **Tutti i comandi sono visibili solo agli amministratori.**',
    defaultPrompt: `Modera questo server come una squadra di OP equa, gentile ma ferma.

=== REGOLE ===
- Niente insulti, odio, discriminazione o tossicità estrema
- Niente affermazioni sessiste, razziste, omofobe o transfobiche
- Niente spam, pubblicità, vendita di account/Nitro o link sospetti
- Rispetto reciproco, anche quando si è in disaccordo
- Niente contenuti pericolosi o illegali

=== SEVERITÀ (né troppo morbida né troppo rigida) ===
- NON punire mai prese in giro amichevoli, sarcasmo tra amici o autoironia
- Parlare DI altri (es. streamer o avversari) NON è una violazione
- Una sanzione passata da sola NON giustifica una nuova sanzione
- Intervenire solo su violazioni reali, chiare e inequivocabili
- Nel dubbio: preferire un avviso a un timeout

=== ESCALATION (avvisi prima) ===
- Prima violazione: sempre un avviso (warn), nessun timeout
- Timeout solo dopo avvisi ripetuti (registro) o per violazioni gravi
- Al massimo UN timeout per persona per analisi – le altre violazioni della stessa persona come warn
- La violazione più grave è primary=true e riceve la durata più lunga (o uguale)

=== MISURE ===
- Violazioni lievi: warn con un consiglio amichevole
- Insulto o provocazione chiara: warn, in caso di ripetizione timeout 5m–10m
- Violazione ripetuta nonostante l’avviso: timeout 10m–1h
- Discriminazione, incitamento all’odio, minacce: timeout 1d–1w
- Contenuti pericolosi, link di phishing/truffa: timeout 1w
- Spam/pubblicità: prima volta warn, ripetizione timeout 1h
- Nessuna violazione: non moderare nessuno e NON scrivere nulla in chat – il bot resta in silenzio
- Non pubblicare mai saluti, chiacchiere, messaggi di «tutto tranquillo» o aggiornamenti di stato`,
  },
};

function t(key, lang = DEFAULT_LANG, vars = {}) {
  const table = STRINGS[lang] || STRINGS[DEFAULT_LANG];
  let text = table[key] ?? STRINGS[DEFAULT_LANG][key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    text = text.split(`{${k}}`).join(String(v ?? ''));
  }
  return text;
}

function langFromDiscord(locale) {
  if (!locale) return DEFAULT_LANG;
  const base = String(locale).toLowerCase().split('-')[0];
  return LANGS[base] ? base : DEFAULT_LANG;
}

function tzFor(lang) {
  return LANGS[lang]?.tz || LANGS[DEFAULT_LANG].tz;
}

function isValidLang(lang) {
  return Boolean(LANGS[lang]);
}

module.exports = {
  LANGS,
  STRINGS,
  DEFAULT_LANG,
  t,
  langFromDiscord,
  tzFor,
  isValidLang,
};
