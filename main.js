'use strict';
const utils = require('@iobroker/adapter-core');
const { normalizeConfig, buildModel, mergeSerials, serialsFromIds } = require('./lib/model');
const { TruckiCore } = require('./lib/core');
const configio = require('./lib/configio');
const pkg = require('./package.json');

class T2mgGruppen extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 't2mg-gruppen' });
        this.cache = new Map();
        this.queue = Promise.resolve();
        this.core = null;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /** Schreibt geänderte Werte nacheinander in den Namensraum der Instanz (t2mg-gruppen.<N>). */
    write(id, val) {
        this.queue = this.queue
            .then(async () => {
                if (this.cache.get(id) === val) return;
                this.cache.set(id, val);
                await this.setStateAsync(id, { val, ack: true });
            })
            .catch((e) => this.log.error(`Schreiben von ${id} fehlgeschlagen: ${e.message}`));
        return this.queue;
    }

    /** Legt Kanäle und Datenpunkte an und entfernt Altlasten. */
    async ensureStructure(model, prune) {
        const expected = new Set(['info', 'info.connection']);
        for (const ch of model.channels) {
            expected.add(ch.id);
            await this.extendObjectAsync(ch.id, { type: 'channel', common: { name: ch.name }, native: {} });
        }
        for (const st of model.states) {
            expected.add(st.id);
            await this.extendObjectAsync(st.id, { type: 'state', common: st.common, native: {} });
            const cur = await this.getStateAsync(st.id);
            if (!cur || cur.val === null) await this.setStateAsync(st.id, { val: st.common.def, ack: true });
        }
        if (prune) {
            const all = await this.getAdapterObjectsAsync();
            const ids = Object.keys(all).map((full) => full.slice(this.namespace.length + 1));
            // tiefste Pfade zuerst löschen
            ids.sort((a, b) => b.split('.').length - a.split('.').length);
            for (const rel of ids) {
                if (rel && !expected.has(rel) && rel !== 'info' && !rel.startsWith('info.')) {
                    await this.delObjectAsync(rel);
                    this.log.info(`Veralteten Datenpunkt entfernt: ${rel}`);
                }
            }
        }
        for (const [group, list] of Object.entries(model.groups)) await this.setStateChangedAsync(`${group}.info.Count`, { val: list.length, ack: true });
    }

    /** Abonnement-Muster je Quell-Instanz: <adapter>.<SERIAL>* trifft z. B. mqtt.0.T2MG816EB1-wohnung1.* */
    sourcePatterns(cfg) {
        const out = [];
        for (const a of cfg.adapters) {
            for (const d of cfg.devices) {
                out.push(`${a}.${d.serial}*`);
                out.push(`${a}.${d.serial.toUpperCase()}*`);
                out.push(`${a}.${d.serial.toLowerCase()}*`);
            }
        }
        return [...new Set(out)];
    }

    async onReady() {
        this.log.info(`t2mg-gruppen v${pkg.version} startet`);
        await this.setStateAsync('info.connection', false, true);
        const { cfg, errors } = normalizeConfig(this.config, this.log);
        this.cfg = cfg;
        if (errors.length) {
            for (const e of errors) this.log.error(e);
            this.log.error('Konfiguration fehlerhaft - Adapter bleibt inaktiv. Bitte in der Instanz korrigieren');
            return;
        }
        if (!cfg.devices.length) this.log.warn('Keine gueltigen Lader konfiguriert - bitte die Geraetetabelle in der Instanz ausfuellen');
        const model = buildModel(cfg.devices);
        await this.ensureStructure(model, cfg.pruneOnStart);

        this.core = new TruckiCore({
            cfg,
            log: this.log,
            io: {
                write: (id, val) => this.write(id, val),
                invalidate: (id) => this.cache.delete(id),
                setSource: (id, val) => this.setForeignStateAsync(id, { val, ack: false }),
            },
        });

        for (const rel of this.core.targets.keys()) this.subscribeStates(rel);
        const pats = this.sourcePatterns(cfg);
        for (const p of pats) this.subscribeForeignStates(p);

        let count = 0;
        const done = new Set();
        for (const p of pats) {
            const objs = (await this.getForeignObjectsAsync(p, 'state')) || {};
            for (const id of Object.keys(objs)) {
                if (done.has(id) || !this.core.parseId(id)) continue;
                done.add(id);
                await this.core.handle(id, await this.getForeignStateAsync(id));
                count++;
            }
        }
        this.log.info(`Initial-Sync: ${count} Quell-Datenpunkte uebernommen`);
        const missing = this.core.missingDevices();
        if (missing.length) this.log.warn(`Keine passenden Quell-Datenpunkte gefunden fuer: ${missing.map((d) => d.serial).join(', ')}. Seriennummer und Quell-Instanz pruefen (erwartet z. B. mqtt.0.<SERIAL>-<name>.ACSETPOINT)`);

        if (cfg.staleTimeoutSec > 0) this.staleTimer = setInterval(() => this.core.checkStale().catch((e) => this.log.error(e.message)), 30000);
        this.log.info(`Adapter gestartet (Quelle: ${cfg.adapters.join(', ')}, ${cfg.devices.length} Lader), Datenpunkte unter ${this.namespace}.*`);
    }

    onStateChange(id, state) {
        if (!this.core || !state) return;
        const prefix = `${this.namespace}.`;
        if (id.startsWith(prefix)) {
            const rel = id.slice(prefix.length);
            if (state.ack === false && this.core.targets.has(rel)) {
                this.core.writeBack(rel, state).catch((e) => this.log.error(`Schreiben von ${rel}: ${e.message}`));
            }
            return;
        }
        this.core.handle(id, state).catch((e) => this.log.error(`Fehler bei ${id}: ${e.message}`));
    }

    /** Nachrichten der Admin-Oberfläche: JSON-Export/-Import und Geräte-Suche. */
    async onMessage(obj) {
        if (!obj || !obj.command || !obj.callback) return;
        let reply;
        try {
            const msg = obj.message || {};
            if (obj.command === 'exportConfig') reply = configio.exportConfig(msg.config);
            else if (obj.command === 'importConfig') reply = configio.importConfig(msg.json);
            else if (obj.command === 'discoverDevices') {
                const c = msg.config || {};
                const { cfg } = normalizeConfig(c);
                const ids = [];
                for (const a of cfg.adapters) ids.push(...Object.keys((await this.getForeignObjectsAsync(`${a}.*`, 'state')) || {}));
                const serials = serialsFromIds(ids, cfg.adapters);
                const { rows, added } = mergeSerials(c.devices, serials);
                reply = {
                    native: { devices: rows },
                    result: serials.size
                        ? `${serials.size} Trucki-Gateway(s) gefunden, ${added.length} neu in die Tabelle uebernommen. Bei neuen Zeilen die Gruppe eintragen (Zeilen ohne Gruppe werden ignoriert), danach 'Speichern und schliessen' druecken.`
                        : `In ${cfg.adapters.join(', ')} wurden keine Trucki-Gateways (Datenpunkt ACSETPOINT) gefunden.`,
                };
            } else return;
        } catch (e) {
            reply = { error: `Fehler: ${e.message}` };
        }
        this.sendTo(obj.from, obj.command, reply, obj.callback);
    }

    onUnload(callback) {
        try {
            if (this.staleTimer) clearInterval(this.staleTimer);
            this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) module.exports = (options) => new T2mgGruppen(options);
else new T2mgGruppen();
