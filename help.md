# NAT multicast (Cisco Nexus — Multicast Service Reflection)

Outil **`runtime=docker`** : il tourne dans un conteneur isolé, l'application sert son
interface et **proxifie** les appels.

## À quoi ça sert

Surveiller le **NAT multicast** des Cisco Nexus (NX-OS 10.x, `ip service-reflect`), en
particulier en **2022-7**, quand deux switchs (Spine A et Spine B) font chacun le NAT d'une
jambe :

- quelles traductions sont configurées, lesquelles **vivent**, lesquelles ont perdu leur
  entrée ou leur sortie ;
- si les **deux jambes** d'un même flux tiennent, et si les **débits** des liens jumelés
  coïncident ;
- **préparer un nouveau flux** à partir d'un SDP, dans les deux sens.

**La surveillance est strictement en lecture** : uniquement des `show`. Le générateur de
flux **n'écrit rien** non plus : il produit du texte à relire et à appliquer à la main.

## Inventaire

L'outil lit **en lecture seule** l'inventaire de « Pilotage de switch » (volume monté sur
`/inventory`). Tous les Nexus en **NX-API** y sont interrogés ; ceux qui ne portent aucune
règle `ip service-reflect` ne sont relus que toutes les 10 minutes. Un switch se retire de la
surveillance dans **Réglages**.

## Ce que le switch sait dire — et ce qu'il ne sait pas

| Information | D'où elle vient |
|---|---|
| Règles de NAT, modes, ports de bouclage | `show running-config \| include service-reflect` |
| **Vivacité** de chaque flux (présent / absent / a déjà circulé / jamais vu) | `show ip mroute summary` |
| Interface source, voisin, nombre de récepteurs | `show nbm flows` |
| Traduction **réellement programmée en matériel** | `show forwarding multicast route` (toutes les 5 min) |
| **Débit réel** des liens NAT | compteurs d'interface (moyenne 30 s) |
| Joins statiques vers l'extérieur | `show running-config interface <sortie>` |

**Il n'existe pas de débit par flux** sur ces switchs : avec NBM, `show ip mroute summary` ne
donne que la vivacité (« only liveness detected »), et `show nbm flows statistics` reste vide
tant que les politiques NBM sont en `no policer`. L'écran ne l'invente pas : les débits
affichés sont ceux des **liens**, c'est-à-dire des **cumuls**. Le débit d'un port de bouclage
(ex. Eth1/34 pour Eth1/33) est tout ce qui est traduit vers ce voisin.

## Onglets

- **Accueil 2022-7** *(par défaut dès qu'une paire est déclarée)* :
  - **quatre tuiles** : incidents en cours, flux doublés, liens symétriques, jambes lues ;
  - **le schéma des deux jambes** : émetteurs → Spine A / Spine B → voisins. Trait plein =
    lien symétrique ; **pointillé orange** = écart, du côté de la jambe en cause ;
  - **une carte par lien et par sens** : débit de A, débit de B, une **jauge de l'écart
    B − A** centrée sur zéro avec la **bande de tolérance** en vert, et la **courbe de l'écart**
    sur la dernière heure. On dessine l'écart et non les débits : deux barres de 17,6 et
    16,5 Gb/s se ressemblent, un écart de 6 % face à une tolérance de 1 % saute aux yeux. Un
    écart au-delà de la graduation est dit « hors échelle » et s'exprime aussi en rapport
    (« B ≈ 2,0 × A ») ;
  - **flux par jambe** : un carré par flux, jambe A en haut, B en bas ; un clic ouvre la
    traduction ;
  - **incidents en cours**, puis **Flux par flux** (repliable) : la liste complète, avec
    filtres par état, émetteur et famille, recherche, et tri ;
  - **Gérer les paires** (repliable).
- **Par switch** : la vue d'un switch ou d'une capture — verdict, une rangée par famille de
  traductions (un carré par traduction), émetteurs actifs, liens du NAT et leur débit.
- **Traductions** : le tableau détaillé, filtrable ; un clic sur une ligne montre les sources
  candidates, chaque sortie, ses abonnés et la vérification matérielle.
- **Nouveau flux** : le générateur SDP → config (ci-dessous).
- **Journal** : les changements d'état confirmés (perte, rétablissement, asymétrie…), jamais
  chaque relevé.
- **Captures** : sorties CLI collées à la main, analysées comme un switch (sans alerte).
- **Réglages** : intervalle de relevé, tolérance, switchs interrogés, alertes par e-mail.

## Verdict d'une traduction

Une traduction = un **groupe d'entrée**, ses **sources candidates** (NX-OS exige une règle par
source possible : huit serveurs pour une même chaîne font huit règles) et ses **sorties**.

| Verdict | Signification |
|---|---|
| **OK** | une source vivante, toutes les sorties présentes |
| **Entrée perdue** | aucune source vivante, alors que la sortie a des abonnés |
| **NAT en échec** | l'entrée vit, mais une sortie manque |
| **Deux émetteurs** | deux serveurs émettent le même groupe en même temps |
| **Absente du matériel** | la règle est configurée mais pas programmée |
| **Inutilisée** | jamais vue, ou sans abonné : pas d'alerte |

Vérification matérielle : en **émission** (egress), la traduction apparaît en ligne `Encap`
sous la route d'entrée ; en **réception** (ingress), NX-OS réécrit à l'entrée, et c'est la
route d'origine qui doit partir vers les abonnés du groupe traduit. Une route non relevée vaut
« non vérifiée », jamais « absente ».

## 2022-7

**Déclarer une paire** : Accueil 2022-7 → Gérer les paires (l'outil propose les paires
plausibles). Les traductions des deux switchs sont appariées automatiquement — même groupe
d'entrée, même groupe de sortie, **même fin d'adresse** (plans déclinés par jambe, ex.
A 239.101.3.N ↔ B 239.101.4.N) ou même rang — en gardant la clé qui apparie le plus.

**Liens jumelés** : les ports NAT des deux spines sont appariés par nom (Eth1/33 avec
Eth1/33), sinon par rang. L'écart est calculé dans chaque sens.

**Alerte d'asymétrie** : écart au-delà de **1 %** pendant **2 relevés** (`asym_pct`,
`grace_polls`) ; sous **100 Mb/s** (`asym_floor_mbps`) on ne juge pas — au repos, le moindre
écart fait un pourcentage énorme.

**Une cause = un incident** : si un flux tenu par une seule jambe passe par les liens qui
dévient, il est donné comme cause, et les liens qu'il fait dévier forment **un seul**
incident. Une jambe **illisible** (switch injoignable) n'est jamais comptée comme morte : elle
donne une seule alerte « jambe illisible ».

## Nouveau flux : du SDP à la config, dans les deux sens

1. Choisir le **sens** :
   - **Émission** — on envoie un de nos flux à l'extérieur : coller le **SDP de notre
     source** ;
   - **Réception** — on reçoit un flux de l'extérieur : coller le **SDP reçu de l'autre
     bout**.
2. Choisir la **cible** : la paire 2022-7 (les deux spines) ou un switch seul.
3. **Préparer**. L'outil rend, par jambe, la règle proposée, puis :
   - la **config de chaque spine**, à copier ;
   - en émission, **un SDP par destination** (VOISIN-A, VOISIN-B…) à envoyer à l'autre bout ; en
     réception, le **SDP interne** à donner aux récepteurs du fabric. En 2022-7, chaque SDP
     porte les deux jambes (`a=group:DUP`).

Comment la règle est construite :

- un **SDP 2022-7** donne les deux jambes d'un coup : chaque bloc est rattaché au spine dont
  le mode `ip service-reflect mode` couvre son groupe. Un SDP d'une seule jambe ne prépare
  que celle-ci ;
- **rien n'est inventé** : la forme est **copiée sur la traduction voisine** de la même
  famille — sources candidates (en émission, toutes celles de la famille, pour le secours
  entre serveurs), source traduite, ports UDP réécrits, `static-oif`, et le join statique
  `ip igmp static-oif` sur l'interface de sortie si la voisine en a un ;
- l'**adresse de sortie** prolonge la voisine (.16 → .224 donne .17 → .225), sinon c'est le
  premier trou du /24. **Elle est modifiable** — l'autre bout l'impose souvent — puis
  « Recalculer » ;
- un flux **déjà traduit** ne produit aucune config : on obtient seulement le SDP de la
  traduction existante (pratique pour renvoyer à l'autre bout le SDP d'un flux en service).

**Rien n'est écrit sur les switchs.** Appliquer la config **à la main, une jambe après
l'autre** : la seconde continue de servir si la première se passe mal. Points à vérifier
soi-même avant d'appliquer :

- les politiques NBM (`nbm host-policy`, `nbm flow-policy`) doivent autoriser le nouvel
  émetteur et le nouveau groupe ;
- en réception, ce qui fait venir le flux jusqu'au spine (déclaration ou join côté
  fournisseur) n'est pas produit par l'outil ;
- la place en TCAM (`hardware access-list tcam region mcast-nat`) : une chaîne émise vers huit
  serveurs candidats et deux destinations coûte seize règles.

## Noms des flux

Si « **Plan multicast** » est installé et accessible, chaque flux prend le nom que le plan lui
donne : attribution saisie à la main, puis équipement reconnu par la convention (avec essence,
canal et réseau), puis plage, puis nom de famille. Sans accès au plan, l'écran reste en
adresses ; une adresse inconnue du plan n'a pas de nom deviné.

## Captures

Pour un site que cette instance ne joint pas : **Captures → Nouvelle capture**, coller les
sorties (config, `show ip mroute summary` au minimum ; `show nbm flows`, `show forwarding
multicast route`, débits d'interface en option). **La config collée est purgée avant
enregistrement** : seuls restent le hostname, les lignes `service-reflect`, et pour chaque
interface sa description, son adresse et ses `ip igmp static-oif`. Mots de passe,
communautés et clés ne sont jamais enregistrés.

## Diagnostic à distance

`GET /api/tools/mcast_nat/diag/<id du switch>` rend les sorties brutes des descriptions
d'interfaces et ce qui en a été compris — utile quand un nom de voisin manque à l'écran.
