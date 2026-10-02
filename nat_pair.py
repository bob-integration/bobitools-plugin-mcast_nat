# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 BOBI SAS, France
# Auteur : Cyril Mazouer, pour le compte de BOBI SAS
# Distribué sous licence GNU GPL v3 (ou ultérieure) ; voir le fichier LICENSE.

"""
2022-7 : ce qu'une PAIRE de switchs dit d'elle-même, au-delà des flux un par un.

Les deux jambes d'un lien 2022-7 portent les mêmes flux : leurs débits RÉELS doivent
coïncider. On apparie donc les liens NAT des deux switchs (même port, sinon même rang),
on mesure l'écart B − A dans chaque sens, et on cherche la CAUSE au niveau des flux — un
flux tenu par une seule jambe qui passe par ce lien. Une cause = un incident, même si elle
fait dévier plusieurs liens.

Fonctions PURES : modèles des deux switchs + appariement des flux → liens et incidents.
"""

from nat_parse import court


def _voisin(nom):
    """« VOISIN-B-BORDERLEAF01 - Eth1/53 » → « VOISIN-B-BORDERLEAF01 » (le port d'en face
    encombre un titre ; il reste visible dans le détail)."""
    return (nom or "").split(" - ")[0].strip()


def lier(ma, mb):
    """Paires de ports NAT (rôle `nat_port`) : même nom d'interface d'abord, puis le rang
    pour ce qui reste. Rend [(lien_a, lien_b)]."""
    pa = [l for l in ma.get("links") or [] if l["role"] == "nat_port"]
    pb = [l for l in mb.get("links") or [] if l["role"] == "nat_port"]
    res, pris = [], set()
    for a in pa:
        b = next((x for x in pb if x["interface"] == a["interface"]), None)
        if b:
            res.append((a, b))
            pris.add(id(a))
            pris.add(id(b))
    reste_a = [a for a in pa if id(a) not in pris]
    reste_b = [b for b in pb if id(b) not in pris]
    res += list(zip(reste_a, reste_b))
    return res


def _touche(t, interface, sens):
    """La traduction `t` passe-t-elle par `interface` dans ce sens ? Sortant (tx) : une de
    ses sorties y est envoyée. Entrant (rx) : une de ses sources y arrive."""
    if sens == "tx":
        return any(o.get("oif") == interface for o in t["outputs"])
    return any(c.get("interface") == interface for c in t["candidates"])


def analyser(ma, mb, ap, cfg, erreur_a=None, erreur_b=None):
    """Liens jumelés + incidents de la paire. `ap` = nat_model.apparier(ma, mb)."""
    seuil = float(cfg.get("asym_pct") or 1.0)
    plancher = float(cfg.get("asym_floor_mbps") or 100) * 1e6
    ia = {t["key"]: t for t in ma["translations"]}
    ib = {t["key"]: t for t in mb["translations"]}
    seules = [x for x in ap["pairs"] if x["state"] == "single"]

    liens = []
    for la, lb in lier(ma, mb):
        for sens, champ in (("tx", "tx_bps"), ("rx", "rx_bps")):
            va, vb = la.get(champ), lb.get(champ)
            cle = f"{la['interface']}|{lb['interface']}|{sens}"
            if va is None or vb is None:
                etat, ecart = "unknown", None
            elif max(va, vb) < plancher:
                # Au repos, le moindre écart fait un pourcentage énorme : on ne juge pas.
                etat, ecart = "idle", None
            else:
                ref = va or vb
                ecart = (vb - va) / ref * 100
                etat = "asym" if abs(ecart) > seuil else "sym"
            causes = []
            for x in seules:
                manque = "b" if x["a_state"] == "ok" else "a"
                t = ib[x["b"]] if manque == "b" else ia[x["a"]]
                itf = lb["interface"] if manque == "b" else la["interface"]
                if _touche(t, itf, sens):
                    causes.append({"a": x["a"], "b": x["b"], "missing": manque})
            liens.append({
                "key": cle, "dir": sens,
                "a_if": la["interface"], "b_if": lb["interface"],
                "a_if_short": court(la["interface"]), "b_if_short": court(lb["interface"]),
                "a_name": _voisin(la.get("name")), "b_name": _voisin(lb.get("name")),
                "a_bps": va, "b_bps": vb, "delta_bps": (vb - va) if (va is not None and vb is not None) else None,
                "ecart_pct": ecart, "state": etat, "causes": causes})

    # ── Incidents : une cause = un incident ──
    incidents = []
    for cote, err, m in (("a", erreur_a, ma), ("b", erreur_b, mb)):
        if err:
            incidents.append({"kind": "leg_unreadable", "severity": "critical", "side": cote,
                              "title": f"Jambe {cote.upper()} illisible",
                              "detail": f"{err} — son dernier état connu est affiché", "keys": []})
    expliquees = set()
    par_cause = {}
    for l in liens:
        if l["state"] != "asym":
            continue
        cles = tuple(sorted((c["a"], c["b"]) for c in l["causes"]))
        par_cause.setdefault(cles, []).append(l)
    for cles, ls in par_cause.items():
        if cles:
            expliquees.update(cles)
            manque = {c["missing"] for l in ls for c in l["causes"]}
            cote = "B" if manque == {"b"} else "A" if manque == {"a"} else "A et B"
            delta = sum(abs(l["delta_bps"] or 0) for l in ls) / max(1, len(ls))
            incidents.append({
                "kind": "asym", "severity": "warning",
                "title": f"Jambe {cote} : écart sur {len(ls)} lien{'s' if len(ls) > 1 else ''}"
                         f" (≈ {delta / 1e9:.2f} Gb/s)".replace(".", ","),
                "detail": "cause : " + str(len(cles)) + " flux sur une seule jambe",
                "links": [l["key"] for l in ls], "keys": [list(k) for k in cles]})
        else:
            for l in ls:
                incidents.append({
                    "kind": "asym", "severity": "warning",
                    "title": f"Écart inexpliqué : {l['a_name'] or l['a_if_short']} "
                             f"({'sortant' if l['dir'] == 'tx' else 'entrant'})",
                    "detail": "aucun flux d'une seule jambe ne passe par ce lien — "
                              "flux hors NAT, ou débit d'un flux différent entre les jambes",
                    "links": [l["key"]], "keys": []})
    reste = [x for x in seules if (x["a"], x["b"]) not in expliquees]
    if reste:
        incidents.append({"kind": "single", "severity": "warning",
                          "title": f"{len(reste)} flux sur une seule jambe",
                          "detail": "sans écart de débit visible sur les liens",
                          "keys": [[x["a"], x["b"]] for x in reste]})
    aucune = [x for x in ap["pairs"] if x["state"] == "none"]
    if aucune:
        abonnes = sum(max((o.get("receivers") or 0) for o in ia[x["a"]]["outputs"]) for x in aucune)
        incidents.append({"kind": "none", "severity": "critical",
                          "title": f"{len(aucune)} flux absents sur les deux jambes",
                          "detail": f"{abonnes} abonnés en attente" if abonnes else "",
                          "keys": [[x["a"], x["b"]] for x in aucune]})
    ordre = {"critical": 0, "warning": 1}
    incidents.sort(key=lambda i: ordre.get(i["severity"], 2))

    utilises = sum(1 for x in ap["pairs"] if x["state"] != "idle")
    juges = [l for l in liens if l["state"] in ("sym", "asym")]
    return {
        "links": liens, "incidents": incidents,
        "summary": {
            "incidents": len(incidents),
            "critical": sum(1 for i in incidents if i["severity"] == "critical"),
            "warning": sum(1 for i in incidents if i["severity"] == "warning"),
            "both": ap["counts"]["both"], "single": ap["counts"]["single"],
            "none": ap["counts"]["none"], "used": utilises,
            "links_sym": sum(1 for l in juges if l["state"] == "sym"), "links_judged": len(juges),
            "legs_read": (0 if erreur_a else 1) + (0 if erreur_b else 1),
            "asym_pct": seuil}}
