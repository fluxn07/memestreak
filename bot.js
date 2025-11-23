// bot.js

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const express = require("express");

// -------------------- ENV --------------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN / SUPABASE_URL / SUPABASE_KEY");
  process.exit(1);
}

// -------------------- INIT --------------------
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("🚀 MemeStreak Bot Running...");

bot.on("polling_error", (err) => {
  console.log("Polling error:", err.code, err.message);
});

// -------------------- EXPRESS API (Website → Bot) --------------------
const app = express();
app.use(express.json());

// POST /sendCode  { uid, code }  -> send login code to user on Telegram
app.post("/sendCode", async (req, res) => {
  try {
    const { uid, code } = req.body;
    if (!uid || !code) {
      return res.status(400).json({ error: "uid and code required" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("tg_user_id")
      .eq("uid", uid)
      .maybeSingle();

    if (error || !user) {
      console.error("sendCode user lookup error:", error);
      return res.status(404).json({ error: "User not found" });
    }

    await bot
      .sendMessage(
        user.tg_user_id,
        `🔐 Your MemeStreak login code:\n\n⭐ *${code}*`,
        { parse_mode: "Markdown" }
      )
      .catch((err) => {
        if (err.response && err.response.statusCode === 403) {
          console.log("User blocked bot while sending login code.");
        } else {
          console.error("sendCode sendMessage error:", err);
        }
      });

    return res.json({ success: true });
  } catch (err) {
    console.error("sendCode error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🌐 Express API is live on port", PORT));

// -------------------- STATE --------------------
const userStates = new Map(); // tgUserId -> { mode, data }
const pendingSendTarget = new Map(); // tgUserId -> { friendUid }

// -------------------- UTILS --------------------
function logError(ctx, err) {
  console.error(`${ctx} error:`, err);
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

// streak update in friends table for both directions
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

// Log reactions (optional table "reactions")
async function saveReaction(senderUid, receiverUid, memeMessageId, emoji) {
  try {
    const { error } = await supabase.from("reactions").insert({
      sender_uid: senderUid,
      receiver_uid: receiverUid,
      meme_message_id: memeMessageId,
      reaction: emoji,
    });
    if (error) throw error;
  } catch (err) {
    logError("saveReaction", err);
  }
}

// -------------------- COMMANDS --------------------

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await ensureUser(msg.from);

    userStates.delete(msg.from.id);
    pendingSendTarget.delete(msg.from.id);

    const text =
      "🔥 *Welcome to MemeStreak!*\n\n" +
      `Your UID: *${user.uid}*\n\n` +
      "Share memes every day to keep your streak alive! 🔥\n\n" +
      "Commands:\n" +
      "• /myuid – Show your UID\n" +
      "• /addfriend – Add a friend using their UID\n" +
      "• /friends – See your friend list & streaks\n" +
      "• /sendmeme – Send a meme to a friend\n" +
      "• /site – Open meme website";

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

// /site
bot.onText(/\/site/, async (msg) => {
  const chatId = msg.chat.id;
  const url = "https://www.memedroid.com"; // temporary source
  await bot.sendMessage(
    chatId,
    "🌐 Tap below to open meme site, download a meme, then come back and send it via /sendmeme:",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "Open Meme Site", url }]],
      },
    }
  );
});

// /addfriend -> ask for UID in next message
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

// /sendmeme – choose friend with buttons
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
      {
        reply_markup: { inline_keyboard: buttons },
      }
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

    // Friend chosen
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

    // Reaction button pressed
    if (data.startsWith("react:")) {
      const parts = data.split(":"); // react:emoji:senderUid
      const emoji = parts[1];
      const originalSenderUid = parts[2];

      const reactor = await ensureUser(from); // user who pressed reaction

      const memeMsg = query.message;
      const memeMessageId = memeMsg.message_id;

      // save reaction in DB
      await saveReaction(reactor.uid, originalSenderUid, memeMessageId, emoji);

      // notify original sender (if they still allow bot)
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

// -------------------- MESSAGE HANDLER (for add_friend UID) --------------------
bot.on("message", async (msg) => {
  try {
    // ignore messages that are pure commands
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

// -------------------- MEME HANDLERS --------------------
bot.on("photo", (msg) => handleIncomingMeme(msg, "photo"));
bot.on("video", (msg) => handleIncomingMeme(msg, "video"));
bot.on("document", (msg) => handleIncomingMeme(msg, "document"));

async function handleIncomingMeme(msg, type) {
  try {
    const senderTgId = msg.from.id;
    const target = pendingSendTarget.get(senderTgId);

    if (!target) {
      // meme not part of /sendmeme flow → ignore streak logic
      return;
    }

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

    // get file_id
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

    const callbackBase = `react`; // react:emoji:senderUid
    const reactionKeyboard = {
      inline_keyboard: [
        [
          { text: "😂", callback_data: `${callbackBase}:😂:${senderUid}` },
          { text: "🤣", callback_data: `${callbackBase}:🤣:${senderUid}` },
          { text: "😐", callback_data: `${callbackBase}:😐:${senderUid}` },
          { text: "😭", callback_data: `${callbackBase}:😭:${senderUid}` },
          { text: "❤️", callback_data: `${callbackBase}:❤️:${senderUid}` },
        ],
      ],
    };

    // send meme to friend
    let sent;
    if (type === "photo") {
      sent = await bot.sendPhoto(receiverChatId, fileId, {
        caption,
        reply_markup: reactionKeyboard,
      });
    } else if (type === "video") {
      sent = await bot.sendVideo(receiverChatId, fileId, {
        caption,
        reply_markup: reactionKeyboard,
      });
    } else if (type === "document") {
      sent = await bot.sendDocument(receiverChatId, fileId, {
        caption,
        reply_markup: reactionKeyboard,
      });
    }

    // update streak
    await bumpStreak(senderUid, friendUid);

    await bot.sendMessage(
      msg.chat.id,
      "✅ Meme sent! Streak updated (max +1 per day if both keep sending). 🔥"
    );

    pendingSendTarget.delete(senderTgId);

    // Optionally save initial "no reaction yet" using sent.message_id if you want
    // const memeMessageId = sent.message_id;
  } catch (err) {
    logError("handleIncomingMeme", err);
    bot.sendMessage(
      msg.chat.id,
      "❌ Something went wrong while sending your meme."
    );
  }
}
