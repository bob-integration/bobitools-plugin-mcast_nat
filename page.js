// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BOBI SAS, France
// Auteur : Cyril Mazouer, pour le compte de BOBI SAS
// Distribué sous licence GNU GPL v3 (ou ultérieure) ; voir le fichier LICENSE.

// Front de l'outil « NAT multicast ». Enregistre window.BTTools["mcast_nat"].
// Aucune logique réseau ici : le conteneur relève, modélise et alerte ; l'écran montre.
(function () {
  "use strict";

  window.BTTools = window.BTTools || {};
  let EL = null, CTX = null, timer = null;
  let overview = null, curId = null, tab = "vue", data = null, hist = null;
  let filt = { states: new Set(), family: "", q: "", open: null, limit: 150 };
  let pairSel = null;
  // Noms tirés de « Plan multicast » (attribution, convention, plage) : {groupe: {name, detail}}.
  // Facultatifs : sans accès à cet outil, ou s'il n'est pas installé, l'écran reste en adresses.
  let noms = {};

  const esc = (s) => (window.BT ? window.BT.esc(s) : String(s == null ? "" : s));
  const $ = (sel) => EL.querySelector(sel);
  const toast = (m, k) => CTX.toast(m, k || "info");

  const TABS = [["paire", "Accueil 2022-7"], ["vue", "Par switch"], ["trad", "Traductions"], ["sdp", "Nouveau flux"],
                ["journal", "Journal"], ["captures", "Captures"], ["reglages", "Réglages"]];
  const ETATS = ["nat_ko", "lost", "multi", "hw_missing", "ok", "idle"];
  const LIB = { nat_ko: "NAT en échec", lost: "Entrée perdue", multi: "Deux émetteurs",
                hw_missing: "Absente du matériel", ok: "OK", idle: "Inutilisée" };
  const SEV = { nat_ko: "critical", lost: "critical", multi: "warning", hw_missing: "warning",
                ok: "good", idle: "neutral" };
  const COUL = { critical: "var(--nat-crit)", warning: "var(--nat-warn)", good: "var(--nat-ok)",
                 neutral: "var(--nat-idle)" };
  const FLUX = { live: "présent", lost: "absent (a déjà circulé)", never: "jamais vu", absent: "pas de route" };

  function fmtBps(b) {
    if (b == null) return "—";
    if (b >= 1e9) return (b / 1e9).toFixed(2).replace(".", ",") + " Gb/s";
    if (b >= 1e6) return (b / 1e6).toFixed(1).replace(".", ",") + " Mb/s";
    if (b >= 1e3) return (b / 1e3).toFixed(0) + " kb/s";
    return Math.round(b) + " b/s";
  }
  function age(ts) {
    if (!ts) return "jamais";
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (s < 60) return "il y a " + s + " s";
    if (s < 3600) return "il y a " + Math.round(s / 60) + " min";
    if (s < 86400) return "il y a " + Math.round(s / 3600) + " h";
    return "il y a " + Math.round(s / 86400) + " j";
  }
  function duree(ts) {
    if (!ts) return "";
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min";
    if (s < 86400) return Math.round(s / 3600) + " h";
    return Math.round(s / 86400) + " j";
  }
  const pill = (etat, txt) => '<span class="nat-pill ' + SEV[etat] + '">' + esc(txt || LIB[etat]) + "</span>";
  const cur = () => (overview && overview.sources || []).find((s) => s.id === curId) || null;
  const nomDe = (g) => noms[g] || null;
  const nomTr = (t) => nomDe(t.in_group) || t.outputs.map((o) => nomDe(o.group)).find(Boolean) || null;
  const nomHtml = (n) => n ? '<div class="nat-name">' + esc(n.name) + (n.detail ? ' <span>' + esc(n.detail) + "</span>" : "") + "</div>" : "";

  async function loadNames(groupes) {
    const manquants = [...new Set(groupes)].filter((g) => g && !(g in noms));
    if (!manquants.length) return;
    manquants.forEach((g) => { noms[g] = null; });       // pas de seconde demande pour une adresse inconnue du plan
    for (let i = 0; i < manquants.length; i += 300) {
      const lot = manquants.slice(i, i + 300);
      try {
        const r = await BT.fetchJSON("/api/tools/mcast_ipam/names?groups=" + encodeURIComponent(lot.join(",")));
        Object.assign(noms, (r && r.names) || {});
      } catch (e) { return; }                            // pas d'accès au plan : on reste en adresses
    }
  }
  const pb = (c) => c ? c.nat_ko + c.lost + c.multi + c.hw_missing : 0;

  // ── Données ──
  async function loadOverview() {
    overview = await CTX.api("overview");
    const srcs = overview.sources || [];
    if (!curId || !srcs.some((s) => s.id === curId)) {
      const best = srcs.find((s) => s.has_nat && s.kind === "switch") || srcs.find((s) => s.has_nat) || srcs[0];
      curId = best ? best.id : null;
    }
    renderSelect();
  }
  async function loadSource() {
    data = null; hist = null;
    if (!curId) return;
    const s = cur();
    if (!s || !s.has_nat) return;
    try { data = await CTX.api("source/" + encodeURIComponent(curId)); } catch (e) { data = { error: e.message }; }
    if (data && data.model) {
      const gs = [];
      data.model.translations.forEach((t) => { gs.push(t.in_group); t.outputs.forEach((o) => gs.push(o.group)); });
      await loadNames(gs);
    }
    if (s.kind === "switch") {
      try { hist = await CTX.api("history?sid=" + encodeURIComponent(curId)); } catch (e) { hist = null; }
    }
  }

  function renderSelect() {
    const sel = $("#nat-source");
    const srcs = overview.sources || [];
    const grp = (titre, list) => list.length ? '<optgroup label="' + esc(titre) + '">' + list.map((s) =>
      '<option value="' + esc(s.id) + '"' + (s.id === curId ? " selected" : "") + ">" + esc(s.name) +
      (s.counts && pb(s.counts) ? " — " + pb(s.counts) + " ⚠" : "") +
      (s.error ? " — injoignable" : "") + "</option>").join("") + "</optgroup>" : "";
    sel.innerHTML = grp("Switchs avec NAT", srcs.filter((s) => s.kind === "switch" && s.has_nat)) +
      grp("Captures", srcs.filter((s) => s.kind === "capture")) +
      grp("Sans NAT ou pas encore relevés", srcs.filter((s) => s.kind === "switch" && !s.has_nat)) ||
      '<option value="">Aucune source</option>';
    sel.onchange = async () => { curId = sel.value; filt.open = null; await loadSource(); render(); };
  }

  function renderFresh() {
    const s = cur(), f = $("#nat-fresh");
    if (!s) { f.textContent = ""; return; }
    if (s.kind === "capture") { f.textContent = "capture du " + new Date(s.at * 1000).toLocaleString(); f.className = "nat-fresh muted"; return; }
    const vieux = s.at && (Date.now() / 1000 - s.at) > 3 * ((overview.config || {}).poll_seconds || 30);
    f.textContent = s.error ? "relevé en échec : " + s.error : (s.at ? "relevé " + age(s.at) : "en attente du premier relevé");
    f.className = "nat-fresh " + (s.error || vieux ? "stale" : "muted");
  }

  function renderTabs() {
    $("#nat-tabs").innerHTML = TABS.map(([k, l]) =>
      '<button class="tab' + (k === tab ? " active" : "") + '" role="tab" data-t="' + k + '" type="button">' + esc(l) + "</button>").join("");
    $("#nat-tabs").querySelectorAll("button").forEach((b) => b.onclick = () => { tab = b.dataset.t; renderTabs(); render(); });
  }

  function render() {
    if (!EL) return;
    renderFresh();
    const c = $("#nat-content");
    try {
      if (tab === "vue") c.innerHTML = vueHtml();
      else if (tab === "trad") c.innerHTML = tradHtml();
      else if (tab === "paire") { c.innerHTML = paireHtml(); bindPaires(); loadPairHome(); }
      else if (tab === "sdp") { c.innerHTML = sdpHtml(); bindSdp(); }
      else if (tab === "journal") { c.innerHTML = '<div class="meta">Chargement…</div>'; loadJournal(); }
      else if (tab === "captures") { c.innerHTML = '<div class="meta">Chargement…</div>'; loadCaptures(); }
      else if (tab === "reglages") { c.innerHTML = '<div class="meta">Chargement…</div>'; loadReglages(); }
      bind();
    } catch (e) {
      c.innerHTML = '<div class="nat-err">' + esc(e.message) + "</div>";
    }
  }

  function absence() {
    const s = cur();
    if (!s) return '<div class="nat-note">Aucun switch NX-OS dans l\'inventaire de « Pilotage de switch », et aucune capture. ' +
      "Ajoutez le switch qui fait le NAT dans « Pilotage de switch » (NX-API), ou déposez une capture.</div>";
    if (s.kind === "switch" && s.error) return '<div class="nat-err">' + esc(s.name) + " : relevé impossible — " + esc(s.error) + "</div>";
    if (s.kind === "switch" && s.has_nat === false) return '<div class="nat-note">' + esc(s.name) +
      " ne porte aucune règle <code>ip service-reflect</code> : rien à surveiller ici.</div>";
    if (!data) return '<div class="meta">En attente du premier relevé…</div>';
    if (data.error) return '<div class="nat-err">' + esc(data.error) + "</div>";
    return null;
  }

  // ── Vue d'ensemble ──
  function vueHtml() {
    const a = absence();
    if (a) return a;
    const m = data.model, c = m.counts, n = pb(c);
    const sev = (c.nat_ko + c.lost) ? "crit" : n ? "warn" : "ok";
    const stack = ETATS.filter((e) => c[e]).map((e) =>
      '<span style="flex:' + c[e] + ";background:" + COUL[SEV[e]] + '" title="' + esc(LIB[e]) + " : " + c[e] + '"></span>').join("");
    const chips = ETATS.filter((e) => c[e]).map((e) =>
      '<button class="nat-pill ' + SEV[e] + '" type="button" data-goto="' + e + '">' + esc(LIB[e]) + " · " + c[e] + "</button>").join("");
    let h = '<div class="nat-hero"><div class="nat-verdict ' + sev + '">' +
      '<span class="nat-h">' + esc(m.hostname || cur().name) + "</span>" +
      '<span class="big">' + (n ? n + " en défaut" : "Tout circule") + "</span>" +
      '<span class="sub">' + c.total + " traductions · " + c.outputs_live + "/" + c.outputs + " sorties présentes" +
      (m.hw_checked ? (m.partial_hw ? " · table matérielle partielle" : " · table matérielle vérifiée") : " · table matérielle non lue") + "</span>" +
      "</div>" +
      '<div class="nat-card"><span class="nat-h">Répartition</span><div class="nat-stack">' + stack + "</div>" +
      '<div class="nat-chips">' + chips + "</div>" +
      '<span class="nat-note">Un carré par traduction ci-dessous ; survolez-le pour le détail, cliquez pour l\'ouvrir.</span></div></div>';

    h += '<div class="nat-rails">' + m.families.map(railHtml).join("") + "</div>";
    h += '<div class="nat-grid2">' + emetteursHtml(m) + liensHtml(m) + "</div>";
    if (m.ignored && m.ignored.length) h += '<div class="nat-note">' + m.ignored.length +
      " règle(s) de préfixe (mask-len &lt; 32) non détaillée(s).</div>";
    return h;
  }

  function prefixes(groupes) {
    const p = {};
    groupes.forEach((g) => { const k = g.split(".").slice(0, 3).join(".") + ".x"; p[k] = (p[k] || 0) + 1; });
    return Object.keys(p).join(", ");
  }

  function railHtml(f) {
    const idx = trIndex();
    const trs = f.keys.map((k) => idx[k]).filter(Boolean);
    const c = f.counts;
    const ins = trs.some((t) => t.state === "lost") ? "crit" : trs.some((t) => t.active.length) ? "ok" : "";
    const outs = trs.some((t) => t.state === "nat_ko") ? "crit" : trs.some((t) => t.state === "hw_missing" || t.state === "multi") ? "warn" :
      trs.some((t) => t.state === "ok") ? "ok" : "";
    let outGroups = [];
    trs.forEach((t) => t.outputs.forEach((o) => { if (f.dir !== "egress" || o.oif === f.interface) outGroups.push(o.group); }));
    let gauche, droite;
    if (f.dir === "egress") {
      const noms = new Set(), actifs = new Set();
      trs.forEach((t) => t.candidates.forEach((x) => { noms.add(x.name || x.source); if (x.state === "live") actifs.add(x.name || x.source); }));
      gauche = '<div class="nat-node"><span class="n">Émetteurs locaux</span><span class="s">' + noms.size +
        " possibles · " + actifs.size + " actif" + (actifs.size > 1 ? "s" : "") + "</span></div>";
      droite = '<div class="nat-node right"><span class="n">' + esc(f.name || f.if_short || "?") + '</span><span class="s nat-mono">' +
        esc(f.if_short || "") + " · " + esc(prefixes(outGroups)) + "</span></div>";
    } else {
      const rx = trs.filter((t) => t.outputs.some((o) => (o.receivers || 0) > 0)).length;
      gauche = '<div class="nat-node"><span class="n">' + esc(f.name || f.if_short || "?") + '</span><span class="s nat-mono">' +
        esc(f.if_short || "") + " · " + esc(f.mode || "") + "</span></div>";
      droite = '<div class="nat-node right"><span class="n">Abonnés du fabric</span><span class="s"><span class="nat-mono">' +
        esc(prefixes(outGroups)) + "</span> · " + rx + " sortie" + (rx > 1 ? "s" : "") + " demandée" + (rx > 1 ? "s" : "") + "</span></div>";
    }
    const dots = trs.map((t) => '<button class="nat-dot ' + t.severity + '" type="button" data-k="' + esc(t.key) +
      '" aria-label="' + esc(t.key + " — " + t.label) + '"></button>').join("");
    const resume = ETATS.filter((e) => c[e] && e !== "ok" && e !== "idle").map((e) => LIB[e] + " : " + c[e]).join(" · ");
    return '<div class="nat-rail">' + gauche + '<div class="nat-wire ' + ins + '"></div>' +
      '<div class="nat-box"><div class="t"><span>' + (f.dir === "egress" ? "Sortant" : "Entrant") +
      ' · <span class="nat-mono">' + esc(f.mode || "") + "</span></span><b>" + c.ok + "/" + c.total + "</b></div>" +
      '<div class="nat-dots">' + dots + "</div>" +
      (resume ? '<div class="t"><span style="color:var(--nat-crit)">' + esc(resume) + "</span></div>" : "") +
      '</div><div class="nat-wire ' + outs + '"></div>' + droite + "</div>";
  }

  function emetteursHtml(m) {
    const par = {};
    let total = 0;
    m.translations.filter((t) => t.dir === "egress").forEach((t) => t.candidates.forEach((x) => {
      const k = x.name || x.source;
      par[k] = par[k] || { n: 0, ip: x.source, itf: x.if_short };
      if (x.state === "live") { par[k].n++; total++; }
    }));
    const lignes = Object.entries(par).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
    if (!lignes.length) return '<div class="nat-card"><span class="nat-h">Qui émet</span><span class="nat-note">Pas de traduction sortante.</span></div>';
    const max = Math.max(1, ...lignes.map((l) => l[1].n));
    return '<div class="nat-card"><span class="nat-h">Qui émet vers l\'extérieur · traductions alimentées</span><div class="nat-bars">' +
      lignes.map(([k, v]) => '<div class="nat-barrow"><span class="lbl" title="' + esc(v.ip + " · " + (v.itf || "")) + '">' + esc(k) +
        '</span><span class="nat-track"><span style="width:' + (100 * v.n / max) + '%"></span></span><span class="v">' + v.n + "</span></div>").join("") +
      '</div><span class="nat-note">Chaque groupe sortant accepte plusieurs serveurs ; un seul doit émettre à la fois. ' +
      total + " traductions sortantes ont un émetteur actif.</span></div>";
  }

  function spark(serie, champ) {
    if (!serie || serie.length < 2) return "";
    const pts = serie.slice(-120), W = 300, H = 34;
    const vals = pts.map((p) => p[champ] || 0), mx = Math.max(1, ...vals);
    const x = (i) => (i / (pts.length - 1)) * (W - 4) + 2, y = (v) => H - 3 - (v / mx) * (H - 8);
    const d = vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
    return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="nat-spark-area" d="' + d + " L" + x(vals.length - 1).toFixed(1) + " " + (H - 1) + " L2 " + (H - 1) + ' Z"/>' +
      '<path class="nat-spark-line" d="' + d + '" vector-effect="non-scaling-stroke"/>' +
      '<circle class="nat-spark-end" r="3" cx="' + x(vals.length - 1).toFixed(1) + '" cy="' + y(vals[vals.length - 1]).toFixed(1) + '"/></svg>';
  }

  function liensHtml(m) {
    const ports = m.links.filter((l) => l.role === "nat_port");
    const parIf = {};
    m.links.forEach((l) => parIf[l.interface] = l);
    const series = (hist && hist.links) || {};
    if (!ports.length) return '<div class="nat-card"><span class="nat-h">Liens du NAT</span><span class="nat-note">Aucun port de bouclage déclaré.</span></div>';
    const h = ports.map((p) => {
      const loop = parIf[p.pair] || {};
      return '<div class="nat-link"><span class="nm">' + esc(p.name || p.if_short) + " <small class=\"nat-mono\">" + esc(p.if_short) +
        '</small></span><span class="rt">↗ ' + fmtBps(p.tx_bps) + " · ↙ " + fmtBps(p.rx_bps) + "</span>" +
        spark(series[p.interface], 2) +
        '<span class="nat-note">Bouclage <span class="nat-mono">' + esc(loop.if_short || "?") + "</span> : " + fmtBps(loop.tx_bps) +
        " traduits au total vers ce voisin</span><span></span></div>";
    }).join("");
    const releve = ports.some((p) => p.tx_bps != null);
    return '<div class="nat-card"><span class="nat-h">Liens du NAT · débit réel, cumulé par lien</span><div class="nat-links">' + h + "</div>" +
      '<span class="nat-note">' + (releve ? "↗ vers le voisin, ↙ depuis le voisin (moyenne 30 s du switch). " : "Débits non relevés pour cette source. ") +
      "Ces chiffres sont des CUMULS sur le lien. Il n'existe pas de débit par flux sur ce switch : les politiques NBM sont en " +
      "<code>no policer</code> et <code>show nbm flows statistics</code> reste vide ; la colonne d'état ne dit que présent / absent.</span></div>";
  }

  // ── Traductions ──
  let _idx = null, _idxOf = null;
  function trIndex() {
    if (_idxOf !== data) { _idx = {}; (data.model.translations || []).forEach((t) => _idx[t.key] = t); _idxOf = data; }
    return _idx;
  }
  function famOf(t) {
    return data.model.families.filter((f) => f.keys.includes(t.key)).map((f) => f.key);
  }

  function tradHtml() {
    const a = absence();
    if (a) return a;
    const m = data.model;
    const q = filt.q.trim().toLowerCase();
    let list = m.translations.filter((t) => (!filt.states.size || filt.states.has(t.state)) &&
      (!filt.family || famOf(t).includes(filt.family)) &&
      (!q || JSON.stringify([t.key, nomTr(t), t.outputs.map((o) => o.group + " " + o.oif_name), t.candidates.map((c) => c.source + " " + (c.name || ""))]).toLowerCase().includes(q)));
    list.sort((x, y) => ETATS.indexOf(x.state) - ETATS.indexOf(y.state));
    const total = list.length;
    list = list.slice(0, filt.limit);
    const chips = ETATS.filter((e) => m.counts[e]).map((e) =>
      '<button type="button" class="nat-pill ' + SEV[e] + (filt.states.size && !filt.states.has(e) ? " off" : "") + '" data-st="' + e + '">' +
      esc(LIB[e]) + " · " + m.counts[e] + "</button>").join("");
    const fams = '<select id="nat-fam"><option value="">Toutes les familles</option>' + m.families.map((f) =>
      '<option value="' + esc(f.key) + '"' + (f.key === filt.family ? " selected" : "") + ">" +
      (f.dir === "egress" ? "Sortant " : "Entrant ") + esc(f.mode || "") + " · " + esc(f.name || f.if_short || "") + "</option>").join("") + "</select>";
    const since = data.since || {};
    const rows = list.map((t) => {
      const act = t.candidates.filter((c) => c.state === "live");
      const em = act.length ? act.map((c) => '<div>' + esc(c.name || "") + ' <span class="nat-mono muted">' + esc(c.source) + "</span></div>").join("") :
        '<span class="muted">aucun · ' + t.candidates.length + " candidat" + (t.candidates.length > 1 ? "s" : "") + "</span>";
      const outs = '<div class="nat-out">' + t.outputs.map((o) => '<span class="nat-o"><span class="d ' + o.state + '"></span><span class="nat-mono">' +
        esc(o.group) + (o.udp_dst ? ":" + o.udp_dst : "") + "</span><small>" +
        (nomDe(o.group) && nomDe(o.group) !== nomTr(t) ? esc(nomDe(o.group).name) + " · " : "") + esc(o.oif_name || o.oif_short || "local") +
        (o.receivers ? " · " + o.receivers + " OIF" : "") + "</small></span>").join("") + "</div>";
      const ouvert = filt.open === t.key;
      return '<tr class="nat-row' + (ouvert ? " sel" : "") + '" data-k="' + esc(t.key) + '"><td>' + pill(t.state) +
        (since[t.key] && t.state !== "idle" ? '<div class="muted" style="font-size:.75rem;margin-top:3px">depuis ' + duree(since[t.key]) + "</div>" : "") +
        '</td><td class="m">' + esc(t.in_group) + nomHtml(nomTr(t)) + '</td><td>' + em + '</td><td class="arrow">→</td><td>' + outs + "</td></tr>" +
        (ouvert ? '<tr class="nat-detail"><td colspan="5">' + detailHtml(t) + "</td></tr>" : "");
    }).join("");
    return '<div class="nat-filters">' + chips + fams + '<input type="search" id="nat-q" placeholder="Groupe, serveur, voisin…" value="' + esc(filt.q) + '">' +
      (filt.states.size || filt.family || filt.q ? '<button class="btn" id="nat-clear" type="button">Tout afficher</button>' : "") + "</div>" +
      '<div class="nat-tblwrap"><table class="nat-tbl"><thead><tr><th>État</th><th>Entrée</th><th>Émetteur actif</th><th></th><th>Sorties traduites</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="muted">Aucune traduction ne correspond.</td></tr>') + "</tbody></table></div>" +
      (total > list.length ? '<button class="btn nat-more" id="nat-more" type="button">Afficher ' + Math.min(150, total - list.length) + " de plus (" + (total - list.length) + " restantes)</button>" : "");
  }

  function detailHtml(t) {
    const cands = t.candidates.map((c) => '<span class="nat-cand ' + c.state + '"><span><b>' + esc(c.name || "?") + "</b> " +
      '<span class="nat-mono">' + esc(c.source) + "</span></span><small>" + esc(c.if_short || "") + " · " + esc(FLUX[c.state]) + "</small></span>").join("");
    const outs = '<table class="nat-tbl"><thead><tr><th>Sortie</th><th>Source</th><th>UDP</th><th>Interface</th><th>Flux</th><th>Abonnés</th><th>Matériel</th></tr></thead><tbody>' +
      t.outputs.map((o) => '<tr><td class="m">' + esc(o.group) + '</td><td class="m">' + esc(o.source) + '</td><td class="m">' +
        (o.udp_src || o.udp_dst ? esc((o.udp_src || "—") + " → " + (o.udp_dst || "—")) : "inchangés") + "</td><td>" +
        esc(o.oif_short ? o.oif_short + " " + (o.oif_name || "") : "fabric local") + "</td><td>" + esc(FLUX[o.state]) + "</td><td>" +
        (o.receivers == null ? "—" : o.receivers + " OIF") + (o.nbm_rx != null ? ' <span class="muted">· NBM ' + o.nbm_rx + "</span>" : "") + "</td><td>" +
        (o.hw === true ? '<span class="nat-hw yes">programmée</span>' : o.hw === false ? '<span class="nat-hw no">absente</span>' : '<span class="muted">non vérifiée</span>') +
        "</td></tr>" + (o.shared_with && o.shared_with.length ? '<tr><td colspan="7" class="nat-issue">Aussi alimentée par ' + esc(o.shared_with.join(", ")) + "</td></tr>" : "")).join("") +
      "</tbody></table>";
    return '<div style="display:flex;flex-direction:column;gap:10px">' +
      (t.issues.length ? t.issues.map((i) => '<div class="nat-issue">' + esc(i) + "</div>").join("") : "") +
      '<div><span class="nat-h">Sources candidates (' + t.candidates.length + ")</span><div class=\"nat-cands\" style=\"margin-top:6px\">" + cands + "</div></div>" +
      '<div class="nat-tblwrap">' + outs + "</div></div>";
  }

  // ── 2022-7 ──
  // ── Accueil 2022-7 : la paire d'abord ──
  const nomSrc = (id) => ((overview.sources || []).find((x) => x.id === id) || {}).name || id;
  const pairLabel = (p) => p.label || nomSrc(p.a) + " / " + nomSrc(p.b);
  const ETIQ = { both: ["good", "Deux jambes"], single: ["warning", "Une seule jambe"], none: ["critical", "Aucune jambe"], idle: ["neutral", "Inutilisée"] };
  const CLE = { in: "même groupe d'entrée", out: "même groupe de sortie", suffix: "même fin d'adresse", rank: "même rang dans la famille" };
  const gbps = (b) => b == null ? "—" : (b / 1e9).toFixed(2).replace(".", ",");
  const pct = (e) => (e > 0.005 ? "+" : e < -0.005 ? "−" : "") + Math.abs(e).toFixed(1).replace(".", ",") + " %";

  function paireHtml() {
    const pairs = overview.pairs || [];
    if (!pairs.length) return gestionPairesHtml(true);
    if (!pairSel || !pairs.some((p) => p.pair.id === pairSel)) pairSel = pairs[0].pair.id;
    return (pairs.length > 1 ? '<div class="nat-chips">' + pairs.map((p) => {
      const sm = p.summary || {};
      const sv = !p.ready ? "neutral" : sm.critical ? "critical" : sm.warning ? "warning" : "good";
      return '<button type="button" class="nat-pill ' + sv + (p.pair.id === pairSel ? "" : " off") + '" data-pair="' + esc(p.pair.id) + '">' +
        esc(pairLabel(p.pair)) + (p.ready ? (sm.incidents ? " · " + sm.incidents + " incident" + (sm.incidents > 1 ? "s" : "") : " · OK") : " · en attente") + "</button>";
    }).join("") + "</div>" : "") + '<div id="nat-pair-home" class="nat-content"><div class="meta">Chargement…</div></div>';
  }

  function gestionPairesHtml(seul) {
    const srcs = (overview.sources || []).filter((x) => x.has_nat);
    const pairs = (overview.config || {}).pairs || [];
    const opts = (sel) => srcs.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === sel ? " selected" : "") + ">" + esc(x.name) + "</option>").join("");
    const sugg = (overview.suggestions || []).map((x) => '<div class="nat-actions" style="align-items:center"><span>' + esc(nomSrc(x.a)) + " + " + esc(nomSrc(x.b)) + " — " + x.matched +
      ' traductions appariées (' + esc(CLE[x.key] || x.key) + ')</span><button class="btn btn-green" type="button" data-sugg="' + esc(x.a + "|" + x.b + "|" + x.key) + '">Déclarer cette paire</button></div>').join("");
    const liste = pairs.map((p) => '<div class="nat-actions" style="align-items:center"><span><b>' + esc(pairLabel(p)) + '</b> <span class="muted">A = ' + esc(nomSrc(p.a)) +
      " · B = " + esc(nomSrc(p.b)) + " · " + esc(p.key === "auto" ? "appariement automatique" : CLE[p.key] || p.key) + '</span></span><button class="btn btn-red" type="button" data-pdel="' + esc(p.id) + '">Retirer</button></div>').join("");
    const corps = (seul ? '<div class="nat-note">En 2022-7, deux switchs font chacun le NAT d\'une jambe. Déclarez la paire : l\'accueil montrera alors les deux jambes côte à côte, lien par lien, ' +
      "et alertera si leurs débits divergent." + (srcs.length < 2 ? " Il faut deux sources avec du NAT (switchs ou captures) ; une seule est connue pour l'instant." : "") + "</div>" : "") +
      liste + (sugg ? '<div class="nat-note">Paires plausibles :</div>' + sugg : "") +
      '<div class="nat-form"><label for="nat-pa">Jambe A</label><select id="nat-pa">' + opts(srcs[0] && srcs[0].id) + "</select>" +
      '<label for="nat-pb">Jambe B</label><select id="nat-pb">' + opts(srcs[1] && srcs[1].id) + "</select>" +
      '<label for="nat-pk">Apparier par</label><select id="nat-pk"><option value="auto">automatique (le plus de correspondances)</option>' +
      Object.entries(CLE).map(([k, v]) => '<option value="' + k + '">' + esc(v) + "</option>").join("") + "</select>" +
      '<label for="nat-pl">Nom</label><input id="nat-pl" type="text" placeholder="ex. Spine A / Spine B"></div>' +
      '<div class="nat-actions"><button class="btn btn-green" id="nat-padd" type="button">Ajouter la paire</button></div>';
    return seul ? '<div class="nat-card"><span class="nat-h">Déclarer une paire 2022-7</span>' + corps + "</div>" :
      '<details class="nat-card" data-keep="gestion"><summary class="nat-h" style="cursor:pointer">Gérer les paires</summary>' + corps + "</details>";
  }

  async function loadPairHome() {
    const box = $("#nat-pair-home");
    if (!box || !pairSel) return;
    let r, h;
    try {
      [r, h] = await Promise.all([CTX.api("pair/" + encodeURIComponent(pairSel)),
        CTX.api("history?sid=" + encodeURIComponent("pair:" + pairSel)).catch(() => null)]);
    } catch (e) { box.innerHTML = '<div class="nat-err">' + esc(e.message) + "</div>"; return; }
    if (!EL || tab !== "paire") return;
    if (!r.ready) { box.innerHTML = '<div class="nat-note">Les deux jambes n\'ont pas encore été relevées.</div>' + gestionPairesHtml(false); bindPaires(); return; }
    await loadNames(r.pairs.flatMap((p) => [p.a, p.b, ...p.a_out, ...p.b_out]));
    if (!EL || tab !== "paire") return;
    // Le contenu est remplacé d'un bloc, à hauteur égale : la page ne bouge pas. Les sections
    // qu'on avait dépliées le restent.
    const ouvertes = new Set([...box.querySelectorAll("details[data-keep][open]")].map((d) => d.dataset.keep));
    box.innerHTML = tuilesHtml(r) + synoptiqueHtml(r) + liensJumelesHtml(r, h) +
      '<div class="nat-grid2">' + bandesHtml(r) + incidentsHtml(r) + "</div>" + fluxParFluxHtml(r) + gestionPairesHtml(false);
    box.querySelectorAll("details[data-keep]").forEach((d) => { if (ouvertes.has(d.dataset.keep)) d.open = true; });
    bindPaires();
    bindPf();
    box.querySelectorAll("[data-twin]").forEach((el) => el.onclick = () => {
      const [cote, k] = el.dataset.twin.split("|");
      curId = cote === "b" ? r.pair.b : r.pair.a; renderSelect();
      loadSource().then(() => ouvrir(k));
    });
  }

  function tuilesHtml(r) {
    const sm = r.summary;
    const tuile = (cls, titre, val, sous) => '<div class="nat-tile ' + cls + '"><span class="nat-h">' + titre + '</span><span class="big">' + val + '</span><span class="sub">' + sous + "</span></div>";
    return '<div class="nat-tiles">' +
      tuile(sm.critical ? "crit" : sm.warning ? "warn" : "ok", "État de la paire", sm.incidents ? sm.incidents + " incident" + (sm.incidents > 1 ? "s" : "") : "Tout tient",
        sm.incidents ? sm.critical + " critique · " + sm.warning + " attention" : "deux jambes saines") +
      tuile(sm.single || sm.none ? "warn" : "", "Flux doublés", sm.both + ' <small>/ ' + sm.used + " utilisés</small>",
        (sm.single ? sm.single + " sur une seule jambe" : "aucun sur une seule jambe") + (sm.none ? " · " + sm.none + " sur aucune" : "")) +
      tuile(sm.links_judged && sm.links_sym < sm.links_judged ? "warn" : "", "Liens symétriques", sm.links_sym + " <small>/ " + sm.links_judged + "</small>",
        "tolérance ±" + String(sm.asym_pct).replace(".", ",") + " % pendant " + ((overview.config || {}).grace_polls || 2) + " relevés") +
      tuile(sm.legs_read < 2 ? "crit" : "", "Jambes", sm.legs_read + " <small>/ 2 lues</small>",
        "relevé le plus ancien : " + age(Math.min(r.legs.a.at || 0, r.legs.b.at || 0) || null)) + "</div>";
  }

  function ports(r) {
    const vus = {}, res = [];
    r.links.forEach((l) => {
      const k = l.a_if + "|" + l.b_if;
      if (!vus[k]) { vus[k] = { a_if: l.a_if_short, b_if: l.b_if_short, a_name: l.a_name, b_name: l.b_name }; res.push(vus[k]); }
      vus[k][l.dir] = l;
    });
    return res;
  }

  function synoptiqueHtml(r) {
    const ps = ports(r), n = Math.max(1, ps.length);
    const fautif = (l, cote) => l && l.state === "asym" && (!l.causes.length || l.causes.some((c) => c.missing === cote));
    const jambe = (cote, o) => {
      const L = r.legs[cote], c = L.counts || {};
      let h = '<div class="nat-syn-wire" style="grid-column:2;grid-row:' + (o + 1) + " / span " + n + '"><span class="ln"></span></div>' +
        '<div class="nat-syn-card leg-' + cote + '" style="grid-column:3;grid-row:' + (o + 1) + " / span " + n + '"><span><b>Spine ' + cote.toUpperCase() + "</b> " +
        '<span class="nat-mono muted" style="font-size:.78rem">' + esc(L.hostname || L.name) + "</span></span>" +
        '<span class="muted" style="font-size:.82rem">' + (c.ok || 0) + " traductions OK" + (L.emitters ? " · " + L.emitters_live + " émetteurs actifs" : "") + "</span>" +
        (pb(c) ? '<span style="font-size:.82rem;color:var(--nat-crit)">' + pb(c) + " en défaut</span>" : "") + "</div>";
      ps.forEach((p, i) => {
        const tx = p.tx, rx = p.rx, mal = fautif(tx, cote) || fautif(rx, cote);
        const ecarts = [tx, rx].filter((l) => l && l.state === "asym").map((l) => "écart " + pct(l.ecart_pct));
        const v = (l) => l ? (cote === "a" ? l.a_bps : l.b_bps) : null;
        const inconnu = !tx || tx.state === "unknown";
        h += '<div class="nat-syn-link ' + (inconnu ? "idle" : mal ? "warn" : "ok") + '" style="grid-column:4;grid-row:' + (o + i + 1) + '">' +
          '<span class="lbl nat-mono">' + (inconnu ? "débit non relevé" : "↗ " + gbps(v(tx)) + " · ↙ " + gbps(v(rx)) + " Gb/s" + (mal && ecarts.length ? " · " + ecarts.join(" / ") : "")) + "</span>" +
          '<span class="ln"></span></div>' +
          '<div class="nat-syn-card' + (mal ? " warn" : "") + '" style="grid-column:5;grid-row:' + (o + i + 1) + '"><span><b>' + esc((cote === "a" ? p.a_name : p.b_name) || "?") +
          '</b></span><span class="nat-mono muted" style="font-size:.78rem">' + esc(cote === "a" ? p.a_if : p.b_if) + "</span></div>";
      });
      return h;
    };
    const A = r.legs.a, B = r.legs.b;
    return '<section class="nat-card"><span class="nat-h">Les deux jambes · trait plein = symétrique, pointillé orange = écart</span>' +
      '<div class="nat-syn" style="grid-template-rows:repeat(' + 2 * n + ', minmax(64px, auto))">' +
      '<div class="nat-syn-card" style="grid-column:1;grid-row:1 / span ' + 2 * n + '"><span><b>Émetteurs locaux</b></span><span class="muted" style="font-size:.82rem">' +
      Math.max(A.emitters, B.emitters) + " possibles</span>" + '<span style="font-size:.82rem">actifs : A ' + A.emitters_live + " · B " + B.emitters_live + "</span></div>" +
      jambe("a", 0) + jambe("b", n) + "</div></section>";
  }

  function liensJumelesHtml(r, h) {
    if (!r.links.length) return '<div class="nat-note">Aucun lien NAT apparié entre les deux jambes (ports de bouclage non déclarés).</div>';
    const seuil = r.summary.asym_pct, R = Math.max(8, Math.ceil(seuil * 4));
    const pos = (e) => ((Math.max(-R, Math.min(R, e)) + R) / (2 * R) * 100).toFixed(1) + "%";
    const series = (h && h.links) || {};
    const carte = (l) => {
      const ps = l.state === "asym" ? "warning" : l.state === "sym" ? "good" : "neutral";
      const etat = { asym: "Asymétrique", sym: "Symétrique", idle: "Au repos", unknown: "Non relevé" }[l.state];
      const voisin = l.a_name === l.b_name ? l.a_name : l.a_name + " / " + l.b_name;
      const titre = (l.dir === "tx" ? "Vers " : "Depuis ") + (voisin || l.a_if_short) + (l.dir === "tx" ? " · sortant" : " · entrant");
      const route = (cote) => {
        const L = r.legs[cote], itf = cote === "a" ? l.a_if_short : l.b_if_short, vz = cote === "a" ? l.a_name : l.b_name;
        return l.dir === "tx" ? esc(L.hostname || L.name) + " " + esc(itf) + " → " + esc(vz) : esc(vz) + " → " + esc(L.hostname || L.name) + " " + esc(itf);
      };
      let jauge = "";
      if (l.ecart_pct != null) {
        const pts = (series[l.key] || []).slice(-120).map((p) => p[1] ? (p[2] - p[1]) / p[1] * 100 : 0);
        const y = (e) => (22 - Math.max(-R, Math.min(R, e)) / R * 20).toFixed(1);
        const d = pts.length > 1 ? "M" + pts.map((e, i) => (i / (pts.length - 1) * 300).toFixed(1) + " " + y(e)).join(" L") : "";
        jauge = '<div class="nat-gauge-h"><span>B − A</span><span class="nat-mono" style="color:' + COUL[ps] + ';font-weight:600">' + pct(l.ecart_pct) +
          (l.state === "asym" ? " · " + (l.delta_bps < 0 ? "−" : "+") + gbps(Math.abs(l.delta_bps)) + " Gb/s" : "") +
          // Au-delà de la graduation, l'aiguille reste collée au bord : on le dit, et un écart
          // massif se lit mieux en rapport (« B ≈ 2,0 × A ») qu'en pourcentage.
          (Math.abs(l.ecart_pct) > R ? " · hors échelle" : "") +
          (Math.abs(l.ecart_pct) >= 25 && l.a_bps && l.b_bps ? " · " + (l.b_bps >= l.a_bps ? "B ≈ " + (l.b_bps / l.a_bps).toFixed(1).replace(".", ",") + " × A" :
            "A ≈ " + (l.a_bps / l.b_bps).toFixed(1).replace(".", ",") + " × B") : "") + "</span></div>" +
          '<div class="nat-gauge"><span class="band" style="left:' + pos(-seuil) + ";width:" + (seuil / R * 100).toFixed(2) + '%"></span><span class="zero"></span>' +
          '<span class="needle" style="left:' + pos(l.ecart_pct) + ";background:" + COUL[ps] + '"></span></div>' +
          '<div class="nat-gauge-t nat-mono"><span>−' + R + " %</span><span>0</span><span>+" + R + " %</span></div>" +
          (d ? '<span class="muted" style="font-size:.78rem">Écart sur la dernière heure · bande verte = tolérance</span>' +
            '<svg class="nat-espark" viewBox="0 0 300 44" preserveAspectRatio="none" aria-label="Écart B − A sur la dernière heure">' +
            '<rect x="0" y="' + y(seuil) + '" width="300" height="' + (seuil / R * 40).toFixed(1) + '" class="bandr"></rect>' +
            '<line x1="0" y1="22" x2="300" y2="22" class="axe" vector-effect="non-scaling-stroke"></line>' +
            '<path d="' + d + '" fill="none" style="stroke:' + COUL[ps] + '" stroke-width="2" vector-effect="non-scaling-stroke"></path></svg>' : "");
      } else {
        jauge = '<span class="nat-note">' + (l.state === "idle" ? "Trafic sous le plancher de " + ((overview.config || {}).asym_floor_mbps || 100) + " Mb/s : écart non jugé." : "Débit non relevé sur au moins une jambe.") + "</span>";
      }
      const causes = l.causes.length ? '<div class="nat-note">Cause probable : ' + l.causes.slice(0, 4).map((c) => {
        const n = nomDe(c.a) || nomDe(c.b);
        return '<span class="nat-mono">' + esc(c.missing === "b" ? c.b : c.a) + "</span>" + (n ? " (" + esc(n.name) + ")" : "") + " absent sur " + c.missing.toUpperCase();
      }).join(", ") + (l.causes.length > 4 ? "…" : "") + "</div>" : "";
      return '<article class="nat-lcard ' + ps + '"><div class="nat-actions" style="align-items:center"><b>' + esc(titre) + '</b><span class="nat-spacer"></span>' + pill(ps === "good" ? "ok" : ps === "warning" ? "multi" : "idle", etat) + "</div>" +
        '<div class="nat-legrows"><span class="nat-leg2 a">A</span><span class="r">' + route("a") + '</span><span class="nat-mono v">' + gbps(l.a_bps) + " Gb/s</span>" +
        '<span class="nat-leg2 b">B</span><span class="r">' + route("b") + '</span><span class="nat-mono v">' + gbps(l.b_bps) + " Gb/s</span></div>" + jauge + causes + "</article>";
    };
    const ordre = { asym: 0, sym: 1, idle: 2, unknown: 3 };
    return '<section style="display:flex;flex-direction:column;gap:10px"><span class="nat-h">Liens 2022-7 · ce que B porte par rapport à A</span>' +
      '<div class="nat-lcards">' + r.links.slice().sort((a, b) => ordre[a.state] - ordre[b.state] || (a.dir === "tx" ? -1 : 1)).map(carte).join("") + "</div>" +
      '<span class="nat-note">Débit réel lu sur chaque port (moyenne 30 s), cumulé sur le lien : il n\'existe pas de débit par flux sur ces switchs. Les deux jambes portent les mêmes flux : leurs débits doivent coïncider.</span></section>';
  }

  function bandesHtml(r) {
    const fams = {};
    r.pairs.forEach((p) => {
      const k = (p.dir === "egress" ? "Sortant " : "Entrant ") + (p.mode || "");
      (fams[k] = fams[k] || []).push(p);
    });
    const legSev = (st) => SEV[st] || "neutral";
    return '<section class="nat-card"><span class="nat-h">Flux par jambe · A en haut, B en bas</span>' + Object.entries(fams).map(([k, ps]) => {
      const c = { both: 0, single: 0, none: 0, idle: 0 };
      ps.forEach((p) => c[p.state]++);
      const res = [c.both + " doublés", c.single ? c.single + " sur une seule jambe" : "", c.none ? c.none + " sur aucune" : "", c.idle ? c.idle + " inutilisés" : ""].filter(Boolean).join(" · ");
      return '<div style="display:flex;flex-direction:column;gap:5px"><div style="font-size:.85rem"><b>' + esc(k) + '</b> <span class="muted">' + esc(res) + "</span></div>" +
        '<div class="nat-twins">' + ps.map((p) => {
          const n = nomDe(p.a) || nomDe(p.b);
          return '<button type="button" class="nat-twin" data-twin="a|' + esc(p.a) + '" title="' +
            esc(p.a + (p.b !== p.a ? " / " + p.b : "") + (n ? " — " + n.name : "") + " — " + ETIQ[p.state][1]) + '"><i class="' + legSev(p.a_state) + '"></i><i class="' + legSev(p.b_state) + '"></i></button>';
        }).join("") + "</div></div>";
    }).join("") + "</section>";
  }

  function incidentsHtml(r) {
    const cle = (k) => {
      const [a, b] = k, n = nomDe(a) || nomDe(b);
      return '<span class="nat-mono">' + esc(a === b ? a : a + " / " + b) + "</span>" + (n ? " " + esc(n.name) : "");
    };
    return '<section class="nat-card"><span class="nat-h">Incidents en cours</span>' + (r.incidents.length ? r.incidents.map((i) =>
      '<div class="nat-inc ' + i.severity + '"><span class="nat-pill ' + i.severity + '">' + (i.severity === "critical" ? "Critique" : "Attention") + "</span><div><b>" + esc(i.title) + "</b>" +
      (i.detail ? '<div class="muted" style="font-size:.84rem">' + esc(i.detail) + "</div>" : "") +
      (i.keys && i.keys.length ? '<div style="font-size:.82rem;margin-top:3px">' + i.keys.slice(0, 6).map(cle).join(" · ") + (i.keys.length > 6 ? " · +" + (i.keys.length - 6) : "") + "</div>" : "") +
      "</div></div>").join("") : '<span class="nat-note">Aucun incident : chaque flux utilisé tient sur ses deux jambes, et les liens sont symétriques.</span>') + "</section>";
  }

  // « Flux par flux » : filtres et tri conservés d'un rafraîchissement à l'autre.
  let pfilt = { states: new Set(), src: "", fam: "", q: "", tri: "etat" };
  let pairData = null;
  const ORDRE_PAIRE = { none: 0, single: 1, both: 2, idle: 3 };
  const ipNum = (g) => String(g).split(".").reduce((a, x) => a * 256 + (+x || 0), 0);
  const famP = (p) => (p.dir === "egress" ? "Sortant " : "Entrant ") + (p.mode || "");
  const emetteurP = (p) => p.a_name || p.b_name || "";
  const nomPlanP = (p) => nomDe(p.a) || nomDe(p.b) || p.a_out.concat(p.b_out).map(nomDe).find(Boolean) || null;

  function fluxParFluxHtml(r) {
    pairData = r;
    return '<details class="nat-card" data-keep="flux"><summary class="nat-h" style="cursor:pointer">Flux par flux · ' + r.pairs.length + " paires · " + esc(CLE[r.key_used] || r.key_used) + "</summary>" +
      (r.only_a.length || r.only_b.length ? '<span class="nat-note">' + (r.only_a.length ? r.only_a.length + " traduction(s) sans jumelle sur " + esc(nomSrc(r.pair.a)) + ". " : "") +
        (r.only_b.length ? r.only_b.length + " sur " + esc(nomSrc(r.pair.b)) + "." : "") + "</span>" : "") +
      '<div class="nat-filters"><span id="nat-pf-chips" class="nat-chips">' + pfChips() + "</span>" + pfSelects() +
      '<input type="search" id="nat-pf-q" placeholder="Groupe, émetteur, nom du plan…" value="' + esc(pfilt.q) + '" aria-label="Rechercher un flux"></div>' +
      '<div id="nat-pf-body">' + pfBody() + "</div></details>";
  }

  function pfChips() {
    const c = { both: 0, single: 0, none: 0, idle: 0 };
    pairData.pairs.forEach((p) => c[p.state]++);
    return ["none", "single", "both", "idle"].filter((k) => c[k]).map((k) => '<button type="button" class="nat-pill ' + ETIQ[k][0] +
      (pfilt.states.size && !pfilt.states.has(k) ? " off" : "") + '" data-pfst="' + k + '">' + ETIQ[k][1] + " · " + c[k] + "</button>").join("");
  }

  function pfSelects() {
    const ems = {}, fams = {};
    pairData.pairs.forEach((p) => {
      // Un flux compte une fois par émetteur, même quand les deux jambes le citent.
      new Set([p.a_name, p.b_name].filter(Boolean)).forEach((n) => { ems[n] = (ems[n] || 0) + 1; });
      fams[famP(p)] = (fams[famP(p)] || 0) + 1;
    });
    const sansEm = pairData.pairs.filter((p) => !emetteurP(p)).length;
    const opt = (v, lib, sel) => '<option value="' + esc(v) + '"' + (v === sel ? " selected" : "") + ">" + esc(lib) + "</option>";
    return '<select id="nat-pf-src" aria-label="Émetteur">' + opt("", "Tous les émetteurs", pfilt.src) +
      Object.keys(ems).sort((a, b) => a.localeCompare(b, "fr", { numeric: true })).map((n) => opt(n, n + " (" + ems[n] + ")", pfilt.src)).join("") +
      (sansEm ? opt("—", "Sans émetteur actif (" + sansEm + ")", pfilt.src) : "") + "</select>" +
      '<select id="nat-pf-fam" aria-label="Famille">' + opt("", "Toutes les familles", pfilt.fam) +
      Object.keys(fams).map((f) => opt(f, f + " (" + fams[f] + ")", pfilt.fam)).join("") + "</select>" +
      '<label class="muted" for="nat-pf-tri" style="font-size:.85rem">Trier par</label><select id="nat-pf-tri">' +
      opt("etat", "état (problèmes d'abord)", pfilt.tri) + opt("entree", "adresse d'entrée", pfilt.tri) + opt("emetteur", "émetteur", pfilt.tri) + opt("nom", "nom du plan", pfilt.tri) + "</select>";
  }

  function pfBody() {
    const r = pairData, legSev = (st) => SEV[st] || "neutral";
    const q = pfilt.q.trim().toLowerCase();
    const nomP = (k, outs) => nomDe(k) || outs.map(nomDe).find(Boolean) || null;
    let lignes = r.pairs.filter((p) => (!pfilt.states.size || pfilt.states.has(p.state)) &&
      (!pfilt.fam || famP(p) === pfilt.fam) &&
      (!pfilt.src || (pfilt.src === "—" ? !emetteurP(p) : p.a_name === pfilt.src || p.b_name === pfilt.src)) &&
      (!q || [p.a, p.b, ...p.a_out, ...p.b_out, p.a_name, p.b_name, (nomPlanP(p) || {}).name, (nomPlanP(p) || {}).detail]
        .some((x) => x && String(x).toLowerCase().includes(q))));
    const parIp = (a, b) => ipNum(a.a) - ipNum(b.a);
    const tris = {
      etat: (a, b) => ORDRE_PAIRE[a.state] - ORDRE_PAIRE[b.state] || parIp(a, b),
      entree: parIp,
      emetteur: (a, b) => (emetteurP(a) || "￿").localeCompare(emetteurP(b) || "￿", "fr", { numeric: true }) || parIp(a, b),
      nom: (a, b) => ((nomPlanP(a) || {}).name || "￿").localeCompare((nomPlanP(b) || {}).name || "￿", "fr", { numeric: true }) || parIp(a, b),
    };
    lignes = lignes.sort(tris[pfilt.tri] || tris.etat);
    const total = lignes.length;
    return '<span class="nat-note">' + (total === r.pairs.length ? total + " flux" : total + " flux sur " + r.pairs.length) +
      (total > 400 ? " — les 400 premiers affichés" : "") +
      (pfilt.states.size || pfilt.src || pfilt.fam || pfilt.q ? ' · <button type="button" class="btn" id="nat-pf-clear">Tout afficher</button>' : "") + "</span>" +
      '<div class="nat-tblwrap"><table class="nat-tbl"><thead><tr><th>Jambes</th><th>' + esc(nomSrc(r.pair.a)) + "</th><th>" + esc(nomSrc(r.pair.b)) + "</th><th></th></tr></thead><tbody>" +
      (lignes.slice(0, 400).map((p) => '<tr><td><span class="nat-legs"><span class="nat-leg ' + legSev(p.a_state) + '">A</span><span class="nat-leg ' + legSev(p.b_state) + '">B</span></span></td>' +
        '<td><span class="nat-mono">' + esc(p.a) + " → " + esc(p.a_out.join(", ")) + '</span><div class="muted" style="font-size:.78rem">' + esc(LIB[p.a_state]) + (p.a_name ? " · " + esc(p.a_name) : "") + "</div>" + nomHtml(nomP(p.a, p.a_out)) + "</td>" +
        '<td><span class="nat-mono">' + esc(p.b) + " → " + esc(p.b_out.join(", ")) + '</span><div class="muted" style="font-size:.78rem">' + esc(LIB[p.b_state]) + (p.b_name ? " · " + esc(p.b_name) : "") + "</div>" + nomHtml(nomP(p.b, p.b_out)) + "</td>" +
        '<td><span class="nat-pill ' + ETIQ[p.state][0] + '">' + ETIQ[p.state][1] + "</span></td></tr>").join("") ||
        '<tr><td colspan="4" class="muted">Aucun flux ne correspond.</td></tr>') + "</tbody></table></div>";
  }

  function bindPf() {
    if (!$("#nat-pf-body")) return;
    const maj = () => {
      $("#nat-pf-body").innerHTML = pfBody();
      $("#nat-pf-chips").innerHTML = pfChips();
      bindPfDyn();
    };
    const bindPfDyn = () => {
      EL.querySelectorAll("[data-pfst]").forEach((b) => b.onclick = () => {
        const k = b.dataset.pfst;
        if (pfilt.states.has(k)) pfilt.states.delete(k); else pfilt.states.add(k);
        maj();
      });
      const clr = $("#nat-pf-clear");
      if (clr) clr.onclick = () => {
        pfilt = { states: new Set(), src: "", fam: "", q: "", tri: pfilt.tri };
        $("#nat-pf-q").value = ""; $("#nat-pf-src").value = ""; $("#nat-pf-fam").value = "";
        maj();
      };
    };
    $("#nat-pf-src").onchange = (e) => { pfilt.src = e.target.value; maj(); };
    $("#nat-pf-fam").onchange = (e) => { pfilt.fam = e.target.value; maj(); };
    $("#nat-pf-tri").onchange = (e) => { pfilt.tri = e.target.value; maj(); };
    const q = $("#nat-pf-q");
    q.oninput = () => { pfilt.q = q.value; clearTimeout(q._t); q._t = setTimeout(maj, 150); };
    bindPfDyn();
  }

  function bindPaires() {
    EL.querySelectorAll("[data-pdel]").forEach((b) => b.onclick = async () => {
      if (!confirm("Retirer cette paire ? Les switchs restent surveillés un par un.")) return;
      try {
        await saveConfig({ pairs: (overview.config.pairs || []).filter((p) => p.id !== b.dataset.pdel) });
        pairSel = null; toast("Paire retirée"); await loadOverview(); renderTabs(); render();
      } catch (e) { if (!e.rightsShown) toast(e.message, "error"); }
    });
  }

  async function saveConfig(patch) {
    overview.config = await CTX.api("config", { method: "PUT", body: patch });
    return overview.config;
  }

  async function ajouterPaire(a, b, key, label) {
    if (!a || !b || a === b) { toast("Choisissez deux sources différentes", "error"); return; }
    const pairs = (overview.config.pairs || []).concat([{ a, b, key: key || "auto", label: label || "" }]);
    try { await saveConfig({ pairs }); toast("Paire déclarée"); await loadOverview(); tab = "paire"; renderTabs(); render(); }
    catch (e) { if (!e.rightsShown) toast(e.message, "error"); }
  }

  // ── Nouveau flux : SDP collé → config + SDP à transmettre (rien n'est écrit) ──
  let sdpEtat = { direction: "egress", target: "", text: "", result: null, sorties: { a: {}, b: {} }, sources: "famille" };

  function copier(txt) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(txt);
    // Hors HTTPS (instance en http://192.168…), l'API presse-papiers est refusée : repli classique.
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } finally { ta.remove(); }
    return Promise.resolve();
  }
  function telecharger(nom, txt) {
    const url = URL.createObjectURL(new Blob([txt], { type: "application/sdp" }));
    const a = document.createElement("a");
    a.href = url; a.download = nom; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sdpCibles() {
    const pairs = ((overview.config || {}).pairs || []).map((p) => ({ id: p.id, lib: "Paire 2022-7 · " + pairLabel(p) }));
    const srcs = (overview.sources || []).filter((x) => x.has_nat).map((x) => ({ id: x.id, lib: x.name + (x.kind === "capture" ? " (capture)" : "") }));
    return pairs.concat(srcs);
  }

  function sdpHtml() {
    const cibles = sdpCibles();
    if (!cibles.length) return '<div class="nat-note">Aucun switch avec du NAT n\'est encore relevé : le générateur copie la forme des règles existantes, il lui en faut.</div>';
    if (!cibles.some((c) => c.id === sdpEtat.target)) sdpEtat.target = (pairSel && cibles.some((c) => c.id === pairSel)) ? pairSel : cibles[0].id;
    const sens = (v, titre, aide) => '<label class="nat-sens' + (sdpEtat.direction === v ? " on" : "") + '"><input type="radio" name="nat-sens" value="' + v + '"' +
      (sdpEtat.direction === v ? " checked" : "") + "><span><b>" + titre + '</b><span class="muted">' + aide + "</span></span></label>";
    return '<div class="nat-card"><span class="nat-h">Préparer un flux à traduire</span>' +
      '<div class="nat-note">Collez un SDP : l\'outil en tire la règle de NAT de chaque spine, copiée sur une traduction voisine de la même famille, et le SDP à transmettre. ' +
      "<b>Rien n'est écrit sur les switchs</b> : la config est à relire, puis à appliquer à la main, une jambe après l'autre.</div>" +
      '<div class="nat-sens-row">' + sens("egress", "Émission", "on envoie un de nos flux à l'extérieur — collez le SDP de notre source") +
      sens("ingress", "Réception", "on reçoit un flux de l'extérieur — collez le SDP reçu de l'autre bout") + "</div>" +
      '<div class="nat-form wide"><label for="nat-sdp-target">Cible</label><select id="nat-sdp-target">' +
      cibles.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === sdpEtat.target ? " selected" : "") + ">" + esc(c.lib) + "</option>").join("") + "</select>" +
      '<label for="nat-sdp-text">SDP<br><span class="muted" style="font-size:.75rem">un SDP 2022-7 (a=group:DUP) donne les deux jambes d\'un coup</span></label>' +
      '<textarea id="nat-sdp-text" spellcheck="false" style="min-height:180px" placeholder="v=0&#10;o=- … IN IP4 …&#10;m=video 5004 RTP/AVP 96&#10;c=IN IP4 239.100.0.17/64&#10;a=source-filter: incl IN IP4 239.100.0.17 192.168.72.62&#10;…">' + esc(sdpEtat.text) + "</textarea>" +
      (sdpEtat.direction === "egress" ? '<label for="nat-sdp-src">Sources</label><select id="nat-sdp-src"><option value="famille"' + (sdpEtat.sources === "famille" ? " selected" : "") +
        ">toutes les sources candidates de la famille (secours entre serveurs)</option><option value=\"sdp\"" + (sdpEtat.sources === "sdp" ? " selected" : "") + ">seulement la source du SDP</option></select>" : "") +
      '</div><div class="nat-actions"><button class="btn btn-green" id="nat-sdp-go" type="button">Préparer</button>' +
      (sdpEtat.result ? '<button class="btn" id="nat-sdp-reset" type="button">Effacer</button>' : "") + "</div></div>" +
      '<div id="nat-sdp-res" class="nat-content">' + (sdpEtat.result ? sdpResultatHtml(sdpEtat.result) : "") + "</div>";
  }

  function sdpResultatHtml(r) {
    let h = (r.errors || []).map((e) => '<div class="nat-err">' + esc(e) + "</div>").join("") +
      (r.warnings || []).map((w) => '<div class="nat-inc warning"><span>' + esc(w) + "</span></div>").join("");
    if ((r.errors || []).length && !(r.legs || []).length) return h;
    h += '<div class="nat-lcards">' + (r.legs || []).map((leg) => {
      const i = leg.input;
      const ent = '<span class="nat-mono">' + esc(i.group) + "</span> depuis <span class=\"nat-mono\">" + esc(i.source || "?") + "</span> · " + esc(i.media) + (i.port ? " · port " + i.port : "");
      const lignes = leg.outputs.map((o, n) => "<tr><td>" + (leg.existing ? '<span class="nat-mono">' + esc(o.group) + "</span>" :
          '<input class="nat-mono" type="text" size="15" data-sortie="' + leg.side + "|" + n + '" value="' + esc(o.group) + '" aria-label="Groupe de sortie">') + "</td>" +
        '<td class="m">' + (o.udp_dst ? esc((o.udp_src || "—") + " → " + o.udp_dst) : "inchangés") + "</td><td>" + esc(o.oif_name || o.oif_short || "fabric local") +
        (o.oif_short && o.oif_name ? ' <span class="muted nat-mono">' + esc(o.oif_short) + "</span>" : "") + "</td><td>" +
        (o.static_join ? "oui" : '<span class="muted">non</span>') + "</td></tr>").join("");
      const modele = leg.template && !leg.existing ? '<span class="nat-note">Forme copiée sur <span class="nat-mono">' + esc(leg.template) + "</span>" +
        (leg.template_outputs ? " → " + leg.template_outputs.map((o) => '<span class="nat-mono">' + esc(o.group) + (o.udp_dst ? ":" + o.udp_dst : "") + "</span>").join(", ") : "") +
        (leg.sources ? " · " + leg.sources.length + " source" + (leg.sources.length > 1 ? "s" : "") + " candidate" + (leg.sources.length > 1 ? "s" : "") : "") + "</span>" : "";
      return '<article class="nat-lcard' + ((leg.errors || []).length ? " warning" : "") + '"><div class="nat-actions" style="align-items:center"><span class="nat-leg2 ' + leg.side + '" style="width:22px">' +
        leg.side.toUpperCase() + "</span><b>" + esc(leg.spine) + '</b><span class="nat-spacer"></span>' +
        (leg.existing ? pill("ok", "Déjà traduit") : pill("idle", "Nouvelle règle")) + "</div>" +
        '<div style="font-size:.88rem">Entrée : ' + ent + "</div>" + modele +
        (leg.errors || []).map((e) => '<div class="nat-issue">' + esc(e) + "</div>").join("") +
        (leg.warnings || []).map((w) => '<div class="nat-note">' + esc(w) + "</div>").join("") +
        (lignes ? '<div class="nat-tblwrap"><table class="nat-tbl"><thead><tr><th>Sortie</th><th>UDP</th><th>Vers</th><th>Join statique</th></tr></thead><tbody>' + lignes + "</tbody></table></div>" : "") +
        "</article>";
    }).join("") + "</div>";
    if ((r.legs || []).some((l) => !l.existing)) h += '<div class="nat-actions"><button class="btn" id="nat-sdp-recalc" type="button">Recalculer avec ces adresses</button>' +
      '<span class="nat-note">Une adresse de sortie est proposée en prolongeant la voisine ; corrigez-la si l\'autre bout en impose une autre.</span></div>';
    const blocs = [];
    Object.entries(r.configs || {}).forEach(([cote, txt]) => blocs.push({ titre: "Config · " + ((r.legs.find((l) => l.side === cote) || {}).spine || cote), txt, nom: null }));
    (r.sdps || []).forEach((x, n) => blocs.push({ titre: "SDP · " + x.title, txt: x.text, nom: "flux-" + (n + 1) + ".sdp" }));
    h += blocs.map((b, n) => '<section class="nat-card"><div class="nat-actions" style="align-items:center"><span class="nat-h">' + esc(b.titre) + '</span><span class="nat-spacer"></span>' +
      '<button class="btn" type="button" data-copy="' + n + '">Copier</button>' + (b.nom ? '<button class="btn" type="button" data-dl="' + n + '">Télécharger</button>' : "") +
      '</div><pre class="nat-pre">' + esc(b.txt) + "</pre></section>").join("");
    sdpEtat._blocs = blocs;
    return h;
  }

  async function sdpPreparer() {
    const box = $("#nat-sdp-res");
    sdpEtat.text = $("#nat-sdp-text").value;
    if (!sdpEtat.text.trim()) { toast("Collez d'abord un SDP", "error"); return; }
    box.innerHTML = '<div class="meta">Préparation…</div>';
    try {
      sdpEtat.result = await CTX.api("sdp", { body: { direction: sdpEtat.direction, target: sdpEtat.target, sdp: sdpEtat.text,
        options: { sorties: sdpEtat.sorties, sources: sdpEtat.sources } } });
    } catch (e) { box.innerHTML = '<div class="nat-err">' + esc(e.message) + "</div>"; return; }
    if (!EL || tab !== "sdp") return;
    box.innerHTML = sdpResultatHtml(sdpEtat.result);
    bindSdpResultat();
  }

  function bindSdpResultat() {
    EL.querySelectorAll("[data-sortie]").forEach((inp) => inp.onchange = () => {
      const [cote, n] = inp.dataset.sortie.split("|");
      sdpEtat.sorties[cote] = sdpEtat.sorties[cote] || {};
      sdpEtat.sorties[cote][n] = inp.value.trim();
    });
    const rc = $("#nat-sdp-recalc");
    if (rc) rc.onclick = sdpPreparer;
    EL.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => copier(sdpEtat._blocs[+b.dataset.copy].txt).then(() => toast("Copié")));
    EL.querySelectorAll("[data-dl]").forEach((b) => b.onclick = () => { const x = sdpEtat._blocs[+b.dataset.dl]; telecharger(x.nom, x.txt); });
  }

  function bindSdp() {
    EL.querySelectorAll('input[name="nat-sens"]').forEach((r) => r.onchange = () => {
      sdpEtat.direction = r.value; sdpEtat.text = $("#nat-sdp-text").value; sdpEtat.result = null; sdpEtat.sorties = { a: {}, b: {} }; render();
    });
    const t = $("#nat-sdp-target");
    if (t) t.onchange = () => { sdpEtat.target = t.value; sdpEtat.sorties = { a: {}, b: {} }; };
    const sr = $("#nat-sdp-src");
    if (sr) sr.onchange = () => { sdpEtat.sources = sr.value; };
    const ta = $("#nat-sdp-text");
    if (ta) ta.oninput = () => { sdpEtat.sorties = { a: {}, b: {} }; };   // nouveau SDP : on oublie les adresses corrigées
    const go = $("#nat-sdp-go");
    if (go) go.onclick = sdpPreparer;
    const rs = $("#nat-sdp-reset");
    if (rs) rs.onclick = () => { sdpEtat = { direction: sdpEtat.direction, target: sdpEtat.target, text: "", result: null, sorties: { a: {}, b: {} }, sources: "famille" }; render(); };
    if (sdpEtat.result) bindSdpResultat();
  }

  // ── Journal ──
  async function loadJournal() {
    let r;
    try { r = await CTX.api("events"); } catch (e) { $("#nat-content").innerHTML = '<div class="nat-err">' + esc(e.message) + "</div>"; return; }
    if (!EL || tab !== "journal") return;
    const ev = r.events || [];
    $("#nat-content").innerHTML = ev.length ? '<div>' + ev.map((e) => '<div class="nat-ev"><span class="nat-mono muted">' + esc(e.ts.replace("T", " ")) +
      '</span><span><span class="nat-pill ' + esc(e.severity) + '">' + esc(e.label) + "</span></span><div><b>" + esc(e.subject) + "</b>" +
      (e.detail ? "<pre>" + esc(e.detail) + "</pre>" : "") + "</div></div>").join("") + "</div>" :
      '<div class="nat-note">Aucun événement. Le journal ne note que les CHANGEMENTS d\'état confirmés (une perte, un rétablissement), pas chaque relevé.</div>';
  }

  // ── Captures ──
  async function loadCaptures() {
    let r;
    try { r = await CTX.api("captures"); } catch (e) { $("#nat-content").innerHTML = '<div class="nat-err">' + esc(e.message) + "</div>"; return; }
    if (!EL || tab !== "captures") return;
    const caps = r.captures || [];
    const champ = (id, lbl, aide) => '<label for="' + id + '">' + lbl + '<br><span class="muted" style="font-size:.75rem">' + aide + "</span></label><textarea id=\"" + id + "\" spellcheck=\"false\"></textarea>";
    $("#nat-content").innerHTML = '<div class="nat-note">Une capture, ce sont des sorties CLI collées à la main, analysées comme un switch — pour un site que cette instance ne joint pas, ou pour garder une photo. ' +
      "Pas d'alerte sur une capture. La config collée est PURGÉE avant enregistrement : seules les lignes <code>service-reflect</code>, le hostname, et la description et l'adresse des interfaces sont conservées.</div>" +
      (caps.length ? '<div class="nat-card"><span class="nat-h">Captures enregistrées</span>' + caps.map((c) => '<div class="nat-actions" style="align-items:center"><span><b>' + esc(c.name) +
        '</b> <span class="muted">' + esc(new Date(c.created * 1000).toLocaleString()) + '</span></span><button class="btn" type="button" data-open="' + esc(c.id) + '">Ouvrir</button>' +
        '<button class="btn btn-red" type="button" data-del="' + esc(c.id) + '">Supprimer</button></div>').join("") + "</div>" : "") +
      '<div class="nat-card"><span class="nat-h">Nouvelle capture</span><div class="nat-form wide">' +
      '<label for="nat-cn">Nom</label><input id="nat-cn" type="text" placeholder="ex. spine-a, 6 oct. 9 h">' +
      champ("nat-cc", "Config *", "<code>show running-config | include service-reflect</code> + <code>show running-config interface</code>, ou la config entière") +
      champ("nat-cs", "Vivacité *", "<code>show ip mroute summary</code>") +
      champ("nat-cb", "NBM", "<code>show nbm flows</code>") +
      champ("nat-cf", "Table matérielle", "<code>show forwarding multicast route</code>") +
      champ("nat-cr", "Débits", "<code>show interface Eth1/28, Eth1/29 | include \"^Ether|rate\"</code>") +
      champ("nat-ci", "Interfaces", "<code>show interface description</code> + <code>show ip interface brief</code> (si la config ne les a pas)") +
      '</div><div class="nat-actions"><button class="btn btn-green" id="nat-csave" type="button">Analyser et enregistrer</button></div></div>';
    $("#nat-csave").onclick = async () => {
      const v = (id) => $("#" + id).value;
      try {
        const r2 = await CTX.api("captures", { body: { name: v("nat-cn"), config: v("nat-cc"), summary: v("nat-cs"), nbm: v("nat-cb"),
          fwd: v("nat-cf"), rates: v("nat-cr"), interfaces: v("nat-ci") } });
        toast("Capture analysée");
        await loadOverview(); curId = r2.id; renderSelect(); await loadSource(); tab = "vue"; renderTabs(); render();
      } catch (e) { if (!e.rightsShown) toast(e.message, "error"); }
    };
    EL.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
      if (!confirm("Supprimer cette capture ?")) return;
      try { await CTX.api("captures/" + encodeURIComponent(b.dataset.del), { method: "DELETE" }); toast("Capture supprimée"); await loadOverview(); await loadSource(); render(); }
      catch (e) { if (!e.rightsShown) toast(e.message, "error"); }
    });
    EL.querySelectorAll("[data-open]").forEach((b) => b.onclick = async () => {
      curId = b.dataset.open; renderSelect(); await loadSource(); tab = "vue"; renderTabs(); render();
    });
  }

  // ── Réglages ──
  async function loadReglages() {
    let al;
    try { al = await CTX.api("alerts"); } catch (e) { al = {}; }
    if (!EL || tab !== "reglages") return;
    const c = overview.config;
    const sws = (overview.sources || []).filter((s) => s.kind === "switch");
    const num = (id, lbl, v, aide) => '<label for="' + id + '">' + lbl + '</label><span><input id="' + id + '" type="number" min="1" value="' + esc(v) +
      '" style="width:90px"> <span class="muted" style="font-size:.8rem">' + aide + "</span></span>";
    $("#nat-content").innerHTML = '<div class="nat-card"><span class="nat-h">Surveillance</span><div class="nat-form wide">' +
      num("nat-poll", "Relevé toutes les", c.poll_seconds, "secondes (15 au moins)") +
      num("nat-grace", "Tolérance", c.grace_polls, "relevés concordants avant de changer d'état — la vivacité NX-OS est un échantillon") +
      num("nat-stat", "Config relue toutes les", c.static_minutes, "minutes") +
      num("nat-hw", "Table matérielle relue toutes les", c.hw_minutes, "minutes") +
      num("nat-burst", "Récapitulatif au-delà de", c.burst, "traductions touchées dans un même relevé (une cause = une alerte)") +
      "</div>" +
      '<span class="nat-h">Switchs interrogés</span><div class="nat-note">Tous les Nexus en NX-API de « Pilotage de switch » sont lus ; ceux sans règle <code>service-reflect</code> sont relus seulement toutes les ' +
      esc(c.static_minutes) + " minutes. Décochez un switch pour ne plus l'interroger du tout.</div>" +
      '<div class="nat-chips">' + sws.map((s) => '<label class="nat-pill neutral" style="cursor:pointer"><input type="checkbox" data-sw="' + esc(s.id) + '"' +
        (c.disabled.includes(s.id) ? "" : " checked") + "> " + esc(s.name) + "</label>").join("") + "</div>" +
      '<div class="nat-actions"><button class="btn btn-green" id="nat-csave2" type="button">Enregistrer</button></div></div>' +
      '<div class="nat-card"><span class="nat-h">Alertes par e-mail</span>' +
      (al.mail_ready ? "" : '<div class="nat-note">Le service Mail n\'est pas branché sur cette instance (jeton absent) : activer l\'option n\'enverrait rien.</div>') +
      '<div class="nat-form wide"><label for="nat-mail">Envoyer</label><span><input type="checkbox" class="ios-toggle" id="nat-mail"' + (al.mail_enabled ? " checked" : "") +
      '> chaque changement d\'état confirmé</span><label for="nat-to">Destinataires</label><input id="nat-to" type="text" value="' + esc(al.mail_to || "") +
      '" placeholder="vide = destinataires par défaut du service Mail"></div>' +
      '<div class="nat-actions"><button class="btn btn-green" id="nat-msave" type="button">Enregistrer</button></div></div>';
    $("#nat-csave2").onclick = async () => {
      const v = (id) => parseInt($("#" + id).value, 10);
      const disabled = sws.filter((s) => !EL.querySelector('[data-sw="' + s.id + '"]').checked).map((s) => s.id);
      try {
        await saveConfig({ poll_seconds: v("nat-poll"), grace_polls: v("nat-grace"), static_minutes: v("nat-stat"),
          hw_minutes: v("nat-hw"), burst: v("nat-burst"), disabled });
        toast("Réglages enregistrés");
      } catch (e) { if (!e.rightsShown) toast(e.message, "error"); }
    };
    $("#nat-msave").onclick = async () => {
      try { await CTX.api("alerts", { method: "PUT", body: { mail_enabled: $("#nat-mail").checked, mail_to: $("#nat-to").value } }); toast("Alertes enregistrées"); }
      catch (e) { if (!e.rightsShown) toast(e.message, "error"); }
    };
  }

  // ── Interactions ──
  function ouvrir(k) {
    filt.open = k; filt.states.clear(); filt.family = ""; filt.q = k; tab = "trad"; renderTabs(); render();
  }

  function bind() {
    EL.querySelectorAll("[data-goto]").forEach((b) => b.onclick = () => {
      filt.states = new Set([b.dataset.goto]); filt.family = ""; filt.q = ""; filt.open = null; tab = "trad"; renderTabs(); render();
    });
    EL.querySelectorAll(".nat-dot").forEach((d) => {
      d.onclick = () => ouvrir(d.dataset.k);
      d.onmouseenter = d.onfocus = (ev) => tip(d, trIndex()[d.dataset.k]);
      d.onmouseleave = d.onblur = () => { $("#nat-tip").hidden = true; };
    });
    EL.querySelectorAll("tr.nat-row").forEach((r) => r.onclick = () => { filt.open = filt.open === r.dataset.k ? null : r.dataset.k; render(); });
    EL.querySelectorAll("[data-st]").forEach((b) => b.onclick = () => {
      const e = b.dataset.st;
      if (filt.states.has(e)) filt.states.delete(e); else filt.states.add(e);
      filt.limit = 150; render();
    });
    const fam = $("#nat-fam");
    if (fam) fam.onchange = () => { filt.family = fam.value; filt.limit = 150; render(); };
    const q = $("#nat-q");
    if (q) q.oninput = () => {
      filt.q = q.value; filt.limit = 150;
      clearTimeout(q._t); q._t = setTimeout(() => { render(); const n = $("#nat-q"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 200);
    };
    const clr = $("#nat-clear");
    if (clr) clr.onclick = () => { filt.states.clear(); filt.family = ""; filt.q = ""; filt.open = null; render(); };
    const more = $("#nat-more");
    if (more) more.onclick = () => { filt.limit += 150; render(); };
    EL.querySelectorAll("[data-pair]").forEach((b) => b.onclick = () => { pairSel = b.dataset.pair; render(); });
    EL.querySelectorAll("[data-sugg]").forEach((b) => b.onclick = () => { const [a, bb, k] = b.dataset.sugg.split("|"); ajouterPaire(a, bb, k, ""); });
    const padd = $("#nat-padd");
    if (padd) padd.onclick = () => ajouterPaire($("#nat-pa").value, $("#nat-pb").value, $("#nat-pk").value, $("#nat-pl").value);
  }

  function tip(el, t) {
    const box = $("#nat-tip");
    if (!t) return;
    const act = t.candidates.filter((c) => c.state === "live");
    const nt = nomTr(t);
    box.innerHTML = "<div><b>" + esc(t.in_group) + "</b> " + pill(t.state) + "</div>" +
      (nt ? "<div>" + esc(nt.name) + (nt.detail ? ' <span class="muted">' + esc(nt.detail) + "</span>" : "") + "</div>" : "") +
      '<div class="muted">' + (act.length ? "émis par " + esc(act.map((c) => c.name || c.source).join(", ")) : "aucun émetteur présent") + "</div>" +
      t.outputs.map((o) => "<div>→ <b>" + esc(o.group) + "</b> " + esc(FLUX[o.state]) + (o.oif_name ? " · " + esc(o.oif_name) : "") + "</div>").join("") +
      (t.issues.length ? '<div style="color:var(--nat-crit)">' + esc(t.issues[0]) + "</div>" : "");
    box.hidden = false;
    const r = el.getBoundingClientRect();
    const w = box.offsetWidth, hh = box.offsetHeight;
    let x = r.left + r.width / 2 - w / 2, y = r.top - hh - 8;
    if (y < 8) y = r.bottom + 8;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    box.style.left = x + "px"; box.style.top = y + "px";
  }

  async function refresh(force) {
    try {
      if (force) { await CTX.api("poll", { method: "POST", body: {} }); await new Promise((r) => setTimeout(r, 2500)); }
      await loadOverview(); await loadSource();
      if (tab === null) { tab = (overview.pairs || []).length ? "paire" : "vue"; renderTabs(); }
      if (tab === "paire" && !force && $("#nat-pair-home")) { renderFresh(); loadPairHome(); }
      else if (["vue", "trad", "paire"].includes(tab)) render(); else renderFresh();
    } catch (e) {
      if (EL) $("#nat-content").innerHTML = '<div class="nat-err">' + esc(e.message) + "</div>";
    }
  }

  function mount(el, ctx) {
    EL = el; CTX = ctx; overview = null; data = null; tab = null; curId = null;
    filt = { states: new Set(), family: "", q: "", open: null, limit: 150 };
    noms = {};
    renderTabs();
    $("#nat-refresh").onclick = () => refresh(true);
    refresh(false);
    // Rafraîchissement discret : seulement sur les vues d'état, et pas dans un onglet caché.
    timer = setInterval(() => {
      if (!EL || document.hidden || !["vue", "paire"].includes(tab)) return;
      // Pas de mise à jour pendant une saisie (déclaration de paire) : elle effacerait le champ.
      const actif = document.activeElement;
      if (actif && EL.contains(actif) && /^(INPUT|SELECT|TEXTAREA)$/.test(actif.tagName)) return;
      if (tab === "trad" && filt.open) return;
      refresh(false);
    }, 20000);
  }

  function unmount() {
    clearInterval(timer); timer = null; EL = null; CTX = null; overview = null; data = null;
  }

  window.BTTools["mcast_nat"] = { mount, unmount };
})();
