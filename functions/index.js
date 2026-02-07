/**
 * DON TRADING JOURNAL — Cloud Functions
 *
 * Compatible: firebase-functions v6, firebase-admin v12, Node 20
 *
 * SETUP:
 *   firebase functions:secrets:set METAAPI_TOKEN
 *   firebase deploy --only functions
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// ─── SECRET ───
const METAAPI_TOKEN = defineSecret("METAAPI_TOKEN");

// ─── CONFIG ───
const REGION = "london";
const URLS = {
  provisioning: `https://mt-provisioning-api-v1.${REGION}.agiliumtrade.ai`,
  client: `https://mt-client-api-v1.${REGION}.agiliumtrade.ai`,
  metastats: `https://metastats-api-v1.${REGION}.agiliumtrade.ai`,
};

// ─── HTTP HELPER (retry 202) ───
async function metaFetch(url, token, opts = {}) {
  const maxRetries = opts.retries ?? 5;
  const method = opts.method || "GET";
  const body = opts.body ? JSON.stringify(opts.body) : undefined;

  for (let i = 0; i <= maxRetries; i++) {
    const res = await fetch(url, {
      method,
      headers: { "auth-token": token, "Content-Type": "application/json" },
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

// ─── Helper: obtener accountId ───
async function getAccountId(uid) {
  const doc = await db.collection("users").doc(uid).get();
  const id = doc.exists && doc.data().metaApiAccountId;
  if (!id) throw new HttpsError("not-found", "No tienes cuenta de broker conectada.");
  return id;
}

// ─── Helper: validar auth ───
function requireAuth(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesion primero.");
  return request.auth.uid;
}


// ═══════════════════════════════════════════════════════
// 1. CONNECT BROKER
// ═══════════════════════════════════════════════════════
exports.connectBroker = onCall(
  { timeoutSeconds: 120, secrets: [METAAPI_TOKEN] },
  async (request) => {
    const uid = requireAuth(request);
    const token = METAAPI_TOKEN.value();
    const { brokerServer, mtLogin, mtPassword, platform } = request.data;

    if (!brokerServer || !mtLogin || !mtPassword) {
      throw new HttpsError("invalid-argument", "Faltan datos: servidor, login o password.");
    }

    // Ya tiene cuenta?
    const userDoc = await db.collection("users").doc(uid).get();
    if (userDoc.exists && userDoc.data().metaApiAccountId) {
      const existingId = userDoc.data().metaApiAccountId;
      try {
        const acct = await metaFetch(
          `${URLS.provisioning}/users/current/accounts/${existingId}`, token, { retries: 0 }
        );
        return { success: true, message: "Cuenta ya vinculada", state: acct.state };
      } catch (_) { /* No existe, re-crear */ }
    }

    // Crear cuenta en MetaApi
    let account;
    try {
      account = await metaFetch(`${URLS.provisioning}/users/current/accounts`, token, {
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
      if (err.message && err.message.includes("already exists")) {
        throw new HttpsError("already-exists", "Esta cuenta MT5 ya esta registrada.");
      }
      throw new HttpsError("internal", "Error MetaApi: " + err.message);
    }

    // Guardar en Firestore
    await db.collection("users").doc(uid).set({
      email: request.auth.token.email || "",
      metaApiAccountId: account.id,
      brokerServer: brokerServer,
      mtLogin: String(mtLogin),
      platform: platform || "mt5",
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Esperar deploy (max 60s)
    var deployed = false;
    for (var i = 0; i < 30; i++) {
      await new Promise(function(r) { setTimeout(r, 2000); });
      try {
        var st = await metaFetch(
          URLS.provisioning + "/users/current/accounts/" + account.id, token, { retries: 0 }
        );
        if (st.state === "DEPLOYED" || st.connectionStatus === "CONNECTED") {
          deployed = true;
          break;
        }
      } catch (_) {}
    }

    return {
      success: true,
      deployed: deployed,
      message: deployed ? "Cuenta conectada" : "Cuenta creada. Desplegando, intenta en 1-2 min.",
    };
  }
);


// ═══════════════════════════════════════════════════════
// 2. USER STATUS
// ═══════════════════════════════════════════════════════
exports.getUserStatus = onCall(async (request) => {
  const uid = requireAuth(request);
  const doc = await db.collection("users").doc(uid).get();

  if (!doc.exists || !doc.data().metaApiAccountId) {
    return { connected: false };
  }
  const d = doc.data();
  return { connected: true, brokerServer: d.brokerServer, mtLogin: d.mtLogin, platform: d.platform };
});


// ═══════════════════════════════════════════════════════
// 3. ACCOUNT INFO
// ═══════════════════════════════════════════════════════
exports.getAccountInfo = onCall(
  { secrets: [METAAPI_TOKEN] },
  async (request) => {
    const uid = requireAuth(request);
    const id = await getAccountId(uid);
    return await metaFetch(
      URLS.client + "/users/current/accounts/" + id + "/account-information",
      METAAPI_TOKEN.value()
    );
  }
);


// ═══════════════════════════════════════════════════════
// 4. METRICS
// ═══════════════════════════════════════════════════════
exports.getMetrics = onCall(
  { timeoutSeconds: 90, secrets: [METAAPI_TOKEN] },
  async (request) => {
    const uid = requireAuth(request);
    const id = await getAccountId(uid);
    const token = METAAPI_TOKEN.value();

    try {
      const res = await metaFetch(URLS.metastats + "/users/current/accounts/" + id + "/metrics", token);
      return { ok: true, metrics: res.metrics || res, source: "metastats" };
    } catch (err) {
      if (err.status === 403) {
        try {
          await metaFetch(
            URLS.provisioning + "/users/current/accounts/" + id + "/enable-metastats-api",
            token, { method: "PUT", body: {}, retries: 0 }
          );
        } catch (_) {}
        return { ok: false, metrics: null, source: "none", reason: "metastats_enabling" };
      }
      throw new HttpsError("internal", err.message);
    }
  }
);


// ═══════════════════════════════════════════════════════
// 5. TRADES
// ═══════════════════════════════════════════════════════
exports.getTrades = onCall(
  { timeoutSeconds: 60, secrets: [METAAPI_TOKEN] },
  async (request) => {
    const uid = requireAuth(request);
    const id = await getAccountId(uid);
    const token = METAAPI_TOKEN.value();

    const now = new Date().toISOString();
    const ago = new Date(Date.now() - 365 * 86400000).toISOString();
    const start = (request.data && request.data.startDate) || ago;
    const end = (request.data && request.data.endDate) || now;

    // MetaStats primero
    try {
      const res = await metaFetch(
        URLS.metastats + "/users/current/accounts/" + id + "/historical-trades/time/" + start + "/" + end + "?updateHistory=true", token
      );
      return { trades: res.trades || (Array.isArray(res) ? res : []), source: "metastats" };
    } catch (_) {}

    // Fallback: Client API
    try {
      const res = await metaFetch(
        URLS.client + "/users/current/accounts/" + id + "/history-deals/time/" + start + "/" + end, token
      );
      return { trades: Array.isArray(res) ? res : (res.deals || []), source: "client" };
    } catch (err) {
      throw new HttpsError("internal", err.message);
    }
  }
);


// ═══════════════════════════════════════════════════════
// 6. DAILY GROWTH
// ═══════════════════════════════════════════════════════
exports.getDailyGrowth = onCall(
  { secrets: [METAAPI_TOKEN] },
  async (request) => {
    const uid = requireAuth(request);
    const id = await getAccountId(uid);
    try {
      const res = await metaFetch(
        URLS.metastats + "/users/current/accounts/" + id + "/daily-growth", METAAPI_TOKEN.value()
      );
      return { data: res.dailyGrowth || (Array.isArray(res) ? res : []) };
    } catch (_) {
      return { data: [] };
    }
  }
);


// ═══════════════════════════════════════════════════════
// 7. DISCONNECT
// ═══════════════════════════════════════════════════════
exports.disconnectBroker = onCall(
  { secrets: [METAAPI_TOKEN] },
  async (request) => {
    const uid = requireAuth(request);
    const token = METAAPI_TOKEN.value();

    const doc = await db.collection("users").doc(uid).get();
    if (!doc.exists || !doc.data().metaApiAccountId) return { ok: true };

    const id = doc.data().metaApiAccountId;
    try {
      await metaFetch(URLS.provisioning + "/users/current/accounts/" + id, token, { method: "DELETE", retries: 0 });
    } catch (_) {}

    await db.collection("users").doc(uid).update({
      metaApiAccountId: admin.firestore.FieldValue.delete(),
      brokerServer: admin.firestore.FieldValue.delete(),
      mtLogin: admin.firestore.FieldValue.delete(),
      disconnectedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ok: true };
  }
);