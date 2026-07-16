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

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
const SITE_URL = defineString("SITE_URL", { default: "https://roshcam.com" });

// ---------- SERVER-SIDE TRUTH: packs + catalog prices ----------
// Keep in sync with COIN_PACKS / COSMETICS in index.html. Prices here win.
const COIN_PACKS = {
  p1000:  { coins: 1000,  usd: 199,  name: "Starter pack" },
  p2800:  { coins: 2800,  usd: 499,  name: "Plus pack (+13% extra)" },
  p5000:  { coins: 5000,  usd: 799,  name: "Pro pack (+28% extra)" },
  p13500: { coins: 13500, usd: 1999, name: "Whale pack (+38% extra)" },
};
// Keep in lockstep with CX_PRICE in index.html — tuned to the ROSHCOIN packs.
const RARITY_PRICE = { rare: 400, epic: 900, legendary: 2200, mythic: 4500, ascended: 8000 };
// One-time first-purchase deal. Must match WELCOME_OFFER in index.html.
const WELCOME_OFFER = { itemId: "fr_neon", price: 300 };
// How long after buying a cosmetic a player may undo it for a full refund.
// 10 minutes — pairs with the in-shop Refund button (see the preview modal).
const REFUND_WINDOW_MS = 600000;
// Plain-text a gift note down to something safe to store + render.
function cleanGiftNote(s) {
  return String(s || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}
const COSMETIC_RARITY = {
  // name styles
  ns_amethyst: "rare",
  ns_blood: "rare",
  ns_chrome: "rare",
  ns_cyber: "epic",
  ns_dragonlord: "mythic",
  ns_emerald: "rare",
  ns_fire: "epic",
  ns_galaxy: "legendary",
  ns_gold: "legendary",
  ns_ice: "rare",
  ns_neon: "epic",
  ns_netrunner: "mythic",
  ns_prisma: "mythic",
  ns_royal: "legendary",
  ns_sakura: "rare",
  ns_starforged: "ascended",
  ns_starlight: "legendary",
  ns_sunset: "epic",
  ns_toxic: "rare",
  ns_void: "epic",
  // player tags
  tg_beast: "epic",
  tg_boss: "epic",
  tg_bot: "rare",
  tg_clutch: "epic",
  tg_cosmic: "ascended",
  tg_dragon: "mythic",
  tg_goat: "mythic",
  tg_king: "legendary",
  tg_legend: "legendary",
  tg_lucky: "rare",
  tg_menace: "epic",
  tg_og: "legendary",
  tg_pro: "rare",
  tg_sweat: "rare",
  tg_syndicate: "mythic",
  tg_vibe: "rare",
  // avatar effects
  av_aqua: "rare",
  av_crimson: "epic",
  av_electric: "epic",
  av_emerald: "rare",
  av_eventhorizon: "ascended",
  av_flame: "epic",
  av_galaxy: "legendary",
  av_gold: "legendary",
  av_hologrid: "mythic",
  av_ice: "rare",
  av_liquid: "mythic",
  av_mint: "rare",
  av_nebula: "legendary",
  av_prism: "epic",
  av_rose: "rare",
  av_sunfire: "epic",
  av_void: "mythic",
  av_wyrmfire: "mythic",
  // profile frames
  fr_blood: "epic",
  fr_circuit: "rare",
  fr_emerald: "epic",
  fr_galaxy: "legendary",
  fr_gold: "legendary",
  fr_hoard: "mythic",
  fr_liquid: "mythic",
  fr_neon: "epic",
  fr_nightcity: "mythic",
  fr_starforge: "ascended",
  fr_sunset: "legendary",
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
  const wantWelcome = !!req.data?.welcome;
  const base = itemPrice(itemId);
  if (!base) throw new HttpsError("invalid-argument", "Unknown item.");
  const ref = userRef(uid);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Profile missing.");
    const data = snap.data();
    const owned = ownedOf(data);
    if (owned.includes(itemId)) throw new HttpsError("already-exists", "You already own this.");
    // Welcome offer: one specific item, one time per account, at a fixed price.
    let price = base;
    let welcome = false;
    if (wantWelcome) {
      if (itemId !== WELCOME_OFFER.itemId) throw new HttpsError("failed-precondition", "That item isn't the welcome offer.");
      if (data.welcomeClaimed) throw new HttpsError("failed-precondition", "Welcome offer already used.");
      price = WELCOME_OFFER.price;
      welcome = true;
    }
    const coins = coinsOf(data);
    if (coins < price) throw new HttpsError("failed-precondition", "Not enough RoshCoins.");
    const update = {
      coins: FieldValue.increment(-price),
      "cosmetics.owned": FieldValue.arrayUnion(itemId),
      // Remember the last buy so it can be undone inside the refund window.
      lastPurchase: { itemId, price, at: Date.now() },
    };
    if (welcome) update.welcomeClaimed = true;
    tx.update(ref, update);
    tx.set(db.collection("purchases").doc(), {
      uid, itemId, coins: -price, type: welcome ? "welcome" : "cosmetic",
      createdAt: FieldValue.serverTimestamp(),
    });
    return { coins: coins - price, owned: [...owned, itemId], welcomeClaimed: welcome || !!data.welcomeClaimed };
  });
  return result;
});

// ═══════════════ UNDO A COSMETIC PURCHASE (refund window) ═══════════════
// Only the single most-recent purchase, only within REFUND_WINDOW_MS, and only
// if it's still owned. Unequips it too, then returns the coins.
exports.refundCosmetic = onCall({ cors: true }, async (req) => {
  const uid = requireUser(req);
  const itemId = String(req.data?.itemId || "");
  const ref = userRef(uid);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Profile missing.");
    const data = snap.data();
    const lp = data.lastPurchase;
    if (!lp || lp.itemId !== itemId) throw new HttpsError("failed-precondition", "Nothing to undo.");
    if (Date.now() - (Number(lp.at) || 0) > REFUND_WINDOW_MS) throw new HttpsError("failed-precondition", "The refund window has passed.");
    const owned = ownedOf(data);
    if (!owned.includes(itemId)) throw new HttpsError("failed-precondition", "You don't own this.");
    // Worn = kept. Equipping a cosmetic commits the purchase.
    const cos = data.cosmetics || {};
    if (["name", "tag", "avatar", "frame"].some((slot) => cos[slot] === itemId)) {
      throw new HttpsError("failed-precondition", "You've equipped this item — equipped cosmetics can't be refunded.");
    }
    const price = Number(lp.price) || itemPrice(itemId) || 0;
    const update = {
      coins: FieldValue.increment(price),
      "cosmetics.owned": FieldValue.arrayRemove(itemId),
      lastPurchase: FieldValue.delete(),
    };
    tx.update(ref, update);
    tx.set(db.collection("purchases").doc(), {
      uid, itemId, coins: price, type: "refund",
      createdAt: FieldValue.serverTimestamp(),
    });
    return { coins: coinsOf(data) + price, owned: owned.filter((x) => x !== itemId) };
  });
});

// ═══════════════ 4. GIFT A COSMETIC (coins into escrow) ═══════════════
exports.giftCosmetic = onCall({ cors: true }, async (req) => {
  const uid = requireUser(req);
  const toUid = String(req.data?.toUid || "");
  const itemId = String(req.data?.itemId || "");
  const note = cleanGiftNote(req.data?.note);
  const wrap = String(req.data?.wrap || "gift").slice(0, 12);
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
      note, wrap,
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

// ═══════════════ 6. CASE DUPLICATES → ROSHCOINS ═══════════════
// The wallet is server-owned, so the client can't credit itself the 50-coin
// duplicate refund from case openings — it asks here instead. Each item must
// already be owned (that's what makes it a duplicate). Batched for bulk opens.
const DUPE_COIN_VALUE = 50;
exports.redeemDupeCoins = onCall({ cors: true }, async (req) => {
  const uid = requireUser(req);
  const raw = Array.isArray(req.data?.items) ? req.data.items : [req.data?.itemId];
  const items = raw.map((x) => String(x || "")).filter(Boolean).slice(0, 60);
  if (!items.length) throw new HttpsError("invalid-argument", "No items.");
  const ref = userRef(uid);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Profile missing.");
    const data = snap.data();
    const owned = ownedOf(data);
    for (const id of items) {
      if (!owned.includes(id)) throw new HttpsError("failed-precondition", "Not a duplicate.");
    }
    const credit = items.length * DUPE_COIN_VALUE;
    tx.update(ref, { coins: FieldValue.increment(credit) });
    tx.set(db.collection("purchases").doc(), {
      uid, items, coins: credit, type: "dupe_convert",
      createdAt: FieldValue.serverTimestamp(),
    });
    return { coins: coinsOf(data) + credit, credited: credit };
  });
});
