/**
 * DON TRADING JOURNAL — Firebase Cloud Functions
 *
 * Arquitectura segura:
 *   Frontend → Firebase Auth → Cloud Functions → MetaApi → Broker MT5
 *
 * El token maestro de MetaApi NUNCA se expone al cliente.
 *
 * SETUP:
 *   firebase functions:config:set metaapi.token="TU_TOKEN" metaapi.region="london"
 *   cd functions && npm install
 *   firebase deploy --only functions
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// ─── CONFIG (secretos en firebase functions:config) ───
const META_TOKEN = functions.config().metaapi?.token || "";
const REGION = functions.config().metaapi?.region || "london";

const URLS = {
  provisioning: `https://mt-provisioning-api-v1.${REGION}.agiliumtrade.ai`,
  client: `https://mt-client-api-v1.${REGION}.agiliumtrade.ai`,
  metastats: `https://metastats-api-v1.${REGION}.agiliumtrade.ai`,
};

// ─── HTTP HELPER con retry para 202 ───
async function metaFetch(url, opts = {}) {
  const maxRetries = opts.retries ?? 5;
  const method = opts.method || "GET";
  const body = opts.body ? JSON.stringify(opts.body) : undefined;

  for (let i = 0; i <= maxRetries; i++) {
    const res = await fetch(url, {
      method,
      headers: { "auth-token": META_TOKEN, "Content-Type": "application/json" },
      body,
    });

    if (res.status === 202) {
      const wait = parseInt(res.headers.get("retry-after") || "5", 10);
      await new Promise((r) => setTimeout(r, Math.min(wait, 15) * 1000));
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      let msg = `HTTP ${res.status}`;
      try { msg = JSON.parse(text).message || msg; } catch (_) {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    return res.json();
  }

  throw new Error("MetaApi sigue procesando. Reintenta en unos segundos.");
}

// ─── AUTH GUARD ───
function requireAuth(ctx) {
  if (!ctx.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Inicia sesión primero.");
  }
  return ctx.auth.uid;
}

// ─── Obtener accountId desde Firestore ───
async function getAccountId(uid) {
  const doc = await db.collection("users").doc(uid).get();
  const id = doc.exists && doc.data().metaApiAccountId;
  if (!id) {
    throw new functions.https.HttpsError("not-found", "No tienes cuenta de broker conectada.");
  }
  return id;
}

// ═══════════════════════════════════════════════════════
// 1. CONNECT BROKER
//    Recibe credenciales del broker → crea cuenta en MetaApi
//    → habilita MetaStats → guarda en Firestore
// ═══════════════════════════════════════════════════════
exports.connectBroker = functions
  .runWith({ timeoutSeconds: 120 })
  .https.onCall(async (data, ctx) => {
    const uid = requireAuth(ctx);
    const { brokerServer, mtLogin, mtPassword, platform } = data;

    if (!brokerServer || !mtLogin || !mtPassword) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Faltan datos: servidor, login o password."
      );
    }

    // ── ¿Ya tiene cuenta? ──
    const userDoc = await db.collection("users").doc(uid).get();
    if (userDoc.exists && userDoc.data().metaApiAccountId) {
      const existingId = userDoc.data().metaApiAccountId;
      // Verificar que sigue viva en MetaApi
      try {
        const acct = await metaFetch(
          `${URLS.provisioning}/users/current/accounts/${existingId}`,
          { retries: 0 }
        );
        return {
          success: true,
          message: "Cuenta ya vinculada",
          accountId: existingId,
          state: acct.state,
        };
      } catch (_) {
        // No existe, se re-crea abajo
      }
    }

    // ── Crear cuenta en MetaApi ──
    let account;
    try {
      account = await metaFetch(`${URLS.provisioning}/users/current/accounts`, {
        method: "POST",
        retries: 0,
        body: {
          name: `DON-${mtLogin}`,
          type: "cloud",
          login: String(mtLogin),
          password: mtPassword,
          server: brokerServer,
          platform: platform || "mt5",
          region: REGION,
          application: "MetaApi",
          magic: 0,
          metastatsApiEnabled: true,
          resourceSlots: 1,
          copyFactoryRoles: [],
        },
      });
    } catch (err) {
      if (err.message?.includes("already exists")) {
        throw new functions.https.HttpsError(
          "already-exists",
          "Esta cuenta MT5 ya está registrada. Contacta soporte."
        );
      }
      throw new functions.https.HttpsError("internal", `Error MetaApi: ${err.message}`);
    }

    const accountId = account.id;

    // ── Guardar en Firestore ──
    await db.collection("users").doc(uid).set(
      {
        email: ctx.auth.token.email || "",
        metaApiAccountId: accountId,
        brokerServer,
        mtLogin: String(mtLogin),
        platform: platform || "mt5",
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // ── Esperar deploy (max 60s) ──
    let deployed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const st = await metaFetch(
          `${URLS.provisioning}/users/current/accounts/${accountId}`,
          { retries: 0 }
        );
        if (st.state === "DEPLOYED" || st.connectionStatus === "CONNECTED") {
          deployed = true;
          break;
        }
      } catch (_) {}
    }

    return {
      success: true,
      deployed,
      message: deployed
        ? "Cuenta conectada exitosamente"
        : "Cuenta creada. Se está desplegando, intenta en 1-2 min.",
    };
  });

// ═══════════════════════════════════════════════════════
// 2. USER STATUS — ¿Tiene cuenta conectada?
// ═══════════════════════════════════════════════════════
exports.getUserStatus = functions.https.onCall(async (_data, ctx) => {
  const uid = requireAuth(ctx);
  const doc = await db.collection("users").doc(uid).get();

  if (!doc.exists || !doc.data().metaApiAccountId) {
    return { connected: false };
  }

  const d = doc.data();
  return {
    connected: true,
    brokerServer: d.brokerServer,
    mtLogin: d.mtLogin,
    platform: d.platform,
  };
});

// ═══════════════════════════════════════════════════════
// 3. ACCOUNT INFO — Balance, equity
// ═══════════════════════════════════════════════════════
exports.getAccountInfo = functions.https.onCall(async (_data, ctx) => {
  const uid = requireAuth(ctx);
  const id = await getAccountId(uid);

  const info = await metaFetch(
    `${URLS.client}/users/current/accounts/${id}/account-information`
  );
  return info;
});

// ═══════════════════════════════════════════════════════
// 4. METRICS — MetaStats (con auto-enable si falla 403)
// ═══════════════════════════════════════════════════════
exports.getMetrics = functions
  .runWith({ timeoutSeconds: 90 })
  .https.onCall(async (data, ctx) => {
    const uid = requireAuth(ctx);
    const id = await getAccountId(uid);

    try {
      const res = await metaFetch(
        `${URLS.metastats}/users/current/accounts/${id}/metrics`
      );
      return { ok: true, metrics: res.metrics || res, source: "metastats" };
    } catch (err) {
      if (err.status === 403) {
        // Auto-habilitar MetaStats
        try {
          await metaFetch(
            `${URLS.provisioning}/users/current/accounts/${id}/enable-metastats-api`,
            { method: "PUT", body: {}, retries: 0 }
          );
        } catch (_) {}
        return { ok: false, metrics: null, source: "none", reason: "metastats_enabling" };
      }
      throw new functions.https.HttpsError("internal", err.message);
    }
  });

// ═══════════════════════════════════════════════════════
// 5. TRADES — Historial cerrado
// ═══════════════════════════════════════════════════════
exports.getTrades = functions
  .runWith({ timeoutSeconds: 60 })
  .https.onCall(async (data, ctx) => {
    const uid = requireAuth(ctx);
    const id = await getAccountId(uid);

    const now = new Date().toISOString();
    const ago = new Date(Date.now() - 365 * 86400000).toISOString();
    const start = data?.startDate || ago;
    const end = data?.endDate || now;

    // Intentar MetaStats
    try {
      const res = await metaFetch(
        `${URLS.metastats}/users/current/accounts/${id}/historical-trades/time/${start}/${end}?updateHistory=true`
      );
      return { trades: res.trades || (Array.isArray(res) ? res : []), source: "metastats" };
    } catch (_) {}

    // Fallback: Client API
    try {
      const res = await metaFetch(
        `${URLS.client}/users/current/accounts/${id}/history-deals/time/${start}/${end}`
      );
      return { trades: Array.isArray(res) ? res : (res.deals || []), source: "client" };
    } catch (err) {
      throw new functions.https.HttpsError("internal", err.message);
    }
  });

// ═══════════════════════════════════════════════════════
// 6. DAILY GROWTH — P&L por día
// ═══════════════════════════════════════════════════════
exports.getDailyGrowth = functions.https.onCall(async (_data, ctx) => {
  const uid = requireAuth(ctx);
  const id = await getAccountId(uid);

  try {
    const res = await metaFetch(
      `${URLS.metastats}/users/current/accounts/${id}/daily-growth`
    );
    return { data: res.dailyGrowth || (Array.isArray(res) ? res : []) };
  } catch (_) {
    return { data: [] };
  }
});

// ═══════════════════════════════════════════════════════
// 7. DISCONNECT — Desvincular broker
// ═══════════════════════════════════════════════════════
exports.disconnectBroker = functions.https.onCall(async (_data, ctx) => {
  const uid = requireAuth(ctx);
  const doc = await db.collection("users").doc(uid).get();
  if (!doc.exists || !doc.data().metaApiAccountId) return { ok: true };

  const id = doc.data().metaApiAccountId;

  // Intentar borrar/undeployar en MetaApi
  try {
    await metaFetch(`${URLS.provisioning}/users/current/accounts/${id}`, {
      method: "DELETE",
      retries: 0,
    });
  } catch (_) {}

  // Limpiar Firestore
  await db.collection("users").doc(uid).update({
    metaApiAccountId: admin.firestore.FieldValue.delete(),
    brokerServer: admin.firestore.FieldValue.delete(),
    mtLogin: admin.firestore.FieldValue.delete(),
    disconnectedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true };
});