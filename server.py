#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 BOBI SAS, France
# Auteur : Cyril Mazouer, pour le compte de BOBI SAS
# Distribué sous licence GNU GPL v3 (ou ultérieure) ; voir le fichier LICENSE.

"""
Service embarqué de l'outil « NAT multicast » (runtime=docker), sur :8080. L'orchestrateur
proxifie /api/tools/mcast_nat/<path> → /<path>.

Surveille le NAT multicast des Cisco Nexus (Multicast Service Reflection, NX-OS 10.x) :
quelles traductions sont configurées, lesquelles vivent, lesquelles ont perdu leur entrée ou
leur sortie, et — en 2022-7 — si les DEUX jambes d'une paire de switchs tiennent.

STRICTEMENT EN LECTURE : uniquement des `show`. Aucune écriture de config, jamais.

Ce que le switch sait dire, et ce qu'il ne sait pas :
  - la VIVACITÉ de chaque (S,G) (`show ip mroute summary`) — avec NBM, rien de plus ;
  - la topologie NBM (interface source, voisin, nombre de récepteurs) ;
  - la traduction RÉELLEMENT programmée en matériel (`show forwarding multicast route`) ;
  - le débit RÉEL par interface — donc le cumul traduit, sur les ports de bouclage.
  Pas de débit PAR FLUX : les politiques NBM sont en `no policer`, et `show nbm flows
  statistics` reste vide. L'écran le dit au lieu d'inventer un chiffre.

Inventaire : lu en lecture seule dans le volume de « Pilotage de switch » (/inventory).
"Captures" : sorties CLI collées à la main, analysées comme un switch (sans alerte).
"""

import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import nat_model as M
import nat_pair as NP
import nat_parse as P

try:
    import requests
    from requests.auth import HTTPBasicAuth
    import urllib3
    urllib3.disable_warnings()
except ImportError:
    requests = None

INV_DIR = os.environ.get("INVENTORY_DIR", "/inventory")
INV_SWITCHES = os.path.join(INV_DIR, "switches.json")
DATA_DIR = os.environ.get("DATA_DIR", "/data")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
EVENTS_FILE = os.path.join(DATA_DIR, "events.json")
STATES_FILE = os.path.join(DATA_DIR, "alert_states.json")
ALERTS_FILE = os.path.join(DATA_DIR, "alerts.json")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
CAPTURES_DIR = os.path.join(DATA_DIR, "captures")

MAX_EVENTS = 2000
MAX_POINTS = 720
MAIL_TOKEN = os.environ.get("MAIL_TOKEN") or ""
APP_URL = (os.environ.get("BT_APP_URL") or "http://host.docker.internal:5000").rstrip("/")

DEFAULT_CONFIG = {
    # La vivacité NX-OS est un échantillon : un flux sain peut afficher 0 sur un relevé.
    # On ne change d'état qu'après `grace_polls` relevés concordants.
    "poll_seconds": 30, "grace_polls": 2,
    # Config du NAT et noms d'interfaces : ils bougent rarement, inutile de les relire à
    # chaque passe.
    "static_minutes": 10,
    # La table matérielle complète est volumineuse : vérifiée moins souvent.
    "hw_minutes": 5,
    # Au-delà de ce nombre de traductions touchées dans une même passe, UN événement
    # récapitulatif plutôt qu'une rafale (une cause = une alerte).
    "burst": 3,
    # 2022-7 : écart toléré entre les débits des deux jambes d'un même lien, et plancher
    # sous lequel on ne juge pas (au repos, le moindre écart fait un pourcentage énorme).
    "asym_pct": 1.0, "asym_floor_mbps": 100,
    "disabled": [],            # switchs à ne pas interroger
    "pairs": [],               # 2022-7 : [{id, label, a, b, key}]
}

_lock = threading.Lock()
_poll_now = threading.Event()
ETAT = {}        # sid → {model, at, error, has_nat, cache…}
HIST = {}        # sid → {"counts": [...], "links": {if: [...]}}


# ── Fichiers ──
def _read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def _load_config():
    c = dict(DEFAULT_CONFIG)
    c.update(_read_json(CONFIG_FILE, {}) or {})
    return c


def _save_config(patch):
    c = _load_config()
    for k in DEFAULT_CONFIG:
        if k in patch:
            c[k] = patch[k]
    for k in ("poll_seconds", "grace_polls", "static_minutes", "hw_minutes", "burst"):
        try:
            c[k] = max(1, int(c[k]))
        except (TypeError, ValueError):
            c[k] = DEFAULT_CONFIG[k]
    c["poll_seconds"] = max(15, c["poll_seconds"])
    try:
        c["asym_pct"] = min(50.0, max(0.1, float(c["asym_pct"])))
    except (TypeError, ValueError):
        c["asym_pct"] = DEFAULT_CONFIG["asym_pct"]
    try:
        c["asym_floor_mbps"] = max(0, int(c["asym_floor_mbps"]))
    except (TypeError, ValueError):
        c["asym_floor_mbps"] = DEFAULT_CONFIG["asym_floor_mbps"]
    paires = []
    for p in c.get("pairs") or []:
        if isinstance(p, dict) and p.get("a") and p.get("b") and p["a"] != p["b"]:
            paires.append({"id": p.get("id") or uuid.uuid4().hex[:8], "label": str(p.get("label") or ""),
                           "a": str(p["a"]), "b": str(p["b"]),
                           "key": p.get("key") if p.get("key") in ("auto", "in", "out", "suffix", "rank") else "auto"})
    c["pairs"] = paires
    c["disabled"] = [str(x) for x in (c.get("disabled") or [])]
    _write_json(CONFIG_FILE, c)
    return c


# ── Inventaire (lecture seule) et captures ──
def _load_switches():
    d = _read_json(INV_SWITCHES, [])
    if isinstance(d, dict):
        d = d.get("switches") or list(d.values())
    return [s for s in (d or []) if isinstance(s, dict) and s.get("transport") == "nxapi"]


def _captures_disque():
    res = []
    try:
        noms = sorted(os.listdir(CAPTURES_DIR))
    except OSError:
        return res
    for n in noms:
        if n.endswith(".json"):
            c = _read_json(os.path.join(CAPTURES_DIR, n), None)
            if c:
                res.append(c)
    return res


# ── NX-API (lecture seule) ──
class DriverError(Exception):
    pass


class Nxapi:
    def __init__(self, sw):
        if requests is None:
            raise DriverError("module 'requests' absent de l'image")
        scheme = sw.get("scheme") or "https"
        port = sw.get("port") or (443 if scheme == "https" else 80)
        self.url = f"{scheme}://{sw['host']}:{port}/ins"
        self.auth = HTTPBasicAuth(sw.get("username", ""), sw.get("password", ""))
        self.verify = bool(sw.get("verify_tls", False))

    def _post(self, commands, method, timeout=30):
        payload = [{"jsonrpc": "2.0", "method": method, "params": {"cmd": c, "version": 1},
                    "id": i + 1} for i, c in enumerate(commands)]
        try:
            r = requests.post(self.url, json=payload, auth=self.auth, verify=self.verify,
                              headers={"Content-Type": "application/json-rpc"}, timeout=timeout)
        except requests.RequestException as e:
            raise DriverError(f"NX-API injoignable : {e}")
        if r.status_code == 401:
            raise DriverError("authentification refusée")
        if r.status_code >= 400 and r.status_code != 500:
            raise DriverError(f"NX-API a répondu HTTP {r.status_code}")
        try:
            out = r.json()
        except ValueError:
            raise DriverError(f"NX-API : réponse illisible (HTTP {r.status_code})")
        return out if isinstance(out, list) else [out]

    def texte(self, commande, timeout=30):
        res = self._post([commande], "cli_ascii", timeout)[0]
        if "error" in res:
            raise DriverError((res["error"].get("data") or {}).get("msg")
                              or res["error"].get("message") or "erreur NX-API")
        return (res.get("result") or {}).get("msg", "") or ""

    def debits(self, interfaces):
        """Débit RÉEL (30 s) des interfaces données, depuis le JSON structuré."""
        if not interfaces:
            return {}
        res = {}
        for nom, r in zip(interfaces, self._post([f"show interface {i}" for i in interfaces], "cli")):
            body = (r.get("result") or {}).get("body") or {}
            row = ((body.get("TABLE_interface") or {}).get("ROW_interface"))
            row = row[0] if isinstance(row, list) else row
            if row:
                res[nom] = {"rx_bps": int(row.get("eth_inrate1_bits") or 0),
                            "tx_bps": int(row.get("eth_outrate1_bits") or 0)}
        return res


# ── Relevé d'un switch ──
def _relever(sw, cfg):
    sid = sw["id"]
    with _lock:
        e = ETAT.setdefault(sid, {"cache": {}})
    cache = e["cache"]
    now = time.time()
    d = Nxapi(sw)
    if now - cache.get("static_at", 0) > cfg["static_minutes"] * 60 or "reflect" not in cache:
        try:
            txt = d.texte("show running-config | include service-reflect")
        except DriverError:
            # Filtre refusé : on filtre nous-mêmes, et rien d'autre que les lignes
            # service-reflect ne survit à filtrer_config.
            txt = P.filtrer_config(d.texte("show running-config", timeout=60))
        try:
            txt += "\nhostname " + d.texte("show hostname").strip()
        except DriverError:
            pass
        cache["reflect"] = P.parse_reflect(txt)
        if cache["reflect"]["rules"]:
            ifs = d.texte("show interface description") + "\n" + d.texte("show ip interface brief")
            cache["interfaces"] = P.parse_interfaces(ifs)
            # Gardé pour le diagnostic à distance (GET /diag/<id>) : descriptions et adresses,
            # rien de secret. Sert quand un nom de voisin manque à l'écran.
            cache["raw_ifs"] = ifs[:20000]
        else:
            cache["interfaces"] = {}
        cache["static_at"] = now
    reflect = cache["reflect"]
    if not reflect["rules"]:
        return {"has_nat": False, "model": None}
    summary, _ = P.parse_mroute_summary(d.texte("show ip mroute summary", timeout=60))
    try:
        nbm = P.parse_nbm_flows(d.texte("show nbm flows", timeout=60))
    except DriverError:
        nbm = {}                              # NBM absent : on vit sans topologie NBM
    if now - cache.get("hw_at", 0) > cfg["hw_minutes"] * 60 or "fwd" not in cache:
        try:
            cache["fwd"] = P.parse_forwarding(d.texte("show forwarding multicast route", timeout=90))
        except DriverError:
            cache["fwd"] = None
        cache["hw_at"] = now
    modele = M.construire(reflect, cache["interfaces"], summary, nbm, cache.get("fwd"), {})
    try:
        rates = d.debits(M.interfaces_a_mesurer(reflect, modele["translations"]))
    except DriverError:
        rates = {}
    modele["links"] = M.liens(reflect, cache["interfaces"], rates, modele["translations"])
    modele["hw_at"] = cache.get("hw_at")
    return {"has_nat": True, "model": modele}


def _modele_capture(c):
    t = c.get("texts") or {}
    reflect = P.parse_reflect(t.get("config", ""))
    ifs = P.parse_interfaces((t.get("config", "") or "") + "\n" + (t.get("interfaces", "") or ""))
    summary, _ = P.parse_mroute_summary(t.get("summary", ""))
    nbm = P.parse_nbm_flows(t.get("nbm", ""))
    fwd = P.parse_forwarding(t["fwd"]) if (t.get("fwd") or "").strip() else None
    rates = P.parse_rates_text(t.get("rates", ""))
    m = M.construire(reflect, ifs, summary, nbm, fwd, rates)
    m["partial_hw"] = bool(fwd) and len(fwd) < 50   # une route collée ne prouve rien du reste
    return m


# ── Journal, alertes, e-mail ──
_KIND = {"nat_ko": "NAT en échec", "lost": "Entrée perdue", "multi": "Deux émetteurs simultanés",
         "hw_missing": "Traduction absente du matériel", "clear": "Rétabli",
         "unreachable": "Switch injoignable", "reachable": "Switch de nouveau joignable",
         "leg_down": "2022-7 : une seule jambe", "pair_none": "2022-7 : les deux jambes en défaut",
         "pair_ok": "2022-7 : les deux jambes rétablies",
         "asym": "2022-7 : débits asymétriques", "sym": "2022-7 : débits de nouveau symétriques"}
_SEV = {"nat_ko": "critical", "lost": "critical", "multi": "warning", "hw_missing": "warning",
        "clear": "good", "unreachable": "critical", "reachable": "good", "leg_down": "warning",
        "pair_none": "critical", "pair_ok": "good", "asym": "warning", "sym": "good"}


def _load_alerts():
    d = _read_json(ALERTS_FILE, {}) or {}
    return {"mail_enabled": bool(d.get("mail_enabled")), "mail_to": str(d.get("mail_to") or ""),
            "mail_ready": bool(MAIL_TOKEN)}


def _mail(subject, body, to):
    if not (MAIL_TOKEN and requests):
        return
    payload = {"subject": subject, "body": body}
    if to:
        payload["to"] = to
    try:
        requests.post(f"{APP_URL}/api/mail/send", json=payload,
                      headers={"X-BT-Mail-Token": MAIL_TOKEN}, timeout=8)
    except Exception:
        pass


def _event(kind, subject, detail, sid=None, keys=None):
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "kind": kind, "severity": _SEV.get(kind, "info"),
           "label": _KIND.get(kind, kind), "subject": subject, "detail": detail,
           "source": sid, "keys": keys or []}
    with _lock:
        ev = _read_json(EVENTS_FILE, []) or []
        ev.append(rec)
        _write_json(EVENTS_FILE, ev[-MAX_EVENTS:])
    a = _load_alerts()
    if a["mail_enabled"]:
        threading.Thread(target=_mail, args=(f"[NAT multicast] {rec['label']} — {subject}", detail,
                                             a["mail_to"]), daemon=True).start()


BAD = {"nat_ko", "lost", "multi", "hw_missing"}


def _transitions(states, prefix, courants, grace):
    """Hystérésis commune : `courants` = {clé: état}. Rend [(clé, ancien, nouveau)] des
    changements CONFIRMÉS (même état vu `grace` fois de suite)."""
    out = []
    for k, cur in courants.items():
        sk = prefix + k
        st = states.get(sk)
        if st is None:
            states[sk] = {"state": cur, "since": time.time(), "pending": None, "n": 0}
            if cur in BAD or cur in ("single", "none", "asym"):
                out.append((k, None, cur))
            continue
        if cur == st["state"]:
            st["pending"], st["n"] = None, 0
            continue
        if st["pending"] == cur:
            st["n"] += 1
        else:
            st["pending"], st["n"] = cur, 1
        if st["n"] >= grace:
            out.append((k, st["state"], cur))
            st.update({"state": cur, "since": time.time(), "pending": None, "n": 0})
    return out


def _emettre(groupes, nom, sid, burst):
    """Une alerte par (sorte) et par passe ; détaillée si peu nombreuse, récapitulée sinon."""
    for kind, lignes in groupes.items():
        if not lignes:
            continue
        cles = [k for k, _ in lignes]
        if len(lignes) <= burst:
            for k, txt in lignes:
                _event(kind, f"{nom} · {k}", txt, sid, [k])
        else:
            _event(kind, f"{nom} · {len(lignes)} traductions",
                   "\n".join(txt for _, txt in lignes[:40]) +
                   ("\n…" if len(lignes) > 40 else ""), sid, cles)


def _alerter_switch(states, sid, nom, modele, cfg):
    courants = {t["key"]: t["state"] for t in modele["translations"]}
    idx = {t["key"]: t for t in modele["translations"]}
    groupes = {}
    for k, old, new in _transitions(states, f"{sid}|", courants, cfg["grace_polls"]):
        t = idx[k]
        if new in BAD:
            sortie = ", ".join(o["group"] for o in t["outputs"])
            groupes.setdefault(new, []).append(
                (k, f"{k} → {sortie} : {'; '.join(t['issues']) or t['label']}"))
        elif old in BAD:
            groupes.setdefault("clear", []).append((k, f"{k} : {M.LIBELLE.get(old, old)} → {t['label']}"))
    _emettre(groupes, nom, sid, cfg["burst"])


def _alerter_paires(states, cfg, noms):
    for p in cfg.get("pairs") or []:
        ma, mb = (ETAT.get(p["a"]) or {}).get("model"), (ETAT.get(p["b"]) or {}).get("model")
        if not (ma and mb) or (ETAT[p["a"]].get("error") or ETAT[p["b"]].get("error")):
            continue          # une jambe illisible n'est pas une jambe morte : on attend
        ap = M.apparier(ma, mb, p.get("key") or "auto")
        courants = {f"{x['a']}~{x['b']}": x["state"] for x in ap["pairs"]}
        groupes = {}
        label = p.get("label") or f"{noms.get(p['a'], p['a'])} / {noms.get(p['b'], p['b'])}"
        for k, old, new in _transitions(states, f"pair:{p['id']}|", courants, cfg["grace_polls"]):
            a, b = k.split("~")
            if new == "single":
                groupes.setdefault("leg_down", []).append((k, f"{a} / {b} : une seule jambe vivante"))
            elif new == "none":
                groupes.setdefault("pair_none", []).append((k, f"{a} / {b} : aucune jambe saine"))
            elif old in ("single", "none") and new in ("both", "idle"):
                groupes.setdefault("pair_ok", []).append((k, f"{a} / {b} : rétabli"))
        _emettre(groupes, label, None, cfg["burst"])

        # Débits des deux jambes, lien par lien : historique (courbe d'écart) et alerte.
        an = NP.analyser(ma, mb, ap, cfg)
        h = HIST.setdefault(f"pair:{p['id']}", {"counts": [], "links": {}})
        t = int(time.time())
        for l in an["links"]:
            if l["a_bps"] is not None and l["b_bps"] is not None:
                s_ = h["links"].setdefault(l["key"], [])
                s_.append([t, l["a_bps"], l["b_bps"]])
                del s_[:-MAX_POINTS]
        idx = {l["key"]: l for l in an["links"]}
        courants = {l["key"]: ("asym" if l["state"] == "asym" else "sym")
                    for l in an["links"] if l["state"] in ("sym", "asym")}
        groupes = {}
        for k, old, new in _transitions(states, f"pairlink:{p['id']}|", courants, cfg["grace_polls"]):
            l = idx[k]
            sens = "sortant" if l["dir"] == "tx" else "entrant"
            nom = f"{l['a_name'] or l['a_if_short']} / {l['b_name'] or l['b_if_short']} ({sens})"
            if new == "asym":
                cause = (f" — cause probable : {len(l['causes'])} flux sur une seule jambe ("
                         + ", ".join(f"{c['a']}/{c['b']}" for c in l["causes"][:10]) + ")") if l["causes"] else ""
                groupes.setdefault("asym", []).append((k, (
                    f"{nom} : A {l['a_bps'] / 1e9:.2f} · B {l['b_bps'] / 1e9:.2f} Gb/s, écart "
                    f"{l['ecart_pct']:+.1f} %{cause}").replace(".", ",")))
            elif old == "asym":
                groupes.setdefault("sym", []).append((k, f"{nom} : écart revenu sous le seuil"))
        _emettre(groupes, label, None, cfg["burst"])


# ── Historique (courbes) ──
def _histo(sid, modele):
    h = HIST.setdefault(sid, {"counts": [], "links": {}})
    t = int(time.time())
    c = modele["counts"]
    h["counts"].append([t, c["ok"], c["nat_ko"] + c["lost"] + c["multi"] + c["hw_missing"],
                        c["outputs_live"]])
    del h["counts"][:-MAX_POINTS]
    for l in modele["links"]:
        if l["rx_bps"] is None and l["tx_bps"] is None:
            continue
        s = h["links"].setdefault(l["interface"], [])
        s.append([t, l["rx_bps"], l["tx_bps"]])
        del s[:-MAX_POINTS]


# ── Boucle ──
def _relever_tous(switches, cfg):
    """Relevés EN PARALLÈLE : un switch qui ne répond pas ne doit pas retarder les autres."""
    from concurrent.futures import ThreadPoolExecutor
    now = time.time()
    a_lire = []
    for sw in switches:
        e = ETAT.setdefault(sw["id"], {"cache": {}})
        if sw["id"] in cfg["disabled"]:
            continue
        # Switch sans NAT connu et en échec : inutile d'insister à chaque passe.
        if e.get("has_nat") is not True and e.get("error") and \
                now - e.get("tried", 0) < cfg["static_minutes"] * 60:
            continue
        e["tried"] = now
        a_lire.append(sw)

    def un(sw):
        try:
            return sw, _relever(sw, cfg), None
        except Exception as ex:
            return sw, None, ex

    if not a_lire:
        return []
    with ThreadPoolExecutor(max_workers=min(8, len(a_lire))) as pool:
        return list(pool.map(un, a_lire))


def _passe():
    cfg = _load_config()
    states = _read_json(STATES_FILE, {}) or {}
    switches = _load_switches()
    noms = {sw["id"]: sw.get("name") or sw["id"] for sw in switches}
    for sw, r, ex in _relever_tous(switches, cfg):
        sid = sw["id"]
        e = ETAT[sid]
        if ex is None:
            ancien = e.get("error")
            e.update({"has_nat": r["has_nat"], "model": r["model"], "at": time.time(), "error": None,
                      "fails": 0})
            if ancien and e.get("down_alerted"):
                _event("reachable", noms[sid], "relevé de nouveau possible", sid)
                e["down_alerted"] = False
            if r["model"]:
                _alerter_switch(states, sid, noms[sid], r["model"], cfg)
                _histo(sid, r["model"])
        else:
            e["error"] = str(ex)
            e["fails"] = e.get("fails", 0) + 1
            # On NE conclut RIEN sur ses traductions (lu ≠ absent) ; une seule alerte, pour
            # le switch, et seulement s'il portait du NAT.
            if e.get("has_nat") and e["fails"] >= cfg["grace_polls"] and not e.get("down_alerted"):
                _event("unreachable", noms[sid], str(ex), sid)
                e["down_alerted"] = True
    _alerter_paires(states, cfg, noms)
    _write_json(STATES_FILE, states)


def _boucle():
    dernier_histo = 0
    while True:
        try:
            _passe()
        except Exception as ex:
            print(f"mcast_nat: passe en échec : {ex}", flush=True)
        if time.time() - dernier_histo > 300:
            try:
                _write_json(HISTORY_FILE, HIST)
                dernier_histo = time.time()
            except OSError:
                pass
        try:
            periode = _load_config()["poll_seconds"]
        except Exception:
            periode = 30
        _poll_now.wait(periode)
        _poll_now.clear()


# ── Vues ──
def _sources():
    """Switchs NX-OS de l'inventaire + captures, avec leur dernier état."""
    cfg = _load_config()
    res = []
    for sw in _load_switches():
        e = ETAT.get(sw["id"]) or {}
        m = e.get("model")
        res.append({"id": sw["id"], "name": sw.get("name") or sw["id"], "host": sw.get("host"),
                    "kind": "switch", "disabled": sw["id"] in cfg["disabled"],
                    "has_nat": e.get("has_nat"), "error": e.get("error"), "at": e.get("at"),
                    "hostname": (m or {}).get("hostname"), "counts": (m or {}).get("counts"),
                    "links": (m or {}).get("links") or [], "families": _fam_resume(m)})
    for c in _captures():
        m = c.get("_model")
        res.append({"id": c["id"], "name": c.get("name") or c["id"], "host": None, "kind": "capture",
                    "has_nat": bool(m and m["counts"]["total"]), "error": None, "at": c.get("created"),
                    "hostname": (m or {}).get("hostname"), "counts": (m or {}).get("counts"),
                    "links": (m or {}).get("links") or [], "families": _fam_resume(m)})
    return res


def _fam_resume(m):
    if not m:
        return []
    return [{k: f[k] for k in ("key", "dir", "mode", "if_short", "name", "counts")}
            for f in m["families"]]


def _modele(sid):
    e = ETAT.get(sid)
    if e and e.get("model"):
        return e["model"], e
    for c in _captures():
        if c["id"] == sid:
            return c.get("_model"), {"at": c.get("created"), "kind": "capture"}
    return None, e


def _depuis(sid):
    states = _read_json(STATES_FILE, {}) or {}
    pre = f"{sid}|"
    return {k[len(pre):]: v.get("since") for k, v in states.items() if k.startswith(pre)}


def _paire(p):
    ma, ea = _modele(p["a"])
    mb, eb = _modele(p["b"])
    if not (ma and mb):
        return {"pair": p, "ready": False}
    ap = M.apparier(ma, mb, p.get("key") or "auto")
    ia = {t["key"]: t for t in ma["translations"]}
    ib = {t["key"]: t for t in mb["translations"]}
    for x in ap["pairs"]:
        ta, tb = ia[x["a"]], ib[x["b"]]
        x["a_out"] = [o["group"] for o in ta["outputs"]]
        x["b_out"] = [o["group"] for o in tb["outputs"]]
        x["a_src"] = ta["active"]
        x["b_src"] = tb["active"]
        x["a_name"] = next((c["name"] for c in ta["candidates"] if c["state"] == "live"), None)
        x["b_name"] = next((c["name"] for c in tb["candidates"] if c["state"] == "live"), None)
    ea_err, eb_err = (ea or {}).get("error"), (eb or {}).get("error")
    ap.update({"pair": p, "ready": True, "a_error": ea_err, "b_error": eb_err})
    ap.update(NP.analyser(ma, mb, ap, _load_config(), ea_err, eb_err))

    def jambe(m, e, sid):
        emis = {c["name"] or c["source"] for t in m["translations"] if t["dir"] == "egress"
                for c in t["candidates"]}
        actifs = {c["name"] or c["source"] for t in m["translations"] if t["dir"] == "egress"
                  for c in t["candidates"] if c["state"] == "live"}
        nom = next((s["name"] for s in _sources() if s["id"] == sid), sid)
        return {"id": sid, "name": nom, "hostname": m.get("hostname"), "counts": m["counts"],
                "emitters": len(emis), "emitters_live": len(actifs), "at": (e or {}).get("at")}
    ap["legs"] = {"a": jambe(ma, ea, p["a"]), "b": jambe(mb, eb, p["b"])}
    return ap


def _suggestions(cfg):
    """Paires 2022-7 plausibles : deux sources dont les traductions s'apparient à plus de
    moitié. Proposées, jamais appliquées d'office."""
    deja = {frozenset((p["a"], p["b"])) for p in cfg.get("pairs") or []}
    avec = [(s["id"], _modele(s["id"])[0]) for s in _sources() if s.get("counts")]
    res = []
    for i, (a, ma) in enumerate(avec):
        for b, mb in avec[i + 1:]:
            if frozenset((a, b)) in deja or not ma or not mb:
                continue
            ap = M.apparier(ma, mb)
            n = min(len(ma["translations"]), len(mb["translations"])) or 1
            if len(ap["pairs"]) / n >= 0.5:
                res.append({"a": a, "b": b, "matched": len(ap["pairs"]), "key": ap["key_used"]})
    return res


# ── HTTP ──
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return {}

    def _route(self, method):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        q = parse_qs(u.query)
        try:
            if method == "GET":
                return self._get(parts, q)
            if method == "PUT" and parts == ["config"]:
                return self._send(200, _save_config(self._body()))
            if method == "PUT" and parts == ["alerts"]:
                b = self._body()
                _write_json(ALERTS_FILE, {"mail_enabled": bool(b.get("mail_enabled")),
                                          "mail_to": str(b.get("mail_to") or "")})
                return self._send(200, _load_alerts())
            if method == "POST" and parts == ["poll"]:
                _poll_now.set()
                return self._send(202, {"ok": True})
            if method == "POST" and parts == ["captures"]:
                return self._capture(self._body())
            if method == "DELETE" and len(parts) == 2 and parts[0] == "captures":
                p = os.path.join(CAPTURES_DIR, os.path.basename(parts[1]) + ".json")
                if not os.path.exists(p):
                    return self._send(404, {"error": "capture inconnue"})
                os.remove(p)
                _invalider_captures()
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "route inconnue"})
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def _get(self, parts, q):
        if parts == ["health"]:
            return self._send(200, {"ok": True})
        if parts == ["overview"]:
            cfg = _load_config()
            return self._send(200, {"sources": _sources(), "pairs": [
                {k: v for k, v in _paire(p).items() if k != "pairs"} for p in cfg["pairs"]],
                "suggestions": _suggestions(cfg), "config": cfg, "now": time.time()})
        if len(parts) == 2 and parts[0] == "source":
            m, e = _modele(parts[1])
            if not m:
                return self._send(404, {"error": (e or {}).get("error") or "aucun relevé pour cette source"})
            return self._send(200, {"model": m, "at": (e or {}).get("at"), "error": (e or {}).get("error"),
                                    "since": _depuis(parts[1]), "now": time.time()})
        if len(parts) == 2 and parts[0] == "pair":
            p = next((x for x in _load_config()["pairs"] if x["id"] == parts[1]), None)
            if not p:
                return self._send(404, {"error": "paire inconnue"})
            return self._send(200, _paire(p))
        if len(parts) == 2 and parts[0] == "diag":
            e = ETAT.get(parts[1]) or {}
            c = e.get("cache") or {}
            return self._send(200, {"interfaces_raw": c.get("raw_ifs"),
                                    "interfaces_parsed": c.get("interfaces"),
                                    "rules": len((c.get("reflect") or {}).get("rules") or []),
                                    "error": e.get("error")})
        if parts == ["history"]:
            sid = (q.get("sid") or [""])[0]
            return self._send(200, HIST.get(sid) or {"counts": [], "links": {}})
        if parts == ["events"]:
            ev = _read_json(EVENTS_FILE, []) or []
            return self._send(200, {"events": list(reversed(ev))[:300]})
        if parts == ["config"]:
            return self._send(200, _load_config())
        if parts == ["alerts"]:
            return self._send(200, _load_alerts())
        if parts == ["captures"]:
            return self._send(200, {"captures": [{k: v for k, v in c.items() if k not in ("texts", "_model")}
                                                 for c in _captures()]})
        return self._send(404, {"error": "route inconnue"})

    def _capture(self, b):
        texts = {k: str(b.get(k) or "") for k in ("config", "interfaces", "summary", "nbm", "fwd", "rates")}
        # La config collée peut contenir TOUS les secrets du switch : on n'en garde que
        # ce qui sert au NAT, avant d'écrire quoi que ce soit sur disque.
        texts["config"] = P.assainir_config(texts["config"])
        texts["interfaces"] = P.assainir_config(texts["interfaces"]) if "\ninterface " in \
            ("\n" + texts["interfaces"]) else texts["interfaces"]
        if not P.parse_reflect(texts["config"])["rules"]:
            return self._send(400, {"error": "aucune règle `ip service-reflect destination` dans la "
                                             "config collée"})
        if not texts["summary"].strip():
            return self._send(400, {"error": "il faut au moins `show ip mroute summary` pour "
                                             "savoir ce qui vit"})
        c = {"id": "cap-" + uuid.uuid4().hex[:8], "name": str(b.get("name") or "Capture")[:80],
             "created": time.time(), "texts": texts}
        os.makedirs(CAPTURES_DIR, exist_ok=True)
        _write_json(os.path.join(CAPTURES_DIR, c["id"] + ".json"), c)
        _invalider_captures()
        return self._send(201, {"id": c["id"]})

    def do_GET(self):
        self._route("GET")

    def do_PUT(self):
        self._route("PUT")

    def do_POST(self):
        self._route("POST")

    def do_DELETE(self):
        self._route("DELETE")


# Les captures sont relues du disque, mais leur modèle se calcule une fois.
_CAP_CACHE = {}


def _invalider_captures():
    _CAP_CACHE.clear()


def _captures():
    res = []
    for c in _captures_disque():
        m = _CAP_CACHE.get(c["id"])
        if m is None:
            try:
                m = _modele_capture(c)
            except Exception as ex:
                print(f"mcast_nat: capture {c['id']} illisible : {ex}", flush=True)
                m = None
            _CAP_CACHE[c["id"]] = m
        c["_model"] = m
        res.append(c)
    return res


if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(CAPTURES_DIR, exist_ok=True)
    HIST.update(_read_json(HISTORY_FILE, {}) or {})
    threading.Thread(target=_boucle, daemon=True).start()
    print(f"mcast_nat: prêt sur :8080 (inventaire={INV_SWITCHES}, data={DATA_DIR})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT") or 8080)), Handler).serve_forever()
