# ELPRO 115E-2 test unit — blanks sheet

**The sheet that goes with [`elpro115e_test_card.md`](elpro115e_test_card.md).** The card
tells the technician what to do; this tells them what to type. Every `▢` on the card is a
row here.

**How to use it:** fill the *Value* column, delete the *Where to get it* column, and send
the result with the card. Twenty minutes, most of it in the broker console.

> **Three of these rows are not yours to fill.** The unit lives on the other office's
> network, so their IP address, gateway and NTP server are theirs to supply — §C. Send the
> sheet with §C blank and ask them to complete it; do not guess, and do not hold up the
> rest of the sheet waiting for it.

---

## §A · Already decided — copy these across as-is

Nothing to fill in. They are here so the technician has every value on one page, and so
you can see what has already been fixed by the MegaNet end.

| Field | Value | Why it is this |
|---|---|---|
| **Topic Prefix** | `meganet/v1/elpro_test/logger/reading/` | Must be exact, trailing `/` included. The bridge subscribes to `meganet/v1/+/+/reading/elpro` and nothing else. |
| **Device name** | `elpro` | Becomes the final topic segment, giving `meganet/v1/elpro_test/logger/reading/elpro`. |
| **Device Type** | `General Purpose` | The type that exposes the `Register` IO-Type, which is how raw registers get published. |
| **Slave address** | `0` | Only 115S expansion units need one. |
| **Enable Sparkplug** | **OFF** | Not negotiable — see the card. With it on, the topic and payload both become something MegaNet cannot read, and it looks like it is working from the device end. |
| **Queuing Mode** | `FIFO` | Replays an outage in the order it happened. |
| **Node Update** | `600` (seconds) | The unit's own status/statistics interval. |
| **Keep Alive** | `60` (seconds) | Fine for an Ethernet link. |
| **Clean Session** | unticked | Keeps the session persistent so a broker blip does not lose queued messages. |
| **Historian** | ticked | Flags messages that were queued during an outage. |
| **Queue Size (Max)** | `3000` | Device maximum is 10,000, shared across brokers. |
| **Queue Delay (s)** | `0` | No rate limiting needed on Ethernet. |
| **Broker username** | `station-elpro_test` | Created in §B1. |
| **Broker port** | `8883` | MQTT over TLS. |

**The input rows** — start with the first only, add the other two once it lands:

| # | Payload Prefix | Register | What it is |
|---|---|---|---|
| 1 | `9003` | `30007` | The gateway's own battery voltage. Nothing has to be wired up. |
| 2 | `9001` | `30005` | Supply voltage |
| 3 | `9002` | `30001` | Analog input 1 — reads near zero unwired, which is fine |

> **Payload Prefix is an address, not a register.** `9003` is the ALERT address MegaNet
> files the reading under; `30007` is where the device reads the number from. Swapping them
> is the mistake worth watching for, and the card says so too.

---

## §B · Yours to fill

### B1 · The broker credential — do this first

In your broker's console (HiveMQ Cloud → your cluster → **Access Management**), create a
credential:

- **Username:** `station-elpro_test`
- **Password:** generate a long one
- **Permission:** **Publish**, on topic filter `meganet/v1/elpro_test/#`

Publish only, and scoped to that one prefix. A credential that can write any topic is a
credential that can fabricate readings for a real gauging station. Same shape as every
other station credential — [`bridge/deploy/mosquitto.acl.example`](../bridge/deploy/mosquitto.acl.example)
has the reasoning.

**HiveMQ shows a generated password once.** Put it straight into the table below.

| Field | Value | Where to get it |
|---|---|---|
| **Broker password** | ▢ | The credential you just created. Shown once. |

### B2 · The broker address

| Field | Value | Where to get it |
|---|---|---|
| **IP/Name** (broker hostname) | ▢ | GitHub → this repo → **Settings** → **Secrets and variables** → **Actions** → the **Variables** tab → `MQTT_URL`. It reads `mqtts://<something>.hivemq.cloud:8883`; **the sheet wants just the hostname**, without `mqtts://` and without `:8883`. It is a *variable* rather than a secret exactly so you can read it back — see [`mqtt-provisioning.md`](mqtt-provisioning.md) §3.2. Failing that, the cluster's **Overview** page in the HiveMQ console shows it. |

### B3 · TLS — and the two files that do not exist

**A technician will ask you for three files. Two of them are not things.**

| What they ask for | The answer |
|---|---|
| **Client certificate** | **Does not exist.** Do not go looking. |
| **Client private key** | **Does not exist.** Do not go looking. |
| **CA certificate** | Real, public, not a secret — and quite possibly not needed either. |

**Why.** The client certificate and key are for **mutual TLS**, where the broker
makes each device prove its identity with a certificate issued to it. HiveMQ Cloud
does not work that way: the device proves who it is with the **username and
password** from §B1. There is nothing to issue and nothing to send.

The **CA certificate** does the opposite job — it is how the *device* checks that
whatever answers on port 8883 really is your broker, rather than something sitting
in the middle. Because your broker's certificate is signed by a **public** CA, the
root is a public download, not something you generate.

**Tell the technician to work down this ladder** (the card already does):

1. **Tick TLS and upload nothing.** Many devices carry the common public roots
   built in. If it connects, there is nothing to send and nothing to do.
2. **CA certificate only**, if step 1 is refused.
3. **Stop and ring**, if step 2 is refused. Do not improvise a client certificate.

#### Getting the CA certificate, if step 2 is reached

**Easiest first — the script.** [`tools/get-broker-ca.ps1`](../tools/get-broker-ca.ps1)
runs on any Windows machine with nothing installed. It opens the real connection to the
real broker on the real port, asks Windows to build the certificate chain, and writes the
root out as a PEM file:

```powershell
powershell -ExecutionPolicy Bypass -File .\get-broker-ca.ps1 `
    -BrokerHost your-cluster.s1.eu.hivemq.cloud
```

It prints the chain, names the root, and writes two files beside itself:
`<host>-ca-root.crt` (send this one first) and `<host>-ca-chain.crt` (only if the root
alone is refused — some devices want the intermediates too).

> **If the script cannot connect, that is a finding, not a failure.** It means the machine
> cannot reach the broker on 8883 — and the 115E-2 on the same network will not be able to
> either. Check the firewall allows outbound TCP 8883 before anyone blames the device.

**If you would rather not run a script**, two manual routes, both giving the same file — a
text file starting `-----BEGIN CERTIFICATE-----`:

- **The HiveMQ console.** Your cluster's connection / getting-started page names the CA it
  uses and generally links the download.
- **The Windows certificate store**, once you know which CA to look for (the script or the
  console tells you): `Win+R` → `certmgr.msc` → **Trusted Root Certification Authorities**
  → **Certificates** → find it → right-click → **All Tasks** → **Export** → **Base-64
  encoded X.509 (.CER)**.

> **Do not send a `.pfx`, a `.p12`, or anything you had to type a password to open.** Those
> carry private keys. A CA certificate is public — if what you are about to attach is
> secret, it is the wrong file.

### B4 · Identity labels

**This is the one that confused me too, so here is what these actually are.** They are the
unit's own name badge, typed on the device's **Module Information** page. ELPRO uses them
to build the topic **only when Sparkplug is enabled** — and we are turning Sparkplug off,
so **they do not appear in our topic at all.** They show up in the unit's own status
messages, as `System Info/Owner` and `System Info/Device Name`.

They are free text. Pick something a person reading a broker log would recognise.

| Field | Suggested | Where to get it |
|---|---|---|
| **Owner Name (Group)** | `MegaNet` | Your call. Anything. Appears only in the unit's status messages. |
| **Device Name (Node)** | `ELPRO-TEST-1` | Your call — **but make it unique across any other ELPRO gear you own.** The 115E-2 names its own data-log directories after it, and the manual warns that data from modules sharing a name collides. |
| **Client ID** | `elpro-test-1` | Your call, but it **must be unique on the broker** — a duplicate makes the broker refuse the connection outright, and ELPRO calls this out specifically. Lowercase, no spaces. |

---

## §C · Theirs to fill — send this section blank

The unit sits on the other office's network. Ask them to complete these before the
technician starts; none of them is knowable from here.

| Field | Value | Notes for them |
|---|---|---|
| **IP Address** | ▢ | A static address on the LAN the unit will live on. There is no DHCP option documented on this device. |
| **Subnet Mask** | ▢ | |
| **Default Gateway** | ▢ | |
| **Primary DNS** | ▢ | Only needed because the broker is given by name rather than by number. `8.8.8.8` works if they have no internal DNS. |
| **Secondary DNS** | ▢ | Use the same as primary if there is no second one. |
| **NTP Server IP** | ▢ | An internal NTP server, or a public one. **Not optional** — the unit has no time-zone handling and runs on UTC, and a wrong clock makes the TLS connection fail in a way that looks like a bad password. |

**The firewall rules they will need**, if their network restricts outbound traffic:

| Direction | Port | For |
|---|---|---|
| Outbound TCP | **8883** | The unit → the broker |
| Outbound UDP | **123** | NTP |

---

## §D · Before you send it — two checks

**1 · Confirm the test station is live** (Supabase SQL editor):

```sql
select id, name, station_number, enabled,
       meganet.resolve_publisher('elpro_test') as publisher_resolves,
       meganet.resolve_station(9003, null)     as addr_9003_resolves
  from meganet.station where id = 'elpro_test';
```

All three should come back naming `elpro_test`. If they do not, the migration has not been
applied to this database — `db/migrations/0021_elpro_test_station.sql`.

**2 · Confirm the bridge is subscribed to four topics, not three.** The connect log should
show `meganet/v1/+/+/reading/elpro` among them. If it shows three, the bridge is running an
older build and the messages will arrive at the broker and go nowhere.

---

## §E · The sheet to send

Fill this in and send it with the card. Nothing else needs to go with it.

```
ELPRO 115E-2 TEST UNIT — SETTINGS
Contact: ......................  Phone: ......................
Best time to ring: ......................

BROKER
  IP/Name .......................................  Port 8883
  User name  station-elpro_test
  Password  .......................................
  Client ID  .......................................
  TLS  yes
       Try connecting with NO certificate files first (see card 3.3).
       If refused, ask for the CA certificate. There is no client
       certificate and no client private key — they do not exist.
  Keep Alive 60   Clean Session OFF   Historian ON
  Queue Size 3000   Queue Delay 0

MQTT
  MQTT Enable        ON
  Enable Sparkplug   OFF   <-- must be off
  Topic Prefix       meganet/v1/elpro_test/logger/reading/
  Queuing Mode       FIFO
  Node Update        600 seconds
  Owner Name (Group) .......................................
  Device Name (Node) .......................................

DEVICE
  Name  elpro     Type  General Purpose     Slave address  0
  Full topic should read: meganet/v1/elpro_test/logger/reading/elpro

INPUT ROWS   (start with row 1 only)
  #  Payload Prefix  Register  Count  Sensitivity  Update Time  Scale  Offset
  1  9003            30007     1      1            60           1.0    0
  2  9001            30005     1      1            60           1.0    0
  3  9002            30001     1      1            60           1.0    0

NETWORK   (your office to complete)
  IP Address ..................  Subnet ..................
  Gateway ..................  DNS ................../..................
  NTP Server ..................
  Firewall: outbound TCP 8883, outbound UDP 123

WHEN YOU PRESS SAVE
  Ring the contact above and stay on the line.
```

---

## What comes back

The card's last section lists it. The two that matter most:

- **The actual topic and payload**, copied out of the unit's *Monitor MQTT Comms* screen.
- **Whether the CA certificate alone was accepted.**

Everything else on that list is a question ELPRO's own documentation does not answer, and
the technician is the only person in a position to answer it. Log the replies on
[#166](https://github.com/cdomotor-g/MegaNet/issues/166).
