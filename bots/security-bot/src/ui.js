/**
 * ============================================================================
 *  UI-Bausteine – Components V2 als reine JSON-Objekte
 *
 *  Alles, was der Bot anzeigt (Setup-Wizard, Logs, Panels), wird hier gebaut.
 *  Bewusst ROHES JSON statt Builder-Klassen: Das funktioniert mit jeder
 *  discord.js-14-Version ab Components-V2-Support und ist in Tests ohne
 *  Discord-Verbindung direkt prüfbar.
 *
 *  Aufbau einer V2-Nachricht:
 *    flags: 32768 (IsComponentsV2) [+ 64 für "nur für dich sichtbar"]
 *    components: [ Container { TextDisplay, Separator, ActionRow, ... } ]
 *
 *  Regel im ganzen Bot: kurze Texte, keine Romanbeschreibungen.
 * ============================================================================
 */

const { MessageFlags } = require('discord.js');

// Fallback, falls eine ältere discord.js-Version die Konstante nicht kennt.
const FLAG_V2 = MessageFlags?.IsComponentsV2 ?? 1 << 15;
const FLAG_EPHEMERAL = MessageFlags?.Ephemeral ?? 1 << 6;

const STYLE = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
  link: 5,
};

/** Textabsatz innerhalb eines Containers. */
function text(content) {
  return { type: 10, content: String(content ?? '') };
}

/** Trennlinie (divider=true) bzw. Abstand. */
function separator(divider = true) {
  return { type: 14, divider: Boolean(divider), spacing: 1 };
}

/** Container mit optionaler Akzentfarbe (z. B. 0x57f287 für Grün). */
function container(components, { accentColor } = {}) {
  const c = { type: 17, components: components.flat().filter(Boolean) };
  if (accentColor != null) c.accent_color = accentColor;
  return c;
}

/** Aktionszeile: Buttons oder Select-Menüs. */
function row(components) {
  return { type: 1, components: components.flat().filter(Boolean) };
}

function button({ id, label, style = STYLE.secondary, emoji, disabled = false }) {
  const b = { type: 2, style, label: label ? String(label).slice(0, 80) : undefined, custom_id: id, disabled: Boolean(disabled) };
  if (emoji) b.emoji = typeof emoji === 'string' ? { name: emoji } : emoji;
  if (!b.label && !b.emoji) b.label = '…';
  return b;
}

function linkButton({ label, url, emoji }) {
  const b = { type: 2, style: STYLE.link, label: String(label).slice(0, 80), url };
  if (emoji) b.emoji = typeof emoji === 'string' ? { name: emoji } : emoji;
  return b;
}

function stringSelect({ id, placeholder, options, min = 1, max = 1, disabled = false }) {
  return {
    type: 3,
    custom_id: id,
    placeholder: placeholder ? String(placeholder).slice(0, 150) : undefined,
    options: options.map((o) => ({
      label: String(o.label).slice(0, 100),
      value: String(o.value).slice(0, 100),
      description: o.description ? String(o.description).slice(0, 100) : undefined,
      default: Boolean(o.default),
      emoji: o.emoji ? (typeof o.emoji === 'string' ? { name: o.emoji } : o.emoji) : undefined,
    })),
    min_values: min,
    max_values: max,
    disabled: Boolean(disabled),
  };
}

function channelSelect({ id, placeholder, min = 0, max = 25, types = [0], disabled = false, selected = [] }) {
  const menu = {
    type: 8,
    custom_id: id,
    placeholder: placeholder ? String(placeholder).slice(0, 150) : undefined,
    channel_types: types,
    min_values: min,
    max_values: max,
    disabled: Boolean(disabled),
  };
  if (selected.length) menu.default_values = [...new Set(selected.map(String))].slice(0, 25).map((id) => ({ id, type: 'channel' }));
  return menu;
}

function roleSelect({ id, placeholder, min = 0, max = 25, disabled = false, selected = [] }) {
  const menu = {
    type: 6,
    custom_id: id,
    placeholder: placeholder ? String(placeholder).slice(0, 150) : undefined,
    min_values: min,
    max_values: max,
    disabled: Boolean(disabled),
  };
  if (selected.length) menu.default_values = [...new Set(selected.map(String))].slice(0, 25).map((id) => ({ id, type: 'role' }));
  return menu;
}

/** Fertige Nachricht (Normalnachricht oder ephemeral). */
function payload(components, { ephemeral = false, allowedMentions } = {}) {
  const body = {
    flags: FLAG_V2 | (ephemeral ? FLAG_EPHEMERAL : 0),
    components: (Array.isArray(components) ? components : [components]).filter(Boolean),
  };
  if (allowedMentions) body.allowedMentions = allowedMentions;
  return body;
}

/** Textinput für Modals (style 1 = einzeilig, 2 = mehrzeilig). */
function textInput({ id, label, value, placeholder, required = false, style = 1, maxLength = 400, minLength = 0 }) {
  const input = {
    type: 4,
    custom_id: id,
    style,
    required: Boolean(required),
    max_length: maxLength,
    min_length: minLength,
  };
  if (value) input.value = String(value).slice(0, maxLength);
  if (placeholder) input.placeholder = String(placeholder).slice(0, 100);
  // Modernes Modal-Format: Input wird von einem Label umschlossen.
  return { type: 18, label: String(label).slice(0, 45), component: input };
}

/** Checkbox-Gruppe (Häkchen) für Modals. */
function checkboxGroup({ id, label, options, required = false }) {
  return {
    type: 18,
    label: String(label).slice(0, 45),
    component: {
      type: 22,
      custom_id: id,
      required: Boolean(required),
      options: options.map((o) => ({
        label: String(o.label).slice(0, 100),
        value: String(o.value),
        description: o.description ? String(o.description).slice(0, 100) : undefined,
        default: Boolean(o.default),
      })),
    },
  };
}

/** Modal-Body aus Label-Wrappern. */
function modal({ id, title, components }) {
  return { custom_id: id, title: String(title).slice(0, 45), components };
}

/** Kürzt Text auf eine Zeichenzahl (für Prompt-Budgets und Anzeigen). */
function clip(value, max) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

module.exports = {
  STYLE,
  FLAG_V2,
  FLAG_EPHEMERAL,
  text,
  separator,
  container,
  row,
  button,
  linkButton,
  stringSelect,
  channelSelect,
  roleSelect,
  payload,
  textInput,
  checkboxGroup,
  modal,
  clip,
};
