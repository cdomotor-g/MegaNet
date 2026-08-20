# ELPRO 115E-2 → MegaNet: test unit setup card

**For the technician configuring the test unit.** One sitting, about an hour.
You do not need to know anything about MegaNet, and you should not need to read
anything else. If a value is not on this card it will be on the **blanks sheet**
that came with it.

**What success looks like:** you press *Save and Activate*, ring the contact on
the sheet, and within a minute they tell you a reading from your unit has
appeared in their system. That is the whole test.

> **You are proving a path, not commissioning a site.** Nothing here is
> permanent, no field wiring is needed, and the one value we start with —
> the gateway's own battery voltage — is something the unit already knows about
> itself. If a step will not do what this card says, **stop and write down what
> you saw**; that is more useful to us than a workaround.

---

## Before you start

| You need | Notes |
|---|---|
| The **blanks sheet** | Broker address, passwords, IP settings. Every `▢` below is on it. |
| A **115E-2**, powered | Firmware **V2.33 or later** — check the home page. Below that it cannot do MQTT at all. |
| **USB-A → USB-B cable** | The unit's port is USB-B, on the bottom. |
| A **Windows laptop** with **CConfig** | Version 2.1.0.72 or later. From elprotech.com → Resources → 115E-2 → Software. |
| The **USB driver**, if you want the web pages | `Inst_Elpro_USB_Driver_2.0.0.2.exe_zip`, same place. Installing CConfig usually installs it. |
| The **CA certificate file** | On or with the sheet. Only needed if the sheet says TLS. |

**Write the serial number off the side label before the unit is racked.** You
will need it if the unit ever has to be reset, and the reset asks you to type it.

---

## 1 · Get in

1. Power on. Wait for **PWR solid green** — about 80 seconds. (Red ≈ 2 s →
   orange 12 s → fast flash 30 s → slow flash 50 s → green.)
2. Plug in the USB cable. Windows should show a device called **115E-2** and add
   an adapter called **Elpro 115E-2 USB Ethernet/ RNDIS Interface**.
3. Connect:
   - **Web:** browser → `http://192.168.111.1` (the same on every unit)
   - **CConfig:** Communications → *Program Unit* → **USB** → *Refresh* until
     it says Connected → username and password → OK
4. Log in. Try `user` / `user`, then `admin` / `admin`, then the password printed
   on the side label. **Write down which one worked.**

> The first connection to a 115E-2 has to be over USB. Ethernet configuration
> access is switched off until somebody turns it on, and that can only be done
> over USB.

---

## 2 · Basics

| Where | Set |
|---|---|
| Home page | **Read and note the firmware version.** Below V2.33, stop — the unit needs upgrading first. |
| Module Information | **Device Name** ▢ (from the sheet) |
| Network settings | **IP Address** ▢, **Subnet Mask** ▢, **Default Gateway** ▢ |
| System Tools → Set Date and Time | Tick **Enable NTP**, enter **NTP Server IP** ▢, then *Save changes and activate* |

> **The clock matters more than it looks.** The unit has no time zone support, so
> it runs on UTC — and if TLS is in use, a wrong clock makes the secure
> connection fail with an error that looks like a password problem.

If the sheet asks for it, also tick **Remote access** in CConfig so the unit can
be configured over Ethernet later. That can only be done over USB, so do it now
or not at all.

---

## 3 · MQTT

Find **MQTT** in CConfig's tree view under the device. (If your unit offers MQTT
on the web pages instead, use those — and **tell us**, because we do not know
which of the two this hardware does.)

### 3.1 The basics

| Field | Set to |
|---|---|
| **MQTT Enable** | **on** |
| **Enable Sparkplug** | **OFF** — see the box below. This one is not optional. |
| **Topic Prefix** | `meganet/v1/elpro_test/logger/reading/` — exactly, including the trailing `/` |
| **Owner Name (Group)** / **Device Name (Node)** | ▢ from the sheet |
| **Queuing Mode** | **FIFO** |
| **Node Update** | `600` seconds |

> ### ⚠️ Sparkplug must be off
> With Sparkplug on, the unit takes over the topic and sends a compressed binary
> payload. Our system can read neither, and — this is the part that wastes a
> day — **it will look like it is working from your end**: the unit connects,
> the broker accepts it, the traffic counter climbs, and nothing whatsoever
> arrives at the other end. If the Topic Prefix box disappears when you tick a
> checkbox, you have ticked this one.

### 3.2 The broker

One broker. Fill the row across:

| Column | Value |
|---|---|
| **Enabled** | ✓ |
| **Client ID** | ▢ — must be unique; a duplicate makes the broker refuse the connection |
| **IP/Name** | ▢ |
| **Port** | ▢ (normally `8883`) |
| **Historian** | ✓ |
| **Keep Alive (Sec)** | `60` |
| **Clean Session** | ✗ — leave unticked |
| **User name** / **Password** | ▢ / ▢ |
| **Queue Size (Max)** | `3000` |
| **Queue Delay (s)** | `0` |
| **TLS** | ✓ if the sheet says so — load the certificates first (3.3) |

If the broker is given by name rather than by number, the unit also needs DNS:
**Network** page → Advanced Networking → Default Gateway, Primary DNS ▢,
Secondary DNS ▢ → *Save Changes and Reset*.

> There is **no QoS, retain or Last Will setting** on this page. That is expected
> — do not go looking. If your unit *does* have them, that is a genuine finding
> and we want to know.

### 3.3 Certificates (only if the sheet says TLS)

**MQTT Security** page → *Choose File* for each:

- **CA Certificate** ▢
- **Client Certificate** ▢ — only if the sheet provides one
- **Client Private Key** ▢ — only if the sheet provides one

**Try the CA certificate on its own first.** ELPRO's documentation demands all
three but also says a username and password may be enough, and nobody here knows
which is true on this hardware. **Whichever way it goes, write it down** — it
decides how much work every future unit is.

### 3.4 The device

Add one entry:

| Field | Value |
|---|---|
| **Device Name** | `elpro` |
| **Device Type** | **General Purpose** |
| **Slave address** | `0` |

> The device name becomes the last part of the topic. With the prefix from 3.1,
> the unit will publish to
> `meganet/v1/elpro_test/logger/reading/elpro` — please check it reads exactly
> that where the screen shows you the full topic.

### 3.5 One input, to begin with

Add **one** row on the Input Configuration table. This publishes the gateway's
own battery voltage, so nothing has to be wired to anything.

| Column | Value |
|---|---|
| **Enabled** | ✓ |
| **Device** | `elpro` |
| **IO-Type** | `Register` |
| **Local Input** | `Register` |
| **Payload Prefix** | `9003` |
| **Register** | `30007` |
| **Input Count** | `1` |
| **Sensitivity** | `1` |
| **Update Time (sec)** | `60` |
| **Scaling** | `1.0` |
| **Offset** | `0` |

> **`9003` is not a typo and not a register.** It is the address our system will
> file the reading under. The device puts whatever you type here into the message
> as the value's name, and we have set our end up to expect that number.
>
> **Update Time and Sensitivity must not both be zero**, or the row never sends
> anything at all. `60` seconds is deliberately chatty for a test — we will slow
> it down later.

**Save often.** These pages time out.

### 3.6 Commit

**Program Unit** (CConfig) or **Save and Activate Changes** (web). Note whether
the unit restarted and how long it was away.

---

## 4 · Check it is talking

1. **LEDs:** PWR solid green, LAN green. There is **no MQTT LED** — the front
   panel cannot tell you the broker is connected.
2. **Monitor MQTT Comms** (Network Diagnostics). It starts on its own when the
   page opens. Within a minute or so you should see a **Tx** line with the topic
   and the payload. It will look roughly like:

   ```
   meganet/v1/elpro_test/logger/reading/elpro   {"timestamp":1787…,"9003":137}
   ```

   **Copy a couple of those lines out and keep them** — paste them into Notepad.
   They are the single most useful thing you can send back.
3. **Connectivity** page → the broker should show connected, with the message
   count climbing.

---

## 5 · Ring the contact

Tell them the unit is publishing. They will look at their end and tell you
whether it arrived. Stay on the line — if it did not, the next thing to try is
usually two minutes' work while you are still in front of it.

**Once they confirm it landed**, add two more input rows the same way, so we are
testing more than one value:

| Payload Prefix | Register | What it is |
|---|---|---|
| `9001` | `30005` | Supply voltage |
| `9002` | `30001` | Analog input 1 (reads near zero with nothing connected — that is fine) |

---

## 6 · What to send back

Most of this is answering questions ELPRO's own documentation does not, so
please do not skip it even where it feels obvious.

**About the unit**
- Serial number, firmware version, CConfig version
- Which login worked: `user`/`user`, `admin`/`admin`, or the label password

**About the screens** — we have never seen this hardware
- Was **MQTT configurable from the web pages**, or only from CConfig?
- The **exact column names** on the Broker table, and whether there was a
  **Port** field
- Were there any **QoS**, **retain** or **Last Will** fields anywhere?
- Did the Input Configuration table have an **Export Table / Import Table**
  (CSV) button?
- **Node Update** — what units did it show, and what did it accept?

**About TLS**
- Did the **CA certificate alone** work, or were the client certificate and key
  required?
- What **file formats** did it accept or reject?

**The evidence**
- Those copied **Monitor MQTT Comms** lines — topic and payload
- Anything on this card that could not be done as written, and what you did
  instead

---

## If it does not work

| What you see | Try this |
|---|---|
| Cannot reach `192.168.111.1` | The USB driver is not installed, or the unit has not finished booting. Check Device Manager for the RNDIS adapter, and wait for PWR solid green. |
| No MQTT section anywhere | Firmware is below V2.33. Check the home page. |
| MQTT is on but nothing publishes | **Sensitivity and Update Time are both zero** on the input row — that row will never send. Set Update Time to 60. |
| Broker will not connect | Check the clock first (section 2) — an out-of-date clock fails TLS in a way that looks like a bad password. Then username, password and port. |
| Broker refuses the connection right after you fix something else | Duplicate **Client ID**. It must be unique. |
| It connects, Tx counts climb, nothing arrives at the far end | Check **Enable Sparkplug is off**, then read the full topic back and compare it character by character with 3.4. A wrong topic looks exactly like this. |
| Publishes fine but the far end says the address is wrong | The **Payload Prefix** is the address (`9003`), not the register. Check you have not swapped the two columns. |

---

*Background, if you want it: [`docs/elpro115e_mqtt.md`](elpro115e_mqtt.md) is the
full provisioning guide, and it explains why each of these settings is what it
is. You should not need it to finish this card.*
