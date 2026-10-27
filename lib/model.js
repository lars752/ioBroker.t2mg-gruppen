'use strict';
/**
 * Konfigurationsprüfung und Datenmodell.
 * Quelle (MQTT-Adapter): mqtt.0.<SERIAL>-<name>.<METRIK>, z. B. mqtt.0.T2MG816EB1-wohnung1.ACSETPOINT
 * Ziel: <gruppe>.<LaderN>.<METRIK>, <gruppe>.<LaderN>.<Vorgabe> (schreibbar, siehe WRITES), <gruppe>.info.<Count|Total_Power>
 * Der Anzeigename Lader1, Lader2, … wird je Gruppe in Tabellenreihenfolge automatisch vergeben.
 */
const SEG = /^[A-Za-z0-9_-]+$/;
const SERIAL = /^[A-Za-z0-9]{6,32}$/;
const INSTANCE = /^[A-Za-z0-9_-]+\.\d+$/;
const NAME_PREFIX = 'Lader';

// Schlüssel = letzter Pfadabschnitt des Quell-Datenpunkts, KLEIN geschrieben.
// Vollständige Liste der vom T2MG-Stick veröffentlichten Topics laut Trucki-Benutzerhandbuch.
const ZEPC_STATES = { 0: 'Disabled', 1: 'Enabled', 2: 'Manual', 3: 'MQTT', 4: 'Linked' };
const METRICS = {
    acsetpoint: { key: 'ACSETPOINT', name: 'Ladeleistung Sollwert (ACSETPOINT)', type: 'number', unit: 'W', role: 'value.power', scaleKey: 'outputScale' },
    acdisplay: { key: 'ACDISPLAY', name: 'AC-Leistung Anzeige (ACDISPLAY)', type: 'number', unit: 'W', role: 'value.power', scaleKey: 'outputScale' },
    vgrid: { key: 'VGRID', name: 'Netzspannung (nur NPB-1200/1700)', type: 'number', unit: 'V', role: 'value.voltage' },
    vbat: { key: 'VBAT', name: 'Batteriespannung', type: 'number', unit: 'V', role: 'value.voltage' },
    voutset: { key: 'VOUTSET', name: 'Sollspannung Batterie', type: 'number', unit: 'V', role: 'value.voltage' },
    ioutset: { key: 'IOUTSET', name: 'Sollstrom', type: 'number', unit: 'A', role: 'value.current' },
    iout: { key: 'IOUT', name: 'Ladestrom', type: 'number', unit: 'A', role: 'value.current' },
    minpower: { key: 'MINPOWER', name: 'Minimalleistung', type: 'number', unit: 'W', role: 'value.power' },
    maxpower: { key: 'MAXPOWER', name: 'Maximalleistung laut Gateway', type: 'number', unit: 'W', role: 'value.power' },
    targetmin: { key: 'TARGETMIN', name: 'Zielbereich Ueberschussregelung min', type: 'number', unit: 'W', role: 'value.power' },
    targetmax: { key: 'TARGETMAX', name: 'Zielbereich Ueberschussregelung max', type: 'number', unit: 'W', role: 'value.power' },
    temperature: { key: 'TEMPERATURE', name: 'Temperatur', type: 'number', unit: '°C', role: 'value.temperature' },
    meter: { key: 'METER', name: 'Zaehlerwert (negativ = Ueberschuss)', type: 'number', unit: 'W', role: 'value.power' },
    eepromwrites: { key: 'EEPROMWRITES', name: 'EEPROM-Schreibzugriffe', type: 'number', role: 'value' },
    dayenergy: { key: 'DAYENERGY', name: 'Energie heute', type: 'number', unit: 'kWh', role: 'value.energy' },
    totalenergy: { key: 'TOTALENERGY', name: 'Energie gesamt', type: 'number', unit: 'kWh', role: 'value.energy' },
    state: { key: 'STATE', name: 'Status', type: 'string', role: 'text' },
    zepc: { key: 'ZEPC', name: 'Ueberschussregelung Modus', type: 'number', role: 'value', states: ZEPC_STATES },
};
const SUM_KEY = 'ACSETPOINT';

// Schreibbare Vorgaben: <gruppe>.<LaderN>.<key> -> <quelle>.<source>
// kind: setpoint = Ladeleistung mit Begrenzung und Skalierung, min0 = Watt >= 0, any = beliebige Zahl,
//       zepc = nur 0/1, button = sendet 'REBOOTOVR' und setzt sich zurück
const WRITES = [
    { key: 'SETPOINT', source: 'ACSETPOINTOVR', name: 'Ladeleistung vorgeben (-> ACSETPOINTOVR, deaktiviert ZEPC)', kind: 'setpoint', unit: 'W', role: 'level.power' },
    { key: 'MINPOWER_SET', source: 'MINPOWEROVR', name: 'Minimalleistung vorgeben (-> MINPOWEROVR)', kind: 'min0', unit: 'W', role: 'level.power' },
    { key: 'MAXPOWER_SET', source: 'MAXPOWEROVR', name: 'Maximalleistung vorgeben (-> MAXPOWEROVR)', kind: 'min0', unit: 'W', role: 'level.power' },
    { key: 'TARGETMIN_SET', source: 'TARGETMINOVR', name: 'Zielbereich min vorgeben (-> TARGETMINOVR)', kind: 'any', unit: 'W', role: 'level.power' },
    { key: 'TARGETMAX_SET', source: 'TARGETMAXOVR', name: 'Zielbereich max vorgeben (-> TARGETMAXOVR)', kind: 'any', unit: 'W', role: 'level.power' },
    { key: 'METER_SET', source: 'METEROVR', name: 'Zaehlerwert vorgeben (-> METEROVR, aktiviert ZEPC)', kind: 'any', unit: 'W', role: 'level.power' },
    { key: 'ZEPC_SET', source: 'ZEPCOVR', name: 'Ueberschussregelung ein/aus (-> ZEPCOVR)', kind: 'zepc', role: 'level.mode', states: { 0: 'Disabled', 1: 'Enabled' } },
    { key: 'REBOOT', source: 'REBOOTOVR', name: 'Gateway neu starten (-> REBOOTOVR)', kind: 'button', role: 'button' },
];
const WRITE = WRITES[0];

const DEFAULTS = {
    sourceAdapters: 'mqtt.0',
    staleTimeoutSec: 0,
    pruneOnStart: true,
    powerScale: 1,
    outputScale: 1,
    maxPowerW: 1500,
    logWrites: false,
    devices: [],
};

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Prüft die komplette Konfiguration: Fehler in globalen Werten -> errors, ungültige Zeilen -> Warnung + übersprungen. */
function normalizeConfig(native, log = silent) {
    const n = native || {};
    const errors = [];
    const warnings = [];
    const warn = (m) => { warnings.push(m); log.warn(m); };
    const cfg = {};

    // neues Format = sources-Tabelle [{enabled, adapter}], altes Format = sourceAdapters-String
    let adapters;
    if (Array.isArray(n.sources) && n.sources.length) {
        adapters = n.sources.filter((r) => r && r.enabled && r.adapter).map((r) => String(r.adapter).trim()).filter(Boolean);
    } else {
        adapters = String(n.sourceAdapters === undefined ? DEFAULTS.sourceAdapters : n.sourceAdapters).split(',').map((s) => s.trim()).filter(Boolean);
    }
    const bad = adapters.find((a) => !INSTANCE.test(a));
    if (!adapters.length || bad !== undefined) errors.push(`Quell-Instanz '${bad || ''}' ungueltig oder keine aktiv (erwartet z. B. mqtt.0)`);
    cfg.adapters = adapters;

    const number = (key, label, min, max) => {
        const raw = n[key] === undefined || n[key] === '' || n[key] === null ? DEFAULTS[key] : n[key];
        const v = Number(raw);
        if (!Number.isFinite(v) || v < min || v > max) { errors.push(`${label} muss zwischen ${min} und ${max} liegen (ist: ${raw})`); cfg[key] = DEFAULTS[key]; return; }
        cfg[key] = v;
    };
    number('staleTimeoutSec', 'Stale-Timeout', 0, 86400);
    number('powerScale', 'Skalierung Sollwert', 0.000001, 1000000);
    number('outputScale', 'Skalierung Ladeleistung', 0.000001, 1000000);
    number('maxPowerW', 'Maximale Sollleistung', 0, 100000);
    cfg.pruneOnStart = n.pruneOnStart !== false && n.pruneOnStart !== 'false';
    cfg.logWrites = n.logWrites === true || n.logWrites === 'true';

    cfg.devices = [];
    const serials = new Set();
    const counters = {};
    for (const [i, row] of (Array.isArray(n.devices) ? n.devices : []).entries()) {
        const group = String((row && row.group) || '').trim();
        const serial = String((row && row.serial) || '').trim();
        const where = `Zeile ${i + 1}`;
        if (!group && !serial) continue;
        if (!group) { warn(`${where}: Seriennummer ${serial} ohne Gruppe - ignoriert`); continue; }
        if (!SEG.test(group) || group.toLowerCase() === 'info') { warn(`${where}: Gruppe '${group}' ungueltig (erlaubt: A-Z, 0-9, _, -; 'info' ist reserviert) - uebersprungen`); continue; }
        if (!SERIAL.test(serial)) { warn(`${where}: Seriennummer '${serial}' ungueltig (6-32 Zeichen, A-Z, 0-9) - uebersprungen`); continue; }
        const up = serial.toUpperCase();
        if (serials.has(up)) { warn(`${where}: Seriennummer ${serial} doppelt zugeordnet - uebersprungen`); continue; }
        serials.add(up);
        counters[group] = (counters[group] || 0) + 1;
        cfg.devices.push({ group, name: `${NAME_PREFIX}${counters[group]}`, serial, up });
    }
    return { cfg, errors, warnings };
}

const rowsOf = (devices) => devices.map((d) => ({ group: d.group, serial: d.serial }));

/** Kanäle und Datenpunkte (IDs relativ zum Namensraum der Instanz). */
function buildModel(devices) {
    const channels = [];
    const states = [];
    const groups = {};
    for (const d of devices) (groups[d.group] = groups[d.group] || []).push(d);
    for (const [group, list] of Object.entries(groups)) {
        channels.push({ id: group, name: `Gruppe ${group}` }, { id: `${group}.info`, name: `Information ${group}` });
        states.push(
            { id: `${group}.info.Count`, common: { name: `Anzahl Lader in ${group}`, type: 'number', role: 'value', read: true, write: false, def: list.length } },
            { id: `${group}.info.Total_Power`, common: { name: `Gesamt-Ladeleistung ${group} (Summe ACSETPOINT)`, type: 'number', unit: 'W', role: 'value.power', read: true, write: false, def: 0 } },
        );
        for (const d of list) {
            const label = `${d.name} (${d.serial})`;
            channels.push({ id: `${group}.${d.name}`, name: label });
            for (const m of Object.values(METRICS)) {
                const common = { name: `${label} - ${m.name}`, type: m.type, role: m.role, read: true, write: false, def: m.type === 'string' ? '' : 0 };
                if (m.unit) common.unit = m.unit;
                if (m.states) common.states = m.states;
                states.push({ id: `${group}.${d.name}.${m.key}`, common });
            }
            for (const w of WRITES) {
                const button = w.kind === 'button';
                const common = { name: `${label} - ${w.name}`, type: button ? 'boolean' : 'number', role: w.role, read: !button, write: true, def: button ? false : 0 };
                if (w.unit) common.unit = w.unit;
                if (w.states) common.states = w.states;
                states.push({ id: `${group}.${d.name}.${w.key}`, common });
            }
        }
    }
    return { channels, states, groups };
}

/** Ergänzt die Tabelle um gefundene, noch nicht eingetragene Seriennummern (Gruppe bleibt leer). */
function mergeSerials(rows, serials) {
    const out = (Array.isArray(rows) ? rows : []).map((r) => ({ ...r }));
    const have = new Set(out.map((r) => String(r.serial || '').trim().toUpperCase()));
    const added = [];
    for (const s of [...serials].sort()) {
        if (have.has(s.toUpperCase())) continue;
        out.push({ group: '', serial: s });
        added.push(s);
    }
    return { rows: out, added };
}

/** Seriennummer aus dem Geräte-Segment: 'T2MG816EB1-wohnung1' -> 'T2MG816EB1' (Teil vor dem ersten - oder _). */
function extractSerial(seg) {
    return String(seg).split(/[-_]/)[0];
}

/** Seriennummern aller Trucki-Geräte (Segment besitzt einen ACSETPOINT-Datenpunkt) in den erlaubten Quell-Instanzen. */
function serialsFromIds(ids, adapters) {
    const out = new Set();
    for (const id of ids) {
        const parts = String(id).split('.');
        if (parts.length < 4 || !adapters.includes(`${parts[0]}.${parts[1]}`)) continue;
        if (parts[parts.length - 1].toLowerCase() !== 'acsetpoint') continue;
        const serial = extractSerial(parts[2]);
        if (SERIAL.test(serial)) out.add(serial);
    }
    return out;
}

module.exports = { METRICS, SUM_KEY, WRITE, WRITES, ZEPC_STATES, DEFAULTS, NAME_PREFIX, SERIAL, normalizeConfig, rowsOf, buildModel, mergeSerials, extractSerial, serialsFromIds };
