// Mahau Operação — excluir acesso de vez (só gerência)
// Apaga o login no Firebase Auth (libera o e-mail), marca o cadastro como excluído
// (o nome continua nos relatórios antigos) e tira os checklists da pessoa da rotina.
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ erro: "use POST" });
  try {
    const hdr = req.headers["authorization"] || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    if (!token) return res.status(401).json({ erro: "sem login" });
    const quem = await admin.auth().verifyIdToken(token);
    const quemDoc = await db.collection("usuarios").doc(quem.uid).get();
    const q = quemDoc.data() || {};
    if (q.papel !== "gerencia" || q.ativo !== true) return res.status(403).json({ erro: "só a gerência pode excluir" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const uid = String(body.uid || "");
    if (!uid) return res.status(400).json({ erro: "faltou o usuário" });
    if (uid === quem.uid) return res.status(400).json({ erro: "você não pode excluir o próprio acesso" });
    const alvoRef = db.collection("usuarios").doc(uid);
    const alvo = await alvoRef.get();
    if (!alvo.exists) return res.status(404).json({ erro: "usuário não encontrado" });
    const a = alvo.data();

    try { await admin.auth().deleteUser(uid); }
    catch (e) { if (e.code !== "auth/user-not-found") throw e; }

    const agora = admin.firestore.FieldValue.serverTimestamp();
    await alvoRef.update({ ativo: false, excluido: true, excluidoEm: agora, excluidoPor: quem.uid });
    const mods = await db.collection("modelos").where("funcionarioUid", "==", uid).get();
    const batch = db.batch();
    mods.docs.forEach((d) => batch.update(d.ref, { ativo: false, atualizadoEm: agora }));
    batch.set(db.collection("audit_log").doc(), {
      acao: "acesso_excluido", detalhe: `${a.nome} (${a.cargo || a.papel} · ${a.setor})`,
      uid: quem.uid, nome: q.nome || "", ts: agora,
    });
    await batch.commit();

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: String(e.message || e) });
  }
};
