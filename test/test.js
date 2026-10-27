'use strict';
const assert = require('assert');
const { normalizeConfig, buildModel, serialsFromIds, mergeSerials } = require('../lib/model');
const { TruckiCore } = require('../lib/core');
const { exportConfig, importConfig } = require('../lib/configio');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const warns = [];
const log = { debug() {}, info() {}, warn: (m) => warns.push(m), error() {} };
const ROWS = [
    { group: 'wohnung1', serial: 'T2MG816EB1' },
    { group: 'wohnung2', serial: 'T2MG818D75' },
];
const NATIVE = { sources: [{ enabled: true, adapter: 'mqtt.0' }], devices: ROWS };
const mk = (native = NATIVE) => {
    const w = {};
    const src = {};
    const t = { now: 1_000_000 };
    const { cfg } = normalizeConfig(native, log);
    const core = new TruckiCore({
        cfg, log, now: () => t.now,
        io: { write: async (id, v) => { w[id] = v; }, invalidate() {}, setSource: async (id, v) => { src[id] = v; } },
    });
    return { w, src, t, core, cfg };
};
const S1 = 'mqtt.0.T2MG816EB1-wohnung1';
const S2 = 'mqtt.0.T2MG818D75-wohnung2';
const st = (val) => ({ val, ack: true });

(async () => {
    await test('Konfiguration: gueltige Zeilen, Namen Lader1 je Gruppe', () => {
        const { cfg, errors } = normalizeConfig(NATIVE, log);
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(cfg.devices.map((d) => `${d.group}.${d.name}`), ['wohnung1.Lader1', 'wohnung2.Lader1']);
    });
    await test('Konfiguration: ungueltige und doppelte Zeilen werden uebersprungen', () => {
        warns.length = 0;
        const { cfg } = normalizeConfig({ sources: NATIVE.sources, devices: [
            { group: 'a', serial: 'T2MG000001' },
            { group: 'a', serial: 't2mg000001' }, // doppelt
            { group: 'a b', serial: 'T2MG000002' }, // Leerzeichen
            { group: 'info', serial: 'T2MG000003' }, // reserviert
            { group: 'a', serial: 'T2M' }, // zu kurz
            { group: '', serial: 'T2MG000004' }, // ohne Gruppe
            { group: 'a', serial: 'T2MG000005' },
            { group: '', serial: '' }, null,
        ] }, log);
        assert.deepStrictEqual(cfg.devices.map((x) => `${x.group}.${x.name}`), ['a.Lader1', 'a.Lader2']);
        assert.strictEqual(warns.length, 5);
    });
    await test('Konfiguration: keine aktive Quell-Instanz ist ein Fehler', () => {
        const { errors } = normalizeConfig({ sources: [{ enabled: false, adapter: 'mqtt.0' }], devices: ROWS });
        assert.strictEqual(errors.length, 1);
    });
    await test('Modell: Kanaele und Datenpunkte', () => {
        const m = buildModel(normalizeConfig(NATIVE).cfg.devices);
        const ids = m.states.map((s) => s.id);
        assert.ok(ids.includes('wohnung1.Lader1.ACSETPOINT'));
        assert.ok(ids.includes('wohnung1.Lader1.SETPOINT'));
        assert.ok(ids.includes('wohnung2.info.Total_Power'));
        assert.strictEqual(m.states.find((s) => s.id === 'wohnung1.Lader1.STATE').common.type, 'string');
        assert.ok(ids.includes('wohnung1.Lader1.EEPROMWRITES'));
        assert.ok(ids.includes('wohnung1.Lader1.REBOOT'));
        assert.strictEqual(m.states.find((s) => s.id === 'wohnung1.Lader1.ZEPC').common.states[3], 'MQTT');
        assert.strictEqual(m.states.find((s) => s.id === 'wohnung1.Lader1.REBOOT').common.type, 'boolean');
        assert.strictEqual(m.states.length, 2 * (2 + 18 + 8));
    });
    await test('Discovery: Seriennummern aus mqtt.0-IDs, fremde Topics ignoriert', () => {
        const s = serialsFromIds([`${S1}.ACSETPOINT`, `${S1}.VBAT`, `${S2}.ACSETPOINT`, 'mqtt.0.shellies.foo.ACSETPOINTX', 'mqtt.0.tasmota.power', 'mqtt.1.T2MG999999-x.ACSETPOINT'], ['mqtt.0']);
        assert.deepStrictEqual([...s].sort(), ['T2MG816EB1', 'T2MG818D75']);
        const { rows, added } = mergeSerials([{ group: 'wohnung1', serial: 'T2MG816EB1' }], s);
        assert.deepStrictEqual(added, ['T2MG818D75']);
        assert.strictEqual(rows.length, 2);
    });
    await test('Spiegeln und Gruppensumme', async () => {
        const { w, core } = mk();
        assert.strictEqual(await core.handle(`${S1}.ACSETPOINT`, st(420)), 'ok');
        await core.handle(`${S1}.VBAT`, st(52.3));
        await core.handle(`${S1}.STATE`, st('ON'));
        await core.handle(`${S2}.ACSETPOINT`, st('180'));
        assert.strictEqual(w['wohnung1.Lader1.ACSETPOINT'], 420);
        assert.strictEqual(w['wohnung1.Lader1.VBAT'], 52.3);
        assert.strictEqual(w['wohnung1.Lader1.STATE'], 'ON');
        assert.strictEqual(w['wohnung1.info.Total_Power'], 420);
        assert.strictEqual(w['wohnung2.info.Total_Power'], 180);
        assert.strictEqual(w['info.connection'], true);
        assert.strictEqual(await core.handle(`${S1}.ACSETPOINTOVR`, st(5)), 'ignored');
        assert.strictEqual(await core.handle(`${S1}.REBOOTOVR`, st(null)), 'skip');
        assert.deepStrictEqual(core.missingDevices(), []);
    });
    await test('Zwei Lader in einer Gruppe werden summiert', async () => {
        const { w, core } = mk({ sources: NATIVE.sources, devices: [{ group: 'haus', serial: 'T2MG816EB1' }, { group: 'haus', serial: 'T2MG818D75' }] });
        await core.handle(`${S1}.ACSETPOINT`, st(300));
        await core.handle(`${S2}.ACSETPOINT`, st(150.5));
        assert.strictEqual(w['haus.Lader2.ACSETPOINT'], 150.5);
        assert.strictEqual(w['haus.info.Total_Power'], 450.5);
    });
    await test('Stale-Timeout: veraltete Lader zaehlen als 0 W', async () => {
        const { w, t, core } = mk({ ...NATIVE, staleTimeoutSec: 60 });
        await core.handle(`${S1}.ACSETPOINT`, st(400));
        t.now += 61000;
        await core.checkStale();
        assert.strictEqual(w['wohnung1.info.Total_Power'], 0);
        assert.strictEqual(w['info.connection'], false);
    });
    await test('Rueckweg: SETPOINT -> ACSETPOINTOVR, Begrenzung auf MAXPOWER', async () => {
        const { w, src, core } = mk();
        assert.strictEqual(await core.writeBack('wohnung2.Lader1.SETPOINT', { val: 300, ack: false }), 'no-source');
        await core.handle(`${S2}.MAXPOWER`, st(650));
        await core.writeBack('wohnung2.Lader1.SETPOINT', { val: 300, ack: false });
        assert.strictEqual(src[`${S2}.ACSETPOINTOVR`], 300);
        assert.strictEqual(w['wohnung2.Lader1.SETPOINT'], 300);
        await core.writeBack('wohnung2.Lader1.SETPOINT', { val: 2000, ack: false });
        assert.strictEqual(src[`${S2}.ACSETPOINTOVR`], 650);
        await core.writeBack('wohnung2.Lader1.SETPOINT', { val: -5, ack: false });
        assert.strictEqual(src[`${S2}.ACSETPOINTOVR`], 0);
        assert.strictEqual(await core.writeBack('wohnung2.Lader1.SETPOINT', { val: 'abc', ack: false }), 'invalid');
        assert.strictEqual(await core.writeBack('wohnung2.Lader1.SETPOINT', { val: 100, ack: true }), 'ignored');
    });
    await test('Rueckweg: globale Obergrenze greift, wenn kleiner als MAXPOWER', async () => {
        const { src, core } = mk({ ...NATIVE, maxPowerW: 500 });
        await core.handle(`${S1}.MAXPOWER`, st(1440));
        await core.writeBack('wohnung1.Lader1.SETPOINT', { val: 1000, ack: false });
        assert.strictEqual(src[`${S1}.ACSETPOINTOVR`], 500);
    });
    await test('Neue Messwerte: EEPROMWRITES, ZEPC, METER, VGRID u. a. werden gespiegelt', async () => {
        const { w, core } = mk();
        for (const [k, v] of [['EEPROMWRITES', 1234], ['ZEPC', 1], ['METER', -250], ['VGRID', 231.4], ['VOUTSET', 54.4], ['IOUTSET', 1.5], ['MINPOWER', 50], ['TARGETMIN', -20], ['TARGETMAX', 0]]) {
            assert.strictEqual(await core.handle(`${S1}.${k}`, st(v)), 'ok', k);
            assert.strictEqual(w[`wohnung1.Lader1.${k}`], v, k);
        }
    });
    await test('Weitere Vorgaben: MINPOWER/TARGET/METER/ZEPC/REBOOT -> *OVR', async () => {
        const { w, src, core } = mk();
        await core.handle(`${S1}.VBAT`, st(52));
        await core.writeBack('wohnung1.Lader1.MINPOWER_SET', { val: -10, ack: false });
        assert.strictEqual(src[`${S1}.MINPOWEROVR`], 0);
        await core.writeBack('wohnung1.Lader1.MAXPOWER_SET', { val: 900, ack: false });
        assert.strictEqual(src[`${S1}.MAXPOWEROVR`], 900);
        await core.writeBack('wohnung1.Lader1.TARGETMIN_SET', { val: -30, ack: false });
        assert.strictEqual(src[`${S1}.TARGETMINOVR`], -30);
        await core.writeBack('wohnung1.Lader1.TARGETMAX_SET', { val: 10, ack: false });
        assert.strictEqual(src[`${S1}.TARGETMAXOVR`], 10);
        await core.writeBack('wohnung1.Lader1.METER_SET', { val: -480, ack: false });
        assert.strictEqual(src[`${S1}.METEROVR`], -480);
        await core.writeBack('wohnung1.Lader1.ZEPC_SET', { val: 1, ack: false });
        assert.strictEqual(src[`${S1}.ZEPCOVR`], 1);
        assert.strictEqual(await core.writeBack('wohnung1.Lader1.ZEPC_SET', { val: 3, ack: false }), 'invalid');
        assert.strictEqual(await core.writeBack('wohnung1.Lader1.REBOOT', { val: false, ack: false }), 'ignored');
        await core.writeBack('wohnung1.Lader1.REBOOT', { val: true, ack: false });
        assert.strictEqual(src[`${S1}.REBOOTOVR`], 'REBOOTOVR');
        assert.strictEqual(w['wohnung1.Lader1.REBOOT'], false);
        assert.strictEqual(await core.writeBack('wohnung1.Lader1.METER_SET', { val: true, ack: false }), 'invalid');
    });
    await test('Import/Export: Rundreise inkl. Quell-Tabelle', () => {
        const ex = exportConfig({ ...NATIVE, sources: [{ enabled: true, adapter: 'mqtt.1' }] });
        const im = importConfig(ex.native.configJson);
        assert.ok(!im.error, im.error);
        assert.deepStrictEqual(im.native.devices, ROWS);
        assert.deepStrictEqual(im.native.sources, [{ enabled: true, adapter: 'mqtt.1' }]);
        assert.ok(importConfig('{"adapter":"shelly-gruppen"}').error);
        assert.ok(importConfig('kein json').error);
    });
    console.log(`\n${passed} Tests bestanden`);
})().catch((e) => { console.error(e); process.exit(1); });
