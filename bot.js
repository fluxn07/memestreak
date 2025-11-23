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
  console.error("❌ Missing environment variables.");
  process.exit(1);
}

// -------------------- INIT --------------------
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("🚀 MemeStreak Bot Running...");

// -------------------- EXPRESS API (Website → Bot) --------------------
const app = express();
app.use(express.json());

// Website sends login code → bot forwards to user
app.post("/sendCode", async (req, res) => {
  const { uid, code } = req.body;

  const { data: user, error } = await supabase
    .from("users")
    .select("tg_user_id")
    .eq("uid", uid)
    .single();

  if (error || !user) {
    return res.status(404).json({ error: "User not found" });
  }

  await bot.sendMessage(
    user.tg_user_id,
    `🔐 Your MemeStreak Login Code:\n\n⭐ *${code}*`,
    { parse_mode: "Markdown" }
  );

  return res.json({ success: true });
});

// Railway port binding
app.listen(process.env.PORT || 3000, () =>
  console.log("🌐 Express API is live")
);

// -------------------- UTILS --------------------
function calculateNewStreak(existing, lastSent, now) {
  if (!lastSent) return 1;

  const last = new Date(lastSent);
  const current = new Date(now);

  const startToday = new Date(Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate()
  ));

  const startLast = new Date(Date.UTC(
    last.getUTCFullYear(),
    last.getUTCMonth(),
    last.getUTCDate()
  ));

  const diff = (startToday - startLast) / 86400000;

  if (diff === 0) return existing || 1;
  if (diff === 1) return (existing || 0) + 1;
  return 1;
}

async function ensureUser(tgUser) {
  const tgId = String(tgUser.id);

  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("tg_user_id", tgId)
    .maybeSingle();

  if (existing) return existing;

  const uid = "MS" + Math.floor(100000 + Math.random() * 900000);

  const { data: inserted } = await supabase
    .from("users")
    .insert({
      uid,
      tg_user_id: tgId,
      username: tgUser.username,
      first_name: tgUser.first_name,
    })
    .select("*")
    .single();

  return inserted;
}

// -------------------- FRIEND SYSTEM --------------------
async function addFriend(userUid, friendUid) {
  if (userUid === friendUid)
    return { ok: false, msg: "❌ You cannot add yourself." };

  const { data: friend } = await supabase
    .from("users")
    .select("uid")
    .eq("uid", friendUid)
    .maybeSingle();

  if (!friend)
    return { ok: false, msg: "❌ Friend UID not found." };

  await supabase.from("friends").upsert([
    { user_uid: userUid, friend_uid: friendUid },
    { user_uid: friendUid, friend_uid: userUid }
  ]);

  return { ok: true };
}

async function bumpStreak(senderUid, receiverUid) {
  const now = new Date().toISOString();

  async function updateRow(u1, u2) {
    const { data: row } = await supabase
      .from("friends")
      .select("streak, last_meme_at")
      .eq("user_uid", u1)
      .eq("friend_uid", u2)
      .maybeSingle();

    const newStreak = calculateNewStreak(
      row?.streak ?? null,
      row?.last_meme_at ?? null,
      now
    );

    await supabase.from("friends").upsert({
      user_uid: u1,
      friend_uid: u2,
      streak: newStreak,
      last_meme_at: now,
    });
  }

  await updateRow(senderUid, receiverUid);
  await updateRow(receiverUid, senderUid);
}

// -------------------- COMMANDS --------------------
bot.onText(/\/start/, async (msg) => {
  const user = await ensureUser(msg.from);

  bot.sendMessage(
    msg.chat.id,
    `🔥 *Welcome to MemeStreak!*\n\nYour UID: *${user.uid}*\nShare memes every day to keep streak alive!`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/myuid/, async (msg) => {
  const user = await ensureUser(msg.from);
  bot.sendMessage(msg.chat.id, `🔑 Your UID: *${user.uid}*`, {
    parse_mode: "Markdown",
  });
});

bot.onText(/\/addfriend (.+)/, async (msg, match) => {
  const friendUid = match[1].trim();
  const user = await ensureUser(msg.from);

  const res = await addFriend(user.uid, friendUid);

  bot.sendMessage(msg.chat.id, res.msg || "✅ Friend Added!");
});

bot.onText(/\/friends/, async (msg) => {
  const user = await ensureUser(msg.from);

  const { data: rows } = await supabase
    .from("friends")
    .select("friend_uid, streak")
    .eq("user_uid", user.uid);

  if (!rows || rows.length === 0)
    return bot.sendMessage(msg.chat.id, "You have no friends added!");

  let text = "👥 *Your Friends:*\n\n";
  rows.forEach((f) => {
    text += `• ${f.friend_uid} — 🔥 Streak: ${f.streak}\n`;
  });

  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// -------------------- MEME LISTENER --------------------
bot.on("photo", async (msg) => {
  const sender = await ensureUser(msg.from);

  if (!msg.caption) return; // Need friend UID in caption

  const targetUid = msg.caption.trim();

  const { data: friend } = await supabase
    .from("users")
    .select("uid")
    .eq("uid", targetUid)
    .maybeSingle();

  if (!friend) {
    return bot.sendMessage(msg.chat.id, "❌ Invalid UID in caption.");
  }

  await bumpStreak(sender.uid, targetUid);

  bot.sendMessage(msg.chat.id, "🔥 Meme sent! Your streak updated.");
});
