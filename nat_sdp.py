# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 BOBI SAS, France
# Auteur : Cyril Mazouer, pour le compte de BOBI SAS
# Distribué sous licence GNU GPL v3 (ou ultérieure) ; voir le fichier LICENSE.

"""
Du SDP à la config, et retour : préparer un flux à traduire, dans les deux sens.

  ÉMISSION  : on colle le SDP de NOTRE source (un serveur sur 239.100.0.x) ; on obtient la
              config NAT de chaque spine ET le SDP à envoyer à l'autre bout (VOISIN-A, VOISIN-B…).
  RÉCEPTION : on colle le SDP reçu de l'autre bout (232.5.0.x) ; on obtient la config ET le
              SDP interne à donner à nos récepteurs (239.100.124.x).

Rien n'est inventé : la forme d'une nouvelle règle est COPIÉE sur une traduction voisine de
la même famille (même mode, adresse d'entrée la plus proche) — source traduite, ports
réécrits, interface, join statique. Seule l'adresse de sortie est nouvelle : la première
libre du même /24, modifiable, car c'est souvent l'autre bout qui l'impose.

Un SDP 2022-7 (`a=group:DUP`) porte les deux jambes : chaque bloc est rattaché au spine
dont le mode `service-reflect` couvre son groupe.

Fonctions PURES. Le générateur ne touche JAMAIS un switch : il rend du texte à relire.
"""

import ipaddress
import re

from nat_parse import court, dans


# ── Lecture du SDP ──
def lire_sdp(texte):
    """→ {session: [lignes], blocks: [{media, port, rest, group, ttl, source, mid, lines}],
          dup: [mid, …] | None, origin, name, errors}"""
    lignes = [l.strip() for l in (texte or "").replace("\r", "").split("\n") if l.strip()]
    res = {"session": [], "blocks": [], "dup": None, "origin": None, "name": None, "errors": []}
    cur = None
    c_session = None
    for l in lignes:
        if len(l) < 2 or l[1] != "=":
            continue
        t, v = l[0], l[2:]
        if t == "m":
            cur = {"media": v.split()[0] if v.split() else "", "lines": [l], "port": None, "rest": "",
                   "group": None, "ttl": None, "source": None, "mid": None}
            p = v.split()
            if len(p) >= 2:
                try:
                    cur["port"] = int(p[1].split("/")[0])
                except ValueError:
                    pass
                cur["rest"] = " ".join(p[2:])
            res["blocks"].append(cur)
            continue
        if cur is None:
            res["session"].append(l)
            if t == "o":
                res["origin"] = v
            elif t == "s":
                res["name"] = v
            elif t == "c":
                c_session = v
            elif t == "a" and v.startswith("group:DUP"):
                res["dup"] = v.split()[1:]
            elif t == "a" and v.startswith("source-filter:"):
                res["_sf_session"] = v
            continue
        cur["lines"].append(l)
        if t == "c":
            _connexion(cur, v)
        elif t == "a" and v.startswith("source-filter:"):
            _filtre(cur, v)
        elif t == "a" and v.startswith("mid:"):
            cur["mid"] = v[4:].strip()
    for b in res["blocks"]:
        if not b["group"] and c_session:
            _connexion(b, c_session)
        if not b["source"] and res.get("_sf_session"):
            _filtre(b, res["_sf_session"])
        if not b["source"] and res["origin"]:
            # Sans source-filter, l'adresse de l'origine est la meilleure indication — mais
            # ce n'est qu'une indication : on le dit.
            o = res["origin"].split()
            if len(o) >= 6:
                b["source"] = o[5]
                b["source_guess"] = True
    if not res["blocks"]:
        res["errors"].append("aucun bloc m= : ce texte n'est pas un SDP")
    for i, b in enumerate(res["blocks"]):
        if not b["group"]:
            res["errors"].append(f"bloc {i + 1} : pas d'adresse de destination (ligne c=)")
        elif not dans("224.0.0.0/4", b["group"]):
            res["errors"].append(f"bloc {i + 1} : {b['group']} n'est pas une adresse multicast")
    res.pop("_sf_session", None)
    return res


def _connexion(b, v):
    p = v.split()
    if len(p) >= 3:
        a = p[2].split("/")
        b["group"] = a[0]
        b["ttl"] = a[1] if len(a) > 1 else None


def _filtre(b, v):
    # a=source-filter: incl IN IP4 <destination> <source> [<source>…]
    p = v.split(":", 1)[1].split()
    if len(p) >= 5 and p[0] == "incl":
        b["source"] = p[4]
        b["group"] = b["group"] or p[3]


def ecrire_sdp(sdp, blocs, nom_suffixe=None, origine=None):
    """Réécrit un SDP : `blocs` = [(index du bloc d'origine, {group, source, port})], dans
    l'ordre voulu. Garde tout le reste (rtpmap, fmtp, ptp, mediaclk…) à l'identique."""
    out = []
    for l in sdp["session"]:
        if l.startswith("c="):
            continue                          # remis bloc par bloc
        if l.startswith("a=group:DUP"):
            continue                          # recalculé selon le nombre de blocs
        if l.startswith("a=source-filter:"):
            continue
        if l.startswith("o=") and origine:
            p = l[2:].split()
            if len(p) >= 6:
                p[5] = origine
                l = "o=" + " ".join(p)
        if l.startswith("s=") and nom_suffixe:
            l = l + " " + nom_suffixe
        out.append(l)
    mids = [sdp["blocks"][i].get("mid") or f"{'primary' if n == 0 else 'secondary'}"
            for n, (i, _) in enumerate(blocs)]
    if len(blocs) == 2:
        out.append("a=group:DUP " + " ".join(mids))
    for n, (i, r) in enumerate(blocs):
        b = sdp["blocks"][i]
        ttl = "/" + b["ttl"] if b.get("ttl") else "/64"
        mid_vu = False
        for l in b["lines"]:
            if l.startswith("m="):
                p = l[2:].split()
                if r.get("port"):
                    p[1] = str(r["port"])
                out.append("m=" + " ".join(p))
                out.append(f"c=IN IP4 {r['group']}{ttl}")
                out.append(f"a=source-filter: incl IN IP4 {r['group']} {r['source']}")
                continue
            if l.startswith(("c=", "a=source-filter:")):
                continue
            if l.startswith("a=mid:"):
                mid_vu = True
                if len(blocs) < 2:
                    continue
            out.append(l)
        if len(blocs) == 2 and not mid_vu:
            out.append("a=mid:" + mids[n])
    return "\r\n".join(out) + "\r\n"


# ── Du SDP à la règle ──
def _ip(g):
    return int(ipaddress.ip_address(g))


def _libre(prefixe24, pris):
    """Première adresse libre d'un /24 : ni dans la config, ni vue vivante sur le switch."""
    base = ".".join(prefixe24.split(".")[:3])
    for n in range(1, 255):
        g = f"{base}.{n}"
        if g not in pris:
            return g
    return None


def _suite(in_modele, in_nouveau, out_modele, pris):
    """La sortie qui prolonge la voisine : même décalage qu'entre les entrées (.16 → .224
    donne .17 → .225), si elle reste dans le même /24 et qu'elle est libre. Sinon rien, et
    on prend la première libre — une numérotation non linéaire (triplets vidéo/audio/ANC)
    retombe ainsi sur le premier trou, qui est en pratique la bonne case."""
    d = _ip(in_nouveau) - _ip(in_modele)
    try:
        g = str(ipaddress.ip_address(_ip(out_modele) + d))
    except ValueError:
        return None
    if g.rsplit(".", 1)[0] != out_modele.rsplit(".", 1)[0] or g in pris or g.endswith((".0", ".255")):
        return None
    return g


def _jambe_du_groupe(groupe, sens, modeles):
    """Le spine dont un mode `service-reflect` du bon sens couvre ce groupe."""
    for cote, m in modeles.items():
        if m and any(x["dir"] == sens and dans(x["prefix"], groupe) for x in m.get("modes") or []):
            return cote
    return None


def _modele_de_regle(groupe, sens, m, impose=None):
    """La traduction voisine dont on copie la forme : celle demandée, sinon la plus proche
    du même mode (même sous-bloc, donc même essence et mêmes ports en pratique)."""
    cands = [t for t in m["translations"] if t["dir"] == sens]
    if impose:
        t = next((t for t in cands if t["key"] == impose), None)
        if t:
            return t
    meme_mode = [t for t in cands if t["mode"] and dans(t["mode"], groupe)] or cands
    if not meme_mode:
        return None
    g = _ip(groupe)
    return min(meme_mode, key=lambda t: (abs(_ip(t["in_group"]) - g), _ip(t["in_group"])))


def preparer(sens, texte, modeles, noms, options=None):
    """sens = "egress" (émission) | "ingress" (réception) ; modeles = {"a": modèle, "b": modèle
    ou None} ; noms = {"a": nom affiché, …} ; options = {jambe_unique, modeles_imposes:{cle:
    clé}, sorties:{cle: {index: groupe}}, sources: "famille"|"sdp"}."""
    options = options or {}
    sdp = lire_sdp(texte)
    res = {"sdp": {k: sdp[k] for k in ("name", "origin", "dup", "errors")}, "legs": [], "configs": {},
           "sdps": [], "errors": list(sdp["errors"]), "warnings": []}
    if res["errors"]:
        return res
    if len(sdp["blocks"]) > 2:
        res["warnings"].append(f"{len(sdp['blocks'])} blocs m= : seuls les deux premiers sont traités "
                               "(un SDP 2022-7 en porte deux)")
    blocs = sdp["blocks"][:2]

    pris = {}
    for cote, m in modeles.items():
        if not m:
            continue
        p = set()
        for t in m["translations"]:
            p.add(t["in_group"])
            for o in t["outputs"]:
                p.add(o["group"])
        p.update(m.get("live_groups") or [])
        pris[cote] = p

    deja = set()
    for i, b in enumerate(blocs):
        cote = _jambe_du_groupe(b["group"], sens, modeles)
        auto = cote is not None
        if cote is None:
            cote = options.get("jambe_unique") if len(blocs) == 1 else ("a", "b")[i]
            cote = cote if cote in modeles and modeles.get(cote) else next(
                (c for c in ("a", "b") if modeles.get(c)), None)
        if cote in deja:
            res["errors"].append(f"les deux blocs du SDP désignent la même jambe ({cote.upper()}) : "
                                 "vérifiez les adresses, ou le sens choisi")
            return res
        deja.add(cote)
        m = modeles.get(cote)
        res["legs"].append(_jambe(sens, i, b, cote, auto, m, noms.get(cote, cote), pris.get(cote, set()), options))

    # ── Config par spine ──
    for leg in res["legs"]:
        if leg.get("config"):
            res["configs"][leg["side"]] = leg["config"]

    # ── SDP à transmettre ──
    if sens == "egress":
        # Un SDP par destination ; en 2022-7, la sortie de A et celle de B vers le même voisin
        # (même interface) forment un seul SDP DUP.
        dests = {}
        for leg in res["legs"]:
            for o in leg["outputs"]:
                k = o["oif"] or "local"
                dests.setdefault(k, []).append((leg, o))
        for k, lst in dests.items():
            lst.sort(key=lambda x: x[0]["side"])
            blocs_out = [(leg["block"], {"group": o["group"], "source": o["source"],
                                         "port": o["udp_dst"]}) for leg, o in lst[:2]]
            nom = " / ".join(dict.fromkeys(o["oif_name"] or o["oif_short"] or "local" for _, o in lst))
            res["sdps"].append({"title": "À envoyer vers " + nom, "text": ecrire_sdp(sdp, blocs_out, origine=lst[0][1]["source"]),
                                "legs": [leg["side"] for leg, _ in lst]})
    else:
        blocs_out = []
        for leg in res["legs"]:
            if leg["outputs"]:
                o = leg["outputs"][0]
                blocs_out.append((leg["block"], {"group": o["group"], "source": o["source"],
                                                 "port": o["udp_dst"]}))
        if blocs_out:
            res["sdps"].append({"title": "À donner aux récepteurs du fabric",
                                "text": ecrire_sdp(sdp, blocs_out, origine=blocs_out[0][1]["source"]),
                                "legs": [leg["side"] for leg in res["legs"]]})
    if len(res["legs"]) == 1 and all(modeles.get(c) for c in ("a", "b")):
        res["warnings"].append("SDP d'une seule jambe : collez aussi celui de l'autre jambe (ou un SDP "
                               "2022-7 qui porte les deux) pour obtenir la config des deux spines")
    return res


def _jambe(sens, index, b, cote, auto, m, nom_spine, pris, options):
    leg = {"side": cote, "spine": nom_spine, "block": index, "auto": auto,
           "input": {"group": b["group"], "source": b["source"], "port": b["port"], "media": b["media"],
                     "source_guess": bool(b.get("source_guess"))},
           "outputs": [], "warnings": [], "errors": [], "config": "", "existing": False, "template": None}
    if b.get("source_guess"):
        leg["warnings"].append("pas de a=source-filter : la source est tirée de la ligne o=, à vérifier")
    if not m:
        leg["errors"].append(f"jambe {cote.upper()} : aucun relevé du switch")
        return leg
    if not auto:
        leg["warnings"].append(f"aucun mode `ip service-reflect mode {sens}` de {nom_spine} ne couvre "
                               f"{b['group']} : jambe choisie par défaut, et le mode sera à ajouter")

    # Déjà traduit ? Alors pas de config : on rend le SDP de ce qui existe.
    exist = next((t for t in m["translations"] if t["in_group"] == b["group"]
                  and t["dir"] == sens), None)
    if exist and (not b["source"] or any(c["source"] == b["source"] for c in exist["candidates"])):
        leg["existing"] = True
        leg["template"] = exist["key"]
        leg["outputs"] = [_sortie(o) for o in exist["outputs"]]
        leg["warnings"].append(f"{b['group']} est déjà traduit sur {nom_spine} : aucune config à ajouter, "
                               "le SDP rendu est celui de la traduction existante")
        return leg
    if exist:
        leg["warnings"].append(f"{b['group']} est déjà traduit sur {nom_spine}, mais pour d'autres sources : "
                               f"on ajoute {b['source']} aux candidates existantes")

    modele = exist or _modele_de_regle(b["group"], sens, m, (options.get("modeles_imposes") or {}).get(cote))
    if not modele:
        leg["errors"].append(f"aucune traduction {('sortante' if sens == 'egress' else 'entrante')} sur "
                             f"{nom_spine} dont copier la forme")
        return leg
    leg["template"] = modele["key"]
    leg["template_outputs"] = [{"group": o["group"], "udp_dst": o["udp_dst"], "oif_short": o["oif_short"]}
                               for o in modele["outputs"]]

    imposes = ((options.get("sorties") or {}).get(cote) or {})
    pris = set(pris)
    for n, o in enumerate(modele["outputs"]):
        if exist:
            g = o["group"]
        else:
            g = imposes.get(str(n)) or imposes.get(n) or _suite(modele["in_group"], b["group"], o["group"], pris) \
                or _libre(o["group"], pris)
            if not g:
                leg["errors"].append(f"plus d'adresse libre dans {o['group'].rsplit('.', 1)[0]}.0/24")
                continue
            if g in pris and not (imposes.get(str(n)) or imposes.get(n)):
                leg["errors"].append(f"{g} est déjà utilisé sur {nom_spine}")
            elif g in pris:
                leg["warnings"].append(f"{g} est déjà utilisé sur {nom_spine} : vérifiez avant d'appliquer")
        pris.add(g)
        s = _sortie(o)
        s["group"] = g
        s["state"] = None
        joins = (m.get("static_joins") or {}).get(o["oif"] or "", [])
        s["static_join"] = any(j[0] == o["group"] for j in joins)
        leg["outputs"].append(s)

    # Sources candidates : en émission, la famille en compte souvent plusieurs (secours entre
    # serveurs) ; on les reprend toutes, plus celle du SDP si elle n'y est pas.
    if sens == "egress" and options.get("sources") != "sdp":
        sources = [c["source"] for c in modele["candidates"]]
        if b["source"] and b["source"] not in sources:
            sources.append(b["source"])
            leg["warnings"].append(f"{b['source']} n'est pas une source habituelle de cette famille : ajoutée")
    elif exist:
        sources = [b["source"]] if b["source"] else []
    else:
        sources = [b["source"]] if b["source"] else [c["source"] for c in modele["candidates"]]
    leg["sources"] = sources
    lignes = [f"! {nom_spine} — {('émission' if sens == 'egress' else 'réception')} {b['group']}"
              + (f" (forme copiée sur {modele['key']})" if not exist else "")]
    if not auto:
        p24 = ".".join(b["group"].split(".")[:3]) + ".0/24"
        lignes.append(f"ip service-reflect mode {sens} {p24}")
    for o in leg["outputs"]:
        for src in sources:
            if exist and src in [c["source"] for c in exist["candidates"]]:
                continue
            l = (f"ip service-reflect destination {b['group']} to {o['group']} mask-len 32 "
                 f"source {src} to {o['source']} mask-len 32")
            if o["udp_src"] or o["udp_dst"]:
                l += f" to-udp-src-port {o['udp_src'] or 0} to-udp-dest-port {o['udp_dst'] or 0}"
            if o["oif"] and _regle_avait_oif(modele, o):
                l += f" static-oif {o['oif']}"
            lignes.append(l)
    joins = [o for o in leg["outputs"] if o.get("static_join") and o["oif"]]
    for oif in dict.fromkeys(o["oif"] for o in joins):
        lignes.append(f"interface {oif}")
        for o in joins:
            if o["oif"] == oif:
                lignes.append(f"  ip igmp static-oif {o['group']} source {o['source']}")
    leg["config"] = "\n".join(lignes)
    return leg


def _regle_avait_oif(modele, o):
    return any(x.get("static_oif") == o["oif"] for x in modele["outputs"])


def _sortie(o):
    return {"group": o["group"], "source": o["source"], "udp_src": o.get("udp_src"),
            "udp_dst": o.get("udp_dst"), "oif": o.get("oif"), "oif_short": o.get("oif_short"),
            "oif_name": (o.get("oif_name") or "").split(" - ")[0], "state": o.get("state"),
            "static_oif": o.get("static_oif")}
