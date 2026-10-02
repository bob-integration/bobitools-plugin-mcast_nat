# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 BOBI SAS, France
# Auteur : Cyril Mazouer, pour le compte de BOBI SAS
# Distribué sous licence GNU GPL v3 (ou ultérieure) ; voir le fichier LICENSE.

"""
Modèle du NAT multicast d'un switch : des règles de config + l'état observé → des
TRADUCTIONS lisibles (une par groupe d'entrée), chacune avec ses sources candidates, ses
sorties, et un verdict.

Fonctions PURES (aucune E/S) : le même modèle sert au switch interrogé et à la capture collée.

Vocabulaire des états d'un flux (S,G), tiré de `show ip mroute summary` :
  live   — présent maintenant (vivacité > 0) ;
  lost   — a déjà existé (paquets > 0) mais absent maintenant ;
  never  — route connue, jamais vu passer ;
  absent — pas de route du tout.
"""

from nat_parse import court, dans, interface_de

# Verdicts d'une traduction, du plus grave au plus calme. L'ordre sert au tri et au résumé.
ETATS = ["nat_ko", "lost", "multi", "hw_missing", "ok", "idle"]
LIBELLE = {"nat_ko": "NAT en échec", "lost": "Entrée perdue", "multi": "Deux émetteurs",
           "hw_missing": "Absente du matériel", "ok": "OK", "idle": "Inutilisée"}
GRAVITE = {"nat_ko": "critical", "lost": "critical", "multi": "warning",
           "hw_missing": "warning", "ok": "good", "idle": "neutral"}


def _etat_flux(summary, s, g):
    e = summary.get((s, g))
    if e is None:
        return "absent", None
    if e["bps"] > 0:
        return "live", e
    return ("lost" if e["packets"] > 0 else "never"), e


def _nom_if(interfaces, nom):
    f = interfaces.get(nom) or {}
    d = (f.get("desc") or "").strip()
    if d.lower().startswith("auto-configured by multicast service-reflect"):
        d = "bouclage NAT"
    return d


def construire(cfg, interfaces, summary, nbm, fwd, rates, hostname=None):
    """cfg = parse_reflect ; interfaces = parse_interfaces ; summary = parse_mroute_summary[0] ;
    nbm = parse_nbm_flows ; fwd = parse_forwarding ou None (non relevé) ; rates = {if: {rx,tx}}."""
    rules = cfg.get("rules") or []
    modes = cfg.get("modes") or []

    def mode_de(g):
        for m in modes:
            if dans(m["prefix"], g):
                return m
        return None

    # Regroupement : une traduction = un groupe d'entrée. NX-OS impose une règle par source
    # candidate, d'où N règles identiques côté sortie ; on les replie.
    trad = {}
    for r in rules:
        t = trad.setdefault(r["in_group"], {"in_group": r["in_group"], "sources": [],
                                             "outputs": {}})
        if r["in_source"] not in t["sources"]:
            t["sources"].append(r["in_source"])
        cle = (r["out_group"], r["out_source"], r["udp_src"], r["udp_dst"], r["static_oif"])
        t["outputs"].setdefault(cle, {"group": r["out_group"], "source": r["out_source"],
                                      "udp_src": r["udp_src"], "udp_dst": r["udp_dst"],
                                      "static_oif": r["static_oif"], "from_sources": []})
        t["outputs"][cle]["from_sources"].append(r["in_source"])

    # Une sortie alimentée par DEUX groupes d'entrée : deux flux écrasés l'un sur l'autre dès
    # que les deux vivent. C'est une erreur de config qu'on signale sans attendre l'incident.
    par_sortie = {}
    for t in trad.values():
        for o in t["outputs"].values():
            par_sortie.setdefault((o["source"], o["group"]), set()).add(t["in_group"])

    out = []
    for g, t in trad.items():
        m = mode_de(g)
        cands = []
        for s in t["sources"]:
            etat, e = _etat_flux(summary, s, g)
            nb = nbm.get((s, g)) or {}
            itf = nb.get("src_if") or interface_de(s, interfaces)
            cands.append({"source": s, "state": etat, "interface": itf,
                          "if_short": court(itf) if itf else None,
                          "name": nb.get("nbr") or (_nom_if(interfaces, itf) if itf else "") or None,
                          "local_rx": (e or {}).get("oifs"), "nbm_rx": nb.get("rx")})
        actives = [c for c in cands if c["state"] == "live"]
        vus = [c for c in cands if c["state"] in ("live", "lost")]

        sorties = []
        for o in t["outputs"].values():
            etat, e = _etat_flux(summary, o["source"], o["group"])
            nb = nbm.get((o["source"], o["group"])) or {}
            oif = o["static_oif"]
            hw = None
            routes = [fwd[(a["source"], g)] for a in actives if (a["source"], g) in fwd] if fwd else []
            if routes:
                # Vérification matérielle : l'Encap doit exister sur la route de l'émetteur
                # ACTIF, vers ce (S',G') et ces ports. Route non relevée (capture partielle,
                # émetteur absent) = NON VÉRIFIÉ, jamais « absente ».
                hw = False
                for rt in routes:
                    for enc in rt.get("encaps", []):
                        if (enc["out_group"] == o["group"] and enc["out_source"] == o["source"]
                                and (o["udp_dst"] is None or enc["udp_dst"] == o["udp_dst"])):
                            hw = True
                            oif = oif or enc["oif"]
            autres = sorted(par_sortie.get((o["source"], o["group"]), set()) - {g})
            sorties.append({"group": o["group"], "source": o["source"], "state": etat,
                            "udp_src": o["udp_src"], "udp_dst": o["udp_dst"],
                            "oif": oif, "oif_short": court(oif) if oif else None,
                            "oif_name": _nom_if(interfaces, oif) if oif else "",
                            "receivers": (e or {}).get("oifs"), "nbm_rx": nb.get("rx"),
                            "hw": hw, "shared_with": autres,
                            "candidates": len(o["from_sources"])})
        sorties.sort(key=lambda x: (x["oif"] or "", x["group"]))

        # Verdict. Ordre des questions : l'entrée vit-elle ? si oui, chaque sortie vit-elle ?
        # Une sortie « voulue » a un abonné (OIF statique ou dynamique) : c'est ce qui
        # distingue une chaîne coupée d'une chaîne simplement inutilisée.
        voulue = any((s["receivers"] or 0) > 0 for s in sorties)
        problemes = []
        if actives:
            ko = [s for s in sorties if s["state"] != "live"]
            if ko:
                etat = "nat_ko"
                problemes.append("entrée présente mais " + ", ".join(
                    f"{s['group']} absent" for s in ko))
            elif len(actives) > 1:
                etat = "multi"
                problemes.append("émetteurs simultanés : " + ", ".join(a["source"] for a in actives))
            elif any(s["hw"] is False for s in sorties):
                etat = "hw_missing"
                problemes.append("traduction absente de la table matérielle : " + ", ".join(
                    s["group"] for s in sorties if s["hw"] is False))
            else:
                etat = "ok"
        elif vus or any(s["state"] == "lost" for s in sorties):
            etat = "lost" if voulue else "idle"
            if voulue:
                problemes.append("aucune source vivante, et la sortie a des abonnés")
        else:
            etat = "idle"
        for s in sorties:
            if s["shared_with"]:
                problemes.append(f"{s['group']} est aussi alimenté par {', '.join(s['shared_with'])}")

        out.append({"key": g, "in_group": g, "dir": (m or {}).get("dir") or "?",
                    "mode": (m or {}).get("prefix"), "candidates": cands,
                    "active": [a["source"] for a in actives], "outputs": sorties,
                    "state": etat, "severity": GRAVITE[etat], "label": LIBELLE[etat],
                    "issues": problemes, "wanted": voulue})

    out.sort(key=lambda t: _cle_ip(t["in_group"]))
    return {"hostname": hostname or cfg.get("hostname"), "source_if": cfg.get("source_if"),
            "modes": modes, "translations": out, "families": familles(out, interfaces),
            "links": liens(cfg, interfaces, rates, out), "ignored": cfg.get("ignored") or [],
            "counts": compter(out), "hw_checked": fwd is not None}


def _cle_ip(ip):
    try:
        return tuple(int(x) for x in ip.split("."))
    except ValueError:
        return (999,)


def compter(trads):
    c = {e: 0 for e in ETATS}
    for t in trads:
        c[t["state"]] += 1
    c["total"] = len(trads)
    c["outputs"] = sum(len(t["outputs"]) for t in trads)
    c["outputs_live"] = sum(1 for t in trads for o in t["outputs"] if o["state"] == "live")
    return c


def familles(trads, interfaces):
    """Regroupe pour l'affichage : sens + mode + voisin. Un même mode sortant peut viser deux
    voisins (VOISIN-A et VOISIN-B) : ce sont deux familles, car on les surveille séparément."""
    fam = {}
    for t in trads:
        if t["dir"] == "egress":
            cles = {(o["oif"] or "?") for o in t["outputs"]}
            for oif in cles:
                k = f"egress|{t['mode']}|{oif}"
                f = fam.setdefault(k, {"key": k, "dir": "egress", "mode": t["mode"],
                                       "interface": oif, "if_short": court(oif),
                                       "name": _nom_if(interfaces, oif), "keys": []})
                f["keys"].append(t["key"])
        else:
            srcif = next((c["interface"] for c in t["candidates"] if c["interface"]), None)
            k = f"ingress|{t['mode']}|{srcif}"
            f = fam.setdefault(k, {"key": k, "dir": "ingress", "mode": t["mode"],
                                   "interface": srcif, "if_short": court(srcif) if srcif else None,
                                   "name": _nom_if(interfaces, srcif) if srcif else "", "keys": []})
            f["keys"].append(t["key"])
    idx = {t["key"]: t for t in trads}
    res = []
    for f in fam.values():
        f["counts"] = compter([idx[k] for k in f["keys"]])
        res.append(f)
    res.sort(key=lambda f: (f["dir"] != "egress", f["mode"] or "", f["interface"] or ""))
    return res


def liens(cfg, interfaces, rates, trads):
    """Les interfaces qui portent le NAT, avec leur débit RÉEL (compteurs d'interface).
    Le débit d'un bouclage = tout ce qui est traduit vers son port associé : c'est un
    CUMUL, jamais le débit d'un flux, et l'écran le dit."""
    vus, res = set(), []

    def ajoute(nom, role, pair=None):
        if not nom or nom in vus:
            return
        vus.add(nom)
        r = (rates or {}).get(nom) or {}
        res.append({"interface": nom, "if_short": court(nom), "role": role, "pair": pair,
                    "name": _nom_if(interfaces, nom), "rx_bps": r.get("rx_bps"),
                    "tx_bps": r.get("tx_bps")})

    for m in cfg.get("maps") or []:
        ajoute(m["port"], "nat_port", m["loop"])
        ajoute(m["loop"], "nat_loop", m["port"])
    for t in trads:
        if t["dir"] == "ingress":
            for c in t["candidates"]:
                ajoute(c["interface"], "ingress_in")
    return res


def interfaces_a_mesurer(cfg, trads=None):
    noms = []
    for m in cfg.get("maps") or []:
        noms += [m["port"], m["loop"]]
    for t in trads or []:
        if t["dir"] == "ingress":
            noms += [c["interface"] for c in t["candidates"] if c["interface"]]
    return [n for i, n in enumerate(noms) if n and n not in noms[:i]
            and n.startswith(("Ethernet", "port-channel"))]


# ── 2022-7 : deux switchs, deux jambes ──
def apparier(modele_a, modele_b, cle="auto"):
    """Associe les traductions de deux switchs jumeaux. En 2022-7 chaque jambe a souvent
    SES groupes : on essaie d'abord le groupe d'entrée, puis le groupe de sortie, puis le
    RANG dans la famille (même plan d'adressage décalé). `auto` garde la clé qui apparie le
    plus de traductions — on montre laquelle, pour qu'on puisse la contester."""
    ta = modele_a["translations"]
    tb = modele_b["translations"]

    def par(cle_, trads):
        if cle_ == "in":
            return {t["in_group"]: t for t in trads}
        if cle_ == "out":
            d = {}
            for t in trads:
                for o in t["outputs"]:
                    d.setdefault(o["group"], t)
            return d
        d, rang = {}, {}
        for t in trads:
            fam = (t["dir"], t["mode"])
            rang[fam] = rang.get(fam, 0) + 1
            d[(t["dir"], rang[fam])] = t
        return d

    essais = [cle] if cle in ("in", "out", "rank") else ["in", "out", "rank"]
    meilleur = None
    for c in essais:
        da, db = par(c, ta), par(c, tb)
        communs = [k for k in da if k in db]
        # Score = traductions DISTINCTES appariées : une traduction à deux sorties ne doit
        # pas compter double quand on apparie par groupe de sortie.
        score = len({da[k]["key"] for k in communs})
        if meilleur is None or score > meilleur[0]:
            meilleur = (score, c, communs, da, db)
    _, c, communs, da, db = meilleur
    paires, vus_a, vus_b = [], set(), set()
    for k in communs:
        a, b = da[k], db[k]
        if a["key"] in vus_a or b["key"] in vus_b:
            continue
        vus_a.add(a["key"])
        vus_b.add(b["key"])
        ok_a, ok_b = a["state"] == "ok", b["state"] == "ok"
        if ok_a and ok_b:
            etat = "both"
        elif ok_a or ok_b:
            etat = "single" if (a["wanted"] or b["wanted"] or a["active"] or b["active"]) else "idle"
        elif a["state"] == "idle" and b["state"] == "idle":
            etat = "idle"
        else:
            etat = "none"
        paires.append({"a": a["key"], "b": b["key"], "a_state": a["state"], "b_state": b["state"],
                       "state": etat, "dir": a["dir"], "mode": a["mode"]})
    seuls_a = [t["key"] for t in ta if t["key"] not in vus_a]
    seuls_b = [t["key"] for t in tb if t["key"] not in vus_b]
    c_ = {"both": 0, "single": 0, "none": 0, "idle": 0}
    for p in paires:
        c_[p["state"]] += 1
    return {"key_used": c, "pairs": paires, "only_a": seuls_a, "only_b": seuls_b, "counts": c_}
