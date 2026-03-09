require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } = require('discord.js');
const OpenAI = require('openai');

// ── Init ──────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Daily prompt tracking (resets at midnight) ────────────────────────────────
const userPromptCounts = new Map(); // userId -> { count, date }
const DAILY_LIMIT = 3;
const PREMIUM_ROLE_NAME = 'Premium Builder';
const UPGRADE_LINK = process.env.UPGRADE_LINK || 'https://your-whop-link.com';

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function getUserCount(userId) {
  const today = getTodayDate();
  const record = userPromptCounts.get(userId);
  if (!record || record.date !== today) {
    userPromptCounts.set(userId, { count: 0, date: today });
    return 0;
  }
  return record.count;
}

function incrementUserCount(userId) {
  const today = getTodayDate();
  const current = getUserCount(userId);
  userPromptCounts.set(userId, { count: current + 1, date: today });
}

function isPremium(member) {
  if (!member) return false;
  return member.roles.cache.some(r => r.name === PREMIUM_ROLE_NAME);
}

// ── System prompt ─────────────────────────────────────────────────────────────
const BASE_SYSTEM = `You are BuildrAI Mentor — a sharp, experienced startup mentor speaking directly to young entrepreneurs aged 16–25. 

Your personality:
- Direct, energetic, and brutally practical
- Never use corporate language or generic advice
- Treat young people as capable of building real businesses
- Every response ends with ONE specific action they can take TODAY
- Keep responses punchy — under 300 words unless the task demands more
- Use short paragraphs. No walls of text.
- You believe in them but you don't sugarcoat reality`;

// ── Command prompts ───────────────────────────────────────────────────────────
const COMMAND_PROMPTS = {
  idea: (input) => `The user is interested in: "${input}". Generate 3 unique business ideas for a young entrepreneur. 

For each idea provide:
- A bold name
- One sentence description  
- Who the target customer is
- One specific action to start THIS WEEK (not "do research" — something real)

Make each idea genuinely different. At least one should be online/digital. Make them excited to start.`,

  pitch: (input) => `The user's business: "${input}". Write a powerful 30-second elevator pitch in FIRST PERSON.

Structure (one sentence each):
1. Hook — grab attention immediately
2. Problem — the pain they solve
3. Solution — what they built
4. Why them — their unique edge
5. Call to action — what they want from the listener

Sound like a real person talking, not a press release. Bold and confident.`,

  validate: (input) => `The user's business idea: "${input}". 

Ask them exactly 3 sharp questions that will reveal if this idea has real potential. Focus on:
1. Demand (will people actually pay?)
2. Competition (who else does this?)
3. Monetization (how does money flow?)

Make the questions specific to THEIR idea, not generic. Tell them to answer all 3 and you'll give them a score.

NOTE: If they've already answered 3 questions, skip straight to: give a Viability Score out of 10, a 2-sentence verdict, and one specific low-cost test they can run this week to validate demand.`,

  competitor: (input) => `Analyze this competitor or industry: "${input}".

Break down:
- Business model (how it actually works)
- Revenue streams (how they make money)
- Target customer (who pays them)
- Biggest weakness (be honest and specific)
- One gap in the market the user could exploit RIGHT NOW

Be analytical. Give them intelligence they can actually use, not a Wikipedia summary.`,

  landing: (input) => `Write landing page copy for: "${input}".

Deliver exactly:
- HEADLINE: Bold, specific, benefit-driven (not clever, clear)
- SUBHEADLINE: One sentence expanding the headline
- BENEFIT 1: [Feature] → [What it means for them]
- BENEFIT 2: [Feature] → [What it means for them]  
- BENEFIT 3: [Feature] → [What it means for them]
- SOCIAL PROOF: An invented but realistic customer quote with a name and descriptor
- CTA BUTTON: 4–6 words max

Tone: Bold, modern, speaks directly to young entrepreneurs. No corporate speak.`,

  strategy: (input) => `The user's situation: "${input}".

Give them a concrete 3-step action plan. Each step must be:
- Specific to what they told you (no generic advice)
- Completable within the next 7 days
- Include the exact tool, platform, or resource to use

Format as:
STEP 1 — [Action title]
What to do: [Specific instruction]
Tool to use: [Specific resource]

STEP 2 — [same format]
STEP 3 — [same format]

End with: what success looks like after completing all 3 steps.`
};

// ── Call OpenAI ───────────────────────────────────────────────────────────────
async function callAI(commandName, userInput) {
  const prompt = COMMAND_PROMPTS[commandName](userInput);
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: BASE_SYSTEM },
      { role: 'user', content: prompt }
    ],
    max_tokens: 600,
    temperature: 0.85,
  });
  return response.choices[0].message.content;
}

// ── Register slash commands ───────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('idea').setDescription('Generate 3 business ideas for you')
    .addStringOption(o => o.setName('interest').setDescription('Your interest or topic').setRequired(true)),
  new SlashCommandBuilder().setName('pitch').setDescription('Write your 30-second elevator pitch')
    .addStringOption(o => o.setName('business').setDescription('Describe your business').setRequired(true)),
  new SlashCommandBuilder().setName('validate').setDescription('Score your business idea')
    .addStringOption(o => o.setName('idea').setDescription('Describe your idea').setRequired(true)),
  new SlashCommandBuilder().setName('competitor').setDescription('Break down a competitor or industry')
    .addStringOption(o => o.setName('target').setDescription('Competitor name or industry').setRequired(true)),
  new SlashCommandBuilder().setName('landing').setDescription('Generate landing page copy')
    .addStringOption(o => o.setName('product').setDescription('Describe your product or service').setRequired(true)),
  new SlashCommandBuilder().setName('strategy').setDescription('Get a 3-step action plan')
    .addStringOption(o => o.setName('situation').setDescription('Describe your stage and biggest problem').setRequired(true)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('Error registering commands:', err);
  }
}

// ── Bot ready ─────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅ BuildrAI Mentor is online as ${client.user.tag}`);
  await registerCommands();
});

// ── New member welcome DM ─────────────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await member.send(
      `👋 **Welcome to BuildrAI, ${member.displayName}.**\n\n` +
      `I'm your AI business mentor. Here's what I can do:\n\n` +
      `**/idea** — generate 3 business ideas based on your interests\n` +
      `**/pitch** — write your 30-second elevator pitch\n` +
      `**/validate** — score your idea out of 10\n` +
      `**/competitor** — break down any competitor\n` +
      `**/landing** — write your landing page copy\n` +
      `**/strategy** — build your 3-step action plan\n\n` +
      `You get **3 free prompts per day.** Premium Builders get unlimited access + 2x XP.\n\n` +
      `Type any command to start. Let's build something. 🚀`
    );
  } catch (err) {
    console.log(`Could not DM ${member.user.tag}`);
  }
});

// ── Handle slash commands ─────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const validCommands = ['idea', 'pitch', 'validate', 'competitor', 'landing', 'strategy'];
  if (!validCommands.includes(interaction.commandName)) return;

  // Force DMs only
  if (interaction.channel?.type !== 1) { // 1 = DM channel
    await interaction.reply({
      content: `🔒 To keep your ideas private, I only respond in DMs. **Send me a direct message** and use any command there.`,
      ephemeral: true
    });
    return;
  }

  const userId = interaction.user.id;

  // Check premium status
  let member = null;
  try {
    const guild = client.guilds.cache.first();
    if (guild) member = await guild.members.fetch(userId);
  } catch (_) {}

  const premium = isPremium(member);
  const count = getUserCount(userId);

  if (!premium && count >= DAILY_LIMIT) {
    await interaction.reply(
      `⚡ You've used your **${DAILY_LIMIT} daily prompts.**\n\n` +
      `Premium Builders get **unlimited access + 2x XP.**\n` +
      `👉 Upgrade here: ${UPGRADE_LINK}\n\n` +
      `See you tomorrow, or upgrade now. 🚀`
    );
    return;
  }

  await interaction.deferReply();

  const inputOption = interaction.options.getString(
    interaction.commandName === 'idea' ? 'interest' :
    interaction.commandName === 'pitch' ? 'business' :
    interaction.commandName === 'validate' ? 'idea' :
    interaction.commandName === 'competitor' ? 'target' :
    interaction.commandName === 'landing' ? 'product' : 'situation'
  );

  try {
    const result = await callAI(interaction.commandName, inputOption);
    incrementUserCount(userId);

    const remaining = premium ? '∞' : `${DAILY_LIMIT - getUserCount(userId)}`;
    const footer = premium
      ? `\n\n*Premium Builder — unlimited prompts* ⭐`
      : `\n\n*${remaining} prompts remaining today — [Upgrade to Premium](${UPGRADE_LINK})*`;

    await interaction.editReply(result + footer);
  } catch (err) {
    console.error('OpenAI error:', err);
    await interaction.editReply('Something went wrong. Try again in a moment.');
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
