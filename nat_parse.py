# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 BOBI SAS, France
# Auteur : Cyril Mazouer, pour le compte de BOBI SAS
# Distribué sous licence GNU GPL v3 (ou ultérieure) ; voir le fichier LICENSE.

"""
Lecture des sorties texte NX-OS utiles au NAT multicast (Multicast Service Reflection).

Tout part du TEXTE tel que la CLI l'affiche : c'est ce que rend la NX-API en `cli_ascii`, et
c'est aussi ce qu'un technicien colle à la main dans une « capture ». Un seul jeu de parseurs
pour les deux voies : une capture analysée ici se lit exactement comme un switch interrogé.

Aucune fonction ne garde de secret : la config n'est jamais lue en entier (on demande
`| include service-reflect`), et le repli sur la config complète ne retient que les lignes utiles.
"""

import ipaddress
import re

# ── Noms d'interface : la CLI abrège (Eth1/16, Lo1), la config écrit en long ──
_LONG = {"eth": "Ethernet", "ethernet": "Ethernet", "lo": "loopback", "loopback": "loopback",
         "po": "port-channel", "port-channel": "port-channel", "vlan": "Vlan", "mgmt": "mgmt",
         "tunnel": "Tunnel", "nve": "nve"}


def canon(nom):
    """Eth1/16 → Ethernet1/16, Lo1 → loopback1. Inchangé si non reconnu."""
    m = re.match(r"^([A-Za-z-]+?)(\d.*)$", str(nom or "").strip())
    if not m:
        return str(nom or "").strip()
    base = _LONG.get(m.group(1).lower())
    return (base + m.group(2)) if base else str(nom).strip()


def court(nom):
    """Ethernet1/16 → Eth1/16 (affichage)."""
    n = canon(nom)
    for long_, c in (("Ethernet", "Eth"), ("loopback", "Lo"), ("port-channel", "Po")):
        if n.startswith(long_):
            return c + n[len(long_):]
    return n


def _ip(s):
    try:
        return str(ipaddress.ip_address(s))
    except ValueError:
        return None


# ── Configuration du NAT ──
_RE_RULE = re.compile(
    r"^\s*ip service-reflect destination (\S+) to (\S+) mask-len (\d+) "
    r"source (\S+) to (\S+) mask-len (\d+)(.*)$")
_RE_MODE = re.compile(r"^\s*ip service-reflect mode (egress|ingress) (\S+)")
_RE_SRCIF = re.compile(r"^\s*ip service-reflect source-interface (\S+)")
_RE_MAP = re.compile(r"^\s*multicast service-reflect interface (\S+) map interface (\S+)")


def parse_reflect(texte):
    """`show running-config | include service-reflect` → règles, modes, ports de bouclage.

    Une règle = (G, S) → (G', S'), avec réécriture UDP et OIF statique facultatives. NX-OS
    exige une règle PAR source candidate : huit serveurs pouvant émettre le même groupe font
    huit règles vers la même sortie — le regroupement par groupe d'entrée se fait plus loin."""
    out = {"rules": [], "modes": [], "maps": [], "source_if": None, "hostname": None,
           "ignored": []}
    for ligne in (texte or "").splitlines():
        if ligne.startswith("hostname "):
            out["hostname"] = ligne.split(None, 1)[1].strip()
            continue
        m = _RE_RULE.match(ligne)
        if m:
            g, g2, mg, s, s2, ms, reste = m.groups()
            r = {"in_group": g, "out_group": g2, "group_mask": int(mg),
                 "in_source": s, "out_source": s2, "source_mask": int(ms),
                 "udp_src": None, "udp_dst": None, "static_oif": None}
            t = reste.split()
            for i, mot in enumerate(t[:-1]):
                if mot == "to-udp-src-port":
                    r["udp_src"] = int(t[i + 1])
                elif mot == "to-udp-dest-port":
                    r["udp_dst"] = int(t[i + 1])
                elif mot == "static-oif":
                    r["static_oif"] = canon(t[i + 1])
            if r["group_mask"] != 32 or r["source_mask"] != 32:
                # Règle de PRÉFIXE : traduit un bloc entier. Rare en 2110 (on traduit flux par
                # flux) ; on la garde visible plutôt que d'en déduire de travers des /32.
                out["ignored"].append(ligne.strip())
                continue
            out["rules"].append(r)
            continue
        m = _RE_MODE.match(ligne)
        if m:
            out["modes"].append({"dir": m.group(1), "prefix": m.group(2)})
            continue
        m = _RE_SRCIF.match(ligne)
        if m:
            out["source_if"] = canon(m.group(1))
            continue
        m = _RE_MAP.match(ligne)
        if m:
            out["maps"].append({"port": canon(m.group(1)), "loop": canon(m.group(2))})
    return out


def filtrer_config(texte):
    """Repli quand `| include` est refusé : ne garder de la config complète que les lignes
    service-reflect et le hostname. Le reste (mots de passe, communautés, clés) est jeté
    AVANT d'être stocké où que ce soit."""
    keep = [l for l in (texte or "").splitlines()
            if "service-reflect" in l or l.startswith("hostname ")]
    return "\n".join(keep)


# ── Interfaces : noms (descriptions) et adresses ──
def parse_interfaces(texte):
    """Descriptions + adresses, depuis `show interface description`, `show ip interface
    brief` OU des blocs `interface …` de la config (capture). Rend {Ethernet1/16:
    {desc, addrs:[ip/len]}}."""
    res = {}

    def fiche(n):
        return res.setdefault(canon(n), {"desc": "", "addrs": []})

    cur = None
    for ligne in (texte or "").splitlines():
        # Les lignes de `show ip interface brief` finissent par des espaces : sans ce
        # rstrip, elles passaient pour une description VIDE qui écrasait la vraie.
        ligne = ligne.rstrip()
        if not ligne.strip() or ligne.startswith("---"):
            if not ligne.strip():
                cur = None
            continue
        m = re.match(r"^interface (\S+)\s*$", ligne)
        if m:
            cur = fiche(m.group(1))
            continue
        if cur is not None and ligne.startswith("  "):
            m = re.match(r"^\s+description (.+)$", ligne)
            if m:
                cur["desc"] = m.group(1).strip()
            m = re.match(r"^\s+ip address (\d+\.\d+\.\d+\.\d+)/(\d+)", ligne)
            if m:
                cur["addrs"].append(f"{m.group(1)}/{m.group(2)}")
            continue
        cur = None
        # show ip interface brief : « Eth1/16  192.168.72.61  protocol-up/link-up/admin-up »
        m = re.match(r"^((?:Eth|Lo|Po|Vlan)\S*)\s+(\d+\.\d+\.\d+\.\d+)\s+\S", ligne)
        if m:
            f = fiche(m.group(1))
            if not any(a.split("/")[0] == m.group(2) for a in f["addrs"]):
                # `brief` ne donne pas le masque : /30 est la règle des liens routés 2110,
                # et le voisin se déduit au même titre qu'en /31 (cf. voisin_de).
                f["addrs"].append(m.group(2) + ("/32" if m.group(1).startswith("Lo") else "/30"))
            continue
        # show interface description : « Eth1/16  eth  100G  SRV_HOME_APP_01 »
        m = re.match(r"^((?:Eth|Lo|Po|mgmt|Vlan)\S*)\s+(eth|loopback|--|\S+)\s+(\S+)\s+(.+?)\s*$", ligne)
        if m and not ligne.startswith(("Port ", "Interface ")):
            d = m.group(4).strip()
            fiche(m.group(1))["desc"] = "" if d == "--" else d
            continue
        m = re.match(r"^((?:Eth|Lo|Po|mgmt|Vlan)\S*)\s+(--|\S.*?)\s*$", ligne)
        if m and not re.match(r"^\S+\s+\d+\.\d+\.\d+\.\d+", ligne):
            d = m.group(2).strip()
            if d and d != "--":
                fiche(m.group(1))["desc"] = d
            continue
    return res


def interface_de(ip, interfaces):
    """L'interface dont le sous-réseau contient `ip` (un serveur sur un lien routé)."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return None
    meilleur = None
    for nom, f in interfaces.items():
        for addr in f.get("addrs") or []:
            try:
                net = ipaddress.ip_interface(addr).network
            except ValueError:
                continue
            if a in net and net.prefixlen < 32 and (meilleur is None or net.prefixlen > meilleur[1]):
                meilleur = (nom, net.prefixlen)
    return meilleur[0] if meilleur else None


# ── État multicast ──
_UNIT = {"bps": 1, "kbps": 1e3, "mbps": 1e6, "gbps": 1e9}
_RE_GRP = re.compile(r"^Group:\s+(\S+?)(?:/32)?,")
_RE_SRC = re.compile(r"^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s*([kmg]?bps)\s+(\d+)",
                     re.I)


def parse_mroute_summary(texte):
    """`show ip mroute summary` → {(source, groupe): {bps, packets, oifs}}.

    ATTENTION : avec NBM, NX-OS n'y met que la VIVACITÉ (« only liveness detected ») :
    ~27 b/s = flux présent, 0 = absent. Les paquets comptés sont ceux remontés au CPU, pas le
    trafic réel : `packets > 0` dit seulement que le flux a existé un jour."""
    res, g = {}, None
    stats = "only liveness" not in (texte or "")
    for ligne in (texte or "").splitlines():
        m = _RE_GRP.match(ligne)
        if m:
            g = m.group(1).split("/")[0]
            continue
        if g is None:
            continue
        m = _RE_SRC.match(ligne.strip())
        if m and _ip(m.group(1)):
            bps = float(m.group(6)) * _UNIT.get(m.group(7).lower(), 1)
            res[(m.group(1), g)] = {"bps": bps, "packets": int(m.group(2)),
                                    "oifs": int(m.group(8))}
    return res, stats


def parse_nbm_flows(texte):
    """`show nbm flows` → {(source, groupe): {src_if, nbr, rx, uptime, policy}}.
    Le débit affiché (Bw Mbps) est la RÉSERVATION de la politique, jamais une mesure."""
    res = {}
    for ligne in (texte or "").splitlines():
        t = ligne.split()
        if len(t) < 15 or not _ip(t[0]) or not _ip(t[1]):
            continue
        try:
            rx = int(t[-10])
        except ValueError:
            continue
        res[(t[1], t[0])] = {"uptime": t[2], "src_if": canon(t[3]) if t[3] != "Null" else None,
                             "nbr": " ".join(t[4:-10]).replace("not-available", "") or None,
                             "rx": rx, "policy": t[-1]}
    return res


_RE_FWD_RT = re.compile(r"^\s+\((\S+?)(?:/\d+)?, (\S+?)(?:/\d+)?\), RPF Interface: (\S+?),")
_RE_ENCAP = re.compile(r"Encap \d+\s+\((\S+), (\S+) -> (\S+), (\S+)\) L4\((\d+),(\d+)\)"
                       r"(?: SrcIf\((\S+)\))?")


def parse_forwarding(texte):
    """`show forwarding multicast route` → {(S, G): {rpf, oifs:[…], encaps:[…]}}.

    C'est la table MATÉRIELLE : une traduction n'y figure (ligne « Encap ») que si elle est
    réellement programmée. Chaque Encap est rattachée à l'OIF qui la précède."""
    res, cur, oif = {}, None, None
    for ligne in (texte or "").splitlines():
        m = _RE_FWD_RT.match(ligne)
        if m:
            s, g = m.group(1), m.group(2)
            cur = None
            if _ip(s) and _ip(g):
                cur = res.setdefault((s, g), {"rpf": canon(m.group(3)), "oifs": [], "encaps": []})
            oif = None
            continue
        if cur is None:
            continue
        m = _RE_ENCAP.search(ligne)
        if m:
            cur["encaps"].append({"oif": oif, "in_source": m.group(1), "in_group": m.group(2),
                                  "out_source": m.group(3), "out_group": m.group(4),
                                  "udp_src": int(m.group(5)) or None,
                                  "udp_dst": int(m.group(6)) or None,
                                  "via": canon(m.group(7)) if m.group(7) else None})
            continue
        m = re.match(r"^\s{4}((?:Ethernet|Eth|loopback|Vlan|port-channel|Tunnel|nve)\S+)\s*$", ligne)
        if m:
            oif = canon(m.group(1))
            cur["oifs"].append(oif)
    return res


def parse_rates_text(texte):
    """`show interface … | include "^Ether|rate"` → {Ethernet1/28: {rx_bps, tx_bps}}
    (lignes « 30 seconds input/output rate »). Sert aux captures ; en direct on lit le JSON."""
    res, cur = {}, None
    for ligne in (texte or "").splitlines():
        m = re.match(r"^(\S+) is ", ligne)
        if m:
            cur = res.setdefault(canon(m.group(1)), {"rx_bps": None, "tx_bps": None})
            continue
        m = re.match(r"^\s+30 seconds (input|output) rate (\d+) bits/sec", ligne)
        if m and cur is not None:
            cur["rx_bps" if m.group(1) == "input" else "tx_bps"] = int(m.group(2))
    return {k: v for k, v in res.items() if v["rx_bps"] is not None or v["tx_bps"] is not None}


def dans(prefixe, ip):
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network(prefixe, strict=False)
    except ValueError:
        return False


def assainir_config(texte):
    """Ce qu'on garde d'une config COLLÉE dans une capture : hostname, lignes
    service-reflect, et des blocs `interface` seulement la description et l'adresse. Tout le
    reste — mots de passe, communautés SNMP, clés OSPF — est jeté avant enregistrement."""
    garde, dans_if = [], False
    for l in (texte or "").replace("\r", "").splitlines():
        if l.startswith("hostname ") or "service-reflect" in l:
            garde.append(l.rstrip())
            dans_if = False
        elif re.match(r"^interface \S+\s*$", l):
            garde.append(l.rstrip())
            dans_if = True
        elif dans_if and re.match(r"^\s+(description |ip address \d)", l):
            garde.append(l.rstrip())
        elif not l.startswith(" "):
            dans_if = False
    return "\n".join(garde)
