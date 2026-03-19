require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, Events, EmbedBuilder,
} = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages,
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

// ── In-memory stores ──────────────────────────────────────────────────────────
const promptCounts  = new Map(); // userId -> { count, date }
const xpStore       = new Map(); // userId -> xp
const streakStore   = new Map(); // userId -> { streak, lastDate }
const xpCooldowns   = new Map(); // userId -> timestamp
const conversations = new Map(); // userId -> messages[]

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

function getXP(uid)  { return xpStore.get(uid) || 0; }
function getRank(xp) { return RANKS.filter(r => xp >= r.minXP).at(-1); }
function getNextRank(xp) { return RANKS.find(r => r.minXP > xp) || null; }

function getStreak(uid) { return streakStore.get(uid)?.streak || 0; }
function bumpStreak(uid) {
  const t = today();
  const r = streakStore.get(uid);
  if (!r)              { streakStore.set(uid, { streak: 1, lastDate: t }); return 1; }
  if (r.lastDate === t) return r.streak;
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const yStr = yest.toISOString().split('T')[0];
  const n = r.lastDate === yStr ? r.streak + 1 : 1;
  streakStore.set(uid, { streak: n, lastDate: t });
  return n;
}

function emb(title, desc, footer = null) {
  const e = new EmbedBuilder().setColor(COLOR).setTitle(title).setDescription(desc);
  if (footer) e.setFooter({ text: footer });
  return e;
}

async function getMember(uid) {
  try { return await client.guilds.cache.first()?.members.fetch(uid).catch(() => null) ?? null; }
  catch { return null; }
}

async function grantXP(member, amount) {
  const uid      = member.id;
  const prev     = getXP(uid);
  const prevRank = getRank(prev);
  const next     = prev + amount;
  xpStore.set(uid, next);
  const newRank  = getRank(next);
  if (newRank.name !== prevRank.name) {
    try {
      const ch = member.guild.channels.cache.find(c => c.name === 'achievements');
      if (ch) await ch.send({ embeds: [emb('🎉 Rank Up!', `**${member.displayName}** just hit **${newRank.name}** with **${next} XP**! 🚀`)] });
    } catch {}
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

// ── Prompts ───────────────────────────────────────────────────────────────────
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
  const r = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    system: SYSTEM,
    messages: history,
    max_tokens: 800,
  });
  return r.content[0].text;
}

// ── Prompt-limit check ────────────────────────────────────────────────────────
async function checkLimit(interaction) {
  const uid    = interaction.user.id;
  const member = await getMember(uid);
  const prem   = isPremium(member);
  if (!prem && getCount(uid) >= DAILY_LIMIT) {
    await interaction.reply({ embeds: [emb(
      '⏰ Daily Limit',
      `You've used your **${DAILY_LIMIT} daily prompts**.\n\nResets in **${timeUntilMidnight()}**.\n\nPremium = unlimited + 2x XP.\n👉 ${UPGRADE_LINK}`,
    )] });
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

// ── Command handlers ──────────────────────────────────────────────────────────
async function handleHelp(ix) {
  await ix.reply({ embeds: [emb(
    '🤖 BuildrAI — All Commands',
    `Use AI commands by **DMing me** to keep ideas private.\n\n` +
    `**AI Commands (DM only)**\n` +
    `\`/idea\` — 3 ideas with cost + difficulty\n` +
    `\`/pitch\` — 30-second elevator pitch\n` +
    `\`/validate\` — score/10 + PASS/FAIL + risks\n` +
    `\`/competitor\` — full competitor breakdown\n` +
    `\`/landing\` — landing page copy\n` +
    `\`/strategy\` — tailored 3-step plan\n\n` +
    `**Info**\n` +
    `\`/streak\` — daily usage streak\n` +
    `\`/rank\` — your XP + rank\n` +
    `\`/leaderboard\` — top 10 builders\n` +
    `\`/support\` — get help\n` +
    `\`/help\` — this menu\n\n` +
    `**Limits:** Free = 3/day | Premium = unlimited + 2x XP\n👉 ${UPGRADE_LINK}`,
    'BuildrAI Mentor',
  )] });
}

async function handleSupport(ix) {
  await ix.reply({ embeds: [emb(
    '🆘 Support',
    `For help with BuildrAI, post in **#feedback** or DM Leon directly in the server.\n\nFor payment or billing issues go to **whop.com/support**.\n\nWe respond within 24 hours.`,
    'BuildrAI Mentor',
  )] });
}

async function handleRank(ix) {
  const xp   = getXP(ix.user.id);
  const rank = getRank(xp);
  const next = getNextRank(xp);
  await ix.reply({ embeds: [emb(
    '/rank — Your Progress',
    `**Rank:** ${rank.name}\n**XP:** ${xp}\n\n` +
    (next ? `**${xp} / ${next.minXP} XP** to reach ${next.name}` : `**${xp} XP** — Maximum rank achieved 👑`) +
    `\n\nEarn XP by chatting in the server. Premium = 2x XP.`,
    'BuildrAI Mentor',
  )] });
}

async function handleLeaderboard(ix) {
  const entries = [...xpStore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!entries.length) {
    await ix.reply({ embeds: [emb('/leaderboard', 'No XP earned yet. Start chatting in the server!')] });
    return;
  }
  await ix.deferReply();
  const medals = ['🥇', '🥈', '🥉'];
  const lines  = await Promise.all(entries.map(async ([uid, xp], i) => {
    try { const u = await client.users.fetch(uid); return `${medals[i] || `${i+1}.`} **${u.username}** — ${xp} XP (${getRank(xp).name})`; }
    catch { return `${medals[i] || `${i+1}.`} Unknown — ${xp} XP`; }
  }));
  await ix.editReply({ embeds: [emb('/leaderboard — Top 10 Builders', lines.join('\n'), 'Real-time')] });
}

async function handleStreak(ix) {
  const s = getStreak(ix.user.id);
  const msg = !s
    ? 'No streak yet. Use your first AI command to start. 🔥'
    : s === 1 ? '🔥 **1 day streak.** Just started — don\'t stop now.'
    : s < 7   ? `🔥 **${s} day streak.** Building the habit. Keep going.`
    : s < 30  ? `🔥 **${s} day streak.** Locked in. This is how businesses get built.`
    :           `🔥 **${s} day streak.** Elite consistency. You\'re the real deal.`;
  await ix.reply({ embeds: [emb('/streak — Daily Usage', msg, 'BuildrAI Mentor')] });
}

async function handleValidate(ix) {
  const lim = await checkLimit(ix);
  if (!lim) return;
  await ix.deferReply();
  try {
    const idea    = ix.options.getString('idea');
    const history = [{ role: 'user', content: P.validateAsk(idea) }];
    const result  = await claude(history);
    history.push({ role: 'assistant', content: result });
    conversations.set(ix.user.id, history);
    bumpCount(ix.user.id);
    bumpStreak(ix.user.id);
    await ix.editReply({ embeds: [emb('/validate — Idea Validation', result + '\n\n_Reply to me in DM with all 3 answers to get your score._', footer(lim.prem, ix.user.id))] });
  } catch (err) {
    console.error('validate:', err.message);
    await ix.editReply({ embeds: [emb('⚠️ Error', 'Something went wrong. Try again or use /support.')] });
  }
}

async function handleStrategy(ix) {
  const lim = await checkLimit(ix);
  if (!lim) return;
  await ix.deferReply();
  try {
    const sit     = ix.options.getString('situation');
    const history = [{ role: 'user', content: P.strategyAsk(sit) }];
    const result  = await claude(history);
    history.push({ role: 'assistant', content: result });
    conversations.set(ix.user.id, history);
    bumpCount(ix.user.id);
    bumpStreak(ix.user.id);
    await ix.editReply({ embeds: [emb('/strategy — Action Plan', result + '\n\n_Reply to me in DM with your answers to get your tailored plan._', footer(lim.prem, ix.user.id))] });
  } catch (err) {
    console.error('strategy:', err.message);
    await ix.editReply({ embeds: [emb('⚠️ Error', 'Something went wrong. Try again or use /support.')] });
  }
}

// ── Commands registration ─────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('idea').setDescription('Generate 3 business ideas').addStringOption(o => o.setName('interest').setDescription('Your interest or topic').setRequired(true)),
  new SlashCommandBuilder().setName('pitch').setDescription('Write your 30-second elevator pitch').addStringOption(o => o.setName('business').setDescription('Describe your business').setRequired(true)),
  new SlashCommandBuilder().setName('validate').setDescription('Score your idea (3-question deep dive)').addStringOption(o => o.setName('idea').setDescription('Describe your idea').setRequired(true)),
  new SlashCommandBuilder().setName('competitor').setDescription('Break down a competitor or industry').addStringOption(o => o.setName('target').setDescription('Competitor name or industry').setRequired(true)),
  new SlashCommandBuilder().setName('landing').setDescription('Generate landing page copy').addStringOption(o => o.setName('product').setDescription('Describe your product or service').setRequired(true)),
  new SlashCommandBuilder().setName('strategy').setDescription('Get a tailored 3-step action plan').addStringOption(o => o.setName('situation').setDescription('Describe your situation and biggest challenge').setRequired(true)),
  new SlashCommandBuilder().setName('streak').setDescription('See your daily usage streak'),
  new SlashCommandBuilder().setName('rank').setDescription('See your XP and current rank'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('See top 10 members by XP'),
  new SlashCommandBuilder().setName('support').setDescription('Get help with BuildrAI'),
  new SlashCommandBuilder().setName('help').setDescription('See all available commands'),
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
  try {
    const role = member.guild.roles.cache.find(r => r.name === 'Free User');
    if (role) await member.roles.add(role);
  } catch (err) { console.error('Free User role:', err.message); }

  try {
    await member.send({ embeds: [emb(
      `👋 Welcome to BuildrAI, ${member.displayName}`,
      `I'm your AI business mentor. **DM me** to keep your ideas private.\n\n` +
      `\`/idea\` — 3 business ideas with cost + difficulty\n` +
      `\`/pitch\` — 30-second elevator pitch\n` +
      `\`/validate\` — score/10 + PASS/FAIL + risks\n` +
      `\`/competitor\` — competitor breakdown\n` +
      `\`/landing\` — landing page copy\n` +
      `\`/strategy\` — tailored 3-step plan\n` +
      `\`/streak\` — usage streak\n` +
      `\`/rank\` — XP + rank\n` +
      `\`/leaderboard\` — top 10 builders\n` +
      `\`/support\` — get help\n\n` +
      `**Free:** 3 prompts/day | **Premium:** unlimited + 2x XP\n👉 ${UPGRADE_LINK}\n\nLet's build something real. 🚀`,
      'BuildrAI Mentor',
    )] });
  } catch { console.log(`Could not DM ${member.user.tag}`); }
});

// Single MessageCreate: XP (server) + DM continuation
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.guild) {
    const uid = message.author.id;
    const now = Date.now();
    if (now - (xpCooldowns.get(uid) || 0) >= XP_COOLDOWN_MS) {
      xpCooldowns.set(uid, now);
      try {
        const member = message.member || await message.guild.members.fetch(uid);
        await grantXP(member, isPremium(member) ? XP_PER_MSG * 2 : XP_PER_MSG);
      } catch (err) { console.error('XP:', err.message); }
    }
    return;
  }

  const uid     = message.author.id;
  const history = conversations.get(uid);

  if (!history?.length) {
    await message.reply({ embeds: [emb('👋 BuildrAI Mentor', 'Use a slash command to get started!\n\nType `/help` to see everything I can do.')] });
    return;
  }

  const member = await getMember(uid);
  const prem   = isPremium(member);
  if (!prem && getCount(uid) >= DAILY_LIMIT) {
    await message.reply({ embeds: [emb('⏰ Daily Limit', `You've used your **${DAILY_LIMIT} daily prompts**.\n\nResets in **${timeUntilMidnight()}**.\n\n👉 ${UPGRADE_LINK}`)] });
    return;
  }

  try {
    const updated    = [...history, { role: 'user', content: message.content }];
    const loadingMsg = await message.reply({ embeds: [emb('💭 Thinking...', 'Give me a sec...')] });
    const result     = await claude(updated);
    updated.push({ role: 'assistant', content: result });
    conversations.set(uid, updated.slice(-20));
    bumpCount(uid);
    bumpStreak(uid);
    await loadingMsg.edit({ embeds: [emb('BuildrAI Mentor', result, footer(prem, uid))] });
  } catch (err) {
    console.error('DM:', err.message);
    await message.reply({ embeds: [emb('⚠️ Error', 'Something went wrong. Try again or use /support.')] });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName: cmd } = interaction;

  const aiCmds = ['idea', 'pitch', 'validate', 'competitor', 'landing', 'strategy'];
  if (aiCmds.includes(cmd) && interaction.guildId) {
    await interaction.reply({
      embeds: [emb('🔒 DMs Only', 'AI commands only work in DMs to keep your ideas private.\n\n**Click my username → Message** then use any command.')],
      ephemeral: true,
    });
    return;
  }

  try {
    const H = {
      help:        () => handleHelp(interaction),
      support:     () => handleSupport(interaction),
      rank:        () => handleRank(interaction),
      leaderboard: () => handleLeaderboard(interaction),
      streak:      () => handleStreak(interaction),
      idea:        () => runAI(interaction, '/idea — Business Ideas',       P.idea(interaction.options.getString('interest'))),
      pitch:       () => runAI(interaction, '/pitch — Elevator Pitch',      P.pitch(interaction.options.getString('business'))),
      competitor:  () => runAI(interaction, '/competitor — Analysis',       P.competitor(interaction.options.getString('target'))),
      landing:     () => runAI(interaction, '/landing — Landing Page Copy', P.landing(interaction.options.getString('product'))),
      validate:    () => handleValidate(interaction),
      strategy:    () => handleStrategy(interaction),
    };
    if (H[cmd]) await H[cmd]();
  } catch (err) {
    console.error(`${cmd}:`, err.message);
    try {
      const e = emb('⚠️ Error', 'Something went wrong. Try again or use `/support`.');
      if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [e] });
      else await interaction.reply({ embeds: [e], ephemeral: true });
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);
