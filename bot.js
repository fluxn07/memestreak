// ==================== PART 1 OF 2 ====================
// bot.js (PART 1) - Paste this as the start of your bot.js file

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const jwt = require("jsonwebtoken");

// -------------------- ENV --------------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || "MEMESTREAK_SUPER_SECRET";

if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN / SUPABASE_URL / SUPABASE_KEY");
  process.exit(1);
}

// -------------------- CONSTANTS --------------------
const SITE_URL = process.env.SITE_URL || "https://meme-streak-hub.lovable.app";
const BROADCAST_INTERVAL_MS = 48 * 60 * 60 * 1000; // every 48h

// Random promo messages for broadcasts
const PROMO_MESSAGES = [
  "🤣 New memes just dropped… ready to laugh again?",
  "😂 Need a quick laugh break? I’ve got fresh memes for you!",
  "🔥 Your MemeStreak is hungry… go feed it with new memes!",
  "😈 I bet today’s memes will make you snort-laugh. Prove me wrong.",
  "📲 Scroll less, laugh more. New memes waiting for you!",
  "🤯 Some memes are SO dumb they’re genius. Go see for yourself.",
  "🙃 Bored? I have memes. You know what to do.",
  "😹 Warning: today’s memes may cause uncontrollable giggles.",
];

// -------------------- INIT --------------------
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("🚀 MemeStreak Bot Running...");

bot.on("polling_error", (err) => {
  console.log("Polling error:", err && err.code, err && err.message);
});

// -------------------- EXPRESS API (Website → Bot) --------------------
const app = express();
app.use(express.json());

// === CORS middleware - allow frontend hosted anywhere to call these APIs ===
app.use((req, res, next) => {
  // You can tighten Access-Control-Allow-Origin to your domain if you want:
  // res.header("Access-Control-Allow-Origin", "https://your-frontend.example.com");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// -------------------- TEMP/DB for OTP --------------------
// We'll prefer Supabase storage of OTPs (login_otps table), but also keep an in-memory fallback
const otpStore = {}; // { uid: { otp: '123456', createdAt: Date.now() } }
// When you deploy on multiple instances, in-memory store won't persist — using Supabase is preferred.

// -------------------- API ROUTES --------------------

/***********************************************************
 * POST /verifyUID
 * Body: { uid }
 * Returns: { valid: true/false }
 ***********************************************************/
app.post("/verifyUID", async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.json({ valid: false });

    const { data, error } = await supabase
      .from("users")
      .select("uid")
      .eq("uid", uid)
      .maybeSingle();

    if (error || !data) return res.json({ valid: false });
    return res.json({ valid: true });
  } catch (err) {
    console.error("verifyUID error:", err);
    return res.status(500).json({ valid: false });
  }
});

/***********************************************************
 * POST /sendCode
 * Body: { uid, code }
 * Sends OTP to user's Telegram and stores it in Supabase (and fallback in memory)
 ***********************************************************/
app.post("/sendCode", async (req, res) => {
  try {
    const { uid, code } = req.body;
    if (!uid || !code) {
      return res.status(400).json({ error: "uid and code required" });
    }

    // Lookup user tg_user_id
    const { data: user, error } = await supabase
      .from("users")
      .select("tg_user_id")
      .eq("uid", uid)
      .maybeSingle();

    if (error || !user) {
      console.error("sendCode user lookup error:", error);
      return res.status(404).json({ error: "User not found" });
    }

    // Store OTP in Supabase login_otps table (preferred)
    try {
      await supabase.from("login_otps").insert({
        uid,
        otp: String(code),
      });
    } catch (dbErr) {
      console.error("sendCode: failed to insert OTP row in Supabase:", dbErr);
      // fallback: store in-memory for short-lived use
      otpStore[uid] = { otp: String(code), createdAt: Date.now() };
    }

    // Send OTP to user's Telegram (best-effort)
    try {
      await bot.sendMessage(
        user.tg_user_id,
        `🔐 Your MemeStreak login code:\n\n⭐ *${code}*`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      if (err.response && err.response.statusCode === 403) {
        console.log("User blocked bot while sending login code.");
      } else {
        console.error("sendCode sendMessage error:", err);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("sendCode error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

/***********************************************************
 * POST /verifyOTP
 * Body: { uid, otp }
 * Verifies OTP (prefers Supabase login_otps latest row), returns JWT token on success.
 ***********************************************************/
app.post("/verifyOTP", async (req, res) => {
  try {
    const { uid, otp } = req.body;
    if (!uid || !otp) return res.json({ valid: false });

    // First, try Supabase login_otps table (latest entry)
    try {
      const { data: row, error } = await supabase
        .from("login_otps")
        .select("*")
        .eq("uid", uid)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && row && String(row.otp) === String(otp)) {
        // OTP matches Supabase row
        // Optionally: delete old OTP rows or keep them for audit
        const token = jwt.sign({ uid }, JWT_SECRET, { expiresIn: "365d" });
        return res.json({ valid: true, token });
      }
    } catch (dbErr) {
      console.error("verifyOTP Supabase lookup error:", dbErr);
    }

    // Fallback: check in-memory otpStore
    const mem = otpStore[uid];
    if (mem && String(mem.otp) === String(otp)) {
      // delete in-memory OTP after use
      delete otpStore[uid];
      const token = jwt.sign({ uid }, JWT_SECRET, { expiresIn: "365d" });
      return res.json({ valid: true, token });
    }

    // Not matched
    return res.json({ valid: false });
  } catch (err) {
    console.error("verifyOTP error:", err);
    return res.status(500).json({ valid: false });
  }
});

/***********************************************************
 * POST /autoLogin
 * Body: { token }
 * Verifies JWT token and returns loggedIn status and uid
 ***********************************************************/
app.post("/autoLogin", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.json({ loggedIn: false });

    try {
      const data = jwt.verify(token, JWT_SECRET);
      return res.json({ loggedIn: true, uid: data.uid });
    } catch (err) {
      return res.json({ loggedIn: false });
    }
  } catch (err) {
    console.error("autoLogin error:", err);
    return res.status(500).json({ loggedIn: false });
  }
});

// Express listen (we keep this here in part 1; full file will remain consistent)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🌐 Express API is live on port", PORT));

// -------------------- STATE --------------------
const userStates = new Map(); // tgUserId -> { mode, data }
const pendingSendTarget = new Map(); // tgUserId -> { friendUid }

// -------------------- UTILS --------------------
function logError(ctx, err) {
  console.error(`${ctx} error:`, err);
}

function randomPromoText() {
  const i = Math.floor(Math.random() * PROMO_MESSAGES.length);
  return PROMO_MESSAGES[i];
}

// streak logic: max +1 per day, reset if gap > 1 day
function calculateNewStreak(existingStreak, lastMemeAtISO, nowISO) {
  const current = typeof existingStreak === "number" ? existingStreak : 0;

  if (!lastMemeAtISO) return 1;

  const last = new Date(lastMemeAtISO);
  const now = new Date(nowISO);

  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const startOfLast = new Date(
    Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate())
  );

  const diffDays = Math.round((startOfToday - startOfLast) / 86400000);

  if (diffDays === 0) return current || 1; // same day, keep streak
  if (diffDays === 1) return current + 1; // next day
  return 1; // missed at least 1 full day
}

// Helper: send site button
function sendSiteButton(chatId, text) {
  return bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [[{ text: "Open MemeStreak Hub 🌐", url: SITE_URL }]],
    },
  });
}

// -------------------- SUPABASE HELPERS --------------------
async function ensureUser(tgUser) {
  try {
    const tgId = String(tgUser.id);

    const { data: existing, error: selErr } = await supabase
      .from("users")
      .select("*")
      .eq("tg_user_id", tgId)
      .maybeSingle();

    if (selErr) throw selErr;
    if (existing) return existing;

    const uid = "MS" + Math.floor(100000 + Math.random() * 900000);

    const { data: inserted, error: insErr } = await supabase
      .from("users")
      .insert({
        uid,
        tg_user_id: tgId,
        username: tgUser.username || null,
        first_name: tgUser.first_name || null,
        last_name: tgUser.last_name || null,
      })
      .select("*")
      .single();

    if (insErr) throw insErr;
    return inserted;
  } catch (err) {
    logError("ensureUser", err);
    throw err;
  }
}

async function getUserByUid(uid) {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("uid", uid)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (err) {
    logError("getUserByUid", err);
    return null;
  }
}

async function getFriendsForUserUid(userUid) {
  try {
    const { data, error } = await supabase
      .from("friends")
      .select("friend_uid, streak, last_meme_at")
      .eq("user_uid", userUid);

    if (error) throw error;
    return data || [];
  } catch (err) {
    logError("getFriendsForUserUid", err);
    return [];
  }
}

async function getUsersByUids(uids) {
  if (!uids.length) return [];
  try {
    const { data, error } = await supabase
      .from("users")
      .select("uid, first_name, username")
      .in("uid", uids);

    if (error) throw error;
    return data || [];
  } catch (err) {
    logError("getUsersByUids", err);
    return [];
  }
}

// -------------------- PART 1 END --------------------
// Paste PART 2 after this exact line to complete the file
// ==================== END OF PART 1 OF 2 ====================


// ==================== PART 2 OF 2 ====================
// Continue from Part 1 — DO NOT remove any lines above.

// -------------------- FRIEND RELATIONS --------------------
async function addFriendRelation(userUid, friendUid) {
  try {
    if (userUid === friendUid) {
      return { ok: false, reason: "self" };
    }

    const { data: friend, error: friendErr } = await supabase
      .from("users")
      .select("uid")
      .eq("uid", friendUid)
      .maybeSingle();

    if (friendErr) {
      logError("addFriendRelation lookup", friendErr);
      return { ok: false, reason: "error" };
    }
    if (!friend) {
      return { ok: false, reason: "not_found" };
    }

    const { error: upErr } = await supabase.from("friends").upsert([
      { user_uid: userUid, friend_uid: friendUid },
      { user_uid: friendUid, friend_uid: userUid },
    ]);

    if (upErr) {
      logError("addFriendRelation upsert", upErr);
      return { ok: false, reason: "error" };
    }

    return { ok: true };
  } catch (err) {
    logError("addFriendRelation", err);
    return { ok: false, reason: "error" };
  }
}

// -------------------- STREAK UPDATE --------------------
async function bumpStreak(senderUid, receiverUid) {
  const now = new Date().toISOString();

  async function updateOne(u1, u2) {
    const { data: row, error: selErr } = await supabase
      .from("friends")
      .select("streak, last_meme_at")
      .eq("user_uid", u1)
      .eq("friend_uid", u2)
      .maybeSingle();

    if (selErr) {
      logError("bumpStreak select", selErr);
      return;
    }

    const newStreak = calculateNewStreak(
      row?.streak ?? null,
      row?.last_meme_at ?? null,
      now
    );

    const { error: upErr } = await supabase.from("friends").upsert({
      user_uid: u1,
      friend_uid: u2,
      streak: newStreak,
      last_meme_at: now,
    });

    if (upErr) {
      logError("bumpStreak upsert", upErr);
    }
  }

  try {
    await updateOne(senderUid, receiverUid);
    await updateOne(receiverUid, senderUid);
  } catch (err) {
    logError("bumpStreak", err);
  }
}

// -------------------- REACTIONS --------------------
async function saveReaction(senderUid, receiverUid, memeMessageId, emoji) {
  try {
    const { error } = await supabase.from("reactions").insert({
      sender_uid: senderUid,
      receiver_uid: receiverUid,
      meme_message: String(memeMessageId),
      reaction: emoji,
    });
    if (error) throw error;
  } catch (err) {
    logError("saveReaction", err);
  }
}

// -------------------- BROADCAST JOB --------------------
async function broadcastPromoToAllUsers() {
  try {
    console.log("📣 Running promo broadcast job…");

    const { data: users, error } = await supabase
      .from("users")
      .select("tg_user_id")
      .not("tg_user_id", "is", null);

    if (error) {
      logError("broadcastPromoToAllUsers select", error);
      return;
    }

    if (!users || !users.length) {
      console.log("📣 No users found for promo.");
      return;
    }

    for (const u of users) {
      const chatId = Number(u.tg_user_id);
      const text = `${randomPromoText()}\n\nTap below to open MemeStreak Hub 👇`;

      await sendSiteButton(chatId, text).catch((err) => {
        if (err.response && err.response.statusCode === 403) {
          console.log(`User ${chatId} blocked the bot, skipping.`);
        } else {
          logError("broadcast send", err);
        }
      });

      await new Promise((r) => setTimeout(r, 150));
    }

    console.log("📣 Promo broadcast finished.");
  } catch (err) {
    logError("broadcastPromoToAllUsers", err);
  }
}

setTimeout(broadcastPromoToAllUsers, 15_000);
setInterval(broadcastPromoToAllUsers, BROADCAST_INTERVAL_MS);

// -------------------- COMMANDS --------------------

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await ensureUser(msg.from);

    userStates.delete(msg.from.id);
    pendingSendTarget.delete(msg.from.id);

    const text =
      "🔥 *Welcome to MemeStreak!* \n\n" +
      `Your UID: *${user.uid}*\n\n` +
      "Share memes every day to keep your streak alive! 🔥\n\n" +
      "Commands:\n" +
      "• /myuid – Show your UID\n" +
      "• /addfriend – Add a friend using their UID\n" +
      "• /friends – See your friend list & streaks\n" +
      "• /sendmeme – Send a meme to a friend\n" +
      "• /opensite – Open MemeStreak Hub";

    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err) {
    logError("/start", err);
    bot.sendMessage(chatId, "❌ Something went wrong.");
  }
});

// /myuid
bot.onText(/\/myuid/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await ensureUser(msg.from);
    await bot.sendMessage(chatId, `🔑 Your UID: *${user.uid}*`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    logError("/myuid", err);
    bot.sendMessage(chatId, "❌ Could not get your UID.");
  }
});

// /opensite
bot.onText(/\/opensite/, async (msg) => {
  const chatId = msg.chat.id;
  await sendSiteButton(
    chatId,
    "🌐 Tap below to open *MemeStreak Hub* and explore fresh memes:"
  );
});

// /addfriend
bot.onText(/\/addfriend/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await ensureUser(msg.from);
    userStates.set(msg.from.id, { mode: "add_friend", data: { myUid: user.uid } });

    await bot.sendMessage(
      chatId,
      "👥 Send me your friend's UID (like `MS123456`) to add them.",
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    logError("/addfriend", err);
    bot.sendMessage(chatId, "❌ Could not start add-friend flow.");
  }
});

// /friends
bot.onText(/\/friends/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await ensureUser(msg.from);
    const friends = await getFriendsForUserUid(user.uid);

    if (!friends.length) {
      await bot.sendMessage(
        chatId,
        "👀 You have no friends yet.\nUse /addfriend and share your UID with them."
      );
      return;
    }

    const friendUids = friends.map((f) => f.friend_uid);
    const userInfos = await getUsersByUids(friendUids);

    let text = "👥 *Your friends & streaks:*\n\n";
    for (const f of friends) {
      const info = userInfos.find((u) => u.uid === f.friend_uid);
      const name =
        (info && (info.first_name || info.username)) || f.friend_uid;
      const streak = typeof f.streak === "number" ? f.streak : 0;
      text += `• ${name} – 🔥 ${streak}\n`;
    }

    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err) {
    logError("/friends", err);
    bot.sendMessage(chatId, "❌ Could not load your friends.");
  }
});

// /sendmeme
bot.onText(/\/sendmeme/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await ensureUser(msg.from);
    const friends = await getFriendsForUserUid(user.uid);

    if (!friends.length) {
      await bot.sendMessage(
        chatId,
        "👀 You have no friends to send memes to.\nUse /addfriend first."
      );
      return;
    }

    const friendUids = friends.map((f) => f.friend_uid);
    const userInfos = await getUsersByUids(friendUids);

    const buttons = friends.map((f) => {
      const info = userInfos.find((u) => u.uid === f.friend_uid);
      const name =
        (info && (info.first_name || info.username)) || f.friend_uid;
      const streak = typeof f.streak === "number" ? f.streak : 0;
      return [
        {
          text: `${name} (🔥 ${streak})`,
          callback_data: `pickfriend:${f.friend_uid}`,
        },
      ];
    });

    userStates.set(msg.from.id, {
      mode: "send_meme_select",
      data: { myUid: user.uid },
    });

    await bot.sendMessage(
      chatId,
      "📤 Who do you want to send a meme to?\nTap a friend:",
      { reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logError("/sendmeme", err);
    bot.sendMessage(chatId, "❌ Could not start meme sending flow.");
  }
});

// -------------------- CALLBACKS --------------------
bot.on("callback_query", async (query) => {
  try {
    const data = query.data || "";
    const from = query.from;
    const chatId = query.message.chat.id;

    // Choosing a friend
    if (data.startsWith("pickfriend:")) {
      const friendUid = data.split(":")[1];
      pendingSendTarget.set(from.id, { friendUid });
      userStates.set(from.id, {
        mode: "send_meme_wait_media",
        data: { friendUid },
      });

      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
        "✅ Friend selected!\nNow send a *photo/video/document* – that meme will be forwarded.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Reaction pressed
    if (data.startsWith("react:")) {
      const parts = data.split(":"); // react:emoji:senderUid
      const emoji = parts[1];
      const originalSenderUid = parts[2];

      const reactor = await ensureUser(from);

      const memeMsg = query.message;
      const memeMessageId = memeMsg.message_id;

      await saveReaction(
        reactor.uid,
        originalSenderUid,
        memeMessageId,
        emoji
      );

      const originalSender = await getUserByUid(originalSenderUid);
      if (originalSender && originalSender.tg_user_id) {
        const reactorName =
          reactor.first_name || reactor.username || "Someone";

        await bot
          .sendMessage(
            originalSender.tg_user_id,
            `${reactorName} reacted ${emoji} to your meme 😄`
          )
          .catch((err) => {
            if (err.response && err.response.statusCode === 403) {
              console.log("Original sender blocked bot, skip notify.");
            } else {
              logError("reaction notify", err);
            }
          });
      }

      await bot.answerCallbackQuery(query.id, {
        text: `You reacted ${emoji}`,
        show_alert: false,
      });
      return;
    }
  } catch (err) {
    logError("callback_query", err);
  }
});

// -------------------- MESSAGE HANDLER --------------------
bot.on("message", async (msg) => {
  try {
    if (msg.text && msg.text.startsWith("/")) return;

    const state = userStates.get(msg.from.id);

    // Add friend flow
    if (state && state.mode === "add_friend" && msg.text) {
      const chatId = msg.chat.id;
      const myUid = state.data.myUid;
      const friendUid = msg.text.trim();

      userStates.delete(msg.from.id);

      if (!friendUid || friendUid.length < 4) {
        await bot.sendMessage(
          chatId,
          "❌ That UID looks invalid. Use /addfriend again."
        );
        return;
      }

      const result = await addFriendRelation(myUid, friendUid);
      if (!result.ok) {
        if (result.reason === "self") {
          await bot.sendMessage(chatId, "🙃 You cannot add yourself.");
        } else if (result.reason === "not_found") {
          await bot.sendMessage(chatId, "❌ No user found with that UID.");
        } else {
          await bot.sendMessage(
            chatId,
            "❌ Could not add friend. Please try again."
          );
        }
        return;
      }

      await bot.sendMessage(
        chatId,
        "✅ Friend added!\nNow you both can use /sendmeme to keep your MemeStreak alive 🔥"
      );
      return;
    }
  } catch (err) {
    logError("generic message handler", err);
  }
});

// -------------------- MEME MEDIA HANDLERS --------------------
bot.on("photo", (msg) => handleIncomingMeme(msg, "photo"));
bot.on("video", (msg) => handleIncomingMeme(msg, "video"));
bot.on("document", (msg) => handleIncomingMeme(msg, "document"));

async function handleIncomingMeme(msg, type) {
  try {
    const senderTgId = msg.from.id;
    const target = pendingSendTarget.get(senderTgId);

    if (!target) return;

    const senderUser = await ensureUser(msg.from);
    const senderUid = senderUser.uid;

    const friendUid = target.friendUid;
    const friendRow = await getUserByUid(friendUid);

    if (!friendRow || !friendRow.tg_user_id) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Could not find your friend. Try /sendmeme again."
      );
      pendingSendTarget.delete(senderTgId);
      return;
    }

    const receiverChatId = Number(friendRow.tg_user_id);

    let fileId;
    if (type === "photo") {
      const photos = msg.photo || [];
      if (!photos.length) return;
      fileId = photos[photos.length - 1].file_id;
    } else if (type === "video") {
      if (!msg.video) return;
      fileId = msg.video.file_id;
    } else if (type === "document") {
      if (!msg.document) return; 
      fileId = msg.document.file_id;
    }

    const senderName =
      senderUser.first_name ||
      msg.from.first_name ||
      msg.from.username ||
      "Someone";

    const caption = `📨 Meme from ${senderName}`;

    const reactionKeyboard = {
      inline_keyboard: [
        [
          { text: "😂", callback_data: `react:😂:${senderUid}` },
          { text: "🤣", callback_data: `react:🤣:${senderUid}` },
          { text: "😐", callback_data: `react:😐:${senderUid}` },
          { text: "😭", callback_data: `react:😭:${senderUid}` },
          { text: "❤️", callback_data: `react:❤️:${senderUid}` },
        ],
      ],
    };

    if (type === "photo") {
      await bot.sendPhoto(receiverChatId, fileId, {
        caption,
        reply_markup: reactionKeyboard,
      });
    } else if (type === "video") {
      await bot.sendVideo(receiverChatId, fileId, {
        caption,
        reply_markup: reactionKeyboard,
      });
    } else if (type === "document") {
      await bot.sendDocument(receiverChatId, fileId, {
        caption,
        reply_markup: reactionKeyboard,
      });
    }

    await bumpStreak(senderUid, friendUid);

    await bot.sendMessage(
      msg.chat.id,
      "✅ Meme sent! Streak updated (max +1 per day if both keep sending). 🔥"
    );

    pendingSendTarget.delete(senderTgId);
  } catch (err) {
    logError("handleIncomingMeme", err);
    bot.sendMessage(
      msg.chat.id,
      "❌ Something went wrong while sending your meme."
    );
  }
}

// ==================== END OF PART 2 OF 2 ====================
