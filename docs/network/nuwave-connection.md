# Connecting a TurtleBot 4 (Raspberry Pi) to NUwave

How we got the TurtleBot 4's Raspberry Pi onto Northeastern's **NUwave** (WPA2-Enterprise, PEAP/MSCHAPv2) network — including the non-obvious blocker that cost us the most time.

> **Scope:** this connects the **Raspberry Pi** only. The Create 3 base cannot and does not need to join NUwave (see [network overview](README.md)).

> ⚠️ **Credentials:** never commit real NUwave credentials to this repo. Placeholders below: `<nuwave-username>` (e.g. `pandya.kal`) and `<nuwave-password>`.

---

## TL;DR
1. The real blocker was **not** credentials — the Pi's WiFi **regulatory domain was unset (`00`)**, which **disables the 5 GHz band**. NUwave here is on 5 GHz, so the robot literally couldn't *see* the network. Your phone could, the robot couldn't.
2. Fix: set the WiFi country to **US** → 5 GHz enabled → NUwave becomes visible.
3. Then add a NUwave NetworkManager profile (PEAP/MSCHAPv2) and connect.
4. Keep `ASUS_98` as an automatic fallback so a failed attempt can't strand the robot.

---

## Background: the symptom
- The robot could only ever see `ASUS_98` (the local 2.4 GHz lab router) in its WiFi scan.
- NUwave, eduroam, and **every** other AP were invisible to the robot — even after forced rescans.
- A phone standing next to the robot saw NUwave fine.

## Root cause: 5 GHz disabled by an unset regulatory domain
On a Raspberry Pi, if the WiFi **country code is not set**, the kernel uses the world regulatory domain (`00`), which **disables 5 GHz channels**. The robot was therefore effectively a 2.4 GHz-only radio. Diagnostic that confirmed it:

```bash
cat /sys/module/cfg80211/parameters/ieee80211_regdom   # printed: 00
nmcli -t -f FREQ device wifi list                       # only 2437 MHz (2.4 GHz) ever appeared
```
A dual-band-capable Pi 4 seeing **zero** 5 GHz APs in a building full of them is the tell.

## Fix step 1 — enable 5 GHz (set country = US)
```bash
# Make it permanent (survives reboots)
echo "options cfg80211 ieee80211_regdom=US" | sudo tee /etc/modprobe.d/cfg80211.conf

# Apply now without rebooting (installs iw if missing)
command -v iw >/dev/null || sudo apt-get install -y iw
sudo iw reg set US
sleep 3
cat /sys/module/cfg80211/parameters/ieee80211_regdom    # must now print: US
```
If `apt-get` has no internet, instead `sudo reboot` — the modprobe file applies the country on boot, and the Pi auto-reconnects to `ASUS_98`.

**Verify NUwave is now visible to the robot** (must succeed before continuing):
```bash
nmcli device wifi rescan; sleep 6
nmcli -f SSID,FREQ,SIGNAL,SECURITY device wifi list | grep -i nuwave
```

## Fix step 2 — create the NUwave profile (autoconnect OFF for safe testing)
```bash
sudo nmcli connection add type wifi con-name NUwave ifname wlan0 ssid NUwave -- \
  wifi-sec.key-mgmt wpa-eap \
  802-1x.eap peap \
  802-1x.phase2-auth mschapv2 \
  802-1x.identity "<nuwave-username>" \
  802-1x.password "<nuwave-password>" \
  802-1x.domain-suffix-match "wireless.northeastern.edu" \
  802-1x.ca-cert /etc/ssl/certs/ca-certificates.crt \
  connection.autoconnect no
```
Notes:
- **Domain:** NUwave's server certificate is validated against `wireless.northeastern.edu` (`domain-suffix-match`) using the system CA bundle. This is the correct, secure setup.
- **If** authentication fails on a cert error only, relax validation as a test:
  `sudo nmcli connection modify NUwave 802-1x.ca-cert "" 802-1x.domain-suffix-match ""` — try the secure version first.
- **Anonymous identity:** left blank, per NU's guidance.

## Fix step 3 — test, with a 2-minute auto-revert safety net
⚠️ `wlan0` has one radio, so the instant NUwave associates the Pi **leaves `ASUS_98` and your SSH session drops** — expected on success *and* failure. The safety job forces a return to `ASUS_98` after 120 s no matter what, so you can't be locked out.

```bash
# Arm the safety net first (survives your SSH session dying)
sudo bash -c 'nohup sh -c "sleep 120 && nmcli con up netplan-wlan0-ASUS_98" >/dev/null 2>&1 &'

# Bring up NUwave
sudo nmcli connection up NUwave
```
Then **watch the robot's display** for its IP:
- **New `10.x` IP that persists** → connected. Re-SSH to the new IP.
- **IP returns to the `ASUS_98` address after ~2 min** → NUwave failed or was unusable; you're safely back on `ASUS_98`.

## Fix step 4 — make it permanent (only after a successful test)
```bash
sudo nmcli connection modify NUwave connection.autoconnect yes connection.autoconnect-priority 10
```
`ASUS_98` (priority 0) remains the automatic fallback if NUwave ever drops.

---

## Safety model (why this can't brick the robot's networking)
- `ASUS_98` is a saved, auto-connecting profile and is the **only** auto-connecting WiFi → every boot and every failure returns there.
- The NUwave profile is created **autoconnect off** and tested manually first.
- The timed auto-revert guarantees recovery even if you lose the SSH session.

## If you get locked out
A bad WiFi state can't be fixed over WiFi. Recovery requires physical access:
1. Plug a **monitor + USB keyboard** into the Pi (or an **Ethernet cable** into `eth0`).
2. Log in locally (`ubuntu` / robot password).
3. `sudo nmcli connection up netplan-wlan0-ASUS_98`

---

## Result (June 2026)
- `turtlebot468` Pi connected to NUwave at `10.247.204.21/19`.
- Robot's own ROS 2 stack fully healthy on NUwave (12 nodes, all topics).
- **Controlling the robot from a laptop over NUwave also works** — once the laptop is configured as a FastDDS super-client via env vars. See [ROS 2 over NUwave](ros2-over-nuwave.md) for the working recipe and the discovery-server gotchas we hit.
