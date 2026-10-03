# NAT multicast — plugin Bobi.Tools

Surveillance du **NAT multicast des Cisco Nexus** (NX-OS 10.x, *Multicast Service Reflection*,
`ip service-reflect`) pour [Bobi.Tools](https://github.com/bob-integration/bobitools) :
traductions configurées, émetteur actif, sorties vivantes, vérification en table matérielle,
débit réel des liens NAT, alertes — et contrôle des **deux jambes 2022-7** quand deux spines
font chacun le NAT d'une jambe.

> **Strictement en lecture.** L'outil n'envoie que des `show`. Son générateur de flux
> n'écrit rien non plus : il produit une config et des SDP à relire et à appliquer à la main.

---

## Ce que l'outil montre

- **Accueil 2022-7** : incidents en cours, flux doublés, liens symétriques ; le schéma des deux
  jambes ; pour chaque lien et chaque sens, **l'écart de débit B − A** face à une bande de
  tolérance (on dessine l'écart, pas les débits : deux barres de 17,6 et 16,5 Gb/s se
  ressemblent, un écart de 6 % face à 1 % de tolérance saute aux yeux).
- **Par switch**, **Traductions**, **Journal** (changements d'état confirmés, jamais chaque
  relevé), **Captures** (sorties CLI collées, pour un site que l'instance ne joint pas).
- Un **verdict par traduction** : OK, entrée perdue, NAT en échec, deux émetteurs, absente du
  matériel, inutilisée.

## Ce que le switch sait dire — et ce qu'il ne sait pas

Sur ces Nexus, avec NBM en `no policer`, **il n'existe pas de débit par flux** : `show ip mroute
summary` ne donne que la vivacité. L'outil ne l'invente pas : les débits affichés sont ceux des
**liens NAT** (compteurs d'interface), donc des cumuls. La traduction réellement programmée se
lit dans `show forwarding multicast route` ; une route non relevée vaut « non vérifiée », jamais
« absente ».

## Nouveau flux : du SDP à la config, dans les deux sens

En **émission**, on colle le SDP de sa source ; en **réception**, celui reçu de l'autre bout.
L'outil propose, par jambe, la règle de NAT **copiée sur une traduction voisine de la même
famille** (sources candidates, ports réécrits, `static-oif`, join statique), la config de chaque
spine, et les SDP à transmettre — un SDP 2022-7 porte les deux jambes (`a=group:DUP`). Un flux
déjà traduit ne produit aucune config, seulement son SDP. **Rien n'est écrit sur les switchs** :
appliquer une jambe après l'autre.

## Prérequis

- **Bobi.Tools** avec **Docker** : l'outil tourne en conteneur (`runtime: docker`).
- Le plugin **[Pilotage de switch](https://github.com/bob-integration/bobitools-plugin-switch_ports)**
  (`switch_ports`) : son inventaire et ses identifiants NX-API sont lus **en lecture seule**
  (volume partagé). Sans lui, l'outil démarre mais ne voit aucun switch.
- Des Nexus joignables en **NX-API**.
- Facultatif : **[Plan multicast](https://github.com/bob-integration/bobitools-plugin-mcast_ipam)**
  (`mcast_ipam`), qui donne un nom à chaque flux.

## Installation

Ce dépôt est un **plugin** de Bobi.Tools, monté dans `plugins/mcast_nat/`. Il est inclus dans
l'installation standard :

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bob-integration/bobitools/main/get.sh)
```

L'aide complète est dans [`help.md`](help.md), affichée dans Bobi.Tools (menu « ? » → Aide).

## Sécurité

- Le conteneur n'a pas d'authentification propre : son port n'est publié que sur `127.0.0.1`,
  il n'est donc joignable qu'à travers Bobi.Tools, qui contrôle les droits.
- Les **captures collées sont purgées avant enregistrement** : seuls restent le hostname, les
  lignes `service-reflect` et, par interface, sa description, son adresse et ses joins
  statiques. Mots de passe, communautés et clés ne sont jamais conservés.

## In English

Read-only monitoring of **Cisco Nexus multicast NAT** (Multicast Service Reflection) for
Bobi.Tools: configured translations, active sender, live outputs, hardware-table check, real
NAT link throughput, alerts, and **SMPTE 2022-7 dual-leg** symmetry. It also turns a pasted SDP
into a proposed per-spine NAT config and the SDPs to hand over — without ever writing to a
switch. Requires Docker and the `switch_ports` plugin (read-only inventory).

## Licence

GPL-3.0-or-later — © 2026 BOBI SAS. Voir [LICENSE](LICENSE).
