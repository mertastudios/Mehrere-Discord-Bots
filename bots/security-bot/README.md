# 🛡️ Security Bot (v2)

KI-Moderation für Discord – angetrieben von **Groq** (`openai/gpt-oss-120b` für
Urteile, `openai/gpt-oss-20b` für die günstige Vorprüfung).

**Es gibt genau einen Befehl: `/setup`.** Alles andere läuft automatisch.

---

## Was der Bot macht

1. **Sammeln** – Textnachrichten echter Nutzer in den überwachten Kanälen
   (Team-/Admin-Nachrichten kommen nur als Kontext mit und sind immun).
2. **Lokaler Filter (kostenlos)** – Beleidigungen, Drohungen, Scam-Links, Spam,
   Mention-Druck. Bei einem Treffer geht es sofort weiter, sonst wird gebündelt.
3. **Vorprüfung** (`gpt-oss-20b`, ~1.000 Token) – „Lohnt sich ein genauer Blick?“
   Unter der Schwelle: Puffer verwerfen, keine weiteren Kosten.
4. **Urteil** (`gpt-oss-120b`) – striktes JSON: Maßnahme, Regeln-ID, Begründung,
   fertige Nachricht an den Nutzer, Konfidenz.
5. **Ausführen** – Warnung/Timeout/Kick/Ban (nur was in Schritt 5 erlaubt wurde),
   Ping-Antwort im Kanal, DM an den Nutzer, Eintrag ins Strafregister,
   Meldung ins Log – mit 👍/👎 und „Neuer Auftrag“.

Ohne Verstoß ist der Bot **komplett still**.

---

## `/setup` – die 7 Schritte

| # | Schritt | Besonderheit |
|---|---|---|
| 1 | Sprache | 10 Sprachen, sofort umgestellt |
| 2 | Kanäle | Mehrfachauswahl, „Alle auswählen“, leere Liste = alle Kanäle |
| 3 | Immune Rollen | Owner, Admins und Rollen über der Bot-Rolle sind automatisch immun |
| 4 | Regelwerk | selbst eingeben · überspringen · aus einem Kanal importieren (genau **eine** Nachricht, Text wird aus Embeds/Containern geholt) – die **Discord-Systemregeln sind immer dabei** |
| 5 | KI-Anweisungen | freier Text (bis 2.000 Zeichen) + Häkchen für Timeouts/Kicks/Bans (Verwarnen ist Pflicht) |
| 6 | Log-Kanal | selbst anlegen lassen oder auswählen; bekommt automatisch die richtigen Rechte |
| 7 | Groq-API-Key | wird per Formular eingegeben und **live getestet** |

**Verhalten:** Ist noch nicht alles eingerichtet, merkt sich der Bot den Stand
(auch über Neustarts) und macht beim nächsten Aufruf genau dort weiter – zurück
geht es immer. Ist alles fertig, startet `/setup` wieder bei Schritt 1 mit allen
Werten zum freien Vor- und Zurückspringen.

---

## Feste Regeln des Bots

* **Ohne Administrator-Rechte tut der Bot nichts** – kein Setup, keine Moderation,
  kein Log. Er erklärt freundlich, warum (und meldet es höchstens alle 12 h).
* **`/setup` nur für Owner und Admins.**
* **Log-Kanal heilt sich selbst:** wird er gelöscht, legt der Bot ihn neu an und
  sagt Bescheid. Er ist nie gleichzeitig ein überwachter Kanal.
* **Gelöschte Rollen/Kanäle** verschwinden aus dem Speicher – kein Müll.
* **Server verlassen** = alle Daten dieses Servers werden gelöscht.
* **Fehler und Groq-Limits** landen im Log – inklusive Angabe, wann sich das
  Limit erneuert. Bei einem Limit geht **nichts verloren**: der Puffer bleibt
  vollständig und wird später geprüft.

---

## Free-Plan-Schonung

Groq Free: **30 Anfragen/Minute, 1.000/Tag, 8.000 Token/Minute, 200.000 Token/Tag**
pro Modell. Der Bot rechnet daraus aus, wie viele Urteile pro Tag möglich sind
(Standard ≈ 67) und hält einen Mindestabstand für Ruhe-Prüfungen ein. Risiko-Fälle
haben Vorrang. Zusätzlich bleiben 12 % Reserve ungenutzt, damit nie „auf Kante“
gefahren wird.

Überschreibbar per Umgebung:

```
SECURITY_GROQ_RPD=1000      SECURITY_GROQ_TPD=200000
SECURITY_GROQ_RPM=30        SECURITY_GROQ_TPM=8000
SECURITY_GROQ_RESERVE=0.12  SECURITY_GROQ_AVG_SMART_TOKENS=2600
SECURITY_GROQ_MODEL_SMART=openai/gpt-oss-120b
SECURITY_GROQ_MODEL_FAST=openai/gpt-oss-20b
```

---

## Feedback an den Log-Meldungen

* 👍 / 👎 zeigen live, wie viele Teammitglieder schon bewertet haben
  (`👍 (3)`). Jeder kann genau **einmal** pro Moderation abstimmen.
* Der Klick öffnet ein Formular mit der Frage nach dem Grund (darf leer bleiben).
* Bei 👎 und bestehendem Register-Eintrag gibt es das Häkchen
  **„Aus dem Strafregister entfernen“** (standardmäßig nicht gesetzt) – damit die
  KI künftig nicht strenger entscheidet. Die Entfernung wird im Log vermerkt.
* Der Nutzer bekommt ein Dankeschön – das **echte Feedback geht an den Bot-Owner**
  (Entscheidung, 👍/👎, Grund).

## „Neuer Auftrag“

Grauer Button an jeder Log-Meldung → privates Panel (nur Team) → bis zu **3
Nachrichten-IDs** + **Anweisung**. Der Bot holt jeweils ±15 Nachrichten Kontext,
lässt die KI den Auftrag ausführen (sie verhält sich, als hätte sie den Verstoß
selbst bemerkt) und schreibt ins Log, **wer** den Auftrag gegeben hat. Ergibt die
Anweisung keine klare Maßnahme, steht im Log: *„Keine klare Anweisung verstanden“*.

---

## Dateien

```
bots/security-bot/
├── index.js           # Client, Events, Wartung
└── src/
    ├── ui.js          # Components V2 (rohe JSON-Bausteine)
    ├── hidden.js      # unsichtbare Zustände in Nachrichten (Zero-Width)
    ├── languages.js   # 10 Sprachen der Bot-Texte
    ├── store.js       # RAM-first, Turso/libSQL, Datei-Fallback
    ├── rules.js       # Systemregeln + eigene Regeln
    ├── transcript.js  # Verlauf-Format für die KI, Text aus Embeds/Containern
    ├── collector.js   # Sammeln + lokaler Risikofilter
    ├── budget.js      # Free-Plan-Budget & Pacing
    ├── groq.js        # Groq-Client (JSON-Schema, Fehlerklassen)
    ├── prompts.js     # Systemprompt, Regeln, Anweisungen, Schemas
    ├── pipeline.js    # sammeln → vorprüfen → urteilen → moderieren
    ├── moderator.js   # Maßnahmen, Ping-Antwort, DM, Strafregister
    ├── logging.js     # Log-Kanal, Rechte, Meldungen mit Buttons
    ├── feedback.js    # 👍/👎, Formular, Owner-Info, Register-Entfernung
    ├── orders.js      # „Neuer Auftrag“
    ├── setup.js       # /setup – 7 Schritte
    ├── interactions.js# Router: Buttons, Menüs, Formulare
    ├── guard.js       # Rechteprüfungen (Admin-Pflicht)
    ├── notices.js     # Beitritts-DM, Admin-Hinweise
    ├── maintenance.js # Log-Kanal, Rollen, Server-Aufräumen
    └── register.js    # /setup auf allen Servern registrieren
```

## Umgebungsvariablen

| Variable | Pflicht | Zweck |
|---|---|---|
| `SECURITY_BOT_TOKEN` | ✅ | Token des Bots |
| `SECURITY_BOT_OWNER_ID` | empfohlen | erhält das Feedback zu Entscheidungen |
| `SECURITY_GROQ_API_KEY` | optional | Key zentral für alle Server (dann entfällt Schritt 7) |
| `SECURITY_BOT_GUILD_ID` | optional | registriert `/setup` sofort auf dieser Gilde |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | optional | Persistenz (sonst Datei) |
| `SECURITY_BOT_TURSO_URL` / `SECURITY_BOT_TURSO_AUTH_TOKEN` | optional | eigene Datenbank nur für den Security-Bot |
| `SECURITY_*` (Budget, Intervalle) | optional | siehe oben |
