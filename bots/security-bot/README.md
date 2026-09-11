# 🛡️ Security Bot

Ein vollautomatischer **KI-Sicherheitsbot** für Discord, angetrieben von **Google Gemini** –
standardmäßig über den von Google gepflegten Alias `gemini-flash-lite-latest`
(zeigt immer auf die aktuell günstigste, verfügbare Flash-Lite-Generation; kostenloser
Free-Tier verfügbar). Wird ein Modell von Google mit „nicht mehr verfügbar" (404)
abgelehnt, weicht der Bot **automatisch** auf das nächste Modell einer Fallback-Kette
aus – ein einzelnes abgeschaltetes Modell blockiert die Moderation also nie wieder
tagelang.

Der Bot verhält sich wie ein zuverlässiger **OP-Moderator**: Er sammelt diskret alle
Textnachrichten echter Nutzer, bis genug Tokens für eine Analyse beisammen sind (oder
Mitternacht ist), schickt den Verlauf gemeinsam mit euren Server-Regeln an Gemini und
setzt dessen Entscheidungen um – **Warnung oder Timeout**, immer mit einer persönlichen,
begründeten Nachricht an den Nutzer, direkt als Antwort auf den schwerwiegendsten Verstoß.

---

## 🌟 Highlights

- **Gemini-Powered Context-Moderation**: Gemini bekommt den Chat-Verlauf **mit Kontext**
  (chronologisch, nach Kanälen gruppiert) und entscheidet selbstständig – auch mehrere
  Nutzer gleichzeitig.
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
- **0-Uhr-Flush**: Jede Nacht um 0 Uhr (Zeitzone der Serversprache) wird auch ein kleiner
  Verlauf analysiert – auf toten Servern bekommen Nutzer ihre Verwarnung spätestens
  nachts statt erst nach Tagen.
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
- **Strafenregister**: Gemini sieht pro Teilnehmer, wie oft er in den letzten **20 Tagen**
  moderiert wurde – Eskalation inklusive.
- **Warnungen zuerst**: Erste Verstöße werden grundsätzlich nur verwarnt. Timeouts gibt es
  erst nach wiederholten Warnungen (Strafenregister) oder bei schweren Verstößen (Hass,
  Diskriminierung, Drohungen, Phishing/Betrug).
- **Max. 1 Timeout pro Person**: Pro Analyse kann jede Person höchstens **einmal** getimeoutet
  werden. Weitere Verstöße derselben Person werden automatisch zu Warnungen herabgestuft –
  das garantiert der Code, unabhängig davon, was Gemini liefert.
- **Fair & deeskalierend**: In den meisten Fällen macht niemand etwas Schlimmes – dann
  moderiert Gemini niemanden und darf optional kurz und locker im Chat antworten.
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
| `/set_language` | Ändert die Botsprache dauerhaft (steuert auch die 0-Uhr-Zeitzone & die Standardsprache der KI-Antworten). |
| `/security_check_now` | Wertet die aktuell gesammelten Nachrichten **sofort** aus – ohne auf das Token-Limit oder Mitternacht zu warten. Stellt auch bereits wartende Retry-Batches (z. B. nach einem behobenen API-Fehler) sofort fällig. Praktisch, um nach einer Konfigurationsänderung direkt zu testen. |
| `/help` | Übersicht aller Befehle mit klickbaren Mentions. |

---

## 🧠 Wie die Moderation funktioniert

1. **Sammeln**: Jede Textnachricht echter Nutzer (ohne Bots/Webhooks) landet im
   Buffer – mit Kanal, Anzeigename, Nutzer-ID und Zeitstempel. Admin-Nachrichten
   werden als `isAdmin` markiert (reiner Kontext).
2. **Batch bauen**: Sobald das Token-Budget erreicht ist (Standard **15.000 Token** ≈
   45.000 Zeichen, einstellbar über `SECURITY_GEMINI_MAX_INPUT_TOKENS`), werden alle
   gesammelten Nachrichten zu einem Batch mit **IDs ab 1** verpackt (Admin-Nachrichten
   bekommen **keine ID**). Zusätzlich wird der
   Buffer **jede Nacht um 0 Uhr** als Mini-Verlauf ausgewertet.
3. **Analyse**: Gemini erhält
   - den **System-Prompt** (Rolle, Antwortformat, `{USER}`-Platzhalter-Regel,
     „genau ein `primary`“-Regel, Timeout-Stufen, Strafenregister der Teilnehmer),
   - die **Admin-Anweisungen** aus `/set_prompt` (Regeln, Strenge, Maßnahmen) und
   - den **Chat-Verlauf** (gruppiert nach Kanälen, chronologisch, Klartext).
4. **Antwort**: Ein einziges JSON:
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
     ],
     "chat_reply": ""
   }
   ```
5. **Anwenden**: Der Bot antwortet **auf die Nachricht mit dem schwerwiegendsten
   Verstoß** (`primary: true`), ersetzt `{USER}` durch die echte Erwähnung, wendet den
   **Timeout** an (1m / 5m / 10m / 1h / 1d / 1w) bzw. sendet nur die **Warnung**, und
   pflegt das Strafenregister. Dabei gilt als harte Garantie: **höchstens ein Timeout
   pro Person** pro Analyse – weitere Verstöße derselben Person werden als Warnung
   umgesetzt. Alle Details wandern in den Log-Kanal.
6. **Niemand schuldig?** Dann passiert nichts – optional schreibt Gemini eine kurze,
   lockere Antwort in den Chat (`chat_reply`).

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
Antwortformat, die Admin-Immunität, kein Kick/Ban und max. 1 Timeout pro Person sind fest.
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

# Optional: Token-Budget pro Analyse (Standard 15000)
# SECURITY_GEMINI_MAX_INPUT_TOKENS=15000
```

### Slash-Command-Registrierung

Der vollständige Satz wird zuerst global über
`PUT /applications/{application.id}/commands` registriert (alle Commands tragen
ausschließlich den Guild-Context und Admin-Berechtigung). Erst nachdem Discord alle
fünf globalen Command-Namen und IDs zurückgegeben hat, werden alte Guild-Overrides
entfernt. Eine gültige `SECURITY_BOT_GUILD_ID` behält optional einen sofort sichtbaren
Guild-Satz. Ein Fehler bei diesem optionalen PUT beeinträchtigt den globalen Satz nicht.

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
| `secgem_guilds` | API-Key (verschlüsselt durch die DB-Zugangskontrolle), Prompt, Log-Kanal, Sprache |
| `secgem_messages` | Gesammelte Nachrichten (`batch_id = NULL` → offener Buffer, sonst fest zugeordneter Batch; `is_admin = 1` → nur Kontext, ohne ID) |
| `secgem_batches` | Retry-Metadaten pro Gilde (Versuche, nächster Zeitpunkt, letzter Fehler) |
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
Batch-Bau mit IDs ab 1, Gemini-Request-Struktur & JSON-Parsing, Prompt-Bau (Register,
`{USER}`, `primary`), Anwendungs-Flow (Timeout, Reply auf Hauptverstoß, Log-Kanal),
Retry-Backoff ohne Datenverlust, Admin-Doppelabsicherung, 0-Uhr-Flush und alle Commands.
