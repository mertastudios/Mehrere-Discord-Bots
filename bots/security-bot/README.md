# 🛡️ Security Bot

Ein vollautomatischer **KI-Sicherheitsbot** für Discord, angetrieben von **Google Gemini** –
standardmäßig über den von Google gepflegten Alias `gemini-flash-lite-latest`
(zeigt immer auf die aktuell günstigste, verfügbare Flash-Lite-Generation; kostenloser
Free-Tier verfügbar). Wird ein Modell von Google mit „nicht mehr verfügbar" (404)
abgelehnt, weicht der Bot **automatisch** auf das nächste Modell einer Fallback-Kette
aus – ein einzelnes abgeschaltetes Modell blockiert die Moderation also nie wieder
tagelang.

Der Bot verhält sich wie ein zuverlässiger **OP-Moderator**: Er sammelt diskret alle
Textnachrichten echter Nutzer und analysiert sie adaptiv: bei klaren Risikosignalen sofort,
nach kurzen ruhigen Verläufen nach wenigen Minuten und weiterhin spätestens per
**2-Stunden-Sicherheits-Flush**. Er schickt den Verlauf gemeinsam mit euren Server-Regeln an Gemini und
setzt dessen Entscheidungen um – **Warnung oder Timeout**, immer mit einer persönlichen,
begründeten Nachricht an den Nutzer, direkt als Antwort auf den schwerwiegendsten Verstoß.

**Der Bot chattet nicht.** Er schreibt ausschließlich dann etwas in den Chat, wenn er
tatsächlich jemanden moderiert. Gibt es keinen Verstoß, bleibt er komplett still.

---

## 🌟 Highlights

- **Gemini-Powered Context-Moderation**: Gemini bekommt den Chat-Verlauf **mit Kontext**
  (chronologisch, nach Kanälen gruppiert) und entscheidet selbstständig – auch mehrere
  Nutzer gleichzeitig. Der Verlauf enthält jetzt Reply-Ketten, Mention-Zielpersonen sowie
  Server-Anzeigename/Nickname, globalen Anzeigenamen und Username, damit Spitznamen und
  öffentliche/private Identitäten besser zusammengeführt werden.
- **Selbstaktualisierendes Standardmodell**: `gemini-flash-lite-latest` (überschreibbar
  per `SECURITY_GEMINI_MODEL`) – ein von Google gepflegter Alias, der bei künftigen
  Modell-Ablösungen (z. B. 2.5 → 3.x) automatisch mitzieht, ohne dass ein Code-Deploy
  nötig ist. Lehnt Google ein Modell trotzdem mit 404 ab, probiert der Bot **innerhalb
  desselben Aufrufs** automatisch die nächsten Modelle einer Fallback-Kette durch.
  Gesteuertes JSON-Antwortformat via Structured Output, Thinking & Safety-Filter
  bewusst deaktiviert (ein Moderationsbot muss Toxizität ja lesen dürfen).
- **Nichts geht verloren**: Bei API-Fehlern oder Rate-Limits bleibt der gesammelte
  Verlauf **vollständig erhalten**, neue Nachrichten sammeln sich derweil weiter, und
  der Bot wiederholt die Analyse mit wachsendem Abstand (2min → 5min → 15min → … → max. 6h).
  Zusätzlich schützt ein lokaler Gemini-Limiter vor dauerhaftem 429-Spam (RPM/RPD konfigurierbar,
  `Retry-After` wird beachtet).
- **Adaptive, schnelle Batches**: Der Bot wartet nicht mehr stur auf ein riesiges
  Token-Limit oder den nächsten 2-Stunden-Slot. Er baut Batches früher bei
  Risikosignalen (z. B. Beleidigung, Hate/Slur, RIP-/Todessprache), bei wiederholten
  Mentions derselben Zielperson, bei Dogpiling-Mustern, nach kurzer Ruhephase oder
  nach wenigen Minuten Buffer-Alter. Der 2-Stunden-Flush bleibt nur als Sicherheitsnetz
  erhalten (inkl. Nachholen verpasster Slots nach Neustart/Deploy).
- **Stille statt Small-Talk**: Ohne Verstoß postet der Bot **gar nichts**. Ein früheres
  optionales Feld für lockere Chat-Antworten ist entfernt – es führte dazu, dass der
  Sicherheitsbot ohne Anlass Sachen wie „Hey zusammen! Hier ist alles entspannt 👋"
  schrieb, statt zu moderieren.
- **Admins sind immun – aber Kontext bleibt erhalten**: Nachrichten von Mitgliedern mit
  Administrator-Berechtigung werden **als Kontext** mitgesammelt, damit Gemini das
  Gespräch versteht (z. B. worauf ein Nutzer reagiert). Im Verlauf stehen sie jedoch
  **ohne ID** als `[ADMIN – immun]`, im Strafenregister als `IMMUN (Administrator)` –
  Gemini kann sie damit gar nicht referenzieren. Beim Anwenden wird der Admin-Status
  zusätzlich ein zweites Mal live geprüft. Batches, die nur Admin-Nachrichten
  enthalten, werden ohne API-Aufruf verworfen.
- **Nur Text**: Bilder und Anhänge werden bewusst nicht analysiert – der Bot moderiert
  Text. Anhänge werden im Verlauf nur als Hinweis markiert.
- **Sauber lesbarer Verlauf für die KI**: Mentions → Anzeigenamen, Rollen/Kanäle/Emojis/
  Timestamps → Klartext, Markdown escaped, Nachrichten-IDs zählen pro Analyse von 1.
  Zusätzlich stehen bei Nachrichten optionale Kontextzeilen `Namen/Aliase`, `Antwort auf`
  und `Erwähnt/Zielpersonen` direkt über dem Nachrichtentext.
- **Strafenregister**: Gemini sieht pro Teilnehmer, wie oft er in den letzten **20 Tagen**
  moderiert wurde – Eskalation inklusive.
- **Warnungen zuerst**: Erste Verstöße werden grundsätzlich nur verwarnt. Timeouts gibt es
  erst nach wiederholten Warnungen (Strafenregister) oder bei schweren Verstößen (Hass,
  Diskriminierung, Drohungen, Phishing/Betrug).
- **Max. 1 Timeout pro Person**: Pro Analyse kann jede Person höchstens **einmal** getimeoutet
  werden. Weitere Verstöße derselben Person werden automatisch zu Warnungen herabgestuft –
  das garantiert der Code, unabhängig davon, was Gemini liefert.
- **Ausführlich begründete Moderations-Nachrichten**: Die persönliche Nachricht von Gemini
  (`personal_message`) ist bewusst kein Ein-Zeilen-Hinweis mehr. Der System-Prompt verlangt
  **4–8 vollständige Sätze**: konkreter Inhalt der Verstoß-Nachricht, welche Regel genau
  verletzt wurde und warum, Kontext/Wirkung im Kanal, Begründung der gewählten Maßnahme
  (inkl. Eskalation bei Wiederholungstätern) und ein konkreter Verhaltenshinweis. Dafür ist
  auch das Output-Token-Budget der Gemini-Anfrage auf 8.192 erhöht.
- **Zwangsmoderation per Befehl**: `/security_check_now` hat die optionale Auswahl `user` –
  ein Nutzer, der bei dieser Prüfung **zwingend** moderiert werden soll. Diese Admin-Anordnung
  wird als verbindliche Direktive in den System-Prompt eingebaut („ZWINGENDE MODERATION“) und
  überlebt sogar Retries desselben Batches. Bots und Administratoren können nicht gewählt
  werden (die Admin-Immunität bleibt doppelt geschützt).
- **Anti-Delete (optional)**: Mit `/set_anti_delete_messages` (Auswahl `true`/`false`)
  aktivierbar. Löscht ein echter Nutzer (keine Bots, keine Webhooks) seine eigene **letzte
  Nachricht** eines Kanals, sendet der Bot sie per Webhook mit **exakter Profil-Kopie**
  (Anzeigename & Avatar des Verfassers) erneut – inklusive Anhängen. Erwähnungen pingen
  dabei grundsätzlich niemanden (Ghost-Ping-Schutz). Wurde die Nachricht zwischenzeitlich
  überholt (sie ist nicht mehr die letzte im Kanal), bleibt der Bot still.
- **Fair & deeskalierend, aber mobbing-sensibel**: Harmlose Jokes, Sarkasmus, Insider
  und freundschaftliche Frotzeleien bleiben ausdrücklich geschützt. Gleichzeitig fordert
  der System-Prompt Gemini dazu auf, den gesamten Verlauf auf wiederholtes Pingen,
  Nachtreten, RIP-/Todessprüche über echte Mitglieder, öffentliche Privatstreits und
  Dogpiling gegen dieselbe Zielperson zu prüfen.
- **10 Sprachen**: Deutsch, Englisch, Französisch, Spanisch, Portugiesisch, Russisch,
  Japanisch, Koreanisch, Chinesisch, Italienisch.
- **Turso DB & RAM-First**: Nutzt dieselbe Turso-Datenbank wie der XP-Bot (neue,
  getrennte Tabellen `secgem_*`), mit Dirty-Tracking, Backup-Intervall und lokalem
  Datei-Fallback – Batches & Buffer überleben Neustarts.

---

## 📋 Slash-Commands (alle ausschließlich für Administratoren)

| Befehl | Beschreibung |
|---|---|
| `/set_gemini_api_key [key]` | Hinterlegt den Google Gemini API-Key für diesen Server (wird live bei Google geprüft). `remove` löscht den Key. Keys: [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `/set_prompt` | Öffnet ein **Formular** für die KI-Anweisungen: Server-Regeln, wie streng moderiert wird und welche Maßnahmen Gemini wie einsetzt. Der Standardtext (oder dein letzter Text) ist bereits eingetragen. Leer absenden = zurücksetzen auf Standard. |
| `/set_log_channel [channel]` | Setzt den Log-Kanal, in den der Bot Moderations-Hinweise, API-Fehler und Meldungen sendet. Ohne Kanal-Angabe wird der Log-Kanal entfernt. |
| `/set_anti_delete_messages [enabled:true/false]` | Schaltet **Anti-Delete** ein oder aus. Aktiv: Löscht jemand (kein Bot/Webhook) seine eigene letzte Nachricht eines Kanals, wird sie per Webhook mit exakter Profil-Kopie (Name & Avatar) erneut gesendet. |
| `/set_language` | Ändert die Botsprache dauerhaft (steuert auch die Zeitzone des Sicherheits-Flushs & die Standardsprache der KI-Antworten). |
| `/security_check_now [user]` | Wertet die aktuell gesammelten Nachrichten **sofort** aus – ohne auf den adaptiven Auto-Flush zu warten. Stellt auch bereits wartende Retry-Batches (z. B. nach einem behobenen API-Fehler) sofort fällig. Mit der optionalen Auswahl `user` wird ein Nutzer bestimmt, der bei dieser Prüfung **zwingend moderiert** werden soll (Admin-Anordnung im System-Prompt; Bots/Admins nicht wählbar). |
| `/help` | Übersicht aller Befehle mit klickbaren Mentions. |

---

## 🧠 Wie die Moderation funktioniert

1. **Sammeln**: Jede Textnachricht echter Nutzer (ohne Bots/Webhooks) landet im
   Buffer – mit Kanal, Anzeigename, Nutzer-ID und Zeitstempel. Zusätzlich speichert
   der Bot öffentliche Discord-Identität (Server-Anzeigename/-Nickname, globaler Name,
   Username), erwähnte Zielpersonen und Reply-Kontext mit kurzem Textauszug.
   Admin-Nachrichten werden als `isAdmin` markiert (reiner Kontext).
2. **Batch bauen**: Sobald das harte Token-Budget erreicht ist (Standard **15.000 Token** ≈
   45.000 Zeichen, einstellbar über `SECURITY_GEMINI_MAX_INPUT_TOKENS`) oder die adaptive
   Policy anschlägt, werden alle gesammelten Nachrichten zu einem Batch mit **IDs ab 1**
   verpackt (Admin-Nachrichten bekommen **keine ID**). Die adaptive Policy löst u. a.
   bei Risikosignalen, Dogpiling-/Mention-Druck, nach kurzer Ruhephase oder nach wenigen
   Minuten Buffer-Alter einen früheren Flush aus. Der 2-Stunden-Lauf bleibt als Sicherheitsnetz.
3. **Analyse**: Gemini erhält
   - den **System-Prompt** (Rolle, Antwortformat, `{USER}`-Platzhalter-Regel,
     „genau ein `primary`“-Regel, Timeout-Stufen, Strafenregister der Teilnehmer,
     Mobbing-/Dogpiling-Regeln und Joke-/Sarkasmus-Schutz),
   - die **Admin-Anweisungen** aus `/set_prompt` (Regeln, Strenge, Maßnahmen) und
   - den **Chat-Verlauf** (gruppiert nach Kanälen, chronologisch, Klartext, Reply-/Mention-/Namenskontext).
4. **Antwort**: Ein einziges JSON – es gibt **nur** das Feld `moderations`:
   ```json
   {
     "moderations": [
       {
         "message_id": 7,
         "action": "timeout",
         "duration": "5m",
         "primary": true,
         "reason": "Gegen Regel 2 verstoßen: Beleidigung",
         "personal_message": "{USER}, das war eine klare Beleidigung – 5 Minuten Pause."
       }
     ]
   }
   ```
   Kein Verstoß gefunden? Dann `{"moderations": []}` – und der Bot bleibt still.
5. **Anwenden**: Der Bot antwortet **auf die Nachricht mit dem schwerwiegendsten
   Verstoß** (`primary: true`), ersetzt `{USER}` durch die echte Erwähnung, wendet den
   **Timeout** an (1m / 5m / 10m / 1h / 1d / 1w) bzw. sendet nur die **Warnung**, und
   pflegt das Strafenregister. Dabei gilt als harte Garantie: **höchstens ein Timeout
   pro Person** pro Analyse – weitere Verstöße derselben Person werden als Warnung
   umgesetzt. Alle Details wandern in den Log-Kanal.
6. **Niemand schuldig?** Dann passiert **gar nichts**: keine Nachricht im Chat, kein
   Eintrag im Log-Kanal. Genau das ist der Normalfall.

### Maßnahmen, die Gemini wählen kann

- `warn` – persönliche Ermahnung ohne Timeout
- `timeout` mit `duration`: `1m`, `5m`, `10m`, `1h`, `1d`, `1w`

**Eskalation (Standard):** Erster Verstoß → `warn`. Timeouts erst nach wiederholten
Warnungen (laut Strafenregister) oder bei schweren Verstößen (Hass, Diskriminierung,
Drohungen, Phishing/Betrug). Pro Person höchstens **ein** Timeout pro Analyse – weitere
Verstöße derselben Person werden zu Warnungen. Den schwerwiegendsten Verstoß markiert
Gemini mit `primary: true` (er trägt die längste Dauer).

Welche Maßnahme wann greift, bestimmst **du** in `/set_prompt` – deine Anweisungen haben
höchste Priorität (z. B. „kleine Verstöße → Warnung, Hate → 1 Tag Timeout“). Nur das
Antwortformat, die Admin-Immunität, kein Kick/Ban, max. 1 Timeout pro Person und das Verbot von Nachrichten ohne Verstoß sind fest.
Kick/Ban gibt es bewusst nicht.

---

## 🔧 Konfiguration (Umgebungsvariablen)

```env
# Token des Sicherheitsbots (eigene Discord App!)
SECURITY_BOT_TOKEN=

# Owner Discord-ID (Join-Notice per DM)
SECURITY_BOT_OWNER_ID=

# Optional: genau eine Gilde erhält zusätzlich sofort verfügbare Guild-Commands.
SECURITY_BOT_GUILD_ID=

# Turso-Datenbank (wird mit dem XP-Bot geteilt)
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

# Optional: anderes Gemini-Modell fest pinnen (Standard: gemini-flash-lite-latest,
# ein von Google gepflegter Alias, der automatisch immer auf die aktuell günstigste
# Flash-Lite-Generation zeigt)
# SECURITY_GEMINI_MODEL=gemini-flash-lite-latest

# Optional: Hartes Token-Budget pro Analyse (Standard 15000)
# SECURITY_GEMINI_MAX_INPUT_TOKENS=15000

# Optional: Adaptive Batch-Policy (Default: schnell, aber nicht jede harmlose Zeile einzeln)
# SECURITY_GEMINI_SOFT_INPUT_TOKENS=2500
# SECURITY_GEMINI_SOFT_MAX_MESSAGES=18
# SECURITY_GEMINI_MAX_BUFFER_AGE_MS=300000
# SECURITY_GEMINI_QUIET_FLUSH_MS=90000
# SECURITY_GEMINI_QUIET_MIN_MESSAGES=5
# SECURITY_GEMINI_MENTION_WINDOW_MS=600000
# SECURITY_GEMINI_MENTION_REPEAT_LIMIT=3
# SECURITY_GEMINI_MULTI_AUTHOR_MENTION_LIMIT=2

# Optional: Lokaler Gemini-Limiter. Defaults nutzen den Key intensiv, aber beachten RPM/RPD.
# SECURITY_GEMINI_RPM_LIMIT=12
# SECURITY_GEMINI_TPM_LIMIT=250000
# SECURITY_GEMINI_RPD_LIMIT=1000
# SECURITY_GEMINI_RPD_RESERVE=50
# SECURITY_GEMINI_MIN_REQUEST_INTERVAL_MS=0
# SECURITY_GEMINI_PACE_DAILY=false
# SECURITY_GEMINI_429_COOLDOWN_MS=0
# SECURITY_GEMINI_LIMIT_SCOPE=shared-google-project-id
```

### Slash-Command-Registrierung

Der vollständige Satz (alle 7 Befehle, inklusive `/set_anti_delete_messages` und der
`user`-Option von `/security_check_now`) wird zuerst global über
`PUT /applications/{application.id}/commands` registriert (alle Commands tragen
ausschließlich den Guild-Context und Admin-Berechtigung). Erst nachdem Discord alle
sieben globalen Command-Namen und IDs zurückgegeben hat, werden alte Guild-Overrides
entfernt. Eine gültige `SECURITY_BOT_GUILD_ID` behält optional einen sofort sichtbaren
Guild-Satz. Ein Fehler bei diesem optionalen PUT beeinträchtigt den globalen Satz nicht.
Durch den globalen Bulk-Overwrite landen **neue Befehle automatisch auf jedem Server,
auf dem der Bot bereits ist** – kein erneutes Einladen nötig; der Start-Sync verifiziert
den Satz per Rücklese-Check und repariert ihn bei Abweichungen selbstständig.

### Anti-Delete im Detail

- Pro Kanal nutzt der Bot einen eigenen Webhook (wird bei Bedarf angelegt, wiederverwendet
  und im RAM gecacht) – der Bot braucht dafür die Berechtigung **„Webhooks verwalten“**.
  In Threads hängt der Webhook am Parent-Kanal.
- Nach dem Löschen wird geprüft, ob die gelöschte Nachricht die **letzte Nachricht des
  Kanals** war (Snowflake-Vergleich mit der neuesten verbleibenden Nachricht). Sonst wird
  nichts erneut gesendet, damit der Chat-Verlauf nicht verwürfelt wird.
- Der Webhook postet mit `username` (Server-Anzeigename) und `avatarURL` (Server-Avatar)
  des Verfassers – eine **exakte Profil-Kopie**. `allowedMentions: []` verhindert jede
  Form von Pings (auch @everyone-Ghost-Pings).
- Ausgenommen sind immer: Bots, Webhooks, Systemnachrichten und der Bot selbst. Nachrichten
  ohne Text und ohne Anhänge (z. B. reine Sticker) werden ebenfalls ignoriert.

### Gemini API-Key einrichten

1. Auf [aistudio.google.com/apikey](https://aistudio.google.com/apikey) einen
   kostenlosen API-Key erstellen (Free-Tier reicht für kleine/mittelgroße Server).
2. Auf dem Discord-Server einmal `/set_gemini_api_key` ausführen und den Key eintragen.
   Der Bot prüft ihn direkt bei Google.
3. Optional `/set_prompt` und `/set_log_channel` – danach ist die KI-Überwachung aktiv.

---

## 🗄️ Datenhaltung

| Tabelle | Inhalt |
|---|---|
| `secgem_guilds` | API-Key (verschlüsselt durch die DB-Zugangskontrolle), Prompt, Log-Kanal, Sprache, Anti-Delete-Flag (`anti_delete`) |
| `secgem_messages` | Gesammelte Nachrichten (`batch_id = NULL` → offener Buffer, sonst fest zugeordneter Batch; `is_admin = 1` → nur Kontext, ohne ID) plus `author_meta`, `reply_meta`, `mentions_meta` als JSON-Kontext für Gemini |
| `secgem_batches` | Retry-Metadaten pro Gilde (Versuche, nächster Zeitpunkt, letzter Fehler, ggf. Zwangsmoderations-Direktive `forceUser`) |
| `secgem_penalties` | Strafenregister (20-Tage-Fenster für Gemini, 30-Tage-Aufbewahrung) |

Batches, die dauerhaft fehlschlagen, werden nach **30 Tagen** aus Datenschutzgründen
verworfen (mit Meldung im Log-Kanal). Beim Verlassen des Servers räumt der Bot alle
Daten der Gilde vollständig weg.

---

## ✅ Tests

```bash
node --test tests/security-bot.test.js tests/security-command-registration.test.js tests/security-ready-presence.test.js
```

Die Tests decken die komplette Pipeline ab: Sammel-Regeln & Discord-Format-Auflösung,
Batch-Bau mit IDs ab 1, Rich-Context-Metadaten (Nicknames/Mentions/Replies), Gemini-Request-Struktur & JSON-Parsing, Prompt-Bau (Register,
`{USER}`, `primary`, Mobbing-/Dogpiling-Regeln, Joke-Schutz, Zwangsmoderations-Direktive, ausführliche `personal_message`),
Anwendungs-Flow (Timeout, Reply auf Hauptverstoß, Log-Kanal),
Retry-Backoff ohne Datenverlust, Admin-Doppelabsicherung, adaptive Batch-Policy, lokaler Rate-Limiter, 2-Stunden-Sicherheits-Flush (inkl.
Nachholen verpasster Slots), garantierte Stille ohne Verstoß, die Anti-Delete-Pipeline
(Profil-Kopie per Webhook, Letzte-Nachricht-Erkennung, Bot/Webhook-Ausschluss) und alle
Commands (inkl. `user`-Option & Anti-Delete-Schalter).
