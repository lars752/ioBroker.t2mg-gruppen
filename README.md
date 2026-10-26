# ioBroker.t2mg-gruppen

Ordnet **Trucki2MeanWell-Gateways** (T2MG), deren Daten über den **MQTT-Adapter** ankommen, anhand ihrer Seriennummer frei wählbaren **Gruppen** zu, spiegelt Ladeleistung und Messwerte und bildet pro Gruppe die **Summe der Ladeleistung** (`ACSETPOINT`).
Eine Vorgabe auf `SETPOINT` wird an `ACSETPOINTOVR` des passenden Gateways weitergereicht.

## Funktionen

- **Gruppen frei konfigurierbar:** Tabelle mit Gruppe und Seriennummer, Anzeigename (`Lader1`, `Lader2`, …) wird je Gruppe in Tabellenreihenfolge automatisch vergeben.
- **Erkennung:** Das MQTT-Topic `mqtt.0.T2MG816EB1-wohnung1.*` wird über die Seriennummer (Teil vor dem ersten `-`) zugeordnet, unabhängig von Groß-/Kleinschreibung. Der Name hinter dem `-` darf beliebig sein.
- **Spiegeln:** `ACSETPOINT`, `ACDISPLAY`, `VBAT`, `IOUT`, `TEMPERATURE`, `DAYENERGY`, `TOTALENERGY`, `MAXPOWER`, `STATE`.
- **Gruppensumme:** `<gruppe>.info.Total_Power` = Summe `ACSETPOINT` aller Lader der Gruppe.
- **Rückweg:** Schreibt eine Automatisierung auf `<gruppe>.<LaderN>.SETPOINT` (ack=false), wird der Wert an `mqtt.0.<SERIAL>-<name>.ACSETPOINTOVR` weitergegeben und danach mit ack=true bestätigt.
- **Schutz:** Vorgaben unter 0 W werden auf 0 begrenzt, nach oben auf die konfigurierte Obergrenze **und** auf `MAXPOWER` des Gateways (der kleinere Wert gilt). Ungültige Werte werden verworfen.
- **Stale-Timeout (optional):** Lader ohne Update seit X Sekunden zählen in der Gruppensumme als 0 W. `info.connection` zeigt, ob mindestens ein Gateway aktuelle Daten liefert.
- **Eigener Namensraum:** Alle Datenpunkte liegen unter `t2mg-gruppen.<Instanz>.*`.
- **Aufräumen beim Start** (abschaltbar), **Eingabeprüfung**, **JSON-Import/-Export** wie bei shelly-gruppen.

## Installation

1. ioBroker Admin → Adapter → Experten-Modus → "Adapter aus eigener URL installieren":
   `https://github.com/lars752/ioBroker.t2mg-gruppen`
   Alternativ: `iobroker url https://github.com/lars752/ioBroker.t2mg-gruppen`
2. Instanz anlegen, "Trucki-Gateways der Quell-Instanzen einlesen" drücken, Gruppen eintragen, speichern.

**Voraussetzungen:** Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6.12.2, MQTT-Adapter, der die Trucki-Topics empfängt.

## Konfiguration

| Einstellung | Standard | Bedeutung |
|---|---|---|
| Quell-Instanzen | `mqtt.0` | Instanzen des MQTT-Adapters |
| Skalierung Vorgabe | 1 | Faktor Watt → Wert für `ACSETPOINTOVR` |
| Skalierung Ladeleistung | 1 | Faktor `ACSETPOINT`/`ACDISPLAY` → Watt |
| Maximale Sollleistung | 1500 W | Obergrenze für `SETPOINT`, 0 = nur `MAXPOWER` des Gateways |
| Stale-Timeout | 0 s | Sekunden bis ein Lader als 0 W zählt, 0 = deaktiviert |
| Aufräumen beim Start | an | nicht mehr konfigurierte Datenpunkte löschen |
| Weitergaben im Log | aus | Vorgaben als `info` statt `debug` protokollieren |
| Tabelle | leer | pro Gateway: Gruppe und Seriennummer |

## Datenpunkte (`t2mg-gruppen.0.*`)

| Datenpunkt | Inhalt |
|---|---|
| `<gruppe>.Lader<n>.ACSETPOINT` | aktuelle Ladeleistung (Sollwert des Gateways) in W |
| `<gruppe>.Lader<n>.ACDISPLAY` | angezeigte AC-Leistung in W |
| `<gruppe>.Lader<n>.VBAT` / `IOUT` / `TEMPERATURE` | Batteriespannung (V), Ladestrom (A), Temperatur (°C) |
| `<gruppe>.Lader<n>.DAYENERGY` / `TOTALENERGY` | Energie heute / gesamt (kWh) |
| `<gruppe>.Lader<n>.MAXPOWER` | Maximalleistung laut Gateway (W) |
| `<gruppe>.Lader<n>.STATE` | Status (z. B. `ON`/`OFF`) |
| `<gruppe>.Lader<n>.SETPOINT` | Vorgabe in W (**schreibbar**, → `ACSETPOINTOVR`) |
| `<gruppe>.info.Total_Power` | Summe `ACSETPOINT` der Gruppe |
| `<gruppe>.info.Count` | Anzahl Lader der Gruppe |
| `info.connection` | `true`, solange mindestens ein Gateway aktuelle Daten liefert |

**Hinweis zum Rückweg:** Ob das Gateway eine Vorgabe über `ACSETPOINTOVR` übernimmt, hängt von seinem Regelmodus (`ZEPC`) ab. Bei aktiver Nulleinspeisung im Gateway regelt es selbst und überschreibt die Vorgabe. Damit der MQTT-Adapter Schreibzugriffe publiziert, muss dort das Senden von Zustandsänderungen erlaubt sein.

## Import / Export der Konfiguration

```json
{
  "adapter": "t2mg-gruppen",
  "version": 1,
  "config": {
    "sources": [{ "enabled": true, "adapter": "mqtt.0" }],
    "staleTimeoutSec": 0,
    "pruneOnStart": true,
    "powerScale": 1,
    "outputScale": 1,
    "maxPowerW": 1500,
    "logWrites": false,
    "devices": [
      { "group": "wohnung1", "serial": "T2MG816EB1" },
      { "group": "wohnung2", "serial": "T2MG818D75" }
    ]
  }
}
```

## Entwicklung

```
npm install
npm test     # läuft ohne ioBroker-Instanz
```

Struktur: `lib/model.js` (Konfiguration, Datenmodell), `lib/core.js` (Zuordnung, Summen, Rückweg), `lib/configio.js` (JSON-Import/-Export), `main.js` (Adapter).

## Lizenz

MIT
