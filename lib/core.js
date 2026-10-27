'use strict';
const { METRICS, SUM_KEY, WRITES, extractSerial } = require('./model');

const round = (v, d = 2) => { const f = 10 ** d; return Math.round(v * f) / f; };

/**
 * Kernlogik: ordnet Quell-Datenpunkte (<adapter>.<SERIAL>-<name>.<METRIK>) Gruppen zu, spiegelt die Werte,
 * bildet pro Gruppe die Summe der Ladeleistung (ACSETPOINT) und reicht Schreibzugriffe auf die Vorgaben
 * (SETPOINT, MINPOWER_SET, …, REBOOT) an die passenden *OVR-Topics des Gateways weiter.
 *
 * io.write(rel, val)       -> Promise   eigene Zustände (ack=true)
 * io.invalidate(rel)       -> void      Zwischenspeicher eines eigenen Zustands verwerfen
 * io.setSource(id, val)    -> Promise   Quelle beschreiben (ack=false)
 */
class TruckiCore {
    constructor({ cfg, io, log, now }) {
        this.cfg = cfg;
        this.io = io;
        this.log = log;
        this.now = now || Date.now;
        this.bySerial = new Map(cfg.devices.map((d) => [d.up, d]));
        this.groups = {};
        for (const d of cfg.devices) (this.groups[d.group] = this.groups[d.group] || []).push(d);
        this.targets = new Map(); // relative Ziel-ID der Vorgabe -> { device, w }
        for (const d of cfg.devices) for (const w of WRITES) this.targets.set(`${d.group}.${d.name}.${w.key}`, { device: d, w });
        this.cache = new Map();   // SERIAL -> { val, ts } (Ladeleistung)
        this.prefix = new Map();  // SERIAL -> '<adapter>.<segment>' der Quelle
        this.maxPower = new Map(); // SERIAL -> MAXPOWER des Gateways
        this.lastSum = {};
        this.lastConn = null;
    }

    parseId(id) {
        const parts = String(id).split('.');
        if (parts.length < 4 || !this.cfg.adapters.includes(`${parts[0]}.${parts[1]}`)) return null;
        const device = this.bySerial.get(extractSerial(parts[2]).toUpperCase());
        const metric = METRICS[parts[parts.length - 1].toLowerCase()];
        return device && metric ? { device, metric, prefix: parts.slice(0, parts.length - 1).join('.') } : null;
    }

    /** Spiegelt einen Quellwert auf den Zieldatenpunkt. */
    async handle(id, state) {
        if (!state || state.val === null || state.val === undefined) return 'skip';
        const p = this.parseId(id);
        if (!p) return 'ignored';
        const { device, metric } = p;
        if (!this.prefix.has(device.up)) this.prefix.set(device.up, p.prefix);
        const target = `${device.group}.${device.name}.${metric.key}`;
        if (metric.type === 'string') {
            await this.io.write(target, String(state.val));
            return 'ok';
        }
        const raw = Number(state.val);
        if (!Number.isFinite(raw)) return 'invalid';
        const val = round(raw * (metric.scaleKey ? this.cfg[metric.scaleKey] : 1));
        await this.io.write(target, val);
        if (metric.key === 'MAXPOWER') this.maxPower.set(device.up, val);
        if (metric.key === SUM_KEY) {
            this.cache.set(device.up, { val, ts: this.now() });
            await this.updateGroupSum(device.group);
            await this.updateConnection();
        }
        return 'ok';
    }

    async updateGroupSum(group) {
        let sum = 0;
        for (const d of this.groups[group] || []) {
            const e = this.cache.get(d.up);
            if (!e || this.isStale(e)) continue;
            sum += e.val;
        }
        sum = round(sum, 1);
        if (this.lastSum[group] === sum) return;
        this.lastSum[group] = sum;
        await this.io.write(`${group}.info.Total_Power`, sum);
    }

    isStale(e) { return this.cfg.staleTimeoutSec > 0 && this.now() - e.ts > this.cfg.staleTimeoutSec * 1000; }

    async checkStale() {
        if (this.cfg.staleTimeoutSec <= 0) return;
        for (const g of Object.keys(this.groups)) await this.updateGroupSum(g);
        await this.updateConnection();
    }

    async updateConnection() {
        const conn = [...this.cache.values()].some((e) => !this.isStale(e));
        if (conn === this.lastConn) return;
        this.lastConn = conn;
        await this.io.write('info.connection', conn);
    }

    missingDevices() { return this.cfg.devices.filter((d) => !this.prefix.has(d.up)); }

    /** Begrenzt die Ladeleistungs-Vorgabe auf 0 … min(Obergrenze, MAXPOWER). */
    clampSetpoint(rel, device, val) {
        const limits = [];
        if (this.cfg.maxPowerW > 0) limits.push(this.cfg.maxPowerW);
        if (this.maxPower.get(device.up) > 0) limits.push(this.maxPower.get(device.up));
        const max = limits.length ? Math.min(...limits) : Infinity;
        if (val < 0 || val > max) {
            const clamped = Math.min(Math.max(val, 0), max);
            this.log.warn(`${rel}: Wert ${val} W ausserhalb von 0...${max} W, begrenzt auf ${clamped} W`);
            return clamped;
        }
        return val;
    }

    /** Schreibzugriff (ack=false) auf eine Vorgabe -> <quelle>.<…OVR>. */
    async writeBack(rel, state) {
        const t = this.targets.get(rel);
        if (!t || !state || state.ack) return 'ignored';
        const { device, w } = t;
        let val;
        let out;
        if (w.kind === 'button') {
            if (!state.val || state.val === 'false') return 'ignored';
            val = false;
            out = 'REBOOTOVR';
        } else {
            val = Number(state.val);
            if (state.val === null || state.val === '' || typeof state.val === 'boolean' || !Number.isFinite(val)) {
                this.log.warn(`Ungueltiger Wert fuer ${rel}: ${state.val}`);
                return 'invalid';
            }
            if (w.kind === 'setpoint') {
                val = this.clampSetpoint(rel, device, val);
                out = round(val / this.cfg.powerScale, 3);
            } else if (w.kind === 'zepc') {
                if (val !== 0 && val !== 1) {
                    this.log.warn(`${rel}: nur 0 (Disabled) oder 1 (Enabled) erlaubt, nicht ${state.val}`);
                    return 'invalid';
                }
                out = val;
            } else {
                if (w.kind === 'min0' && val < 0) {
                    this.log.warn(`${rel}: Wert ${val} W unter 0, begrenzt auf 0 W`);
                    val = 0;
                }
                out = round(val, 3);
            }
        }
        const prefix = this.prefix.get(device.up);
        if (!prefix) {
            this.log.warn(`Kein Quell-Datenpunkt fuer ${rel} bekannt (noch kein Wert vom Gateway ${device.serial} empfangen)`);
            return 'no-source';
        }
        const src = `${prefix}.${w.source}`;
        await this.io.setSource(src, out);
        this.io.invalidate(rel);
        await this.io.write(rel, val); // Vorgabe bestätigen (ack=true, ggf. begrenzter Wert; Taster zurück auf false)
        (this.cfg.logWrites ? this.log.info : this.log.debug).call(this.log, `${rel} = ${state.val} -> ${src} = ${out}`);
        return 'ok';
    }
}

module.exports = { TruckiCore };
