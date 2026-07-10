// ═══════════════════════════════════════════════════════════════════
// ROSHCAM STORE BACKEND
// The trusted side of the RoshCoin economy. The browser can only ASK —
// every coin credit, cosmetic purchase, gift and refund happens here,
// so nobody can give themselves currency from DevTools.
//
// Functions:
//   createCheckout   — makes a Stripe Checkout Session for a coin pack
//   stripeWebhook    — Stripe calls this after payment; credits coins
//   purchaseCosmetic — spends coins on a catalog item
//   giftCosmetic     — escrows coins into a pending gift
//   respondGift      — recipient accepts (item granted) or declines
//                      (sender refunded); duplicates auto-refund
// ═══════════════════════════════════════════════════════════════════
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const STRIPE_SECRET_KEY = defineSecret("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");
const STRIPE_WEBHOOK_SECRET = defineSecret("whsec_XqZiHJDL8Uyf3FQ8UYreEf93ApZRVJUP");
const SITE_URL = defineString("SITE_URL", { default: "https://roshcam.com" });

// ---------- SERVER-SIDE TRUTH: packs + catalog prices ----------
// Keep in sync with COIN_PACKS / COSMETICS in index.html. Prices here win.
const COIN_PACKS = {
  p1000:  { coins: 1000,  usd: 199,  name: "Starter pack" },
  p2800:  { coins: 2800,  usd: 499,  name: "Plus pack (+13% extra)" },
  p5000:  { coins: 5000,  usd: 799,  name: "Pro pack (+28% extra)" },
  p13500: { coins: 13500, usd: 1999, name: "Whale pack (+38% extra)" },
};
const RARITY_PRICE = { rare: 800, epic: 2000, legendary: 4500, mythic: 8000 };
const COSMETIC_RARITY = {
  // name styles
  ns_galaxy: "legendary", ns_gold: "legendary", ns_prisma: "mythic",
  ns_neon: "epic", ns_fire: "epic", ns_void: "epic",
  ns_ice: "rare", ns_toxic: "rare", ns_chrome: "rare", ns_blood: "rare",
  // player tags
  tg_goat: "mythic", tg_og: "legendary", tg_king: "legendary",
  tg_clutch: "epic", tg_menace: "epic",
  tg_lucky: "rare", tg_sweat: "rare", tg_bot: "rare",
  // avatar effects
  av_liquid: "mythic", av_void: "mythic", av_galaxy: "legendary", av_gold: "legendary",
  av_flame: "epic", av_electric: "epic", av_prism: "epic",
  av_ice: "rare", av_rose: "rare", av_mint: "rare",
  // profile frames
  fr_liquid: "mythic", fr_galaxy: "legendary", fr_gold: "legendary",
  fr_neon: "epic", fr_blood: "epic", fr_circuit: "rare",
};
const itemPrice = (id) => RARITY_PRICE[COSMETIC_RARITY[id]] || null;

// ---------- helpers ----------
function requireUser(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  if (req.auth.token.firebase?.sign_in_provider === "anonymous") {
    throw new HttpsError("permission-denied", "Guests can't use the store — create a free account.");
  }
  return req.auth.uid;
}
const userRef = (uid) => db.collection("users").doc(uid);
const ownedOf = (data) => (data?.cosmetics && Array.isArray(data.cosmetics.owned)) ? data.cosmetics.owned : [];
const coinsOf = (data) => Math.max(0, Math.round(data?.coins || 0));

// ═══════════════ 1. CREATE STRIPE CHECKOUT SESSION ═══════════════
exports.createCheckout = onCall({ secrets: [STRIPE_SECRET_KEY], cors: true }, async (req) => {
  const uid = requireUser(req);
  const pack = COIN_PACKS[String(req.data?.packId || "")];
  if (!pack) throw new HttpsError("invalid-argument", "Unknown coin pack.");
  const stripe = new Stripe(STRIPE_SECRET_KEY.value());
  const site = SITE_URL.value().replace(/\/$/, "");
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: pack.usd,
        product_data: {
          name: `${pack.coins.toLocaleString()} RoshCoins`,
          description: `${pack.name} — ROSHCAM cosmetic currency`,
        },
      },
    }],
    metadata: { uid, packId: String(req.data.packId), coins: String(pack.coins) },
    success_url: `${site}/?coins=success&sid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/?coins=cancel`,
  });
  return { url: session.url };
});

// ═══════════════ 2. STRIPE WEBHOOK → CREDIT COINS ═══════════════
// Configure in the Stripe dashboard with the event `checkout.session.completed`.
exports.stripeWebhook = onRequest({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
  const stripe = new Stripe(STRIPE_SECRET_KEY.value());
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET.value());
  } catch (e) {
    console.error("[webhook] bad signature", e.message);
    res.status(400).send("bad signature");
    return;
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { uid, packId } = session.metadata || {};
    const pack = COIN_PACKS[packId];
    if (uid && pack && session.payment_status === "paid") {
      // Idempotent credit: the purchase doc (keyed by session id) is the guard,
      // so Stripe retrying the webhook can never double-credit.
      const purchaseRef = db.collection("purchases").doc(session.id);
      await db.runTransaction(async (tx) => {
        const existing = await tx.get(purchaseRef);
        if (existing.exists) return;
        tx.set(purchaseRef, {
          uid, packId, coins: pack.coins, usd: pack.usd,
          type: "coin_pack",
          createdAt: FieldValue.serverTimestamp(),
        });
        tx.update(userRef(uid), { coins: FieldValue.increment(pack.coins) });
      });
      console.log(`[webhook] credited ${pack.coins} coins to ${uid} (${session.id})`);
    }
  }
  res.status(200).send("ok");
});

// ═══════════════ 3. BUY A COSMETIC WITH COINS ═══════════════
exports.purchaseCosmetic = onCall({ cors: true }, async (req) => {
  const uid = requireUser(req);
  const itemId = String(req.data?.itemId || "");
  const price = itemPrice(itemId);
  if (!price) throw new HttpsError("invalid-argument", "Unknown item.");
  const ref = userRef(uid);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Profile missing.");
    const data = snap.data();
    const owned = ownedOf(data);
    if (owned.includes(itemId)) throw new HttpsError("already-exists", "You already own this.");
    const coins = coinsOf(data);
    if (coins < price) throw new HttpsError("failed-precondition", "Not enough RoshCoins.");
    tx.update(ref, {
      coins: FieldValue.increment(-price),
      "cosmetics.owned": FieldValue.arrayUnion(itemId),
    });
    tx.set(db.collection("purchases").doc(), {
      uid, itemId, coins: -price, type: "cosmetic",
      createdAt: FieldValue.serverTimestamp(),
    });
    return { coins: coins - price, owned: [...owned, itemId] };
  });
  return result;
});

// ═══════════════ 4. GIFT A COSMETIC (coins into escrow) ═══════════════
exports.giftCosmetic = onCall({ cors: true }, async (req) => {
  const uid = requireUser(req);
  const toUid = String(req.data?.toUid || "");
  const itemId = String(req.data?.itemId || "");
  const price = itemPrice(itemId);
  if (!price) throw new HttpsError("invalid-argument", "Unknown item.");
  if (!toUid || toUid === uid) throw new HttpsError("invalid-argument", "Pick a friend to gift to.");
  const fromRef = userRef(uid), toRef = userRef(toUid);
  const giftRef = db.collection("gifts").doc();
  const result = await db.runTransaction(async (tx) => {
    const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
    if (!fromSnap.exists || !toSnap.exists) throw new HttpsError("not-found", "Player not found.");
    const coins = coinsOf(fromSnap.data());
    if (coins < price) throw new HttpsError("failed-precondition", "Not enough RoshCoins.");
    tx.update(fromRef, { coins: FieldValue.increment(-price) });
    tx.set(giftRef, {
      from: uid,
      fromName: fromSnap.data().username || "player",
      to: toUid,
      itemId, price,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });
    return { coins: coins - price, giftId: giftRef.id };
  });
  // Heads-up in their notification tray (the live gift toast comes from the
  // client's own gifts listener).
  try {
    await db.collection("notifications").doc(toUid).collection("items").add({
      type: "gift",
      text: `🎁 <b>@${(await fromRef.get()).data().username || "someone"}</b> sent you a gift!`,
      actionUid: uid,
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) { /* notification is best-effort */ }
  return result;
});

// ═══════════════ 5. ACCEPT / DECLINE A GIFT ═══════════════
exports.respondGift = onCall({ cors: true }, async (req) => {
  const uid = requireUser(req);
  const giftId = String(req.data?.giftId || "");
  const accept = !!req.data?.accept;
  const giftRef = db.collection("gifts").doc(giftId);
  return await db.runTransaction(async (tx) => {
    const giftSnap = await tx.get(giftRef);
    if (!giftSnap.exists) throw new HttpsError("not-found", "Gift not found.");
    const gift = giftSnap.data();
    if (gift.to !== uid) throw new HttpsError("permission-denied", "Not your gift.");
    if (gift.status !== "pending") throw new HttpsError("failed-precondition", "Gift already handled.");
    const meSnap = await tx.get(userRef(uid));
    const owned = ownedOf(meSnap.data());
    const duplicate = owned.includes(gift.itemId);
    if (accept && !duplicate) {
      tx.update(userRef(uid), { "cosmetics.owned": FieldValue.arrayUnion(gift.itemId) });
      tx.update(giftRef, { status: "accepted", resolvedAt: FieldValue.serverTimestamp() });
      return { result: "accepted", owned: [...owned, gift.itemId] };
    }
    // Decline — or a duplicate accept — sends the coins straight back.
    tx.update(userRef(gift.from), { coins: FieldValue.increment(gift.price || 0) });
    tx.update(giftRef, { status: "refunded", duplicate, resolvedAt: FieldValue.serverTimestamp() });
    return { result: "refunded", duplicate };
  });
});
