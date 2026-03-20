require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, Events, EmbedBuilder, PermissionFlagsBits,
} = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const cors = require('cors');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
  ],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DAILY_LIMIT    = 3;
const PREMIUM_ROLE   = 'Premium Builder';
const UPGRADE_LINK   = process.env.UPGRADE_LINK || 'https://whop.com/buildrai/buildr-ai-premium-builder/';
const COLOR          = 0x7B2FBE;
const XP_PER_MSG     = 5;
const XP_COOLDOWN_MS = 60_000;

const RANKS = [
  { name: '🌱 Rookie',   minXP: 0     },
  { name: '🔨 Builder',  minXP: 500   },
  { name: '⚙️ Operator', minXP: 1500  },
  { name: '🤝 Closer',   minXP: 3500  },
  { name: '🚀 Founder',  minXP: 7500  },
  { name: '👑 Empire',   minXP: 15000 },
];

// ── Stores ────────────────────────────────────────────────────────────────────
const promptCounts  = new Map();
const xpStore       = new Map();
const streakStore   = new Map();
const xpCooldowns   = new Map();
const conversations = new Map();
const usernameCache = new Map();
const warnStore     = new Map(); // userId -> [{ reason, modTag, timestamp }]
const spamTracker   = new Map(); // userId -> [timestamps]

// ── Reaction Roles ─────────────────────────────────────────────────────────────
let reactionRoleMessageId = null; // stored in-memory; admin runs /setuproles again after restart

const NICHE_ROLES = [
  { emoji: '🛍️', roleName: '🛍️ E-Commerce' },
  { emoji: '📱', roleName: '📱 Social Media / Content' },
  { emoji: '💻', roleName: '💻 Tech / SaaS' },
  { emoji: '🎨', roleName: '🎨 Creative / Design' },
  { emoji: '📈', roleName: '📈 Investing / Finance' },
  { emoji: '🏪', roleName: '🏪 Local Business' },
  { emoji: '🤝', roleName: '🤝 Service Based' },
  { emoji: '🌱', roleName: '🌱 Still Figuring It Out' },
];

const EMOJI_TO_ROLE = new Map(NICHE_ROLES.map(({ emoji, roleName }) => [emoji, roleName]));

// ── Utilities ─────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().split('T')[0]; }

function timeUntilMidnight() {
  const now = new Date();
  const mid = new Date(now); mid.setHours(24, 0, 0, 0);
  const ms = mid - now;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function getCount(uid) {
  const r = promptCounts.get(uid);
  if (!r || r.date !== today()) { promptCounts.set(uid, { count: 0, date: today() }); return 0; }
  return r.count;
}
function bumpCount(uid) { promptCounts.set(uid, { count: getCount(uid) + 1, date: today() }); }

function isPremium(member) {
  return member?.roles.cache.some(r => r.name === PREMIUM_ROLE) ?? false;
}
function isAdmin(member) {
  return member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
}

function getXP(uid)      { return xpStore.get(uid) || 0; }
function getRank(xp)     { return RANKS.filter(r => xp >= r.minXP).at(-1); }
function getNextRank(xp) { return RANKS.find(r => r.minXP > xp) || null; }

function getStreak(uid) { return streakStore.get(uid)?.streak || 0; }
function bumpStreak(uid) {
  const t = today();
  const r = streakStore.get(uid);
  if (!r)               { streakStore.set(uid, { streak: 1, lastDate: t }); return 1; }
  if (r.lastDate === t)   return r.streak;
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const n = r.lastDate === yest.toISOString().split('T')[0] ? r.streak + 1 : 1;
  streakStore.set(uid, { streak: n, lastDate: t });
  return n;
}

function emb(title, desc, footer = null) {
  const e = new EmbedBuilder().setColor(COLOR).setTitle(title).setDescription(desc);
  if (footer) e.setFooter({ text: footer });
  return e;
}

function modEmb(action, target, mod, reason, extra = null) {
  const colors = { WARN: 0xF4A917, MUTE: 0xFF6B35, UNMUTE: 0x22D97A, KICK: 0xFF6B35, BAN: 0xFF0000, UNBAN: 0x22D97A, AUTOMOD: 0xFF6B35 };
  const icons  = { WARN: '⚠️', MUTE: '🔇', UNMUTE: '🔊', KICK: '👢', BAN: '🔨', UNBAN: '✅', AUTOMOD: '🤖' };
  const e = new EmbedBuilder()
    .setColor(colors[action] || COLOR)
    .setTitle(`${icons[action] || '🔨'} ${action}`)
    .addFields(
      { name: 'User',      value: `${target.tag || target} (${target.id || target})`, inline: true },
      { name: 'Moderator', value: mod ? `${mod.tag} (${mod.id})` : 'AutoMod',          inline: true },
      { name: 'Reason',    value: reason || 'No reason provided',                       inline: false },
    )
    .setTimestamp();
  if (extra) e.addFields({ name: 'Details', value: extra, inline: false });
  return e;
}

async function logMod(guild, action, target, mod, reason, extra = null) {
  try {
    const ch = guild.channels.cache.find(c => c.name === 'mod-logs');
    if (ch) await ch.send({ embeds: [modEmb(action, target, mod, reason, extra)] });
  } catch {}
}

function parseDuration(str) {
  const m = str?.match(/^(\d+)(s|m|h|d|w)$/i);
  if (!m) return null;
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return Math.min(parseInt(m[1]) * mult[m[2].toLowerCase()], 28 * 86_400_000);
}

function formatDuration(ms) {
  if (ms >= 86_400_000) return `${Math.floor(ms / 86_400_000)}d`;
  if (ms >= 3_600_000)  return `${Math.floor(ms / 3_600_000)}h`;
  if (ms >= 60_000)     return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 1000)}s`;
}

async function getMember(uid) {
  try { return await client.guilds.cache.first()?.members.fetch(uid).catch(() => null) ?? null; }
  catch { return null; }
}

async function grantXP(member, amount) {
  const uid = member.id;
  const prev = getXP(uid);
  const prevRank = getRank(prev);
  const newXP = prev + amount;
  xpStore.set(uid, newXP);
  if (member.user?.username) usernameCache.set(uid, member.user.username);
  const newRank = getRank(newXP);

  if (newRank.name !== prevRank.name) {
    // Post to #achievements
    try {
      const ch = member.guild.channels.cache.find(c => c.name === 'achievements');
      if (ch) await ch.send({ embeds: [emb('🎉 Rank Up!', `**${member.displayName}** just reached **${newRank.name}** with **${newXP} XP**! 🚀`)] });
    } catch (err) {
      console.error('Achievements post error:', err.message);
    }

    // Remove old rank role, assign new rank role
    try {
      const rankNames = ['🌱 Rookie', '🔨 Builder', '⚙️ Operator', '🤝 Closer', '🚀 Founder', '👑 Empire'];
      // Remove all existing rank roles
      for (const rankName of rankNames) {
        const existingRole = member.guild.roles.cache.find(r => r.name === rankName);
        if (existingRole && member.roles.cache.has(existingRole.id)) {
          await member.roles.remove(existingRole);
        }
      }
      // Add new rank role
      const newRankRole = member.guild.roles.cache.find(r => r.name === newRank.name);
      if (newRankRole) {
        await member.roles.add(newRankRole);
        console.log(`Assigned ${newRank.name} to ${member.displayName}`);
      } else {
        console.log(`Role not found for rank: ${newRank.name}`);
      }
    } catch (err) {
      console.error('Role assignment error:', err.message);
    }
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM = `You are BuildrAI Mentor — a sharp, no-BS startup mentor who has actually built businesses. You talk directly to young entrepreneurs aged 16–25.

Rules:
- Direct and honest. Call out bad ideas clearly but constructively.
- Gen Z energy: real, no corporate speak, no buzzword salad.
- Push back on lazy thinking. Make them think harder.
- Every response ends with ONE specific action they can take TODAY.
- Under 300 words unless the task truly demands more. Short paragraphs. Line breaks. No walls of text.
- You believe in them but won't pretend a bad idea is good.

FORMAT: Every single response MUST open with a short punchy one-liner (1 sentence, motivating but not cringe). Then get into content.`;

const P = {
  idea: i => `User interest: "${i}". Generate 3 unique business ideas for a young entrepreneur.
For EACH idea:
- Bold name
- One-sentence description
- Target customer (specific, not "everyone")
- Estimated startup cost ($$ range)
- Time to first dollar (honest)
- Difficulty: X/5
- One action to start THIS WEEK
At least one fully digital. At least one under $100 to start.`,

  pitch: i => `Business: "${i}". Write a 30-second elevator pitch in FIRST PERSON.
Structure: Hook → Problem → Solution → Why you → CTA. Real person talking, not a press release. Under 100 words.`,

  competitor: i => `Analyze: "${i}".
- Business model (how they actually make money)
- Revenue streams
- Target customer
- Biggest weakness (specific)
- One gap to exploit NOW with a limited budget`,

  landing: i => `Landing page copy for: "${i}".
HEADLINE (under 10 words, benefit-focused)
SUBHEADLINE (1 sentence)
3 BENEFITS (outcomes, not features)
SOCIAL PROOF (one realistic testimonial)
CTA BUTTON TEXT (action verb + outcome)
Modern tone for young entrepreneurs.`,

  validateAsk: i => `User wants to validate: "${i}".
Ask exactly 3 sharp questions about:
1. Demand — do people actually pay for this?
2. Competition — what alternatives exist?
3. Monetization — how exactly will you make money and how much?
Make each question SPECIFIC to their idea. Number them. Tell them: "Answer all 3 and I'll score your idea."`,

  strategyAsk: i => `User situation: "${i}".
Ask 2 follow-up questions to tailor your advice. Ask about the most important unknowns — resources, goal, timeline, or biggest blocker. Make them SPECIFIC to what they described. Number them. Say you'll give a custom 3-step plan after they answer.`,
};

async function claude(history) {
  console.log('Calling Anthropic API with model:', 'claude-haiku-4-5-20251001');
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      system: SYSTEM,
      messages: history,
      max_tokens: 800,
    });
    return r.content[0].text;
  } catch (err) {
    console.error('Anthropic API error — status:', err.status, '| message:', err.message, '| error:', err.error ?? null);
    throw err;
  }
}

async function checkLimit(interaction) {
  const uid = interaction.user.id, member = await getMember(uid), prem = isPremium(member);
  if (!prem && getCount(uid) >= DAILY_LIMIT) {
    await interaction.reply({ embeds: [emb('⏰ Daily Limit', `You've used your **${DAILY_LIMIT} daily prompts**.\n\nResets in **${timeUntilMidnight()}**.\n\nPremium = unlimited + 2x XP.\n👉 ${UPGRADE_LINK}`)] });
    return null;
  }
  return { prem, member };
}

function footer(prem, uid) {
  if (prem) return 'Premium Builder — unlimited prompts ⭐';
  const r = DAILY_LIMIT - getCount(uid);
  return `${r} prompt${r !== 1 ? 's' : ''} remaining today`;
}

async function runAI(interaction, title, firstMsg) {
  const lim = await checkLimit(interaction);
  if (!lim) return;
  await interaction.deferReply();
  try {
    const history = [{ role: 'user', content: firstMsg }];
    const result  = await claude(history);
    history.push({ role: 'assistant', content: result });
    conversations.set(interaction.user.id, history);
    bumpCount(interaction.user.id);
    bumpStreak(interaction.user.id);
    await interaction.editReply({ embeds: [emb(title, result, footer(lim.prem, interaction.user.id))] });
  } catch (err) {
    console.error(`${title}:`, err.message);
    await interaction.editReply({ embeds: [emb('⚠️ Error', 'My brain glitched. Try again or use /support.')] });
  }
}

// ── AI command handlers ───────────────────────────────────────────────────────
async function handleHelp(ix) {
  await ix.reply({ embeds: [emb(
    '🤖 BuildrAI — All Commands',
    `**AI Commands (DM only)**\n` +
    `\`/idea\` — 3 ideas with cost + difficulty\n\`/pitch\` — 30-second elevator pitch\n\`/validate\` — score/10 + PASS/FAIL\n\`/competitor\` — competitor breakdown\n\`/landing\` — landing page copy\n\`/strategy\` — tailored 3-step plan\n\n` +
    `**Info**\n\`/streak\` \`/rank\` \`/leaderboard\` \`/support\` \`/help\`\n\n` +
    `**Mod (Admin only)**\n\`/warn\` \`/warnings\` \`/clearwarns\` \`/mute\` \`/unmute\` \`/kick\` \`/ban\` \`/unban\`\n\n` +
    `**Limits:** Free = 3/day | Premium = unlimited + 2x XP\n👉 ${UPGRADE_LINK}`,
    'BuildrAI Mentor',
  )] });
}

async function handleSupport(ix) {
  await ix.reply({ embeds: [emb('🆘 Support', `Post in **#feedback** or DM Leon directly.\n\nBilling issues: **whop.com/support**\n\nWe respond within 24 hours.`, 'BuildrAI Mentor')] });
}

async function handleRank(ix) {
  const xp = getXP(ix.user.id), rank = getRank(xp), next = getNextRank(xp);
  await ix.reply({ embeds: [emb('/rank — Your Progress',
    `**Rank:** ${rank.name}\n**XP:** ${xp}\n\n` +
    (next ? `**${xp} / ${next.minXP} XP** to reach ${next.name}` : `**${xp} XP** — Maximum rank achieved 👑`) +
    `\n\nEarn XP by chatting. Premium = 2x XP.`, 'BuildrAI Mentor')] });
}

async function handleLeaderboard(ix) {
  const entries = [...xpStore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!entries.length) { await ix.reply({ embeds: [emb('/leaderboard', 'No XP yet. Start chatting!')] }); return; }
  await ix.deferReply();
  const medals = ['🥇', '🥈', '🥉'];
  const lines = await Promise.all(entries.map(async ([uid, xp], i) => {
    try { const u = await client.users.fetch(uid); return `${medals[i] || `${i+1}.`} **${u.username}** — ${xp} XP (${getRank(xp).name})`; }
    catch { return `${medals[i] || `${i+1}.`} Unknown — ${xp} XP`; }
  }));
  await ix.editReply({ embeds: [emb('/leaderboard — Top 10 Builders', lines.join('\n'), 'Real-time')] });
}

async function handleStreak(ix) {
  const s = getStreak(ix.user.id);
  const msg = !s ? 'No streak yet. Use your first AI command to start. 🔥'
    : s === 1 ? '🔥 **1 day streak.** Just started — don\'t stop now.'
    : s < 7   ? `🔥 **${s} day streak.** Building the habit.`
    : s < 30  ? `🔥 **${s} day streak.** Locked in.`
    :           `🔥 **${s} day streak.** Elite consistency.`;
  await ix.reply({ embeds: [emb('/streak', msg, 'BuildrAI Mentor')] });
}

async function handleValidate(ix) {
  const lim = await checkLimit(ix); if (!lim) return;
  await ix.deferReply();
  try {
    const idea = ix.options.getString('idea');
    const history = [{ role: 'user', content: P.validateAsk(idea) }];
    const result = await claude(history);
    history.push({ role: 'assistant', content: result });
    conversations.set(ix.user.id, history);
    bumpCount(ix.user.id); bumpStreak(ix.user.id);
    await ix.editReply({ embeds: [emb('/validate — Idea Validation', result + '\n\n_Reply in DM with all 3 answers to get your score._', footer(lim.prem, ix.user.id))] });
  } catch (err) { console.error('validate:', err.message); await ix.editReply({ embeds: [emb('⚠️ Error', 'Something went wrong. Try /support.')] }); }
}

async function handleStrategy(ix) {
  const lim = await checkLimit(ix); if (!lim) return;
  await ix.deferReply();
  try {
    const sit = ix.options.getString('situation');
    const history = [{ role: 'user', content: P.strategyAsk(sit) }];
    const result = await claude(history);
    history.push({ role: 'assistant', content: result });
    conversations.set(ix.user.id, history);
    bumpCount(ix.user.id); bumpStreak(ix.user.id);
    await ix.editReply({ embeds: [emb('/strategy — Action Plan', result + '\n\n_Reply in DM with your answers to get your plan._', footer(lim.prem, ix.user.id))] });
  } catch (err) { console.error('strategy:', err.message); await ix.editReply({ embeds: [emb('⚠️ Error', 'Something went wrong. Try /support.')] }); }
}

// ── Mod command handlers ──────────────────────────────────────────────────────
async function handleWarn(ix) {
  if (!isAdmin(ix.member)) { await ix.reply({ embeds: [emb('❌ No Permission', 'Admin only.')], ephemeral: true }); return; }
  const target = ix.options.getMember('user');
  const reason = ix.options.getString('reason') || 'No reason provided';
  if (!target) { await ix.reply({ embeds: [emb('❌ Error', 'User not found.')], ephemeral: true }); return; }

  const warns = warnStore.get(target.id) || [];
  warns.push({ reason, modTag: ix.user.tag, timestamp: Date.now() });
  warnStore.set(target.id, warns);

  await logMod(ix.guild, 'WARN', target.user, ix.user, reason, `Total warnings: ${warns.length}`);

  // Auto-escalate
  let autoAction = '';
  if (warns.length === 3) {
    try { await target.timeout(3_600_000, 'Auto: 3 warnings'); autoAction = '\n\n⚡ Auto-muted for 1 hour (3 warnings reached)'; } catch {}
  } else if (warns.length >= 5) {
    try { await target.kick('Auto: 5 warnings'); autoAction = '\n\n⚡ Auto-kicked (5 warnings reached)'; } catch {}
  }

  // DM the warned user
  try { await target.send({ embeds: [emb('⚠️ Warning', `You received a warning in **${ix.guild.name}**.\n\n**Reason:** ${reason}\n\nThis is warning **#${warns.length}**. 3 warnings = auto-mute. 5 warnings = auto-kick.`)] }); } catch {}

  await ix.reply({ embeds: [emb('⚠️ Warned', `**${target.user.tag}** warned.\n**Reason:** ${reason}\n**Total warnings:** ${warns.length}${autoAction}`)] });
}

async function handleWarnings(ix) {
  if (!isAdmin(ix.member)) { await ix.reply({ embeds: [emb('❌ No Permission', 'Admin only.')], ephemeral: true }); return; }
  const target = ix.options.getMember('user') || ix.options.getUser('user');
  const uid = target?.id || target?.id;
  const warns = warnStore.get(uid) || [];
  if (!warns.length) { await ix.reply({ embeds: [emb('📋 Warnings', `No warnings for **${target?.user?.tag || target?.tag}**.`)] }); return; }
  const list = warns.map((w, i) => `${i+1}. **${w.reason}** — by ${w.modTag} <t:${Math.floor(w.timestamp/1000)}:R>`).join('\n');
  await ix.reply({ embeds: [emb(`📋 Warnings — ${target?.user?.tag || target?.tag}`, list)] });
}

async function handleClearwarns(ix) {
  if (!isAdmin(ix.member)) { await ix.reply({ embeds: [emb('❌ No Permission', 'Admin only.')], ephemeral: true }); return; }
  const target = ix.options.getMember('user');
  warnStore.set(target.id, []);
  await logMod(ix.guild, 'WARN', target.user, ix.user, 'Warnings cleared');
  await ix.reply({ embeds: [emb('✅ Cleared', `All warnings cleared for **${target.user.tag}**.`)] });
}

async function handleMute(ix) {
  if (!isAdmin(ix.member)) { await ix.reply({ embeds: [emb('❌ No Permission', 'Admin only.')], ephemeral: true }); return; }
  const target   = ix.options.getMember('user');
  const durStr   = ix.options.getString('duration');
  const reason   = ix.options.getString('reason') || 'No reason provided';
  const duration = parseDuration(durStr);
  if (!duration) { await ix.reply({ embeds: [emb('❌ Invalid Duration', 'Use format: `10m`, `1h`, `1d`, `1w`')], ephemeral: true }); return; }
  try {
    await target.timeout(duration, reason);
    await logMod(ix.guild, 'MUTE', target.user, ix.user, reason, `Duration: ${formatDuration(duration)}`);
    try { await target.send({ embeds: [emb('🔇 Muted', `You were muted in **${ix.guild.name}** for **${formatDuration(duration)}**.\n\n**Reason:** ${reason}`)] }); } catch {}
    await ix.reply({ embeds: [emb('🔇 Muted', `**${target.user.tag}** muted for **${formatDuration(duration)}**.\n**Reason:** ${reason}`)] });
  } catch (err) { await ix.reply({ embeds: [emb('❌ Error', `Could not mute: ${err.message}`)], ephemeral: true }); }
}

async function handleUnmute(ix) {
  if (!isAdmin(ix.member)) { await ix.reply({ embeds: [emb('❌ No Permission', 'Admin only.')], ephemeral: true }); return; }
  const target = ix.options.getMember('user');
  try {
    await target.timeout(null);
    await logMod(ix.guild, 'UNMUTE', target.user, ix.user, 'Timeout removed');
    await ix.reply({ embeds: [emb('🔊 Unmuted', `**${target.user.tag}** timeout removed.`)] });
  } catch (err) { await ix.reply({ embeds: [emb('❌ Error', `Could not unmute: ${err.message}`)], ephemeral: true }); }
}

async function handleKick(ix) {
  if (!isAdmin(ix.member)) { await ix.reply({ embeds: [emb('❌ No Permission', 'Admin only.')], ephemeral: true }); return; }
  const target = ix.options.getMember('user');
  const reason = ix.options.getString('reason') || 'No reason provided';
  try {
    try { await target.send({ embeds: [emb('👢 Kicked', `You were kicked from **${ix.guild.name}**.\n\n**Reason:** ${reason}`)] }); } catch {}
    await target.kick(reason);
    await logMod(ix.guild, 'KICK', target.user, ix.user, reason);
    await ix.reply({ embeds: [emb('👢 Kicked', `**${target.user.tag}** kicked.\n**Reason:** ${reason}`)] });
  } catch (err) { await ix.reply({ embeds: [emb('❌ Error', `Could not kick: ${err.message}`)], ephemeral: true }); }
}

async function handleBan(ix) {
  if (!isAdmin(ix.member)) { await ix.reply({ embeds: [emb('❌ No Permission', 'Admin only.')], ephemeral: true }); return; }
  const target      = ix.options.getMember('user');
  const reason      = ix.options.getString('reason') || 'No reason provided';
  const deleteDays  = ix.options.getInteger('delete_days') || 0;
  try {
    try { await target.send({ embeds: [emb('🔨 Banned', `You were banned from **${ix.guild.name}**.\n\n**Reason:** ${reason}`)] }); } catch {}
    await ix.guild.members.ban(target.id, { reason, deleteMessageDays: deleteDays });
    await logMod(ix.guild, 'BAN', target.user, ix.user, reason, deleteDays ? `Deleted ${deleteDays} days of messages` : null);
    await ix.reply({ embeds: [emb('🔨 Banned', `**${target.user.tag}** banned.\n**Reason:** ${reason}`)] });
  } catch (err) { await ix.reply({ embeds: [emb('❌ Error', `Could not ban: ${err.message}`)], ephemeral: true }); }
}

async function handleUnban(ix) {
  if (!isAdmin(ix.member)) { await ix.reply({ embeds: [emb('❌ No Permission', 'Admin only.')], ephemeral: true }); return; }
  const userId = ix.options.getString('user_id');
  const reason = ix.options.getString('reason') || 'No reason provided';
  try {
    await ix.guild.members.unban(userId, reason);
    await logMod(ix.guild, 'UNBAN', { tag: `User ID: ${userId}`, id: userId }, ix.user, reason);
    await ix.reply({ embeds: [emb('✅ Unbanned', `User \`${userId}\` unbanned.\n**Reason:** ${reason}`)] });
  } catch (err) { await ix.reply({ embeds: [emb('❌ Error', `Could not unban: ${err.message}`)], ephemeral: true }); }
}

// ── Reaction Role command handler ─────────────────────────────────────────────
async function handleSetupRoles(ix) {
  if (!ix.guild) {
    await ix.reply({ embeds: [emb('❌ Server Only', 'This command can only be used in a server.')], ephemeral: true });
    return;
  }
  if (!isAdmin(ix.member)) {
    await ix.reply({ embeds: [emb('❌ No Permission', 'Admin only.')], ephemeral: true });
    return;
  }

  const rolesChannel = ix.guild.channels.cache.find(c => c.name === 'roles-explained');
  if (!rolesChannel) {
    await ix.reply({ embeds: [emb('❌ Channel Not Found', 'Could not find a channel named **#roles-explained**. Please create it first.')], ephemeral: true });
    return;
  }

  await ix.deferReply({ ephemeral: true });

  try {
    const nicheMessage =
      `🎯 **Pick Your Niche**\n\n` +
      `React below to get your niche role. You can pick one or more.\n\n` +
      `🛍️ — E-Commerce\n` +
      `📱 — Social Media / Content\n` +
      `💻 — Tech / SaaS\n` +
      `🎨 — Creative / Design\n` +
      `📈 — Investing / Finance\n` +
      `🏪 — Local Business\n` +
      `🤝 — Service Based\n` +
      `🌱 — Still Figuring It Out`;

    const posted = await rolesChannel.send(nicheMessage);
    reactionRoleMessageId = posted.id;

    // Add all 8 emoji reactions sequentially so they appear in order
    for (const { emoji } of NICHE_ROLES) {
      try { await posted.react(emoji); } catch (err) { console.error(`Failed to react with ${emoji}:`, err.message); }
    }

    await ix.editReply({ embeds: [emb('✅ Roles Message Posted', `Niche role selection message posted in ${rolesChannel}.\n\nMessage ID: \`${posted.id}\``)] });
  } catch (err) {
    console.error('setuproles error:', err.message);
    await ix.editReply({ embeds: [emb('⚠️ Error', `Failed to post roles message: ${err.message}`)] });
  }
}

// ── Commands list ─────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('idea').setDescription('Generate 3 business ideas').addStringOption(o => o.setName('interest').setDescription('Your interest or topic').setRequired(true)),
  new SlashCommandBuilder().setName('pitch').setDescription('Write your 30-second elevator pitch').addStringOption(o => o.setName('business').setDescription('Describe your business').setRequired(true)),
  new SlashCommandBuilder().setName('validate').setDescription('Score your idea (3-question deep dive)').addStringOption(o => o.setName('idea').setDescription('Describe your idea').setRequired(true)),
  new SlashCommandBuilder().setName('competitor').setDescription('Break down a competitor or industry').addStringOption(o => o.setName('target').setDescription('Competitor name or industry').setRequired(true)),
  new SlashCommandBuilder().setName('landing').setDescription('Generate landing page copy').addStringOption(o => o.setName('product').setDescription('Describe your product or service').setRequired(true)),
  new SlashCommandBuilder().setName('strategy').setDescription('Get a tailored 3-step action plan').addStringOption(o => o.setName('situation').setDescription('Describe your situation').setRequired(true)),
  new SlashCommandBuilder().setName('streak').setDescription('See your daily usage streak'),
  new SlashCommandBuilder().setName('rank').setDescription('See your XP and current rank'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('See top 10 members by XP'),
  new SlashCommandBuilder().setName('support').setDescription('Get help with BuildrAI'),
  new SlashCommandBuilder().setName('help').setDescription('See all available commands'),
  new SlashCommandBuilder().setName('warn').setDescription('Warn a user [Admin]')
    .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('warnings').setDescription('See a user\'s warnings [Admin]')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('clearwarns').setDescription('Clear all warnings for a user [Admin]')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('mute').setDescription('Timeout a user [Admin]')
    .addUserOption(o => o.setName('user').setDescription('User to mute').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration: 10m, 1h, 1d, 1w').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('unmute').setDescription('Remove timeout from a user [Admin]')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a user [Admin]')
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a user [Admin]')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .addIntegerOption(o => o.setName('delete_days').setDescription('Days of messages to delete (0-7)').setMinValue(0).setMaxValue(7)),
  new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID [Admin]')
    .addStringOption(o => o.setName('user_id').setDescription('User ID to unban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('setuproles').setDescription('Post the niche reaction role message in #roles-explained [Admin]'),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log('✅ Commands registered');
}

// ── Events ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅ BuildrAI Mentor online as ${client.user.tag}`);
  await registerCommands();
});

client.on(Events.GuildMemberAdd, async (member) => {
  try { const role = member.guild.roles.cache.find(r => r.name === 'Free User'); if (role) await member.roles.add(role); } catch {}
  // Assign starting rank role
  try {
    const rookieRole = member.guild.roles.cache.find(r => r.name === '🌱 Rookie');
    if (rookieRole) await member.roles.add(rookieRole);
  } catch {}
  try {
    await member.send({ embeds: [emb(`👋 Welcome to BuildrAI, ${member.displayName}`,
      `I'm your AI business mentor. **DM me** to keep ideas private.\n\n` +
      `\`/idea\` \`/pitch\` \`/validate\` \`/competitor\` \`/landing\` \`/strategy\`\n` +
      `\`/streak\` \`/rank\` \`/leaderboard\` \`/support\` \`/help\`\n\n` +
      `**Free:** 3/day | **Premium:** unlimited + 2x XP\n👉 ${UPGRADE_LINK}\n\nLet's build. 🚀`, 'BuildrAI Mentor')] });
  } catch {}
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // ── Server: auto-mod + XP ──────────────────────────────────────────────────
  if (message.guild) {
    const uid = message.author.id;
    const member = message.member;

    // Skip auto-mod for admins
    if (!isAdmin(member)) {
      // Anti-spam: 5 messages in 5 seconds
      const now = Date.now();
      const stamps = (spamTracker.get(uid) || []).filter(t => now - t < 5000);
      stamps.push(now);
      spamTracker.set(uid, stamps);
      if (stamps.length >= 5) {
        try {
          await message.delete();
          await member.timeout(300_000, 'AutoMod: spam');
          await logMod(message.guild, 'AUTOMOD', message.author, null, 'Spam detected — 5+ messages in 5 seconds', 'Auto-muted for 5 minutes');
          try { await message.author.send({ embeds: [emb('🤖 AutoMod', 'You were auto-muted for **5 minutes** for spamming. Slow down.')] }); } catch {}
          spamTracker.set(uid, []);
        } catch {}
        return;
      }

      // Anti-invite links (discord.gg / discord.com/invite)
      if (/discord\.(gg|com\/invite)\/\S+/i.test(message.content)) {
        try {
          await message.delete();
          const warns = warnStore.get(uid) || [];
          warns.push({ reason: 'Posted Discord invite link', modTag: 'AutoMod', timestamp: Date.now() });
          warnStore.set(uid, warns);
          await logMod(message.guild, 'AUTOMOD', message.author, null, 'Posted Discord invite link', `Warning #${warns.length}`);
          await message.channel.send({ embeds: [emb('🤖 AutoMod', `${message.author} — no invite links allowed here. (**Warning #${warns.length}**)`)] }).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
        } catch {}
        return;
      }

      // Anti-mass-mention: 5+ unique mentions
      const mentions = new Set([...message.mentions.users.keys(), ...message.mentions.roles.keys()]);
      if (mentions.size >= 5) {
        try {
          await message.delete();
          const warns = warnStore.get(uid) || [];
          warns.push({ reason: 'Mass mention', modTag: 'AutoMod', timestamp: Date.now() });
          warnStore.set(uid, warns);
          await logMod(message.guild, 'AUTOMOD', message.author, null, `Mass mention (${mentions.size} mentions)`, `Warning #${warns.length}`);
          try { await message.author.send({ embeds: [emb('🤖 AutoMod', `Mass mentioning isn't allowed. (**Warning #${warns.length}**)`)] }); } catch {}
        } catch {}
        return;
      }
    }

    // XP
    const now = Date.now();
    if (now - (xpCooldowns.get(uid) || 0) >= XP_COOLDOWN_MS) {
      xpCooldowns.set(uid, now);
      try { await grantXP(member || await message.guild.members.fetch(uid), isPremium(member) ? XP_PER_MSG * 2 : XP_PER_MSG); } catch {}
    }
    return;
  }

  // ── DM: conversation continuation ─────────────────────────────────────────
  const uid = message.author.id, history = conversations.get(uid);
  if (!history?.length) { await message.reply({ embeds: [emb('👋 BuildrAI Mentor', 'Use a slash command to start!\n\nType `/help` to see everything.')] }); return; }
  const member = await getMember(uid), prem = isPremium(member);
  if (!prem && getCount(uid) >= DAILY_LIMIT) { await message.reply({ embeds: [emb('⏰ Daily Limit', `Resets in **${timeUntilMidnight()}**.\n\n👉 ${UPGRADE_LINK}`)] }); return; }
  try {
    const updated = [...history, { role: 'user', content: message.content }];
    const loading = await message.reply({ embeds: [emb('💭 Thinking...', 'Give me a sec...')] });
    const result  = await claude(updated);
    updated.push({ role: 'assistant', content: result });
    conversations.set(uid, updated.slice(-20));
    bumpCount(uid); bumpStreak(uid);
    await loading.edit({ embeds: [emb('BuildrAI Mentor', result, footer(prem, uid))] });
  } catch (err) { console.error('DM conversation failed:', err); await message.reply({ embeds: [emb('⚠️ Error', 'Something went wrong. Try again.')] }); }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName: cmd } = interaction;

  const aiCmds = ['idea', 'pitch', 'validate', 'competitor', 'landing', 'strategy'];
  if (aiCmds.includes(cmd) && interaction.guildId) {
    await interaction.reply({ embeds: [emb('🔒 DMs Only', 'AI commands only work in DMs.\n\n**Click my username → Message** then use any command.')], ephemeral: true });
    return;
  }

  try {
    const H = {
      help: () => handleHelp(interaction), support: () => handleSupport(interaction),
      rank: () => handleRank(interaction),  leaderboard: () => handleLeaderboard(interaction),
      streak: () => handleStreak(interaction), validate: () => handleValidate(interaction),
      strategy: () => handleStrategy(interaction),
      idea:       () => runAI(interaction, '/idea — Business Ideas',       P.idea(interaction.options.getString('interest'))),
      pitch:      () => runAI(interaction, '/pitch — Elevator Pitch',      P.pitch(interaction.options.getString('business'))),
      competitor: () => runAI(interaction, '/competitor — Analysis',       P.competitor(interaction.options.getString('target'))),
      landing:    () => runAI(interaction, '/landing — Landing Page Copy', P.landing(interaction.options.getString('product'))),
      warn: () => handleWarn(interaction), warnings: () => handleWarnings(interaction),
      clearwarns: () => handleClearwarns(interaction), mute: () => handleMute(interaction),
      unmute: () => handleUnmute(interaction), kick: () => handleKick(interaction),
      ban: () => handleBan(interaction), unban: () => handleUnban(interaction),
      setuproles: () => handleSetupRoles(interaction),
    };
    if (H[cmd]) await H[cmd]();
  } catch (err) {
    console.error(`Command ${cmd} failed:`, err);
    try {
      const e = emb('⚠️ Error', 'Something went wrong. Try again or use `/support`.');
      if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [e] });
      else await interaction.reply({ embeds: [e], ephemeral: true });
    } catch {}
  }
});

// ── Reaction Role Events ───────────────────────────────────────────────────────
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    if (!reactionRoleMessageId || reaction.message.id !== reactionRoleMessageId) return;

    // Fetch partial data if needed
    if (reaction.partial) { try { await reaction.fetch(); } catch (err) { console.error('Failed to fetch reaction:', err.message); return; } }
    if (reaction.message.partial) { try { await reaction.message.fetch(); } catch (err) { console.error('Failed to fetch message:', err.message); return; } }

    const emoji = reaction.emoji.name;
    const roleName = EMOJI_TO_ROLE.get(emoji);
    if (!roleName) return;

    const guild = reaction.message.guild;
    if (!guild) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    const role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) { console.error(`Reaction role not found in server: "${roleName}"`); return; }

    await member.roles.add(role);
    console.log(`Added role "${roleName}" to ${user.tag}`);
  } catch (err) {
    console.error('MessageReactionAdd error:', err.message);
  }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    if (user.bot) return;
    if (!reactionRoleMessageId || reaction.message.id !== reactionRoleMessageId) return;

    // Fetch partial data if needed
    if (reaction.partial) { try { await reaction.fetch(); } catch (err) { console.error('Failed to fetch reaction:', err.message); return; } }
    if (reaction.message.partial) { try { await reaction.message.fetch(); } catch (err) { console.error('Failed to fetch message:', err.message); return; } }

    const emoji = reaction.emoji.name;
    const roleName = EMOJI_TO_ROLE.get(emoji);
    if (!roleName) return;

    const guild = reaction.message.guild;
    if (!guild) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    const role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) { console.error(`Reaction role not found in server: "${roleName}"`); return; }

    await member.roles.remove(role);
    console.log(`Removed role "${roleName}" from ${user.tag}`);
  } catch (err) {
    console.error('MessageReactionRemove error:', err.message);
  }
});

// ── Web Dashboard ──────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BuildrAI — Live Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0D0D1A; color: #fff; min-height: 100vh; }
    .header { padding: 28px 40px; border-bottom: 1px solid #1E1E3A; display: flex; align-items: center; justify-content: space-between; }
    .logo { font-size: 22px; font-weight: 700; color: #7B2FBE; }
    .logo span { color: #fff; }
    .live { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #666; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #22D97A; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.3} }
    .container { max-width: 1000px; margin: 0 auto; padding: 40px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 40px; }
    .card { background: #12122A; border: 1px solid #1E1E3A; border-radius: 12px; padding: 24px; }
    .card-label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 10px; }
    .card-value { font-size: 34px; font-weight: 700; color: #7B2FBE; }
    .section-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #aaa; text-transform: uppercase; letter-spacing: 0.5px; }
    .board { background: #12122A; border: 1px solid #1E1E3A; border-radius: 12px; overflow: hidden; margin-bottom: 40px; }
    .row { display: flex; align-items: center; padding: 16px 24px; border-bottom: 1px solid #1a1a30; }
    .row:last-child { border-bottom: none; }
    .row:hover { background: #161630; }
    .pos { width: 36px; font-size: 18px; font-weight: 700; color: #555; }
    .pos.gold { color: #F4A917; }
    .name { flex: 1; font-weight: 600; font-size: 15px; }
    .rank-tag { font-size: 12px; color: #666; margin-right: 20px; }
    .xp-val { font-weight: 700; color: #7B2FBE; }
    .cta { text-align: center; padding: 20px 0; }
    .btn { display: inline-block; color: #fff; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-weight: 600; font-size: 15px; transition: background 0.2s; margin: 8px; }
    .btn:not(.btn-premium) { background: #5865F2; }
    .btn:not(.btn-premium):hover { background: #4752C4; }
    .btn-premium { background: #7B2FBE; }
    .btn-premium:hover { background: #9B4FDE; }
    .empty { padding: 48px; text-align: center; color: #555; }
    .refresh-note { text-align: center; font-size: 12px; color: #444; margin-top: 16px; }
    @media(max-width:600px){ .container{padding:20px;} .header{padding:20px;} .rank-tag{display:none;} .card-value{font-size:26px;} }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">Buildr<span>AI</span></div>
    <div class="live"><div class="dot"></div>Live</div>
  </div>
  <div class="container">
    <div class="stats">
      <div class="card"><div class="card-label">Total Members</div><div class="card-value" id="memberCount">—</div></div>
      <div class="card"><div class="card-label">Total XP Earned</div><div class="card-value" id="totalXP">—</div></div>
      <div class="card"><div class="card-label">Active Builders</div><div class="card-value" id="activeUsers">—</div></div>
      <div class="card"><div class="card-label">Prompts Used Today</div><div class="card-value" id="promptsToday">—</div></div>
    </div>
    <div class="section-title">🏆 XP Leaderboard</div>
    <div class="board" id="board"><div class="empty">Loading...</div></div>
    <div class="cta"><a class="btn" href="https://discord.gg/BberczhERC" target="_blank">Join the Server 🔨</a><a class="btn btn-premium" href="https://whop.com/buildrai/buildr-ai-premium-builder/" target="_blank">Go Premium ⚡</a></div>
    <div class="refresh-note">Refreshes every 30 seconds</div>
  </div>
  <script>
    const medals = ['🥇','🥈','🥉'];
    async function load() {
      try {
        const [s, l] = await Promise.all([fetch('/api/stats').then(r=>r.json()), fetch('/api/leaderboard').then(r=>r.json())]);
        document.getElementById('memberCount').textContent = s.memberCount.toLocaleString();
        document.getElementById('totalXP').textContent = s.totalXP.toLocaleString();
        document.getElementById('activeUsers').textContent = s.activeUsers.toLocaleString();
        document.getElementById('promptsToday').textContent = s.promptsToday.toLocaleString();
        const board = document.getElementById('board');
        if (!l.length) { board.innerHTML = '<div class="empty">No XP earned yet — start chatting in the server!</div>'; return; }
        board.innerHTML = l.map((e,i) => \`<div class="row"><div class="pos \${i<3?'gold':''}">\${medals[i]||i+1}</div><div class="name">\${e.username}</div><div class="rank-tag">\${e.rankName}</div><div class="xp-val">\${e.xp.toLocaleString()} XP</div></div>\`).join('');
      } catch(err) { console.error(err); }
    }
    load();
    setInterval(load, 30000);
  </script>
</body>
</html>`;

const dashApp = express();
dashApp.use(cors());

dashApp.get('/', (req, res) => res.send(DASHBOARD_HTML));

dashApp.get('/api/stats', (req, res) => {
  try {
    const t = today();
    const totalXP = [...xpStore.values()].reduce((a, b) => a + b, 0);
    const promptsToday = [...promptCounts.values()].filter(r => r.date === t).reduce((a, r) => a + r.count, 0);
    res.json({
      memberCount: client.guilds.cache.first()?.memberCount || 0,
      totalXP,
      activeUsers: xpStore.size,
      promptsToday,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

dashApp.get('/api/leaderboard', async (req, res) => {
  try {
    const entries = [...xpStore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const leaderboard = await Promise.all(entries.map(async ([uid, xp], i) => {
      let username = usernameCache.get(uid);
      if (!username) {
        try { const u = await client.users.fetch(uid); username = u.username; usernameCache.set(uid, username); }
        catch { username = 'Builder'; }
      }
      return { rank: i + 1, username, xp, rankName: getRank(xp).name };
    }));
    res.json(leaderboard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
dashApp.listen(PORT, () => console.log(`✅ Dashboard live on port ${PORT}`));
// ── End Dashboard ──────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
