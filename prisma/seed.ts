// Collective Brain — Prisma database seed.
//
// Run with `tsx prisma/seed.ts` (configured as the Prisma seed command).
//
// Design constraints:
//   * Depends ONLY on '@prisma/client', Node builtins, and process.env.
//     It must NOT import from ../server (that triggers full env validation).
//   * Idempotent: safe to re-run. Uses upsert / existence checks throughout,
//     and explicit string ids so referenced rows stay stable across runs.
//   * Runs with only DATABASE_URL set (no Google/Gemini env required).

import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // --- Resolve admin identity / domain from env (with safe fallbacks) -------
  const adminEmail = (process.env.ADMIN_EMAILS || 'admin@monks.com')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const domain = adminEmail.split('@')[1] || 'monks.com';

  // --- Users ---------------------------------------------------------------
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: { name: 'Platform Admin', role: 'ADMIN', avatarUrl: null },
    create: {
      id: 'seed-user-admin',
      email: adminEmail,
      name: 'Platform Admin',
      role: 'ADMIN',
      avatarUrl: null,
    },
  });

  const maya = await prisma.user.upsert({
    where: { email: `maya@${domain}` },
    update: { name: 'Maya Chen', role: 'USER', avatarUrl: null },
    create: {
      id: 'seed-user-maya',
      email: `maya@${domain}`,
      name: 'Maya Chen',
      role: 'USER',
      avatarUrl: null,
    },
  });

  const leo = await prisma.user.upsert({
    where: { email: `leo@${domain}` },
    update: { name: 'Leo Martins', role: 'USER', avatarUrl: null },
    create: {
      id: 'seed-user-leo',
      email: `leo@${domain}`,
      name: 'Leo Martins',
      role: 'USER',
      avatarUrl: null,
    },
  });

  // --- Agents --------------------------------------------------------------
  const researchInstructions = [
    'You are a careful research assistant. Your job is to help users understand topics by summarising sources accurately and answering questions grounded in evidence.',
    'Always cite the specific sources you rely on, quoting or referencing them so the user can verify your claims. When information comes from an attached file, name the file.',
    'Distinguish clearly between what the sources state, what is widely established, and what is your own inference. Never present speculation as fact.',
    'When the available evidence is incomplete, conflicting, or outside your knowledge, say so explicitly and flag your uncertainty rather than guessing.',
    'Prefer concise, well-structured answers. If a question cannot be answered from the provided material, explain what is missing and suggest what would be needed to answer it.',
  ].join(' ');

  const brandInstructions = [
    'You are the Brand Voice Editor. You rewrite copy so it sounds friendly, clear, and unmistakably on-brand.',
    'Our voice is warm but professional, confident without being boastful, and concise — favour short sentences and plain language over jargon and filler.',
    'Preserve the original meaning and any factual claims; improve clarity, tone, rhythm, and flow rather than changing substance.',
    'When brand guidelines are attached, follow them closely for terminology, capitalisation, and preferred phrasing.',
    'Return the rewritten copy directly. If you change something significant, briefly note why so the writer can learn the voice.',
  ].join(' ');

  const researchAgent = await prisma.agent.upsert({
    where: { id: 'seed-agent-research' },
    update: {
      ownerId: maya.id,
      title: 'Research Assistant',
      description: 'Summarises sources and answers questions with citations.',
      instructions: researchInstructions,
    },
    create: {
      id: 'seed-agent-research',
      ownerId: maya.id,
      title: 'Research Assistant',
      description: 'Summarises sources and answers questions with citations.',
      instructions: researchInstructions,
    },
  });

  const brandAgent = await prisma.agent.upsert({
    where: { id: 'seed-agent-brand' },
    update: {
      ownerId: leo.id,
      title: 'Brand Voice Editor',
      description: 'Rewrites copy in our brand voice.',
      instructions: brandInstructions,
    },
    create: {
      id: 'seed-agent-brand',
      ownerId: leo.id,
      title: 'Brand Voice Editor',
      description: 'Rewrites copy in our brand voice.',
      instructions: brandInstructions,
    },
  });

  // --- Optional sample file (local storage driver only) --------------------
  const storageDriver = process.env.STORAGE_DRIVER || 'local';
  let seededFile = false;

  if (storageDriver === 'local') {
    const storageDir = process.env.LOCAL_STORAGE_DIR || './data/uploads';
    const storageKey = 'seed/brand-guidelines.txt';
    const filePath = join(storageDir, storageKey);

    const contents = [
      'Collective Brain — Brand Guidelines (sample)',
      '',
      'Voice: friendly, clear, confident. Write like a knowledgeable colleague.',
      'Tone: warm but professional. Avoid hype, jargon, and filler words.',
      'Sentences: short and active. Prefer plain language over buzzwords.',
      'Always capitalise the product name as "Collective Brain".',
      'Spell "Monks" with a capital M; never "monks" mid-sentence as the company.',
    ].join('\n') + '\n';

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, 'utf8');

    await prisma.file.upsert({
      where: { id: 'seed-file-brand' },
      update: {
        filename: 'brand-guidelines.txt',
        mimeType: 'text/plain',
        size: Buffer.byteLength(contents),
        storageKey,
        uploaderId: leo.id,
      },
      create: {
        id: 'seed-file-brand',
        filename: 'brand-guidelines.txt',
        mimeType: 'text/plain',
        size: Buffer.byteLength(contents),
        storageKey,
        uploaderId: leo.id,
      },
    });

    await prisma.agentFile.upsert({
      where: {
        agentId_fileId: {
          agentId: brandAgent.id,
          fileId: 'seed-file-brand',
        },
      },
      update: {},
      create: {
        agentId: brandAgent.id,
        fileId: 'seed-file-brand',
      },
    });

    seededFile = true;
  }

  // --- Demo thread on the research agent (only if it has no messages) ------
  let seededThread = false;
  const existingMessages = await prisma.message.count({
    where: { agentId: researchAgent.id },
  });

  if (existingMessages === 0) {
    const userMessage = await prisma.message.create({
      data: {
        agentId: researchAgent.id,
        authorId: maya.id,
        role: 'USER',
        content:
          'Can you summarise the main arguments for and against a four-day work week, and tell me how strong the evidence is on productivity?',
      },
    });

    await prisma.message.create({
      data: {
        agentId: researchAgent.id,
        authorId: null,
        role: 'ASSISTANT',
        referencedMessageIds: [userMessage.id],
        content:
          'Here is a balanced summary. In favour: trials (notably the 2022 UK pilot run by 4 Day Week Global) reported that most participating companies maintained or improved revenue while staff reported lower burnout and higher wellbeing. Against: critics note these pilots are mostly self-selected firms in knowledge work, lack control groups, and rely heavily on self-reported measures, so the productivity gains may not generalise to shift-based or customer-facing roles. My read: the wellbeing evidence is fairly consistent, but the productivity evidence is suggestive rather than conclusive — the strongest studies are observational, and I am not aware of large randomised trials. I would treat the "productivity stays flat or improves" claim as plausible but uncertain, and worth validating against your own sector before acting on it.',
      },
    });

    seededThread = true;
  }

  // --- Summary -------------------------------------------------------------
  console.log('Seed complete.');
  console.log(
    `  Users:   ${admin.email} (ADMIN), ${maya.email} (USER), ${leo.email} (USER)`,
  );
  console.log(
    `  Agents:  "${researchAgent.title}" (owner ${maya.email}), "${brandAgent.title}" (owner ${leo.email})`,
  );
  console.log(
    `  File:    ${seededFile ? 'brand-guidelines.txt linked to Brand Voice Editor' : `skipped (STORAGE_DRIVER=${storageDriver})`}`,
  );
  console.log(
    `  Thread:  ${seededThread ? 'created demo USER + ASSISTANT messages on Research Assistant' : 'skipped (messages already exist)'}`,
  );
}

main()
  .catch((error: unknown) => {
    process.exitCode = 1;
    console.error('Seed failed:', error);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
