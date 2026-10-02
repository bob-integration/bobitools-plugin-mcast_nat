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

  const esc = (s) => (window.BT ? window.BT.esc(s) : String(s == null ? "" : s));
  const $ = (sel) => EL.querySelector(sel);
  const toast = (m, k) => CTX.toast(m, k || "info");

  const TABS = [["vue", "Vue d'ensemble"], ["trad", "Traductions"], ["red", "2022-7"],
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
      else if (tab === "red") { c.innerHTML = redHtml(); loadPairDetail(); }
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
      (!q || JSON.stringify([t.key, t.outputs.map((o) => o.group + " " + o.oif_name), t.candidates.map((c) => c.source + " " + (c.name || ""))]).toLowerCase().includes(q)));
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
        esc(o.group) + (o.udp_dst ? ":" + o.udp_dst : "") + "</span><small>" + esc(o.oif_name || o.oif_short || "local") +
        (o.receivers ? " · " + o.receivers + " OIF" : "") + "</small></span>").join("") + "</div>";
      const ouvert = filt.open === t.key;
      return '<tr class="nat-row' + (ouvert ? " sel" : "") + '" data-k="' + esc(t.key) + '"><td>' + pill(t.state) +
        (since[t.key] && t.state !== "idle" ? '<div class="muted" style="font-size:.75rem;margin-top:3px">depuis ' + duree(since[t.key]) + "</div>" : "") +
        '</td><td class="m">' + esc(t.in_group) + '</td><td>' + em + '</td><td class="arrow">→</td><td>' + outs + "</td></tr>" +
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
  function redHtml() {
    const pairs = overview.pairs || [];
    const srcs = (overview.sources || []).filter((s) => s.has_nat);
    const nom = (id) => ((overview.sources || []).find((s) => s.id === id) || {}).name || id;
    let h = '<div class="nat-note">En 2022-7, deux switchs font chacun le NAT d\'une jambe. Une paire associe leurs traductions et montre, pour chaque flux, ' +
      "si les deux jambes tiennent. Une jambe illisible (switch injoignable) n'est jamais comptée comme morte.</div>";
    if (!pairs.length) h += '<div class="nat-card"><span class="nat-h">Aucune paire déclarée</span><span class="nat-note">' +
      (srcs.length < 2 ? "Il faut deux sources avec du NAT (switchs ou captures). Une seule est connue pour l'instant." : "Déclarez la paire ci-dessous.") + "</span></div>";
    else {
      if (!pairSel || !pairs.some((p) => p.pair.id === pairSel)) pairSel = pairs[0].pair.id;
      h += '<div class="nat-chips">' + pairs.map((p) => {
        const c = p.counts || {};
        const s = !p.ready ? "neutral" : c.none ? "critical" : c.single ? "warning" : "good";
        return '<button type="button" class="nat-pill ' + s + (p.pair.id === pairSel ? "" : " off") + '" data-pair="' + esc(p.pair.id) + '">' +
          esc(p.pair.label || nom(p.pair.a) + " / " + nom(p.pair.b)) + (p.ready ? " · " + (c.both || 0) + " doublées" : " · en attente") + "</button>";
      }).join("") + "</div>" + '<div id="nat-pair-detail"><div class="meta">Chargement…</div></div>';
    }
    const opts = (sel) => srcs.map((s) => '<option value="' + esc(s.id) + '"' + (s.id === sel ? " selected" : "") + ">" + esc(s.name) + "</option>").join("");
    const sugg = (overview.suggestions || []).map((s) => '<div class="nat-actions"><span>' + esc(nom(s.a)) + " + " + esc(nom(s.b)) + " — " + s.matched +
      ' traductions appariées</span><button class="btn btn-green" type="button" data-sugg="' + esc(s.a + "|" + s.b + "|" + s.key) + '">Déclarer cette paire</button></div>').join("");
    h += '<div class="nat-card"><span class="nat-h">Déclarer une paire</span>' + (sugg ? '<div class="nat-note">Paires plausibles trouvées :</div>' + sugg : "") +
      '<div class="nat-form"><label for="nat-pa">Jambe A</label><select id="nat-pa">' + opts(srcs[0] && srcs[0].id) + "</select>" +
      '<label for="nat-pb">Jambe B</label><select id="nat-pb">' + opts(srcs[1] && srcs[1].id) + "</select>" +
      '<label for="nat-pk">Apparier par</label><select id="nat-pk"><option value="auto">automatique (le plus de correspondances)</option>' +
      '<option value="in">même groupe d\'entrée</option><option value="out">même groupe de sortie</option><option value="rank">même rang dans la famille</option></select>' +
      '<label for="nat-pl">Nom</label><input id="nat-pl" type="text" placeholder="ex. Spine A / Spine B"></div>' +
      '<div class="nat-actions"><button class="btn btn-green" id="nat-padd" type="button">Ajouter la paire</button></div></div>';
    return h;
  }

  async function loadPairDetail() {
    const box = $("#nat-pair-detail");
    if (!box || !pairSel) return;
    let r;
    try { r = await CTX.api("pair/" + encodeURIComponent(pairSel)); } catch (e) { box.innerHTML = '<div class="nat-err">' + esc(e.message) + "</div>"; return; }
    if (!EL || tab !== "red") return;
    const nom = (id) => ((overview.sources || []).find((s) => s.id === id) || {}).name || id;
    if (!r.ready) { box.innerHTML = '<div class="nat-note">Les deux jambes n\'ont pas encore été relevées.</div>'; return; }
    const c = r.counts, legSev = (st) => SEV[st] || "neutral";
    const ordre = { none: 0, single: 1, both: 2, idle: 3 };
    const lignes = r.pairs.slice().sort((a, b) => ordre[a.state] - ordre[b.state]);
    const etiquette = { both: ["good", "Deux jambes"], single: ["warning", "Une seule jambe"], none: ["critical", "Aucune jambe"], idle: ["neutral", "Inutilisée"] };
    box.innerHTML = '<div class="nat-card"><div class="nat-chips">' +
      ["none", "single", "both", "idle"].filter((k) => c[k]).map((k) => '<span class="nat-pill ' + etiquette[k][0] + '">' + etiquette[k][1] + " · " + c[k] + "</span>").join("") +
      '</div><span class="nat-note">Appariement : ' + esc({ in: "même groupe d'entrée", out: "même groupe de sortie", rank: "même rang dans la famille" }[r.key_used] || r.key_used) +
      ". " + (r.only_a.length ? r.only_a.length + " traduction(s) sans jumelle sur " + esc(nom(r.pair.a)) + ". " : "") +
      (r.only_b.length ? r.only_b.length + " sur " + esc(nom(r.pair.b)) + ". " : "") +
      (r.a_error || r.b_error ? "Relevé en échec sur une jambe : son dernier état connu est affiché." : "") + "</span>" +
      '<div class="nat-twins" aria-label="Une colonne par flux : A en haut, B en bas">' + r.pairs.map((p) =>
        '<span class="nat-twin" title="' + esc(p.a + " / " + p.b + " — " + etiquette[p.state][1]) + '"><i class="' + legSev(p.a_state) + '"></i><i class="' +
        legSev(p.b_state) + '"></i></span>').join("") + '</div><span class="nat-note">Une colonne par flux : jambe A en haut, jambe B en bas.</span>' +
      '<div class="nat-tblwrap"><table class="nat-tbl"><thead><tr><th>Jambes</th><th>' + esc(nom(r.pair.a)) + "</th><th>" + esc(nom(r.pair.b)) + "</th><th></th></tr></thead><tbody>" +
      lignes.slice(0, 400).map((p) => '<tr><td><span class="nat-legs"><span class="nat-leg ' + legSev(p.a_state) + '">A</span><span class="nat-leg ' + legSev(p.b_state) + '">B</span></span></td>' +
        '<td><span class="nat-mono">' + esc(p.a) + " → " + esc(p.a_out.join(", ")) + '</span><div class="muted" style="font-size:.78rem">' + esc(LIB[p.a_state]) + (p.a_name ? " · " + esc(p.a_name) : "") + "</div></td>" +
        '<td><span class="nat-mono">' + esc(p.b) + " → " + esc(p.b_out.join(", ")) + '</span><div class="muted" style="font-size:.78rem">' + esc(LIB[p.b_state]) + (p.b_name ? " · " + esc(p.b_name) : "") + "</div></td>" +
        "<td>" + '<span class="nat-pill ' + etiquette[p.state][0] + '">' + etiquette[p.state][1] + "</span></td></tr>").join("") +
      "</tbody></table></div>" +
      '<div class="nat-actions"><button class="btn btn-red" type="button" id="nat-pdel">Retirer cette paire</button></div></div>';
    $("#nat-pdel").onclick = async () => {
      const cfg = overview.config;
      await saveConfig({ pairs: (cfg.pairs || []).filter((p) => p.id !== pairSel) });
      pairSel = null; toast("Paire retirée"); await loadOverview(); render();
    };
  }

  async function saveConfig(patch) {
    overview.config = await CTX.api("config", { method: "PUT", body: patch });
    return overview.config;
  }

  async function ajouterPaire(a, b, key, label) {
    if (!a || !b || a === b) { toast("Choisissez deux sources différentes", "error"); return; }
    const pairs = (overview.config.pairs || []).concat([{ a, b, key: key || "auto", label: label || "" }]);
    try { await saveConfig({ pairs }); toast("Paire déclarée"); await loadOverview(); render(); }
    catch (e) { if (!e.rightsShown) toast(e.message, "error"); }
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
    box.innerHTML = "<div><b>" + esc(t.in_group) + "</b> " + pill(t.state) + "</div>" +
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
      if (["vue", "trad", "red"].includes(tab)) render(); else renderFresh();
    } catch (e) {
      if (EL) $("#nat-content").innerHTML = '<div class="nat-err">' + esc(e.message) + "</div>";
    }
  }

  function mount(el, ctx) {
    EL = el; CTX = ctx; overview = null; data = null; tab = "vue"; curId = null;
    filt = { states: new Set(), family: "", q: "", open: null, limit: 150 };
    renderTabs();
    $("#nat-refresh").onclick = () => refresh(true);
    refresh(false);
    // Rafraîchissement discret : seulement sur les vues d'état, et pas dans un onglet caché.
    timer = setInterval(() => {
      if (!EL || document.hidden || !["vue", "red"].includes(tab)) return;
      if (tab === "trad" && filt.open) return;
      refresh(false);
    }, 20000);
  }

  function unmount() {
    clearInterval(timer); timer = null; EL = null; CTX = null; overview = null; data = null;
  }

  window.BTTools["mcast_nat"] = { mount, unmount };
})();
