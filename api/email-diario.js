// Mahau Operação — e-mail diário (08h): tarefas de hoje + resultado de ontem
// Roda via Vercel Cron. Env vars: FIREBASE_SERVICE_ACCOUNT, GMAIL_USER, GMAIL_APP_PASSWORD, CRON_SECRET
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

/* ---------- datas (America/Sao_Paulo) ---------- */
const fmtSP = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD
const isoSP = (offsetDias = 0) => fmtSP.format(new Date(Date.now() + offsetDias * 864e5));
const dow = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
const addDias = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const segundaDe = (iso) => addDias(iso, -((dow(iso) + 6) % 7));
const fmtBR = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const DIAS_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const valeNoDia = (m, iso) => (!m.dias || !m.dias.length) ? true : m.dias.includes(dow(iso));
// entregue = TODOS os itens marcados; faltou 1 = não entregue
const entregue = (i) => !!i && (!!i.concluidoEm || ((i.itens || []).length > 0 && i.itens.every((it) => it.done)));
const horaFim = (i) => (i && (i.concluidoEm || (i.itens || []).map((it) => it.doneEm || "").sort().pop())) || "";
const resumoInst = (i, modelo) => ({
  feitos: i ? i.itens.filter((it) => it.done).length : 0,
  total: (i ? i.itens : (modelo && modelo.itens) || []).length,
  faltam: i ? i.itens.filter((it) => !it.done).map((it) => it.t) : null,
});
const statusHTML = (l) => l.ok
  ? `<span style="color:#16A34A;font-weight:700">✓ feita${l.hora ? " às " + esc(l.hora) : ""} (${l.feitos}/${l.total})</span>`
  : (l.faltam
      ? `<span style="color:#DC2626;font-weight:700">✗ incompleta — concluiu ${l.feitos} de ${l.total}</span>${l.faltam.length ? `<br><span style="color:#DC2626">Faltou: ${l.faltam.map(esc).join(" · ")}</span>` : ""}`
      : `<span style="color:#DC2626;font-weight:700">✗ não feita (nem iniciou)</span>`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

module.exports = async (req, res) => {
  // segurança: só o cron da Vercel (Authorization) ou teste manual com ?key=
  const secret = process.env.CRON_SECRET || "";
  const auth = req.headers["authorization"] || "";
  const okCron = secret && auth === `Bearer ${secret}`;
  const okManual = secret && req.query && req.query.key === secret;
  if (!okCron && !okManual) return res.status(401).json({ erro: "não autorizado" });

  try {
    const hoje = isoSP(0), ontem = isoSP(-1);
    const segHoje = segundaDe(hoje), segOntem = segundaDe(ontem);

    const [usSnap, moSnap, ckSnap] = await Promise.all([
      db.collection("usuarios").get(),
      db.collection("modelos").get(),
      db.collection("checklists").where("periodo", "in", [...new Set([hoje, ontem, segHoje, segOntem])]).get(),
    ]);
    const usuarios = usSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    const modelos = moSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((m) => m.ativo !== false);
    const insts = ckSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const instDe = (modeloId, periodo) => insts.find((x) => x.modeloId === modeloId && x.periodo === periodo);

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });

    const funcs = usuarios.filter((u) => u.papel === "funcionario" && u.ativo !== false && u.email);
    const gers = usuarios.filter((u) => u.papel === "gerencia" && u.ativo !== false && u.email);
    let enviados = 0;

    /* ---------- e-mail de cada responsável ---------- */
    for (const u of funcs) {
      const meus = modelos.filter((m) => m.funcionarioUid === u.uid);

      // HOJE: diários que valem hoje + avulsas de hoje + semanal da semana (com status)
      const hojeDiarios = meus.filter((m) => m.freq === "diario" && valeNoDia(m, hoje) && (m.inicioEm || hoje) <= hoje);
      const hojeAvulsas = insts.filter((x) => x.freq === "avulso" && x.funcionarioUid === u.uid && x.periodo === hoje);
      const semanais = meus.filter((m) => m.freq === "semanal" && (m.inicioEm || segHoje) <= addDias(segHoje, 6));

      // ONTEM: o que era esperado e como terminou
      const ontemLinhas = [];
      for (const m of meus.filter((m) => m.freq === "diario" && valeNoDia(m, ontem) && (m.inicioEm || ontem) <= ontem)) {
        const i = instDe(m.id, ontem);
        ontemLinhas.push({ nome: m.nome, ok: entregue(i), hora: horaFim(i), ncs: i ? i.itens.filter((it) => it.nc) : [], ...resumoInst(i, m) });
      }
      for (const x of insts.filter((x) => x.freq === "avulso" && x.funcionarioUid === u.uid && x.periodo === ontem)) {
        ontemLinhas.push({ nome: x.nome + " (avulsa)", ok: entregue(x), hora: horaFim(x), ncs: x.itens.filter((it) => it.nc), ...resumoInst(x) });
      }

      if (!hojeDiarios.length && !hojeAvulsas.length && !semanais.length && !ontemLinhas.length) continue;

      const li = (t) => `<li style="margin:4px 0">${t}</li>`;
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#14181F">
          <div style="background:#101418;padding:14px 18px;border-radius:10px 10px 0 0">
            <span style="color:#B8F642;font-weight:800;letter-spacing:2px">MAHAU</span>
            <span style="color:#9aa3ad;font-size:12px;letter-spacing:3px"> OPERAÇÃO</span>
          </div>
          <div style="border:1px solid #E4E7EC;border-top:none;border-radius:0 0 10px 10px;padding:18px">
            <p>Bom dia, <b>${esc(u.nome)}</b>! Resumo de ${DIAS_PT[dow(hoje)]}, ${fmtBR(hoje)}:</p>
            <h3 style="margin:16px 0 6px">📋 Suas tarefas de hoje</h3>
            <ul style="padding-left:18px;margin:0">
              ${hojeDiarios.map((m) => li(`<b>${esc(m.nome)}</b>${m.limite ? " — " + esc(m.limite) : ""}`)).join("")}
              ${hojeAvulsas.map((x) => li(`<b>${esc(x.nome)}</b> (tarefa avulsa)`)).join("")}
              ${hojeDiarios.length + hojeAvulsas.length === 0 ? li("Nada lançado pra hoje.") : ""}
            </ul>
            ${semanais.length ? `<h3 style="margin:16px 0 6px">🗓 Da semana (até domingo)</h3>
            <ul style="padding-left:18px;margin:0">${semanais.map((m) => { const i = instDe(m.id, segHoje); const feito = entregue(i); return li(`${esc(m.nome)} — ${feito ? '<span style="color:#16A34A;font-weight:700">✓ concluída</span>' : "em aberto"}`); }).join("")}</ul>` : ""}
            ${ontemLinhas.length ? `<h3 style="margin:16px 0 6px">🔁 Como ficou ontem (${fmtBR(ontem)})</h3>
            <ul style="padding-left:18px;margin:0">${ontemLinhas.map((l) => li(`${esc(l.nome)} — ${statusHTML(l)}${l.ncs.length ? `<br><span style="color:#D97706">⚠ ${l.ncs.map((n) => esc(n.t + ": " + n.nc)).join(" · ")}</span>` : ""}`)).join("")}</ul>` : ""}
            <p style="margin-top:18px"><a href="https://mahau-checklist.vercel.app" style="background:#101418;color:#fff;text-decoration:none;padding:11px 18px;border-radius:9px;font-weight:700;display:inline-block">Abrir meus checklists</a></p>
          </div>
        </div>`;
      await transporter.sendMail({
        from: `"Mahau Operação" <${process.env.GMAIL_USER}>`,
        to: u.email,
        subject: `Suas tarefas de hoje · ${fmtBR(hoje)}`,
        html,
      });
      enviados++;
    }

    /* ---------- e-mail da gerência (resumo geral) ---------- */
    if (gers.length) {
      const nomeDe = (uid) => (usuarios.find((x) => x.uid === uid) || {}).nome || "—";
      // ontem por setor
      const setores = {};
      const addLinha = (setor, linha) => (setores[setor] ??= []).push(linha);
      for (const m of modelos.filter((m) => m.freq === "diario" && valeNoDia(m, ontem) && (m.inicioEm || ontem) <= ontem)) {
        const i = instDe(m.id, ontem);
        addLinha(m.setor, { nome: m.nome, resp: nomeDe(m.funcionarioUid), ok: entregue(i), hora: horaFim(i), ncs: i ? i.itens.filter((it) => it.nc) : [], obs: i && i.obs, ...resumoInst(i, m) });
      }
      for (const x of insts.filter((x) => x.freq === "avulso" && x.periodo === ontem)) {
        addLinha(x.setor, { nome: x.nome + " (avulsa)", resp: nomeDe(x.funcionarioUid), ok: entregue(x), hora: horaFim(x), ncs: x.itens.filter((it) => it.nc), obs: x.obs, ...resumoInst(x) });
      }
      const totalOntem = Object.values(setores).flat();
      const feitos = totalOntem.filter((l) => l.ok).length;
      // hoje: o que roda
      const hojeRoda = modelos.filter((m) => m.freq === "diario" && valeNoDia(m, hoje) && (m.inicioEm || hoje) <= hoje);

      const html = `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#14181F">
          <div style="background:#101418;padding:14px 18px;border-radius:10px 10px 0 0">
            <span style="color:#B8F642;font-weight:800;letter-spacing:2px">MAHAU</span>
            <span style="color:#9aa3ad;font-size:12px;letter-spacing:3px"> OPERAÇÃO · GERÊNCIA</span>
          </div>
          <div style="border:1px solid #E4E7EC;border-top:none;border-radius:0 0 10px 10px;padding:18px">
            <p><b>Fechamento de ontem (${DIAS_PT[dow(ontem)]}, ${fmtBR(ontem)}):</b> ${feitos}/${totalOntem.length} checklists entregues.</p>
            ${Object.keys(setores).sort().map((sn) => `
              <h3 style="margin:14px 0 4px">${esc(sn)}</h3>
              <ul style="padding-left:18px;margin:0">
                ${setores[sn].map((l) => `<li style="margin:4px 0">${esc(l.nome)} — ${esc(l.resp)} — ${statusHTML(l)}${l.ncs.length ? `<br><span style="color:#D97706">⚠ ${l.ncs.map((n) => esc(n.t + ": " + n.nc)).join(" · ")}</span>` : ""}${l.obs ? `<br><span style="color:#667085">📝 ${esc(l.obs)}</span>` : ""}</li>`).join("")}
              </ul>`).join("") || "<p>Nenhum checklist previsto ontem.</p>"}
            <h3 style="margin:16px 0 4px">📋 Roda hoje (${DIAS_PT[dow(hoje)]})</h3>
            <ul style="padding-left:18px;margin:0">${hojeRoda.map((m) => `<li style="margin:4px 0">${esc(m.setor)} · ${esc(m.nome)} — ${esc(nomeDe(m.funcionarioUid))}</li>`).join("") || "<li>Nada previsto.</li>"}</ul>
            <p style="margin-top:18px"><a href="https://mahau-checklist.vercel.app" style="background:#101418;color:#fff;text-decoration:none;padding:11px 18px;border-radius:9px;font-weight:700;display:inline-block">Abrir o painel</a></p>
          </div>
        </div>`;
      for (const g of gers) {
        await transporter.sendMail({
          from: `"Mahau Operação" <${process.env.GMAIL_USER}>`,
          to: g.email,
          subject: `Resumo da operação · ontem ${fmtBR(ontem)} + hoje ${fmtBR(hoje)}`,
          html,
        });
        enviados++;
      }
    }

    return res.status(200).json({ ok: true, enviados, hoje, ontem });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: String(e.message || e) });
  }
};
